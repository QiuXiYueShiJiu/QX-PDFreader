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

import { app, BrowserWindow, dialog, ipcMain, nativeImage, net, protocol, screen, shell } from 'electron'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, normalize, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PDFDocument, rgb as pdfRgb } from 'pdf-lib'
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
import { registerPdfAdvancedIpc } from './pdf-advanced'
import { registerPdfToolsIpc } from './pdf-tools'
import { isThumbFresh, saveThumb, thumbPath } from './thumbs'
import { ensureShellThumb } from './shell-thumb'

/* 关联的图片格式：打开时先转一页 PDF，之后缩放/批注/OCR 都能用 */
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']

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
 * ★ 缩略图模式（`--render-thumb <pdf> [<out.png>]`）。
 *
 * ── 为什么要有它 ──────────────────────────────────────────────
 *   资源管理器要显示 PDF 缩略图，必须有一个注册到 shell 的 COM 提供器
 *   （IThumbnailProvider）。而渲染 PDF 是本程序的事（pdf.js），C# 这侧不重复造轮子：
 *   提供器只做三件事 —— 查缓存、唤起本程序渲染一页、把 PNG 交回 explorer。
 *
 * ── 为什么是「唤起一次进程」而不是常驻服务 ──────────────────────
 *   常驻服务要处理开机自启、崩溃重连、多用户会话、升级替换 —— 成本远高于收益。
 *   缩略图只在用户浏览文件夹时按需请求，而且第一次渲染后就命中缓存，
 *   所以「按需起一个隐藏进程、渲完就退」在实际使用里几乎无感。
 *   提供器侧用全局互斥串行化，避免一屏 30 个 PDF 同时起 30 个 Electron。
 */
const THUMB_FLAG = '--render-thumb'
const thumbArgIndex = process.argv.indexOf(THUMB_FLAG)
const THUMB_MODE = thumbArgIndex > 0
const THUMB_SOURCE = THUMB_MODE ? resolve(process.argv[thumbArgIndex + 1] ?? '') : ''
const THUMB_TARGET = THUMB_MODE
  ? resolve(process.argv[thumbArgIndex + 2] ?? thumbPath(THUMB_SOURCE))
  : ''

/** 缩略图模式下一次渲染的超时（毫秒）：超时就交白卷，让 explorer 落回图标 */
const THUMB_TIMEOUT_MS = 20000

/** 渲染层把 dataURL 送回来的「等待者」；thumb 模式下只会有一次 */
let thumbResolve: ((dataUrl: string | null) => void) | null = null

/**
 * 单实例锁。
 *
 * 文件关联双击 PDF 时，Windows 会再启动一次本程序并带上文件路径。
 * 若开两个实例，阅读位置与最近列表会互相覆盖，因此第二个实例
 * 直接把文件转交给已有实例处理，然后退出。
 *
 * ★ 缩略图模式例外：它由 shell 缩略图提供器唤起，**不建可见窗口、不碰设置**，
 *   而且经常发生在主窗口开着的时候 —— 一旦走锁，argv 会被转发给已有实例
 *   然后本进程直接退出（缩略图永远渲不出来），所以这里必须跳过锁。
 */
const gotLock = THUMB_MODE ? true : app.requestSingleInstanceLock()

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

  /* 资源管理器缩略图注册：幂等、免管理员、失败不影响启动 */
  void ensureShellThumb()

  /* 缩略图模式不建主窗口：只需要一个隐藏的离屏窗口渲一页就退出 */
  if (THUMB_MODE) {
    await runThumbMode()
    return
  }

  createMainWindow()
}

/**
 * `--render-thumb` 的完整流程：建隐藏窗口 → 等渲染层要任务 → 拿到 dataURL → 写 PNG → 退出。
 *
 * 退出码约定（供 C# 提供器判断）：
 *   0 = 已写出缩略图
 *   1 = 渲染失败/超时（提供器落回图标，不重试爆炸）
 *   2 = 源文件不存在
 */
async function runThumbMode(): Promise<void> {
  if (!existsSync(THUMB_SOURCE)) {
    console.warn('[thumb] 源文件不存在：', THUMB_SOURCE)
    app.exit(2)
    return
  }

  console.log('[thumb] 渲染缩略图：', THUMB_SOURCE, '→', THUMB_TARGET)

  const win = new BrowserWindow({
    show: false,
    width: 960,
    height: 1200,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // 隐藏窗口会被 Chromium 降频，关掉才能保证 rAF/定时器正常跑完一帧
      backgroundThrottling: false
    }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  const done = new Promise<string | null>((resolveDone) => {
    thumbResolve = resolveDone
    const timer = setTimeout(() => {
      console.warn('[thumb] 超时未拿到缩略图')
      resolveDone(null)
    }, THUMB_TIMEOUT_MS)
    timer.unref?.()
  })

  const query = 'thumb=1'
  const appRoot = readAppRootArg(process.argv)
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    await win.loadURL(`${devUrl}?${query}`)
  } else if (appRoot) {
    await win.loadFile(join(appRoot, 'out', 'renderer', 'index.html'), { search: query })
  } else {
    await win.loadFile(join(__dirname, '../renderer/index.html'), { search: query })
  }

  const dataUrl = await done
  if (!dataUrl) {
    app.exit(1)
    return
  }
  const out = saveThumb(THUMB_SOURCE, dataUrl)
  if (!out) {
    console.warn('[thumb] 写缓存失败')
    app.exit(1)
    return
  }
  /* 允许命令行显式指定输出位置（测试/调试用）：额外再写一份 */
  if (THUMB_TARGET && resolve(THUMB_TARGET) !== resolve(out)) {
    try {
      const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl)
      if (match) {
        mkdirSync(dirname(THUMB_TARGET), { recursive: true })
        writeFileSync(THUMB_TARGET, Buffer.from(match[1], 'base64'))
        console.log('[thumb] 另存：', THUMB_TARGET)
      }
    } catch (err) {
      console.warn('[thumb] 另存失败：', err)
    }
  }
  console.log('[thumb] 完成：', out, statSync(out).size, 'B')
  app.exit(0)
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
 *   我们发出的是 `pdf-file:///C:/<user>/a.pdf`（三段斜杠，盘符在路径里），
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

  /*
   * ★ 首选形式：路径放在 query 里 —— pdf-file:///?p=<编码后的绝对路径>。
   *   原因见各渲染层 toPdfUrl 的注释：Chromium 会把 path 首段目录当 host 并小写化。
   *   下面几条分支保留给旧格式（历史书签、旧版缓存里的 URL）。
   */
  const fromQuery = parsed.searchParams.get('p')
  if (fromQuery) return normalize(fromQuery)

  // host 是盘符（规范化后的小写单字母），也可能是空（标准三段斜杠形式）
  const host = parsed.hostname
  const pathname = decodeURIComponent(parsed.pathname)

  if (!pathname) return null

  // 情况一：盘符落在 host 上 —— pdf-file://c/Users/a.pdf
  if (/^[a-zA-Z]$/.test(host)) {
    return normalize(`${host.toUpperCase()}:${pathname}`)
  }

  // 情况二：盘符在路径里 —— pdf-file:///C:/<user>/a.pdf
  if (/^\/[a-zA-Z]:[\\/]/.test(pathname)) {
    return normalize(pathname.slice(1))
  }

  /*
   * 情况三：POSIX 绝对路径。
   *
   * ★ 这里也有一个 Chromium 规范化问题：我们发的是 `pdf-file:///projects/a.pdf`
   *   （三段斜杠），Chromium 把多余的斜杠折叠成两段，于是**第一段目录变成了 host**：
   *       pdf-file://projects/a.pdf
   *   此时 hostname="projects"、pathname="/a.pdf"，直接取 pathname 会丢掉一层
   *   目录（实测打开 /projects/... 被解析成 /a.pdf，文件永远「不存在」）。
   *   Windows 上因为盘符是单字母、有专门分支，才没暴露这个问题。
   *
   *   处理：host 不是单字母盘符时，把它当成路径的第一段拼回去。
   */
  if (host) {
    return normalize(`/${host}${pathname}`)
  }

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
/*
 * ★ 录屏模式（QX_CAPTURE=1）：窗口不显示在屏幕上，但保持「可见」状态并关掉节流，
 *   这样 Page.startScreencast 才能持续出帧（隐藏窗口没有合成帧，screencast 只会零星来几张）。
 *   窗口被挪到屏幕外 + 不进任务栏，用户看不到任何东西。
 */
const CAPTURE_MODE = process.env.QX_CAPTURE === '1'


/** 插件市场清单的内存缓存（10 分钟内复用） */
/**
 * 市场源可被测试替换（**仅 --test-hooks 下生效**）。
 *
 * 为什么需要：清单的校验与「两源回落」是纯逻辑，但它读的是写死的两个公网 URL，
 * 离线测试既不能依赖公网、也不能往真服务器塞坏包。测试期用本地 http 服务器喂
 * 正常包 / 坏包 / 404 / 连不上四种情况，覆盖回落与丢弃逻辑。
 */
let MARKET_SOURCES: { name: string; url: string }[] | null = null

let MARKET_CACHE: { at: number; value: { ok: boolean; items: unknown[]; at: number; source?: string } } | null = null

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
      backgroundThrottling: !(HIDDEN_MODE && !CAPTURE_MODE)
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
    if (CAPTURE_MODE && mainWindow) {
      // 录屏：挪到屏幕外再 showInactive，既不抢焦点也不出现在用户眼前
      mainWindow.setSkipTaskbar(true)
      mainWindow.setPosition(-4000, -3000)
      mainWindow.showInactive()
      console.log('[pdf] 录屏模式：窗口置于屏幕外，仅用于抓帧')
    } else if (!HIDDEN_MODE) {
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

/**
 * 从命令行参数里挑出第一个可打开的路径（PDF 或图片）。
 *
 * ★ 2026-10-23：以前这里只认 `.pdf`，于是双击图片（注册表明明指向本程序）
 * 会被当成"没有文件参数"直接开空窗口 —— 用户看到的就是"图片格式不支持"。
 * 图片在主进程里会先转成一页 PDF（见 imageToPdfFile），所以这里放行即可。
 */
function extractFileArg(argv: string[]): string | null {
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-')) continue
    const ext = extname(arg).toLowerCase()
    if (ext !== '.pdf' && !IMAGE_EXTS.includes(ext)) continue
    const abs = resolve(arg)
    if (existsSync(abs)) return abs
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
/**
 * 图片转单页 PDF。
 *
 * 用 Electron 自带的 nativeImage 解码（png / jpg / webp / bmp / gif 都能读），
 * 再交给 pdf-lib 排版，省掉一整套图片解码依赖。
 *
 * ★ 2026-10-24 提速（用户反馈"图片加载有点慢"）：
 *   1. **结果缓存**：key = 绝对路径 + mtime + size 的 sha1，命中就直接返回，
 *      第二次打开同一张图不再解码 / 重编码（之前每次都是全流程重做）。
 *      缓存放在 userData/image-cache，按 48 个文件 / 7 天滚动清理。
 *   2. **能直嵌就不重编码**：JPEG 源直接把原始字节塞进 PDF（省掉 toPNG 的
 *      一次解码 + PNG 压码，10MP 图这一项就是好几百毫秒）。
 *   3. **先缩小再编码**：超过 1600px 的图先 resize 到 1600 再编码/直嵌，
 *      避免把 4000×3000 的整张 PNG 写进 PDF。
 */
function imageCacheKey(source: string): string {
  const st = statSync(source)
  return createHash('sha1')
    .update(`${resolve(source)}|${st.mtimeMs}|${st.size}`)
    .digest('hex')
    .slice(0, 24)
}

/** 清掉过期缓存：保留最近 48 个，且删掉 7 天没被碰过的 */
function pruneImageCache(dir: string): void {
  try {
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.pdf'))
      .map((name) => {
        const full = join(dir, name)
        const st = statSync(full)
        return { full, at: st.mtimeMs, size: st.size }
      })
      .sort((a, b) => b.at - a.at)
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000
    for (const [index, file] of files.entries()) {
      if (index >= 48 || file.at < cutoff) rmSync(file.full, { force: true })
    }
  } catch {
    /* 缓存清理失败不影响打开 */
  }
}

async function imageToPdfFile(source: string): Promise<string> {
  const dir = join(app.getPath('userData'), 'image-cache')
  mkdirSync(dir, { recursive: true })

  const key = imageCacheKey(source)
  const cached = join(dir, `${key}.pdf`)
  if (existsSync(cached)) {
    /* 命中就刷新 mtime，让它排在"最近使用"里，不被滚动清理掉 */
    try {
      const now = new Date()
      utimesSync(cached, now, now)
    } catch {
      /* 忽略 */
    }
    return cached
  }

  const image = nativeImage.createFromPath(source)
  if (image.isEmpty()) throw new Error('无法解码这张图片')

  const { width, height } = image.getSize()
  if (!width || !height) throw new Error('图片尺寸异常')

  const scale = Math.min(1600 / width, 1600 / height, 1)
  const pageW = width * scale
  const pageH = height * scale

  const pdf = await PDFDocument.create()
  const ext = extname(source).toLowerCase()
  const resized = scale < 1 ? image.resize({ width: Math.round(pageW), height: Math.round(pageH) }) : image
  let embedded
  if (ext === '.jpg' || ext === '.jpeg') {
    /* JPEG 直嵌：resize 之后的 toJPEG 仍然比 toPNG 快很多，体积也小 */
    embedded = await pdf.embedJpg(resized.toJPEG(88))
  } else {
    embedded = await pdf.embedPng(resized.toPNG())
  }

  const page = pdf.addPage([pageW, pageH])
  page.drawImage(embedded, { x: 0, y: 0, width: pageW, height: pageH })

  await writeFile(cached, await pdf.save())
  pruneImageCache(dir)
  return cached
}

/* ---------------- 新建空白 PDF ---------------- */

/** 常用纸张（pt）。A4 是默认值，教室打印最常用。 */
const BLANK_SIZES: Record<string, [number, number]> = {
  A4: [595.28, 841.89],
  A3: [841.89, 1190.55],
  Letter: [612, 792]
}

export interface BlankPdfSpec {
  pages: number
  size: 'A4' | 'A3' | 'Letter'
  landscape: boolean
  /** 纸面底色（十六进制）。默认纯白；米黄纸打印前肉眼更舒服。 */
  background: string
}

/**
 * 把渲染层传来的（不可信）参数收敛成合法值。
 *
 * 页数上限 200：再多也不是"新建空白"该干的事，而且 pdf-lib 生成会明显变慢。
 */
function normalizeBlankSpec(input: unknown): BlankPdfSpec {
  const raw = (input ?? {}) as Partial<BlankPdfSpec>
  const pages = Math.min(200, Math.max(1, Math.round(Number(raw.pages ?? 1) || 1)))
  const size = (Object.keys(BLANK_SIZES).includes(String(raw.size)) ? String(raw.size) : 'A4') as BlankPdfSpec['size']
  const hex = String(raw.background ?? '#ffffff').trim()
  const background = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : '#ffffff'
  return { pages, size, landscape: Boolean(raw.landscape), background }
}

/**
 * 生成一份空白 PDF 并返回路径。
 *
 * 文件名带时间戳，避免多次新建互相覆盖；目录在 userData/untitled，
 * 属于"临时工作区"，导出时用户自己选位置。
 */
async function createBlankPdf(spec: BlankPdfSpec): Promise<string> {
  const pdf = await PDFDocument.create()
  const [shortSide, longSide] = BLANK_SIZES[spec.size]
  const width = spec.landscape ? longSide : shortSide
  const height = spec.landscape ? shortSide : longSide
  const color = pdfRgb(
    parseInt(spec.background.slice(1, 3), 16) / 255,
    parseInt(spec.background.slice(3, 5), 16) / 255,
    parseInt(spec.background.slice(5, 7), 16) / 255
  )

  for (let index = 0; index < spec.pages; index += 1) {
    const page = pdf.addPage([width, height])
    /* 白纸不用画（默认就是白），只有非白底才铺一层色块，省体积 */
    if (spec.background !== '#ffffff') {
      page.drawRectangle({ x: 0, y: 0, width, height, color })
    }
  }

  pdf.setTitle('新建文档')
  pdf.setCreator('秋夕-PDF阅读器')

  const dir = join(app.getPath('userData'), 'untitled')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date()
  const name = `新建文档-${String(stamp.getMonth() + 1).padStart(2, '0')}${String(stamp.getDate()).padStart(2, '0')}-${String(stamp.getHours()).padStart(2, '0')}${String(stamp.getMinutes()).padStart(2, '0')}${String(stamp.getSeconds()).padStart(2, '0')}.pdf`
  const target = join(dir, name)
  await writeFile(target, await pdf.save())
  return target
}

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

  const ext = extname(abs).toLowerCase()
  const isImage = IMAGE_EXTS.includes(ext)
  if (ext !== '.pdf' && !isImage) {
    return { ok: false, error: '仅支持 PDF 与常见图片格式（png / jpg / webp / bmp / gif）' }
  }

  if (size === 0) {
    return { ok: false, error: '文件为空' }
  }

  // 图片先转成一页 PDF，这样缩放、批注、OCR、导出全都直接可用
  let target = abs
  let title: string | undefined
  if (isImage) {
    try {
      target = await imageToPdfFile(abs)
      title = basename(abs)
    } catch (error) {
      return { ok: false, error: `这张图片打不开：${String(error)}` }
    }
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
    queueOpen(target)
    console.log(
      `[pdf] 尚未就绪（窗口=${!!mainWindow && !mainWindow.isDestroyed()} 渲染层=${rendererReady}），已排队:`,
      target
    )
    // 窗口不在就先把它建出来，否则永远不会有人来冲洗队列
    if (!mainWindow || mainWindow.isDestroyed()) {
      createMainWindow()
    }
    return { ok: true, path: target, title }
  }

  sendOpenToRenderer(target, size, title)
  return { ok: true, path: target, title }
}

/**
 * 真正把打开请求发给渲染层。
 *
 * 反馈循环的最后一道防线：短时间内同一路径只发一次
 * （文件关联监听器 + 拖放可能对同一次操作各触发一遍）。
 */
function sendOpenToRenderer(abs: string, size: number, title?: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const now = Date.now()
  if (abs === lastSentPath && now - lastSentAt < SEND_DEDUPE_MS) {
    console.log('[pdf] 同一路径短时间内重复请求，已忽略:', abs)
    return
  }
  lastSentPath = abs
  lastSentAt = now

  console.log('[pdf] 发送打开请求:', abs)
  mainWindow.webContents.send('pdf:open', { path: abs, name: title ?? basename(abs), size })
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

  /* ============================================================
   * 资源管理器缩略图（渲染层 ←→ 主进程 ←→ shell 提供器）
   * ============================================================ */

  /** 渲染层启动时问「要渲哪个文件」；非 thumb 模式下返回 pdfPath: '' */
  ipcMain.handle('thumb:task', () => ({
    mode: THUMB_MODE,
    pdfPath: THUMB_SOURCE,
    width: 512
  }))

  /** 渲染层交回 dataURL（thumb 模式的主链路） */
  ipcMain.handle('thumb:done', (_e, dataUrl: string) => {
    const resolveDone = thumbResolve
    thumbResolve = null
    resolveDone?.(typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png') ? dataUrl : null)
    return true
  })

  /** 正常打开 PDF 时顺手把首页缩略图写进缓存（走后门，不影响打开速度） */
  ipcMain.handle('thumb:save', (_e, filePath: string, dataUrl: string) => {
    if (typeof filePath !== 'string' || !filePath) return false
    const out = saveThumb(filePath, dataUrl)
    return out !== null
  })

  /** 已有新鲜缩略图就不必再渲一次（渲染层用它跳过重复工作） */
  ipcMain.handle('thumb:fresh', (_e, filePath: string) => {
    if (typeof filePath !== 'string' || !filePath) return false
    return isThumbFresh(thumbPath(filePath), filePath)
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
    const result = await checkForUpdate(6000, getSettings().updateChannel ?? 'auto')
    if (!result.ok || !result.newer) return
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('app:update-available', result)
  }


  /* ---------- 打开文件 ---------- */

  /** 弹系统文件选择框 */
  ipcMain.handle('pdf:pick', async () => {
    const result = await dialog.showOpenDialog(mainWindow ?? undefined!, {
      title: '打开 PDF',
      filters: [
        { name: 'PDF 与图片', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] },
        { name: 'PDF 文档', extensions: ['pdf'] },
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }
      ],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return openFileInWindow(result.filePaths[0])
  })

  /** 打开指定路径（最近列表、拖放都会用到） */
  ipcMain.handle('pdf:open-path', (_e, filePath: string) => openFileInWindow(filePath))

  /*
   * 新建空白 PDF（2026-10-24，用户提的「没法新建空白 pdf」）。
   *
   * 只做「一叠白纸」：页数 / 纸张 / 方向 / 底色。生成后落在 userData 的
   * untitled 目录里，当普通文档打开；要留存就用「导出 PDF」另存为。
   */
  ipcMain.handle('pdf:create-blank', async (_e, spec: unknown) => {
    try {
      const parsed = normalizeBlankSpec(spec)
      const filePath = await createBlankPdf(parsed)
      const opened = await openFileInWindow(filePath)
      if (!opened.ok) return opened
      return { ...opened, blank: true as const, pages: parsed.pages }
    } catch (error) {
      return { ok: false as const, error: `新建失败：${String(error)}` }
    }
  })

  /* ---------- 阅读区背景图 ---------- */

  ipcMain.handle('app:pick-background', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: '窗口未就绪' }
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: '选择阅读区背景图片',
      properties: ['openFile'],
      filters: [
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'bmp', 'gif', 'svg'] }
      ]
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true }

    const source = picked.filePaths[0]
    const ext = extname(source).toLowerCase() || '.png'
    const dir = join(app.getPath('userData'), 'backgrounds')
    mkdirSync(dir, { recursive: true })
    const target = join(dir, `reader-bg${ext}`)
    try {
      copyFileSync(source, target)
      // 换格式时删掉上一张，避免 userData 里越堆越多
      for (const old of readdirSync(dir)) {
        if (old !== basename(target)) rmSync(join(dir, old), { force: true })
      }
      return { ok: true, path: target }
    } catch (error) {
      return { ok: false, error: `保存背景图失败：${String(error)}` }
    }
  })


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
  /*
 * 「默认应用」入口：Windows 10/11 不允许安装器直接改写 UserChoice，
 * 只能把用户送到系统设置页让他自己点一次（见 installer.nsh.in 的
 * Capabilities 注册）。这里只负责打开设置页，不改任何注册表。
 */
ipcMain.handle('app:open-default-apps', async () => {
  try {
    /*
     * ms-settings: 是 Windows 专有协议。Linux 上没有等价的统一入口：
     * deb 安装后由 xdg-mime 决定默认程序，用户在文件管理器里「设为默认」
     * 或跑 xdg-mime default 即可，所以这里只回一句可操作的提示，不假装成功。
     */
    if (process.platform !== 'win32') {
      return {
        ok: false,
        err: 'Linux 下请用系统「设置 → 默认应用」，或执行：xdg-mime default qx-pdfreader.desktop application/pdf'
      }
    }
    await shell.openExternal('ms-settings:defaultapps')
    return { ok: true }
  } catch (error) {
    return { ok: false, err: String(error) }
  }
})
ipcMain.handle('app:info', () => appVersionInfo())

  /* ---------- 版本更新 ---------- */

  /**
   * 查最新版本。
   *
   * 走镜像站（见 src/main/updater.ts），返回结构化结果而不是抛异常：
   * 断网/镜像挂了都只是「查不到」，界面据此显示一句话即可。
   */
  ipcMain.handle('app:update-check', async () => {
    const result = await checkForUpdate(undefined, getSettings().updateChannel ?? 'auto')
    console.log(
      `[update] 检查完成（${result.source ?? '未知通道'}）：本地 ${result.current}，远端 ${result.latest}` +
        (result.newer ? '（有新版本）' : result.ok ? '（已是最新）' : `（${result.error}）`)
    )
    return result
  })

  /* ---------- 插件市场（主题扩展包） ---------- */

  /**
   * 拉取插件市场清单。
   *
   * 只做一件事：GET 镜像站的 `/contact/plugins.php`，把 JSON 原样交给渲染层。
   * 校验放在渲染层做（它是纯展示逻辑），主进程只负责「别让渲染层直接连外网」。
   * 结果缓存 10 分钟：用户来回开关面板不该反复打服务器。
   */
  /**
   * 更新前备份用户数据。
   *
   * 「更新时保存历史数据」的落点：settings.json 里有主题、背景图路径、
   * 界面缩放、快捷键开关等全部偏好，阅读位置也在同一个文件里，
   * 所以备份这一个文件就够；再带上 customThemes 里引用的背景图副本。
   * 备份目录按时间戳分，保留最近 10 份，避免无限长大。
   */
  ipcMain.handle('app:update-backup', async () => {
    try {
      const dir = app.getPath('userData')
      const root = join(dir, 'backups')
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const target = join(root, `update-${stamp}`)
      mkdirSync(target, { recursive: true })
      let copied = 0
      for (const name of ['settings.json', 'positions.json', 'reading-positions.json']) {
        const from = join(dir, name)
        try {
          copyFileSync(from, join(target, name))
          copied += 1
        } catch {
          /* 文件不存在是正常的：不是每个版本都写这几个文件 */
        }
      }
      const entries = (() => {
        try {
          return readdirSync(root, { withFileTypes: true })
        } catch {
          return []
        }
      })()
      const olds = entries
        .filter((e) => e.isDirectory() && e.name.startsWith('update-'))
        .map((e) => e.name)
        .sort()
      for (const name of olds.slice(0, Math.max(0, olds.length - 10))) {
        rmSync(join(root, name), { recursive: true, force: true })
      }
      console.log(`[update] 已备份用户数据 ${copied} 个文件 → ${target}`)
      return { ok: true, dir: target, files: copied }
    } catch (error) {
      console.error('[update] 备份用户数据失败', error)
      return { ok: false, error: (error as Error).message }
    }
  })

  /** 测试挂钩：替换市场源（不联网、只改内存） */
  ipcMain.handle('market:set-sources', (_e, list: unknown) => {
    if (!process.argv.includes('--test-hooks')) {
      console.warn('[market] 拒绝了源替换：未带 --test-hooks')
      return false
    }
    if (!Array.isArray(list)) return false
    const next = list
      .map((one) => one as { name?: unknown; url?: unknown })
      .filter((one) => typeof one?.name === 'string' && typeof one?.url === 'string')
      .map((one) => ({ name: String(one.name), url: String(one.url) }))
    MARKET_SOURCES = next.length > 0 ? next : null
    MARKET_CACHE = null
    console.log(`[market] 源已替换为 ${next.map((s) => s.name).join(', ') || '默认'}`)
    return true
  })

  /** 测试挂钩：清掉 10 分钟缓存，让下一次 market:list 真的重新拉 */
  ipcMain.handle('market:clear-cache', () => {
    MARKET_CACHE = null
    return true
  })

  ipcMain.handle('market:list', async () => {
    const now = Date.now()
    if (MARKET_CACHE && now - MARKET_CACHE.at < 10 * 60_000) return MARKET_CACHE.value

    /*
     * 两个源，同一份 schema：
     *   ① 镜像站 plugins.php —— 国内快，包含未同步到 GitHub 的新包；
     *   ② GitHub raw plugins/index.json —— 镜像站挂了/被墙时的兜底，
     *      也是别人提 PR 加主题包的原始入口。
     * 先①后②，任一成功就返回；两个都失败才报错（文案合并两边的失败原因）。
     */
    const sources = MARKET_SOURCES ?? [
      { name: 'mirror', url: 'https://xn--6rso4u4lc86ad09c.top/contact/plugins.php' },
      {
        name: 'github',
        url: 'https://raw.githubusercontent.com/QiuXiYueShiJiu/QX-PDFreader/main/plugins/index.json'
      }
    ]

    const errors: string[] = []
    for (const source of sources) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8000)
      try {
        const res = await net.fetch(source.url, { signal: controller.signal })
        if (!res.ok) {
          errors.push(`${source.name} ${res.status}`)
          continue
        }
        const json = (await res.json()) as { items?: unknown[] }
        const items = Array.isArray(json.items) ? json.items : []
        const value = { ok: true, items, at: now, source: source.name }
        MARKET_CACHE = { at: now, value }
        console.log(`[market] 清单 ${items.length} 项（来源 ${source.name}）`)
        return value
      } catch (error) {
        const aborted = (error as Error)?.name === 'AbortError'
        errors.push(`${source.name} ${aborted ? '超时' : '连不上'}`)
      } finally {
        clearTimeout(timer)
      }
    }

    return { ok: false, error: `市场不可用（${errors.join(' / ')}）`, items: [] }
  })

  /** 当前版本号（界面显示用，不触发网络） */

  ipcMain.handle('app:update-current', () => currentVersion())

  /**
   * 下载安装包。进度用 send 推给渲染层，避免 IPC invoke 一直挂着。
   * 下载是长任务（约 100 MB），这里不设超时 —— 由用户取消或断网结束。
   */
  ipcMain.handle('app:update-download', async (event, asset: unknown) => {
    const item = asset as {
      name?: string
      size?: number
      url?: string
      sha256?: string
      token?: string
      source?: string
    }
    if (!item || typeof item.url !== 'string' || typeof item.name !== 'string') {
      return { ok: false, error: '下载信息不完整' }
    }
    const result = await downloadUpdate(
      {
        name: item.name,
        size: Number(item.size ?? 0),
        url: item.url,
        sha256: item.sha256,
        token: item.token,
        source: item.source as never
      },
      (p) => {
        if (event.sender.isDestroyed()) return
        event.sender.send('app:update-progress', p)
      }
    )
    console.log(`[update] 下载${result.ok ? '完成' : '失败'}：${result.path ?? result.error}`)
    return result
  })

  /**
   * 打开下载好的安装包（用系统默认方式，装不装由用户决定）。
   *
   * ★ 装之前先把用户数据备份一份（v1.0.5.0）：
   *   设置、阅读位置、最近列表、背景图都在 userData 里，装机/回滚时最容易丢；
   *   这里在打开安装包之前拷到 `userData/update-backups/<版本>-<时间>/`，
   *   只保留最近 3 份，避免越攒越多。备份失败不影响安装（只打个日志）。
   */
  ipcMain.handle('app:update-install', (_e, path: unknown) => {
    const target = String(path ?? '')
    if (!target) return installUpdate(target)
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const version = currentVersion()
      const dir = join(app.getPath('userData'), 'update-backups')
      mkdirSync(dir, { recursive: true })
      const dest = join(dir, `${version}-${stamp}`)
      mkdirSync(dest, { recursive: true })
      let copied = 0
      for (const name of ['settings.json', 'positions.json', 'recent.json']) {
        const src = join(app.getPath('userData'), name)
        if (!existsSync(src)) continue
        copyFileSync(src, join(dest, name))
        copied += 1
      }
      const bgDir = join(app.getPath('userData'), 'backgrounds')
      if (existsSync(bgDir)) {
        cpSync(bgDir, join(dest, 'backgrounds'), { recursive: true })
      }
      // 只留最近 3 份
      const keep = readdirSync(dir)
        .filter((name) => !name.endsWith('.txt'))
        .sort()
        .slice(-3)
      for (const name of readdirSync(dir)) {
        if (!keep.includes(name)) rmSync(join(dir, name), { recursive: true, force: true })
      }
      writeFileSync(
        join(dest, 'README.txt'),
        `升级前自动备份\n版本：${version}\n时间：${new Date().toISOString()}\n内容：${copied} 个 json（设置 / 阅读位置 / 最近列表）\n`,
        'utf8'
      )
      console.log(`[update] 升级前已备份用户数据 → ${dest}（${copied} 个文件）`)
    } catch (error) {
      console.warn('[update] 备份用户数据失败（不影响安装）：', error)
    }
    return installUpdate(target)
  })

  /** 在浏览器里打开 release 页面，供用户自己看说明/手动下载 */
  ipcMain.handle('app:update-open-page', (_e, url: unknown) => {
    const target = String(url ?? '')
    if (!/^https:\/\//i.test(target)) return false
    void shell.openExternal(target)
    return true
  })

  /*
   * ---------- PDF 工具箱 ----------
   * 合并 / 拆分 / 水印 / 压缩 / 加解密 / 图片互转 / Office→PDF。
   * 实现集中在 src/main/pdf-tools.ts；这里只把「当前窗口」的取值函数交过去。
   */
  registerPdfToolsIpc(() => mainWindow)

  /*
   * ---------- 文档编辑（进阶） ----------
   * 页面整理 / 页眉页脚 / 贝茨编号 / 元数据 / 书签 / 附件 / 表单 / 签名 /
   * PDF/A / 安全遮盖 / 导出 Word、Excel / 对比 / 打印。
   * 实现集中在 src/main/pdf-advanced.ts。
   */
  registerPdfAdvancedIpc(() => mainWindow)

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
