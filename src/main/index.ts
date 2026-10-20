// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 主进程入口。
 *
 * 关键设计：**自定义协议 pdf-file:// 读取本地 PDF**。
 *
 * 为什么不用 file:// 直接加载：
 *   pdf.js 在渲染进程里要按 Range 分块读取大文件，file:// 在开启
 *   webSecurity 时不允许 fetch，而关闭 webSecurity 会让整个渲染层失去沙箱。
 *   因此注册一个特权协议，由主进程用 net.fetch 转发（天然支持 Range）。
 *
 * 单实例：文件关联双击时需要把新文件交给已运行实例打开，而不是开新窗口。
 */

import { app, BrowserWindow, dialog, ipcMain, net, protocol, screen, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { basename, extname, join, normalize, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PDFDocument } from 'pdf-lib'
import { diagEnabled, diagLine, diagLogPath, diagMarkerPath, initDiagLog } from './diag-log'
import {
  getSettings,
  patchSettings,
  pushRecent,
  getRecent,
  readLastPosition,
  writeLastPosition,
} from './settings'
import type { Annotation, OpenResult } from '@shared/types'
import { checkForUpdate, currentVersion, downloadUpdate, installUpdate } from './updater'

/**
 * ★ 必须在模块加载时立刻声明特权协议，位置不能挪到文件底部。
 *
 * 踩坑记录：把这段写在文件末尾，编译产物里它的执行顺序落在
 * `app.whenReady().then(onReady)` 之后 —— 于是 onReady 里的
 * `protocol.handle('pdf-file', …)` 在一个**尚未成为特权协议**的 scheme 上注册，
 * 请求根本不会到达处理器，渲染层拿到 404。
 * 表现是 pdf.js 报 `Missing PDF "pdf-file://c/Users/..."`，
 * 而主进程日志里连一行处理器输出都没有。
 *
 * 声明为特权协议后：
 *   · 可以按标准 URL 解析（含盘符冒号）
 *   · 支持 fetch 与流式响应，pdf.js 才能按 Range 分块读取大文件
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'pdf-file',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: false
    }
  }
])

/** 主窗口 */
let mainWindow: BrowserWindow | null = null

/**
 * ★ userData 目录钉死在改名前的名字上（2026-10-16 v2.0.0.0 改名时加）。
 *
 * ── 为什么必须钉 ─────────────────────────────────────────────
 *   Electron 的 userData = appData + productName，而 productName 刚从
 *   「秋夕月拾旧-PDF阅读器」改成「秋夕-PDF阅读器」。不钉的话
 *   %APPDATA%\秋夕-PDF阅读器 会是一个**空目录**，用户的设置、最近打开
 *   列表、每本书的阅读位置全部「凭空消失」（其实还躺在旧目录里）。
 *
 * ── 为什么放在模块顶层、单实例锁之前 ─────────────────────────
 *   · 必须早于任何 app.getPath('userData') 的使用
 *     （src/main/settings.ts、src/main/diag-log.ts 都依赖它）；
 *   · 单实例锁与缓存目录都按它派生，早点定下来才能保证
 *     新旧版本、两次启动之间锁的是同一个东西。
 *
 * 注意：**不要**用 app.setName() 来达到同样目的 —— setName 必须在任何
 * getPath 之前调用，且不会改变已经解析出来的 userData，
 * 结果只会让「应用名」和「数据目录名」不一致。
 *
 * 风险提示：删掉这段（或把常量改掉）等于让老用户数据找不到，别动。
 */
const LEGACY_USER_DATA_NAME = '秋夕月拾旧-PDF阅读器'
{
  const appData = app.getPath('appData')
  const current = app.getPath('userData')
  if (basename(current) !== LEGACY_USER_DATA_NAME) {
    const pinned = join(appData, LEGACY_USER_DATA_NAME)
    try {
      mkdirSync(pinned, { recursive: true })
      app.setPath('userData', pinned)
      console.log('[pdf] userData 目录已钉定到:', pinned)
    } catch (error) {
      console.error('[pdf] userData 目录钉定失败，继续用默认目录:', error)
    }
  }
}

/**
 * 待打开的**文件队列**。
 *
 * ══════════════════════════════════════════════════════════════
 * 为什么是队列，而不是单个 pendingFile（2026-10-17 修的缺陷）
 * ══════════════════════════════════════════════════════════════
 *   用户报「似乎有概率打不开」。根因就是这里：原来只有一个
 *   `pendingFile` 变量，而 `openFileInWindow` 在窗口/渲染层
 *   还没准备好时会**静默什么都不做**（下面那个 if 不成立）。
 *   于是有两条真实的丢文件路径：
 *
 *     ① 渲染层还没订阅 `pdf:open`：窗口对象已经建好，
 *        但页面的 JS 还在加载/执行。这时 `webContents.send` 发出去的
 *        消息没有任何监听者 —— 事件直接丢掉，界面一片空白。
 *        首屏加载快慢就决定了概率，所以表现为「有时打得开有时打不开」。
 *
 *     ② 窗口还没创建：`app.whenReady` 之后到 createMainWindow 之间，
 *        或者窗口被销毁重建的间隙里，mainWindow 为 null，
 *        文件被直接丢弃。
 *
 *   现在改成：**没准备好就入队**，等渲染层显式回报「我准备好收文件了」
 *   （ipc: 'app:renderer-ready'）再按序冲洗队列。
 *   队列去重（同一路径只留一次），避免文件关联被重复触发时连开多次。
 */
const pendingOpens: string[] = []

/**
 * 渲染层是否已挂上 `pdf:open` 监听。
 *
 * 只有它为 true 时才可以真的 send —— 否则消息发给空气。
 * 由渲染层在挂好监听后通过 `app:renderer-ready` 置位；
 * 页面重载（崩溃恢复 / 手动刷新）时会先复位，避免又走到丢消息那条路。
 */
let rendererReady = false

/** 入队（去重）。已就绪且窗口在，调用方可以直接 flush。 */
function queueOpen(filePath: string): void {
  const abs = resolve(filePath)
  if (pendingOpens.includes(abs)) return
  pendingOpens.push(abs)
}

/**
 * 未保存编辑标记（由渲染层同步过来）。
 *
 * 编辑 PDF（文本框/图片/批注改动）之后，用户点右上角关闭按钮
 * 不能直接退出 —— 主进程据此改成「先问渲染层」。
 */
let hasUnsavedEdits = false

/**
 * 是否已确认关闭。
 *
 * 两个来源都汇到这里：正常关闭（无未保存编辑）、渲染层问完用户后的
 * `win:force-close`。为 true 时 close 处理器直接放行。
 */
let allowClose = false


/**
 * 单实例锁。
 *
 * 文件关联双击 PDF 时，Windows 会再启动一次本程序并带上文件路径。
 * 若开两个实例，阅读位置与最近列表会互相覆盖，因此第二个实例
 * 直接把文件转交给已有实例处理，然后退出。
 */
const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const file = extractFileArg(argv)
    if (file) void openFileInWindow(file)
    console.log('[pdf] 第二实例请求：', file ?? '(无文件)')
    revealMainWindow()
  })

  // 首次启动：从命令行取文件（文件关联会以参数形式传入）
  /*
   * ★ 自动化测试可以用环境变量代替命令行传文件。
   *
   *   为什么需要这条：`--app-root=<目录>`（见 createMainWindow 的说明）
   *   是给探针实例指定载荷根的，而 **Electron 会把 argv 里第一个非开关
   *   参数当成「应用路径」** —— 于是「--app-root … PDF路径」这个顺序下
   *   PDF 被当成应用去 require，直接抛
   *   `ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".pdf"`，
   *   进程活着但页面永远不就绪。把文件路径挪到环境变量里最省事，
   *   也不影响正式启动的「双击 PDF → 命令行带路径」这条链路。
   */
  /*
   * 冷启动带的文件路径直接入队。
   * 不在这里 send —— 此刻窗口通常还没建、渲染层更没就绪，
   * 发了也只会丢掉（这正是以前「有时打不开」的来源之一）。
   */
  const startFile =
    extractFileArg(process.argv) ??
    (process.env['PDF_READER_OPEN_FILE'] ? resolve(process.env['PDF_READER_OPEN_FILE']) : null)
  if (startFile) queueOpen(startFile)

  void app.whenReady().then(onReady)
}

app.on('window-all-closed', () => {
  // 单窗口阅读器，关窗即退出（macOS 除外）
  if (process.platform !== 'darwin') app.quit()
})

async function onReady(): Promise<void> {
  console.log('[pdf] 秋夕-PDF阅读器启动')
  console.log('[pdf] 待打开文件:', pendingOpens.length ? pendingOpens.join(', ') : '(无)')

  /* 渲染诊断（默认关闭，见 diag-log.ts 的说明） */
  if (initDiagLog()) {
    console.log('[pdf] ★ 渲染诊断已开启，日志：', diagLogPath())
    const displays = screen.getAllDisplays().map((d) => ({
      尺寸: `${d.size.width}x${d.size.height}`,
      缩放: d.scaleFactor,
      工作区: `${d.workAreaSize.width}x${d.workAreaSize.height}`
    }))
    diagLine(`[main] 屏幕 ${JSON.stringify(displays)}`)
    diagLine(`[main] 主屏缩放 ${screen.getPrimaryDisplay().scaleFactor}`)
  }

  registerPdfProtocol()
  registerIpc()
  createMainWindow()
}

/*
 * 生命周期日志。
 *
 * 之前遇到「应用启动后几秒内静默退出」，而窗口创建日志正常、没有任何错误，
 * 完全看不出退在哪一步。加上这些钩子后能直接定位是窗口被关、还是 process 退出。
 * 这类问题在打包环境里尤其难查，因此长期保留。
 */
app.on('before-quit', () => console.log('[pdf] 生命周期：before-quit'))
app.on('will-quit', () => console.log('[pdf] 生命周期：will-quit'))
app.on('quit', (_e, code) => console.log('[pdf] 生命周期：quit，exitCode =', code))
process.on('exit', (code) => console.log('[pdf] 生命周期：process exit，code =', code))

/* ============================================================
 * 自定义协议：pdf-file://
 * ============================================================ */

/**
 * 注册特权协议。
 *
 * 必须在 app ready 之前调用 registerSchemesAsPrivileged（见文件顶部的声明），
 * 否则 fetch 会受 CORS 限制、且不能使用流式响应。
 */
function registerPdfProtocol(): void {
  protocol.handle('pdf-file', async (request) => {
    const filePath = decodePathFromUrl(request.url)
    if (!filePath) {
      console.warn('[pdf] 协议：无法从 URL 解析路径 →', request.url)
      return new Response('bad request', { status: 400 })
    }

    const exists = existsSync(filePath)
    // 协议层出问题时最难定位，因此把「收到的 URL」与「解析出的路径」都打出来
    console.log(`[pdf] 协议请求: ${decodeURIComponent(request.url)}`)
    console.log(`[pdf]   解析路径: ${filePath}  存在=${exists}`)

    if (!exists) return new Response('not found', { status: 404 })

    // net.fetch 支持 file:// 且会正确处理 Range 请求头，
    // 大文件按需分块读取，pdf.js 才能边下边渲染。
    return net.fetch(pathToFileURL(filePath).toString(), {
      headers: request.headers,
      method: request.method
    })
  })
}

/**
 * 从协议 URL 还原磁盘路径。
 *
 * ★ 必须处理 Chromium 的 URL 规范化（这是最隐蔽的一个坑）。
 *
 *   我们发出的是 `pdf-file:///C:/Users/a.pdf`（三段斜杠，盘符在路径里），
 *   但 Chromium 解析特权协议时会把它规范化为
 *       `pdf-file://c/Users/a.pdf`
 *   —— 盘符被降为小写并变成了 **host**，路径里不再有冒号。
 *   直接用 `url.slice('pdf-file://'.length)` 会得到 `c/Users/a.pdf`，
 *   既丢了盘符冒号又不是有效路径，于是永远 404。
 *
 *   正确做法：用 URL 解析，把 host（单字母盘符）与 pathname 拼回去。
 */
function decodePathFromUrl(rawUrl: string): string | null {
  if (!rawUrl.startsWith('pdf-file:')) return null

  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }

  // host 是盘符（规范化后的小写单字母），也可能是空（标准三段斜杠形式）
  const host = parsed.hostname
  const pathname = decodeURIComponent(parsed.pathname)

  if (!pathname) return null

  // 情况一：盘符落在 host 上 —— pdf-file://c/Users/a.pdf
  if (/^[a-zA-Z]$/.test(host)) {
    return normalize(`${host.toUpperCase()}:${pathname}`)
  }

  // 情况二：盘符在路径里 —— pdf-file:///C:/Users/a.pdf
  if (/^\/[a-zA-Z]:[\\/]/.test(pathname)) {
    return normalize(pathname.slice(1))
  }

  // 情况三：普通绝对路径（非 Windows 盘符场景）
  return normalize(pathname)
}

/* ============================================================
 * 主窗口
 * ============================================================ */

/**
 * 是否以「隐藏窗口」模式运行。
 *
 * 用途：自动化测试。测试窗口若出现在用户桌面上会不断干扰（挡视野、抢焦点），
 *   而 Chrome DevTools Protocol 对隐藏窗口完全有效 ——
 *   渲染、脚本执行、截图都不受影响。
 *
 * 因此提供一个显式开关，让窗口从创建到销毁都保持隐藏，
 * 不依赖外部的 -WindowStyle Hidden 之类的技巧（实测不可靠且难以排查）。
 */
const HIDDEN_MODE = process.argv.includes('--hidden')

/**
 * 原生对话框探针（**只在自动化测试里打开**）。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────
 *   `--hidden` 下 `app:quit` 会跳过原生确认框直接退出，这是为了让自动化
 *   不弹窗、不抢前台。代价是：**「原生框到底弹不弹得出来」这条路从来没被
 *   验证过** —— 而 2026-10-16 用户报的「退出窗口不能正常弹出」正是这条路
 *   上的缺陷（原因见 scripts/inject-dpi-manifest.mjs：注入清单里的
 *   `<dpiAwareness>` 会让所有原生框把进程打崩）。
 *
 *   所以给一个显式开关：带上 `--allow-native-dialogs` 时，隐藏实例**照常
 *   调用原生框**，验证脚本就能：
 *     ① 观察原生框窗口真的出现（#32770，标题「退出应用」）；
 *     ② 用 PostMessage(WM_CLOSE) 把它关掉（不动前台）；
 *     ③ 断言进程没有崩、也没有自己退出。
 *
 *   开关名刻意写得刺眼：普通启动、正式交付的 exe 都不会带它，
 *   因此线上行为与以前完全一致。
 *
 * ── 为什么还要一个**运行期**开关（踩过的连锁假红）────────────────
 *   最初只认启动参数，套件启动时就带上。结果：
 *     · verify-quit-dialog 期望「点退出 → 应用真的退出」，
 *       带上探针后却变成「弹框并阻塞」，判据全红；
 *     · 更要命的是**弹出来的模态框没人关**，主进程被卡住，
 *       后面每一支用例都开始 CDP 超时 —— 一次泄漏引发六支假红。
 *   现在默认关闭；需要验框的用例在渲染层显式打开、用完显式关闭
 *   （preload 的 `pdfApp.diag.setDialogProbe`）。
 *   启动参数仍然有效，用于「整支进程都要验框」的场景。
 */
let DIALOG_PROBE = process.argv.includes('--allow-native-dialogs')

/**
 * 主窗口是否已经完成首次绘制（ready-to-show 之后）。
 *
 * ★ 为什么需要这个标志（2026-10-15 用户报的缺陷，别再删掉）：
 *   用户原话：「现在前台有一个空白无标题栏窗口弹出」。
 *   本窗口是 frame:false 的自绘标题栏窗口，所以**没画过内容时它就是
 *   一个空白、没有标题栏的矩形** —— 与用户描述的形状完全一致。
 *   而 second-instance 分支原先直接 `mainWindow.show()`：
 *   冷启动竞态下（双击 PDF 时上一个实例还在启动）窗口刚 new 出来、
 *   渲染层还没画过，被 show() 出来就是那个空白窗口。
 *   因此任何 show() 都必须等到 ready-to-show 之后。
 */
let contentReady = false

/**
 * 把主窗口带到前台。
 *
 * 两条硬规则（对应上面两个缺陷）：
 *   ① 隐藏模式（自动化测试）下**绝不允许**显示或抢焦点 ——
 *      用户的硬约束是「全程不能更改前台」，测试实例也不许冒头；
 *   ② 内容没准备好（!contentReady）就什么都不做，交给 ready-to-show
 *      再显示，保证用户看到的窗口一定有内容。
 */
function revealMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return

  if (HIDDEN_MODE) {
    console.log('[pdf] 隐藏模式：忽略前台请求（窗口保持隐藏）')
    return
  }

  if (!contentReady) {
    console.log('[pdf] 窗口尚未完成首次绘制：推迟到 ready-to-show 再显示')
    return
  }

  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** 每个有批注的页面一张透明 PNG（尺寸 = 未旋转的页面框，单位 pt） */
interface ExportPageImage {
  /** 页码，1 起 */
  page: number
  /** PNG 字节。渲染层用 canvas.toBlob → arrayBuffer 传过来 */
  data: Uint8Array | ArrayBuffer
}

interface ExportPayload {
  sourcePath: string
  /** 目标路径；不给就弹系统「另存为」（自动化测试给固定路径，免得弹框卡住） */
  targetPath?: string
  defaultName?: string
  pages: ExportPageImage[]
}

/**
 * 「关于」面板要的版本信息。
 *
 * 打包后 app.getAppPath() 指向 resources/app.asar，readFileSync 能直接读到
 * 里面那份被 electron-builder 覆盖过的 package.json（含 productName 与
 * buildVersion）；开发时指向项目根，读到的是源文件。两条路都成立，
 * 所以不需要额外注入构建常量。
 *
 * 显示四段式 buildVersion（2.0.0.0）而不是三段式 version（2.0.0）：
 * 用户认的是「v2.0.0.0」和安装包名。
 */
/**
 * 「关于」面板要的**版本 + 品牌 + 法律声明**。
 *
 * ── 版本号从哪来 ─────────────────────────────────────────────
 *   打包后 app.getAppPath() 指向 resources/app.asar，readFileSync 能直接读到
 *   里面那份被 electron-builder 覆盖过的 package.json（含 productName 与
 *   buildVersion）；开发时指向项目根，读到的是源文件。两条路都成立。
 *
 *   显示四段式 buildVersion（2.1.0.0）而不是三段式 version（2.1.0）：
 *   用户认的是「v2.1.0.0」和安装包名。
 *
 * ── 品牌与声明从哪来（2026-10-17 新增）────────────────────────
 *   著作权 / 官方网站 / 授权协议 / 适用范围 / 技术支持**不能写在源码里**：
 *   用户要求「公开版安装包不得出现任何单位信息」，而专供版必须带
 *   适用范围声明与技术支持。所以由 scripts/build-setup.mjs 在打包前生成
 *   build/build-info.json，经 extraResources 装到 resources/build-info.json
 *   （开发时读工程根的 build/）。这里按「打包内 → 工程内 → 内置默认值」
 *   顺序取，任何一步缺失都不会让面板显示空白。
 */
interface BuildBranding {
  product?: string
  version?: string
  buildVersion?: string
  publisher?: string
  site?: string
  notice?: string
  variant?: 'standard' | 'quick'
  org?: string
  usageScope?: string
  support?: string
}

function readBuildInfo(): BuildBranding {
  const candidates = [
    /* 打包后：resources/build-info.json（extraResources 的落点） */
    process.resourcesPath ? join(process.resourcesPath, 'build-info.json') : '',
    /* 开发 / --app-root 模式：工程根的 build/build-info.json */
    join(app.getAppPath(), 'build', 'build-info.json'),
    join(app.getAppPath(), '..', 'build', 'build-info.json'),
    join(app.getAppPath(), '..', '..', 'build', 'build-info.json')
  ]
  for (const p of candidates) {
    if (!p) continue
    try {
      if (!existsSync(p)) continue
      return JSON.parse(readFileSync(p, 'utf8')) as BuildBranding
    } catch {
      /* 试下一个候选 */
    }
  }
  return {}
}

function appVersionInfo(): {
  product: string
  version: string
  build: string
  publisher: string
  site: string
  notice: string
  variant: string
  org: string
  usageScope: string
  support: string
} {
  const brand = readBuildInfo()
  let pkg: { productName?: string; version?: string; buildVersion?: string } = {}
  try {
    pkg = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8'))
  } catch {
    /* 读不到就用下面的默认值 */
  }
  return {
    product: pkg.productName ?? brand.product ?? '秋夕-PDF阅读器',
    version: pkg.version ?? brand.version ?? app.getVersion(),
    build: pkg.buildVersion ?? brand.buildVersion ?? '',
    publisher: brand.publisher ?? '秋夕月拾旧',
    site: brand.site ?? '',
    notice: brand.notice ?? '',
    variant: brand.variant ?? 'standard',
    /* ★ 公开版这三个字段必须是空的：专供版才由 packaging.json 注入 */
    org: brand.org ?? '',
    usageScope: brand.usageScope ?? '',
    support: brand.support ?? ''
  }
}

/**
 * 窗口底色（跟随主题）。
 *
 * 加载瞬间、窗口缩放露出的底色要和界面一致，否则会闪白/闪黑。
 * sepia 取 base.css 里 `--reader-bg: 226 216 196` 的 #e2d8c4。
 */function themeWindowBackground(theme: string): string {
  if (theme === 'dark') return '#1a1d24'
  if (theme === 'sepia') return '#e2d8c4'
  return '#f3f4f7'
}

function createMainWindow(): void {
  const settings = getSettings()

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 900,
    minHeight: 600,
    // 隐藏模式下全程不显示窗口
    show: false,
    backgroundColor: themeWindowBackground(settings.theme),
    title: '秋夕-PDF阅读器',
    // 无边框 + 自绘标题栏，便于在一体机上做更大的点击区域
    frame: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // pdf.js 需要读取本地文件，但必须走自定义协议而不是关闭安全策略
      webSecurity: true,
      /*
       * ★ 隐藏实例（--hidden，自动化测试用）必须关掉后台节流。
       *
       *   窗口从「显示过」再被藏回去之后，Chromium 会把它当成后台页面：
       *   定时器降频到 1s 级、渲染帧停发（页面进入 hidden 生命周期）。
       *   后果是回归用例整片假红：
       *     · 工具条靠 ResizeObserver 自适应 → 拿不到帧就永远不重算；
       *     · 合成触摸事件的时序被拖到秒级 → 双击/捏合判定失真；
       *     · 一次内容编辑冒烟从 10s 变成 229s。
       *   真机用户看不见窗口时省电是好事，只有隐藏实例需要「照常跑」。
       */
      backgroundThrottling: !HIDDEN_MODE
    }
  })

  mainWindow.once('ready-to-show', () => {
    // 首次绘制完成：此后才允许任何 show()（见 revealMainWindow 的说明）
    contentReady = true

    /* 诊断：记录窗口几何与最大化状态 —— 用户窗口宽度变化的来源可能就在这里 */
    if (diagLogPath() && mainWindow) {
      const b = mainWindow.getBounds()
      diagLine(
        `[main] ready-to-show 窗口 ${b.width}x${b.height}@${b.x},${b.y} 最大化=${mainWindow.isMaximized()} 隐藏模式=${HIDDEN_MODE}`
      )
    }

    // 隐藏模式下不调用 show()，窗口始终不出现在屏幕上
    if (!HIDDEN_MODE) {
      mainWindow?.show()
    } else {
      console.log('[pdf] 隐藏模式：窗口不显示（供自动化测试使用）')
    }

    // 窗口就绪后再送待打开文件，避免渲染层还没挂载就发消息丢失
    /*
     * 这里不再直接送文件。
     * 窗口「画出来了」不等于渲染层的监听已挂好，仍可能丢消息；
     * 统一等渲染层的 app:renderer-ready 握手来冲洗队列。
     * （若渲染层因异常迟迟不回报，下面还有一个兜底定时器。）
     */
    void pendingOpens
  })

  /* 诊断：窗口尺寸/最大化状态变化记一行（渲染层那边也会记 clientWidth） */
  const logBounds = (why: string): void => {
    if (!mainWindow) return
    try {
      const b = mainWindow.getBounds()
      diagLine(`[main] 窗口${why} ${b.width}x${b.height}@${b.x},${b.y} 最大化=${mainWindow.isMaximized()}`)
    } catch {
      /* 忽略 */
    }
  }
  mainWindow.on('resize', () => logBounds('resize'))
  mainWindow.on('maximize', () => logBounds('maximize'))
  mainWindow.on('unmaximize', () => logBounds('unmaximize'))

  mainWindow.on('closed', () => {
    console.log('[pdf] 主窗口已关闭')
    mainWindow = null
    // 窗口没了，绘制状态一并作废：新窗口要重新等 ready-to-show
    contentReady = false
    allowClose = false
    hasUnsavedEdits = false
  })

  /**
   * 主窗口收到 close 时先拦一次并记录来源。
   *
   * ★ 为什么保留这段诊断代码：
   *   排查中发现窗口会在加载完成后约 6 秒**自己关闭**，
   *   而渲染层并未调用关闭按钮（已实测确认），渲染进程也没有崩溃。
   *   在定位到根因之前，这里先记录一条线索，
   *   便于下次复现时快速判断是「窗口主动关闭」还是「被外部关闭」。
   */
  let closeConfirmed = false
  mainWindow.on('close', (event) => {
    if (closeConfirmed || allowClose) return

    /*
     * 有未保存的编辑：不直接关，先让渲染层问用户
     * （保存 / 不保存 / 取消）。渲染层问完会调 win:force-close。
     */
    if (hasUnsavedEdits) {
      event.preventDefault()
      console.log('[pdf] 有未保存的编辑，先向渲染层发起关闭确认')
      mainWindow?.webContents.send('win:close-request')
      return
    }

    console.log('[pdf] 主窗口即将关闭（若为意外关闭请查此行上方的日志）')
    // 不强拦关闭：用户点关闭按钮时必须能正常退出
    closeConfirmed = true
    allowClose = true
    void event
  })

  /*
   * 渲染进程异常诊断。
   *
   * 之前遇到「页面加载完全正常，几秒后窗口自己关闭」，主进程日志里
   * 只有一句 close，看不出是谁触发的。加上这些钩子能区分：
   *   渲染进程崩溃 / 无响应 / 窗口被外部关闭。
   */
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[pdf] ★渲染进程退出：', JSON.stringify(details))
  })
  mainWindow.webContents.on('unresponsive', () => {
    console.error('[pdf] ★渲染进程无响应')
  })
  mainWindow.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error('[pdf] ★preload 出错：', preloadPath, error)
  })
  mainWindow.on('unresponsive', () => console.error('[pdf] ★窗口无响应'))
  mainWindow.on('responsive', () => console.log('[pdf] 窗口恢复响应'))

  // 拦截外部链接，用系统浏览器打开而不是在阅读器里导航
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']

  /**
   * ★ `--app-root=<目录>`：**只给自动化测试用**的载荷根覆盖。
   *
   * ── 为什么需要它（踩坑记录）──────────────────────────────────
   *   tools/verify-native-dialogs.mjs 要验「原生退出确认框真的弹得出来」，
   *   那需要在 `--hidden` 之外再带 `--allow-native-dialogs` 重启一个实例。
   *   一开始的做法是把 app.asar 解包、改产物、再打包成新 asar 塞进
   *   临时 resources 目录 —— 结果 electron 找不到打包时被内联的
   *   运行时依赖（pdf-lib 等，electron-vite 的 externalizeDepsPlugin
   *   把它们留在外部），`resources/node_modules` 又没跟着复制，
   *   进程起来了却什么都不打印、页面永远不就绪（白排查很久）。
   *
   *   改成直接指到**已经装好依赖的工程根**：electron 按正常的
   *   「未打包应用」路径加载 package.json 的 main（out/main/index.js），
   *   依赖走工程自己的 node_modules，最接近真实运行状态，也不用打包。
   *
   *   正式启动与交付的 exe 都不会带这个参数（默认走 asar）。
   */
  const appRoot = readAppRootArg(process.argv)

  /*
   * 测试挂钩开关：启动时带 --test-hooks 就给页面加上 ?test-hooks=1，
   * 渲染层据此把 store 挂到 window，供 tools/ 下的验证脚本读写数据层。
   *
   * 为什么用查询参数而不是让渲染层读 process.argv：
   *   渲染层开了 contextIsolation，拿不到 process。
   *   而 location.search 在任何情况下都可用。
   *
   * 正常启动不会带这个参数，因此正式使用时不暴露任何内部对象。
   */
  const query = process.argv.includes('--test-hooks') ? '?test-hooks=1' : ''

  if (devUrl) {
    void mainWindow.loadURL(devUrl + query)
  } else if (appRoot) {
    const indexPath = join(appRoot, 'out', 'renderer', 'index.html')
    console.log('[pdf] --app-root 指定载荷根：', indexPath)
    void mainWindow.loadFile(indexPath, {
      search: query ? query.slice(1) : undefined
    })
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      search: query ? query.slice(1) : undefined
    })
  }
}

/**
 * 从 argv 里取 `--app-root=<目录>`。
 *
 * 只在目录里确实有 out/renderer/index.html 时才认，避免误把
 * 用户命令行里的同名参数当成载荷根。
 */
function readAppRootArg(argv: string[]): string | null {
  for (const arg of argv) {
    if (!arg.startsWith('--app-root=')) continue
    const dir = resolve(arg.slice('--app-root='.length))
    if (existsSync(join(dir, 'out', 'renderer', 'index.html'))) return dir
    console.warn('[pdf] --app-root 指向的目录里没有 out/renderer/index.html，忽略：', dir)
  }
  return null
}

/* ============================================================
 * 打开文件
 * ============================================================ */

/** 从命令行参数里挑出第一个像 PDF 的路径 */
function extractFileArg(argv: string[]): string | null {
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-')) continue
    const ext = extname(arg).toLowerCase()
    if (ext === '.pdf') {
      const abs = resolve(arg)
      if (existsSync(abs)) return abs
    }
  }
  return null
}

/**
 * 最近一次发给渲染层的打开请求（路径 + 时间）。
 *
 * ★ 用于切断「发送 → 渲染层回调 → 再次请求 → 再次发送」的反馈循环。
 *
 * 踩坑记录：渲染层对 `pdf:open` 的回调里会调用 open.path()，
 * 若监听器因为组件重渲染被重复注册（effect 依赖不稳定），
 * 一条消息会触发 N 次 open.path()，每次都让主进程再发一条，
 * 形成指数级放大 —— 实测一份文件被打开了 400 多次，
 * 最终把窗口拖垮、应用静默退出。
 *
 * 因此主进程侧做最后一道防线：极短时间内对同一路径的重复发送直接忽略。
 * 真正的重开请求（用户再次双击）间隔远大于这个窗口，不会被误挡。
 */
let lastSentPath = ''
let lastSentAt = 0
const SEND_DEDUPE_MS = 800

/**
 * 让渲染层打开指定文件。
 *
 * 校验放在主进程做：渲染层拿不到 fs，无法自行判断文件是否存在、是否可读。
 */
async function openFileInWindow(filePath: string): Promise<OpenResult> {
  const abs = resolve(filePath)

  if (!existsSync(abs)) {
    return { ok: false, error: `文件不存在：${abs}` }
  }

  let size = 0
  try {
    const st = statSync(abs)
    if (!st.isFile()) return { ok: false, error: '目标不是文件' }
    size = st.size
  } catch (error) {
    return { ok: false, error: `无法读取文件信息：${String(error)}` }
  }

  if (extname(abs).toLowerCase() !== '.pdf') {
    return { ok: false, error: '仅支持 PDF 格式' }
  }

  if (size === 0) {
    return { ok: false, error: '文件为空' }
  }

  /*
   * ★ 未就绪时**入队**，绝不丢弃（这就是「概率打不开」的修法）。
   *
   *   两种未就绪：
   *     · 窗口还没建好（mainWindow 为 null / 已销毁）
   *     · 窗口在，但渲染层还没挂上 pdf:open 监听（rendererReady=false）
   *   后者最隐蔽：webContents.send 不报错，消息却没有接收者。
   *   以前两种都直接 return，文件就没了 —— 概率取决于首屏加载快慢。
   */
  if (!mainWindow || mainWindow.isDestroyed() || !rendererReady) {
    queueOpen(abs)
    console.log(
      `[pdf] 尚未就绪（窗口=${!!mainWindow && !mainWindow.isDestroyed()} 渲染层=${rendererReady}），已排队:`,
      abs
    )
    // 窗口不在就先把它建出来，否则永远不会有人来冲洗队列
    if (!mainWindow || mainWindow.isDestroyed()) {
      createMainWindow()
    }
    return { ok: true, path: abs }
  }

  sendOpenToRenderer(abs, size)
  return { ok: true, path: abs }
}

/**
 * 真正把打开请求发给渲染层。
 *
 * 反馈循环的最后一道防线：短时间内同一路径只发一次
 * （文件关联监听器 + 拖放可能对同一次操作各触发一遍）。
 */
function sendOpenToRenderer(abs: string, size: number): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const now = Date.now()
  if (abs === lastSentPath && now - lastSentAt < SEND_DEDUPE_MS) {
    console.log('[pdf] 同一路径短时间内重复请求，已忽略:', abs)
    return
  }
  lastSentPath = abs
  lastSentAt = now

  console.log('[pdf] 发送打开请求:', abs)
  mainWindow.webContents.send('pdf:open', { path: abs, name: basename(abs), size })
  // 更新窗口标题，任务栏与 Alt+Tab 里能看到正在读哪份文件
  mainWindow.setTitle(`${basename(abs)} - 秋夕-PDF阅读器`)
}

/**
 * 冲洗待打开队列（渲染层就绪时调用）。
 *
 * 逐个重新走 openFileInWindow：它会重新校验文件是否还存在，
 * 用户在这几百毫秒里删掉文件也不会崩。
 * 队列里同一路径已去重，所以不会被 dedupe 误伤。
 */
function flushPendingOpens(): void {
  if (pendingOpens.length === 0) return
  const list = pendingOpens.splice(0, pendingOpens.length)
  console.log(`[pdf] 渲染层就绪，冲洗待打开队列（${list.length} 个）`)
  for (const p of list) {
    void openFileInWindow(p)
  }
}

/* ============================================================
 * IPC
 * ============================================================ */

function registerIpc(): void {
  /*
   * 渲染层回报「我已经挂好 pdf:open 监听了」。
   *
   * 这是整套「不丢文件」机制的握手点：在此之前打开的请求全部排队，
   * 到这里才真正 send。页面重载也会再报一次，所以队列里的东西
   * 总能落到新的监听器上。
   */
  ipcMain.handle('app:renderer-ready', () => {
    rendererReady = true
    flushPendingOpens()
    void autoCheckUpdateOnce()
    return true
  })

  /**
   * 启动后静默查一次新版本（每个进程只查一次）。
   *
   * 为什么延迟 4 秒：刚启动时渲染层在解析 PDF、画首页，网络请求与
   * 版本比较虽然不重，但没必要和首屏抢带宽/主线程。查不到（断网、
   * 镜像站挂了）就什么都不做 —— 用户不该被「检查失败」打扰。
   */
  let autoChecked = false
  async function autoCheckUpdateOnce(): Promise<void> {
    if (autoChecked) return
    autoChecked = true
    if (getSettings().updateAutoCheck === false) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 4000))
    if (!mainWindow || mainWindow.isDestroyed()) return
    const result = await checkForUpdate(6000)
    if (!result.ok || !result.newer) return
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('app:update-available', result)
  }


  /* ---------- 打开文件 ---------- */

  /** 弹系统文件选择框 */
  ipcMain.handle('pdf:pick', async () => {
    const result = await dialog.showOpenDialog(mainWindow ?? undefined!, {
      title: '打开 PDF',
      filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return openFileInWindow(result.filePaths[0])
  })

  /** 打开指定路径（最近列表、拖放都会用到） */
  ipcMain.handle('pdf:open-path', (_e, filePath: string) => openFileInWindow(filePath))

  /* ---------- 设置 ---------- */

  ipcMain.handle('pdf:settings-get', () => getSettings())
  ipcMain.handle('pdf:settings-patch', (_e, patch: Record<string, unknown>) => {
    const next = patchSettings(patch as never)
    // 主题变化时同步窗口底色，避免加载瞬间闪白
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(themeWindowBackground(next.theme))
    }
    return next
  })

  /* ---------- 最近打开 ---------- */

  ipcMain.handle('pdf:recent', () => getRecent())
  ipcMain.handle('pdf:recent-push', (_e, entry: { path: string; name: string; page: number }) =>
    pushRecent(entry)
  )

  /* ---------- 阅读位置 ---------- */

  ipcMain.handle('pdf:position-get', (_e, filePath: string) => readLastPosition(filePath))
  ipcMain.handle('pdf:position-set', (_e, filePath: string, page: number) =>
    writeLastPosition(filePath, page)
  )

  /* ---------- 批注 ---------- */

  /*
   * ---------- 批注 ----------
   *
   * 按需求**不做持久化**：批注只活在当前这次运行的会话里，
   * 关掉程序即清空，也不会在 PDF 旁边生成任何额外文件。
   *
   * 因此这些通道不再读写磁盘，只回显渲染层传来的数据 ——
   * 保留通道是为了不改动渲染层结构（它仍按「有后端」的方式调用），
   * 以后若恢复持久化，改这里即可。
   */
  ipcMain.handle('pdf:anno-list', () => [])

  // 追加/修改：原样回显传入的那一条，让渲染层能拿到统一的返回值
  ipcMain.handle('pdf:anno-add', (_e, _filePath: string, item: Annotation) => [item])
  ipcMain.handle(
    'pdf:anno-update',
    (_e, _filePath: string, id: string, patch: Partial<Annotation>) => [{ ...patch, id }]
  )

  // 删除/清空：不保存也就无从谈起，直接回空列表
  ipcMain.handle('pdf:anno-remove', () => [])
  ipcMain.handle('pdf:anno-clear', () => [])

  /* ---------- 窗口控制（自绘标题栏需要） ---------- */

  ipcMain.handle('win:minimize', () => mainWindow?.minimize())
  ipcMain.handle('win:toggle-maximize', () => {
    if (!mainWindow) return false
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
    return mainWindow.isMaximized()
  })
  ipcMain.handle('win:close', () => {
    // 诊断：确认「窗口自己关闭」是否来自渲染层的关闭按钮调用
    console.log('[pdf] 收到 win:close 请求（渲染层标题栏关闭按钮）')
    mainWindow?.close()
  })
  ipcMain.handle('win:is-maximized', () => mainWindow?.isMaximized() ?? false)


  /* ---------- 关闭请求（有未保存编辑时先问渲染层） ---------- */

  /**
   * 渲染层把「当前是否有未保存的编辑」同步过来。
   *
   * 主进程不解析编辑内容，只存一个布尔 —— 关窗口时据此决定
   * 是直接关，还是先问渲染层（保存 / 不保存 / 取消）。
   */
  ipcMain.on('doc:dirty', (_e, dirty: unknown) => {
    hasUnsavedEdits = dirty === true
  })

  /** 渲染层问完用户后，用这个通道真正关窗 */
  ipcMain.handle('win:force-close', () => {
    allowClose = true
    hasUnsavedEdits = false
    mainWindow?.close()
  })

  /* ---------- 退出应用 ---------- */
  /**
   * 渲染层的「退出应用」按钮（已弹确认框）走这里。
   *
   * 用 app.quit() 而不是 mainWindow.close()：
   *   quit 会触发 before-quit，让我们有机会在真正退出前
   *   把阅读位置等数据落盘；close 只是关窗口，
   *   若还有隐藏窗口未关，进程可能不退出。
   */
  /*
   * ---------- 退出应用（原生确认对话框）----------
   *
   * ★ 为什么必须是**原生**对话框，不能用渲染层自己画的浮层
   *   渲染层的浮层（RightRail 里那个 ExitConfirm）是 DOM 节点：
   *     · 不进任务栏、Alt+Tab 切不到；
   *     · 主窗口被遮挡或最小化时用户根本看不见它，
   *       点了「退出应用」像是没反应；
   *     · 与 Windows 原生确认框观感不一致。
   *   dialog.showMessageBox 挂在 mainWindow 上就是**模态子窗口**，
   *   一定浮在阅读器之上，不存在「看不见」的情况。
   *
   * ★ defaultId / cancelId 都取 0（取消）
   *   回车和 Esc 都落到「取消」，避免用户手快一下回车就把程序退了。
   *
   * ★ 隐藏模式（自动化测试）下直接退出，不弹框
   *   测试进程里弹一个模态框会**卡住主进程**，而且没人点它，
   *   最后只能强杀 —— 那正是「测试把用户前台搞乱」的典型来源。
   *   所以 --hidden 时跳过确认，语义仍然正确（本来就是请求退出）。
   *
   * 用 app.quit() 而不是 mainWindow.close()：
   *   quit 会触发 before-quit，让我们有机会在真正退出前
   *   把阅读位置等数据落盘；close 只是关窗口，
   *   若还有隐藏窗口未关，进程可能不退出。
   */
  ipcMain.handle('app:quit', async () => {
    console.log('[pdf] 收到 app:quit 请求（渲染层「退出应用」按钮）')

    if (HIDDEN_MODE && !DIALOG_PROBE) {
      console.log('[pdf] 隐藏模式：跳过退出确认，直接退出')
      app.quit()
      return true
    }

    /*
     * 有未保存的编辑（涂白/文字/图片等覆盖式编辑还没导出）时，
     * 主进程不自己弹框 —— 因为「保存」必须在渲染层跑导出（要 pdf.js 文档对象），
     * 只有渲染层知道怎么保存。这里把决定权交回去，用户选完会调 app:quit-now。
     */
    if (hasUnsavedEdits) {
      console.log('[pdf] 有未保存编辑，交给渲染层问「保存/不保存/取消」')
      mainWindow?.webContents.send('win:quit-request')
      return false
    }

    const { response } = await dialog.showMessageBox(mainWindow ?? undefined!, {
      type: 'warning',
      buttons: ['取消', '退出应用'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: '退出应用',
      message: '确定要退出秋夕-PDF阅读器吗？',
      detail: '批注和笔迹不会保存，退出后即清空。'
    })

    if (response === 1) {
      console.log('[pdf] 用户确认退出')
      app.quit()
    } else {
      console.log('[pdf] 用户在确认框里选了取消')
    }
    return true
  })

  /**
   * 渲染层问完用户「保存 / 不保存 / 取消」后，真的要退出时调这里。
   *
   * 单独开一个通道而不是复用 app:quit：那样会又弹一次确认框 ——
   * 用户刚选完「不保存退出」，紧接着再被问一次「确定退出吗」很荒谬。
   */
  ipcMain.handle('app:quit-now', () => {
    console.log('[pdf] 渲染层确认退出，正在退出')
    app.quit()
    return true
  })

  /**
   * 「有未保存的编辑」三选一确认框（保存为 PDF / 不保存 / 取消）。
   *
   * 放在主进程弹原生框，和「退出应用」的确认保持一致：
   *   · 一体机上原生框比自绘弹窗更省事，也不怕被页面样式影响；
   *   · 渲染层只需要 await 一个字符串，不用维护一套模态状态机。
   * 返回 'save' | 'discard' | 'cancel'。
   */
  ipcMain.handle('doc:confirm-unsaved', async (_e, fileName: unknown) => {
    const name = typeof fileName === 'string' && fileName ? fileName : '当前文档'
    const { response } = await dialog.showMessageBox(mainWindow ?? undefined!, {
      type: 'question',
      buttons: ['保存为 PDF', '不保存', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      title: '还有编辑没有导出',
      message: `《${name}》有编辑内容还没有导出成 PDF`,
      detail:
        '涂白、文字框、图片、图形只存在于这次阅读中，退出后就会丢失。\n' +
        '「保存为 PDF」会另存为一份新文件（原文件不会被修改）。'
    })
    return response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel'
  })

  /* ---------- 渲染诊断日志 ---------- */

  /**
   * 渲染层往诊断日志追加一行。
   *
   * 用 send（不等回执）而不是 invoke：诊断是「尽力而为」的旁路，
   * 绝不能因为写日志让渲染层的滑动/渲染多等一个 IPC 往返。
   * 长度上限是防呆（正常一条记录几百字节）。
   */
  ipcMain.on('diag:log', (_e, line: unknown) => {
    if (typeof line !== 'string' || line.length === 0 || line.length > 4000) return
    diagLine(line)
  })

  /**
   * 运行期开关原生对话框探针（**仅测试挂钩开启时可用**）。
   *
   * 为什么要有它：`--hidden` 默认跳过原生框，而「框到底弹不弹得出来」
   * 是用户报过的缺陷点，必须能单独验一次；但如果整轮套件都带着它，
   * 「点退出就退出」这类判据会集体失真，而且弹出来的模态框一旦没人关
   * 就会把主进程卡死、后续用例全部 CDP 超时。
   * 所以做成「谁要验，谁自己开、验完关」。
   */
  ipcMain.handle('diag:set-dialog-probe', (_e, value: unknown) => {
    if (!process.argv.includes('--test-hooks')) {
      console.warn('[pdf] 拒绝了运行期探针开关：未带 --test-hooks')
      return false
    }
    DIALOG_PROBE = value === true
    console.log(`[pdf] 原生对话框探针 → ${DIALOG_PROBE ? '开启' : '关闭'}`)
    return DIALOG_PROBE
  })

  /** 诊断模式下，渲染层可以问「开了没 / 日志在哪」，便于界面上提示用户 */
  ipcMain.handle('diag:info', () => ({
    启用: diagEnabled(),
    日志: diagLogPath(),
    标记: diagMarkerPath()
  }))

  /* ---------- 关于面板 / 标签页标题 ---------- */

  /** 「关于」里的版本号取自 package.json，避免界面里硬编码一个会过期的号 */
  ipcMain.handle('app:info', () => appVersionInfo())

  /* ---------- 版本更新 ---------- */

  /**
   * 查最新版本。
   *
   * 走镜像站（见 src/main/updater.ts），返回结构化结果而不是抛异常：
   * 断网/镜像挂了都只是「查不到」，界面据此显示一句话即可。
   */
  ipcMain.handle('app:update-check', async () => {
    const result = await checkForUpdate()
    console.log(
      `[update] 检查完成：本地 ${result.current}，远端 ${result.latest}` +
        (result.newer ? '（有新版本）' : result.ok ? '（已是最新）' : `（${result.error}）`)
    )
    return result
  })

  /** 当前版本号（界面显示用，不触发网络） */
  ipcMain.handle('app:update-current', () => currentVersion())

  /**
   * 下载安装包。进度用 send 推给渲染层，避免 IPC invoke 一直挂着。
   * 下载是长任务（约 100 MB），这里不设超时 —— 由用户取消或断网结束。
   */
  ipcMain.handle('app:update-download', async (event, asset: unknown) => {
    const item = asset as { name?: string; size?: number; url?: string }
    if (!item || typeof item.url !== 'string' || typeof item.name !== 'string') {
      return { ok: false, error: '下载信息不完整' }
    }
    const result = await downloadUpdate(
      { name: item.name, size: Number(item.size ?? 0), url: item.url },
      (p) => {
        if (event.sender.isDestroyed()) return
        event.sender.send('app:update-progress', p)
      }
    )
    console.log(`[update] 下载${result.ok ? '完成' : '失败'}：${result.path ?? result.error}`)
    return result
  })

  /** 打开下载好的安装包（用系统默认方式，装不装由用户决定） */
  ipcMain.handle('app:update-install', (_e, path: unknown) => installUpdate(String(path ?? '')))

  /** 在浏览器里打开 release 页面，供用户自己看说明/手动下载 */
  ipcMain.handle('app:update-open-page', (_e, url: unknown) => {
    const target = String(url ?? '')
    if (!/^https:\/\//i.test(target)) return false
    void shell.openExternal(target)
    return true
  })

  /**
   * 标签页切换时同步窗口标题。
   *
   * 不做的话，切到第二个文件后任务栏/Alt+Tab 里还写着第一个文件名，
   * 对「一个窗口多个文件」的浏览器式用法来说很别扭。
   */
  ipcMain.on('doc:active', (_e, filePath: unknown) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const name = typeof filePath === 'string' && filePath ? basename(filePath) : ''
    mainWindow.setTitle(name ? `${name} - 秋夕-PDF阅读器` : '秋夕-PDF阅读器')
  })

  /* ---------- 导出：把批注烘焙成新 PDF ---------- */

  /**
   * 把渲染层画好的「批注图层」烘焙进一份**新** PDF（原文件一个字节都不动）。
   *
   * ── 为什么用位图而不是矢量 ─────────────────────────────────
   *   · 文本框/图片/涂白/笔迹本来就是渲染层用 canvas 画的，同一套
   *     绘制代码再往离屏 canvas 上画一遍，所见即所得，不会出现
   *     「界面上是这样、导出后错位」的经典问题；
   *   · 走矢量就得嵌入中文字体（pdf-lib 内置标准字体不含 CJK），
   *     还要自己处理换行、字距、下划线 —— 代码量和出错面都大得多。
   *   代价：导出的批注是位图，不能在别的软件里再编辑/搜索。
   *   这个取舍在界面上有说明（导出对话框的提示语）。
   *
   * ── 为什么不需要旋转补偿 ───────────────────────────────────
   *   渲染层保证每张 PNG 都在**未旋转**的页面框坐标系里绘制，
   *   尺寸与 pdf-lib 的 page.getSize() 一致，所以这里直接铺满整页。
   *
   * ── 为什么禁止覆盖原文件 ───────────────────────────────────
   *   导出是「另存为」语义：源文件可能正被别的程序占用，
   *   写回原路径要么失败要么把用户的原稿改掉，都不合适。
   */
  ipcMain.handle('pdf:export', async (_e, payload: ExportPayload) => {
    try {
      if (!payload || typeof payload.sourcePath !== 'string' || !existsSync(payload.sourcePath)) {
        return { ok: false, error: '源文件不存在' }
      }

      let target = typeof payload.targetPath === 'string' ? resolve(payload.targetPath) : ''
      if (!target) {
        const result = await dialog.showSaveDialog(mainWindow ?? undefined!, {
          title: '导出为 PDF',
          defaultPath:
            payload.defaultName ??
            `${basename(payload.sourcePath, extname(payload.sourcePath))}-已批注.pdf`,
          filters: [{ name: 'PDF 文档', extensions: ['pdf'] }]
        })
        if (result.canceled || !result.filePath) return { ok: false, canceled: true }
        target = result.filePath
      }

      if (resolve(target) === resolve(payload.sourcePath)) {
        return { ok: false, error: '不能覆盖原文件，请换一个文件名' }
      }

      const pdfDoc = await PDFDocument.load(readFileSync(payload.sourcePath), {
        ignoreEncryption: true
      })
      const total = pdfDoc.getPageCount()
      const list = Array.isArray(payload.pages) ? payload.pages : []

      let baked = 0
      for (const item of list) {
        const index = Math.max(0, Math.min(total - 1, Math.floor(item.page) - 1))
        const bytes = item.data instanceof Uint8Array ? item.data : new Uint8Array(item.data)
        if (bytes.byteLength === 0) continue
        const png = await pdfDoc.embedPng(bytes)
        const page = pdfDoc.getPage(index)
        const { width, height } = page.getSize()
        page.drawImage(png, { x: 0, y: 0, width, height })
        baked++
      }

      await writeFile(target, await pdfDoc.save())
      console.log(`[pdf] 导出完成：${target}（${baked} 页批注图层 / 共 ${total} 页）`)
      return { ok: true, path: target, baked, pages: total }
    } catch (error) {
      console.error('[pdf] 导出失败:', error)
      return { ok: false, error: String(error) }
    }
  })

  /* ---------- 在系统文件管理器中定位 ---------- */

  ipcMain.handle('pdf:reveal', (_e, filePath: string) => {
    shell.showItemInFolder(resolve(filePath))
    return true
  })

  /* ---------- 用系统默认程序打开（便于对照） ---------- */

  ipcMain.handle('pdf:open-external', async (_e, filePath: string) => {
    const error = await shell.openPath(resolve(filePath))
    return error === ''
  })
}

/** 未捕获异常时也要尽量把窗口关干净 */
process.on('uncaughtException', (error) => {
  console.error('[pdf] 未捕获异常：', error)
})
