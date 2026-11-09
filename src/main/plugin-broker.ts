// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 插件代理（主进程侧）。
 *
 * ── 为什么要有这个文件 ───────────────────────────────────────────
 *   插件代码不能跑在主进程：vm 沙箱套不住 `constructor.constructor` 那条逃逸链，
 *   插件只要拿到一个宿主函数就能摸到主进程的 `process` / `require` / `fs`。
 *   所以现在每个插件跑在自己的 utilityProcess 里，
 *   主进程只保留这个 broker：它负责
 *     1. fork / 回收插件宿主进程；
 *     2. 收到子进程的 `api` 请求后，**先按磁盘 manifest 里的权限过滤**，
 *        再真正去读写文件、联网、弹框、存数据；
 *     3. 把命令调用转发给子进程并把结果带回来。
 *   子进程里没有任何直接能力，权限语义因此才真正成立。
 *
 * ── 权限只认这份 spec ───────────────────────────────────────────
 *   spec 由 plugins.ts 从磁盘 manifest 读出后传进来。
 *   子进程发来的消息里即便自称有某权限也不采信 —— 子进程是不可信的。
 */

import { app, BrowserWindow, dialog, net, utilityProcess } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { PDFDocument } from '@cantoo/pdf-lib'
import { crashLog } from './crash-log'
import { openPdfFromPlugin } from './plugin-host-io'
import { cjkFont } from './pdf-advanced'
import type {
  ApiCallMessage,
  CommandRegisteredMessage,
  CommandResultMessage,
  HostInbound,
  HostOutbound,
  PluginHostSpec,
  PluginPermission
} from './plugin-protocol'

/* ------------------------------------------------------------------ */
/* 常量                                                               */
/* ------------------------------------------------------------------ */

/** activate 必须在 5 秒内 ready，否则视为卡死并杀掉进程 */
const ACTIVATE_TIMEOUT_MS = 5_000

/** net.fetchText 的响应体上限：5MB，超过立刻断开，避免插件把内存吃光 */
const NET_BODY_LIMIT = 5 * 1024 * 1024
const NET_TIMEOUT_MS = 30_000

/** files.read 读入上限：10MB，插件拿文本用不着更大 */
const FILE_READ_LIMIT = 10 * 1024 * 1024

/** 插件私有存储：单值 64KB、整文件 1MB */
const STORAGE_VALUE_LIMIT = 64 * 1024
const STORAGE_FILE_LIMIT = 1024 * 1024

/**
 * 内置联网白名单。
 *
 * 插件清单必须联网，所以这两个域名默认放行；插件自己的接口域名要写进
 * manifest 的 `allowedHosts`，由用户安装时看到、由这里校验。
 * 只允许 https —— http 会被中间人改包，插件拿到的内容不可信。
 */
const BASE_ALLOWED_HOSTS = [
  'raw.githubusercontent.com',
  'github.com',
  'api.github.com',
  'xn--6rso4u4lc86ad09c.top'
]

/**
 * 每个 api 方法要求的权限。
 *   · 值为 PluginPermission：必须在 manifest 里声明；
 *   · 值为 null：插件私有数据/命令注册，不需要额外权限；
 *   · 不存在：未知方法，直接拒绝（防止子进程瞎编方法名）。
 */
const REQUIRED_PERMISSIONS: Record<string, PluginPermission | null> = {
  'document.getPath': 'document.read',
  'document.getText': 'document.read',
  'files.read': 'document.read',
  /* 二进制读取：Word/zip 这类文件按 utf8 读会废掉，必须拿原始字节 */
  'files.readBytes': 'document.read',
  /* 压缩包内取文本：docx/xlsx 都是 zip，插件自己解压要背一份 inflate */
  'zip.readText': 'document.read',
  /* 文本 → PDF 并打开：插件要"展示"内容，光有文件路径没用 */
  'pdf.createFromText': 'document.read',
  'files.save': 'files.write',
  'net.fetchText': 'network',
  'ui.notify': 'ui.dialog',
  'ui.confirm': 'ui.dialog',
  'ui.toast': 'ui.dialog',
  'settings.get': 'settings.write',
  'settings.set': 'settings.write',
  'storage.get': null,
  'storage.set': null,
  'storage.delete': null,
  'storage.keys': null
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/
/** 二进制读取上限（带图的 docx 常有十几 MB） */
const BINARY_READ_LIMIT = 64 * 1024 * 1024
/** zip 内单个条目解压后的上限，防解压炸弹 */
const ZIP_ENTRY_LIMIT = 32 * 1024 * 1024
/** 只允许取普通条目名，挡掉 ../ 之类的路径穿越写法 */
const ZIP_ENTRY_RE = /^[A-Za-z0-9._/-]{1,200}$/

/* ------------------------------------------------------------------ */
/* 宿主进程表                                                          */
/* ------------------------------------------------------------------ */

type HostChild = ReturnType<typeof utilityProcess.fork>

interface HostHandle {
  spec: PluginHostSpec
  child: HostChild
  ready: boolean
  /** 主动停止中：exit 事件不要再当成崩溃记录 */
  stopping: boolean
  activateTimer: ReturnType<typeof setTimeout> | null
  activation: { resolve: () => void; reject: (error: Error) => void } | null
  /** runId → 等待命令结果的 Promise */
  pendingRuns: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>
  /** 子进程这个插件注册的命令：短 id → 显示名 */
  commands: Map<string, string>
}

const hosts = new Map<string, HostHandle>()

/**
 * 正在启动中的宿主。
 *
 * 宿主是异步起来的，而界面启动后马上就会取命令表；不等一下的话
 * 第一次拿到的永远是空列表（旧实现是同步 vm，没这个问题）。
 * `plugin:commands` / `plugin:run` 先 await 这里，等全部启动有结果再返回。
 */
const starting = new Set<Promise<void>>()

/** 全局命令表：`<pluginId>:<localId>` → 归属信息 */
const commandIndex = new Map<string, { id: string; label: string; pluginId: string }>()

let nextRunId = 1

/** 当前打开的文档（由渲染层推上来，插件只能通过 api.document 读） */
let currentDocument: { path: string; text: string } = { path: '', text: '' }

export function setCurrentDocument(path: string, text: string): void {
  currentDocument = { path, text }
}

/* ------------------------------------------------------------------ */
/* 宿主进程路径                                                        */
/* ------------------------------------------------------------------ */

/**
 * 找到 plugin-host.js。
 *
 * electron-vite 把主进程打成 CJS，`__dirname` 在开发时是 `out/main`、
 * 打包后是 `resources/app.asar/out/main` —— 两种情况下 plugin-host.js
 * 都和 index.js 同级，所以第一条就够用。
 *
 * 后面的候选是兜底：万一以后把 host 放成 extraResource 或改了 outDir，
 * 只要还有一份在 app 目录下就能启动。全部找不到就抛错（而不是静默降级
 * 回主进程执行 —— 那等于把 RCE 又装回去）。
 */
function resolvePluginHostPath(): string {
  const candidates = [join(__dirname, 'plugin-host.js')]
  candidates.push(join(app.getAppPath(), 'out', 'main', 'plugin-host.js'))
  if (app.isPackaged) {
    // 打包后 getAppPath() 是 app.asar 本身；资源目录下再找一遍以防人工挪动
    candidates.push(join(process.resourcesPath, 'app.asar', 'out', 'main', 'plugin-host.js'))
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  crashLog('plugin-host-missing', candidates.join(' | '))
  throw new Error('找不到 plugin-host.js，插件宿主无法启动（请先构建主进程）')
}

/* ------------------------------------------------------------------ */
/* 启动 / 停止                                                         */
/* ------------------------------------------------------------------ */

/**
 * 启动一个插件宿主进程。
 *
 * 成功以子进程发回 `ready` 为准（说明代码执行完、activate 已调用），
 * 超时 5 秒直接 kill —— activate 里死循环不会拖住应用启动。
 */
export function startPlugin(spec: PluginHostSpec, code: string): Promise<void> {
  stopPlugin(spec.id)

  const child = utilityProcess.fork(resolvePluginHostPath(), [], {
    serviceName: `QX 插件宿主 · ${spec.id}`,
    // 子进程的 stdout/stderr 直接接到父进程控制台，插件日志不会丢
    stdio: 'inherit'
  })

  const handle: HostHandle = {
    spec,
    child,
    ready: false,
    stopping: false,
    activateTimer: null,
    activation: null,
    pendingRuns: new Map(),
    commands: new Map()
  }
  hosts.set(spec.id, handle)

  const startup = new Promise<void>((resolve, reject) => {
    handle.activation = { resolve, reject }
    handle.activateTimer = setTimeout(() => {
      if (handle.stopping || hosts.get(spec.id) !== handle) return
      console.error(`[plugin] ${spec.id} activate 超时，终止宿主进程`)
      crashLog('plugin-activate-timeout', spec.id)
      settleActivation(handle, new Error('插件启动超时（5 秒），已终止'))
      stopPlugin(spec.id)
    }, ACTIVATE_TIMEOUT_MS)

    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object') return
      onHostMessage(handle, message as HostOutbound)
    })
    child.on('exit', (exitCode: number) => onHostExit(handle, exitCode))
    child.on('error', (type: string, location: string, report: string) => {
      console.error(`[plugin] ${spec.id} 宿主进程错误`, type, location, report)
      crashLog('plugin-host-error', { pluginId: spec.id, type, location, report })
    })

    // 等 spawn 再发 activate：fork 返回时进程还没起来，提前 post 可能丢消息
    child.once('spawn', () => {
      if (handle.stopping) return
      postToHost(handle, { type: 'activate', code, spec })
    })
  })

  starting.add(startup)
  const forget = (): boolean => starting.delete(startup)
  void startup.then(forget, forget)
  return startup
}

/**
 * 等当前所有宿主启动有结果（成功或失败）。
 *
 * 只用于 IPC 读取类接口：界面启动时取命令表必须等宿主起来，
 * 否则会稳定拿到空数组。失败不抛 —— 某个插件坏了不该让整个插件面板报错。
 */
export async function waitForHostsReady(): Promise<void> {
  while (starting.size > 0) {
    await Promise.allSettled([...starting])
  }
}

/**
 * 停止一个插件的宿主进程。
 *
 * 会先把命令从全局表里摘掉，再拒绝所有等待中的 Promise，
 * 最后 kill —— 顺序反过来会出现「命令还在、进程没了」的窗口。
 */
export function stopPlugin(pluginId: string): void {
  const handle = hosts.get(pluginId)
  if (!handle) return
  handle.stopping = true
  hosts.delete(pluginId)
  clearActivateTimer(handle)
  handle.commands.clear()
  for (const [fullId, entry] of commandIndex) {
    if (entry.pluginId === pluginId) commandIndex.delete(fullId)
  }
  settleActivation(handle, new Error('插件宿主已停止'))
  for (const [, run] of handle.pendingRuns) {
    run.reject(new Error('插件宿主已停止，命令被中断'))
  }
  handle.pendingRuns.clear()
  try {
    handle.child.kill()
  } catch {
    /* 已经退出 */
  }
}

export function stopAllHosts(): void {
  for (const id of [...hosts.keys()]) stopPlugin(id)
}

function clearActivateTimer(handle: HostHandle): void {
  if (handle.activateTimer) {
    clearTimeout(handle.activateTimer)
    handle.activateTimer = null
  }
}

function settleActivation(handle: HostHandle, error?: Error): void {
  clearActivateTimer(handle)
  const activation = handle.activation
  handle.activation = null
  if (!activation) return
  if (error) activation.reject(error)
  else activation.resolve()
}

function postToHost(handle: HostHandle, message: HostInbound): void {
  if (handle.stopping) return
  try {
    handle.child.postMessage(message)
  } catch (error) {
    console.error(`[plugin] 向 ${handle.spec.id} 发送消息失败`, error)
  }
}

function onHostExit(handle: HostHandle, exitCode: number): void {
  // 主动 stop 的 exit 不再当成崩溃；已经被新 handle 替换的旧进程也忽略
  if (handle.stopping || hosts.get(handle.spec.id) !== handle) return
  hosts.delete(handle.spec.id)
  clearActivateTimer(handle)
  handle.commands.clear()
  for (const [fullId, entry] of commandIndex) {
    if (entry.pluginId === handle.spec.id) commandIndex.delete(fullId)
  }
  settleActivation(handle, new Error(`插件宿主进程异常退出（code ${exitCode}）`))
  for (const [, run] of handle.pendingRuns) {
    run.reject(new Error(`插件宿主进程异常退出（code ${exitCode}）`))
  }
  handle.pendingRuns.clear()
  console.error(`[plugin] ${handle.spec.id} 宿主进程退出，code=${exitCode}`)
  crashLog('plugin-crash', handle.spec.id)
}

/* ------------------------------------------------------------------ */
/* 子进程消息                                                          */
/* ------------------------------------------------------------------ */

function onHostMessage(handle: HostHandle, message: HostOutbound): void {
  switch (message.type) {
    case 'ready':
      if (handle.stopping || hosts.get(handle.spec.id) !== handle) return
      handle.ready = true
      settleActivation(handle)
      console.log(`[plugin] 已加载 ${handle.spec.id}@${handle.spec.version}（utilityProcess）`)
      return
    case 'activate-error':
      if (handle.stopping) return
      console.error(`[plugin] ${handle.spec.id} 启动失败：${message.error}`)
      crashLog('plugin-activate-error', { pluginId: handle.spec.id, error: message.error })
      settleActivation(handle, new Error(message.error))
      stopPlugin(handle.spec.id)
      return
    case 'command-registered': {
      handleCommandRegistered(handle, message)
      return
    }
    case 'command-result': {
      handleCommandResult(handle, message)
      return
    }
    case 'api': {
      void handleApiCall(handle, message)
      return
    }
    default:
      return
  }
}

function handleCommandRegistered(handle: HostHandle, message: CommandRegisteredMessage): void {
  if (handle.stopping) return
  const { commandId, label } = message
  if (typeof commandId !== 'string' || !commandId || typeof label !== 'string' || !label.trim()) {
    console.warn(`[plugin] ${handle.spec.id} 注册了非法命令，已忽略`)
    return
  }
  const fullId = `${handle.spec.id}:${commandId}`
  handle.commands.set(commandId, label)
  commandIndex.set(fullId, { id: fullId, label, pluginId: handle.spec.id })
}

function handleCommandResult(handle: HostHandle, message: CommandResultMessage): void {
  const run = handle.pendingRuns.get(message.runId)
  if (!run) return
  handle.pendingRuns.delete(message.runId)
  if (message.ok) run.resolve(message.value)
  else run.reject(new Error(message.error ?? '命令执行失败'))
}

/* ------------------------------------------------------------------ */
/* api 代理：权限闸门 + 真正的实现                                      */
/* ------------------------------------------------------------------ */

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function handleApiCall(handle: HostHandle, message: ApiCallMessage): Promise<void> {
  const callId = message.callId
  const reply = (ok: boolean, value?: unknown, error?: string): void => {
    postToHost(handle, { type: 'api-result', callId, ok, value, error })
  }
  if (handle.stopping) return
  if (typeof callId !== 'number' || typeof message.fn !== 'string') {
    reply(false, undefined, 'api 调用格式不合法')
    return
  }

  const fn = message.fn
  const args = Array.isArray(message.args) ? message.args : []

  try {
    if (!Object.prototype.hasOwnProperty.call(REQUIRED_PERMISSIONS, fn)) {
      reply(false, undefined, `未知的接口 ${fn}`)
      return
    }
    const needed = REQUIRED_PERMISSIONS[fn]
    if (needed && !handle.spec.permissions.includes(needed)) {
      /*
       * 这就是权限语义的落点：插件进程可以随便发这条消息，
       * 但主进程在真正动手之前按 manifest 拒绝。
       */
      reply(false, undefined, `插件 ${handle.spec.id} 没有权限调用 ${fn}（需要 ${needed}）`)
      return
    }
    const value = await executeApi(handle.spec, fn, args)
    reply(true, value)
  } catch (error) {
    reply(false, undefined, errorText(error))
  }
}

async function executeApi(spec: PluginHostSpec, fn: string, args: unknown[]): Promise<unknown> {
  switch (fn) {
    case 'document.getPath':
      return currentDocument.path

    case 'document.getText':
      return currentDocument.text

    case 'files.save': {
      const defaultName = typeof args[0] === 'string' ? args[0] : 'untitled.txt'
      const content = typeof args[1] === 'string' ? args[1] : String(args[1] ?? '')
      // 路径由用户在原生对话框里选，插件拿不到任意写路径
      const picked = await dialog.showSaveDialog({
        title: `${spec.name} · 保存`,
        defaultPath: defaultName
      })
      if (picked.canceled || !picked.filePath) return ''
      writeFileSync(picked.filePath, content, 'utf8')
      return picked.filePath
    }

    case 'files.read': {
      const defaultPath = typeof args[0] === 'string' && args[0] ? args[0] : undefined
      const picked = await dialog.showOpenDialog({
        title: `${spec.name} · 打开`,
        defaultPath,
        properties: ['openFile']
      })
      if (picked.canceled || picked.filePaths.length === 0) return ''
      const file = picked.filePaths[0]
      const size = statSync(file).size
      if (size > FILE_READ_LIMIT) {
        throw new Error(`文件超过 ${FILE_READ_LIMIT / 1024 / 1024}MB 上限，已拒绝读取`)
      }
      return readFileSync(file, 'utf8')
    }

    /**
     * 读二进制文件（用户选路径）。
     *
     * 为什么要这条：Word/Excel 都是 zip 容器，按 utf8 读出的是乱码，
     * 插件没法从乱码里恢复内容。这里给 base64，插件侧自己解包。
     * 上限比文本读取放宽到 64MB，因为带图的 docx 很容易过 10MB。
     */
    case 'files.readBytes': {
      const defaultPath = typeof args[0] === 'string' && args[0] ? args[0] : undefined
      const picked = await dialog.showOpenDialog({
        title: `${spec.name} · 打开`,
        defaultPath,
        properties: ['openFile']
      })
      if (picked.canceled || picked.filePaths.length === 0) return null
      const file = picked.filePaths[0]
      const size = statSync(file).size
      if (size > BINARY_READ_LIMIT) {
        throw new Error(`文件超过 ${BINARY_READ_LIMIT / 1024 / 1024}MB 上限，已拒绝读取`)
      }
      return { path: file, size, base64: readFileSync(file).toString('base64') }
    }

    /**
     * 从 zip 里取一个文本条目（docx 的 word/document.xml 等）。
     *
     * 解压放在主进程：插件侧要自己实现 inflate，等于让每个插件背一份
     * 压缩库；而且解压炸弹的风险也应该由宿主统一兜（限制条目大小）。
     */
    case 'zip.readText': {
      const base64 = typeof args[0] === 'string' ? args[0] : ''
      const entry = typeof args[1] === 'string' ? args[1] : ''
      if (!base64 || !entry) throw new Error('zip.readText 需要 (base64, entryName)')
      if (!ZIP_ENTRY_RE.test(entry)) throw new Error('条目名不合法')
      const buf = Buffer.from(base64, 'base64')
      if (buf.length > BINARY_READ_LIMIT) throw new Error('压缩包超过上限')
      const files = unzipSync(new Uint8Array(buf), {
        filter: (file: { name: string }) => file.name === entry
      } as never)
      const hit = files[entry]
      if (!hit) throw new Error(`压缩包里没有 ${entry}`)
      if (hit.length > ZIP_ENTRY_LIMIT) throw new Error('条目解压后超过上限')
      return strFromU8(hit)
    }

    /**
     * 文本 → PDF，然后交给应用打开。
     *
     * 插件最多只能写文本（files.save），没法生成 PDF 再打开；
     * 而"插件展示一段内容"是常见需求（Word 插件就是这条）。
     * 排版故意保持极简：A4、微软雅黑、按字宽折行、超页自动分页。
     */
    case 'pdf.createFromText': {
      const title = typeof args[0] === 'string' ? args[0] : '插件生成'
      const text = typeof args[1] === 'string' ? args[1] : ''
      if (!text) throw new Error('没有可写入的文本')
      if (text.length > 2_000_000) throw new Error('文本过长（上限 200 万字符）')

      const pdf = await PDFDocument.create()
      const font = await cjkFont(pdf)
      const size = 11
      const lineHeight = size * 1.6
      const margin = 56
      const pageWidth = 595.28
      const pageHeight = 841.89
      /*
       * 0.72 是实测出来的安全系数：微软雅黑的字身宽比 pdf-lib 量测值大约
       * 1.35~1.4 倍（CJK 字形来自 CFF，量测表与绘制用的不是同一份），
       * 按量测值排版会让中文长句统一冲出页面右边缘。
       * 宁可每行短一点，也不能出现「字跑到纸外」。
       */
      const maxWidth = (pageWidth - margin * 2) * 0.72

      let page = pdf.addPage([pageWidth, pageHeight])
      let y = pageHeight - margin

      /*
       * 按字符宽度折行。
       *
       * ★ 不能直接信任 font.widthOfTextAtSize 的量测：@cantoo/pdf-lib 里 CJK
       *   子集字体的宽度表对中文常常返回 0（字形宽度来自 CFF，量测走的是
       *   另一张表），结果是"怎么算都放得下"，中文长句会一路画出页面右边缘。
       *   所以中文按字号算全角宽（CJK 等宽方块），ASCII 才用量测。
       */
      const charWidth = (ch: string): number => {
        const code = ch.codePointAt(0) ?? 0
        const wide =
          (code >= 0x1100 && code <= 0x115f) ||
          (code >= 0x2e80 && code <= 0xa4cf) ||
          (code >= 0xac00 && code <= 0xd7a3) ||
          (code >= 0xf900 && code <= 0xfaff) ||
          (code >= 0xfe30 && code <= 0xfe6f) ||
          (code >= 0xff00 && code <= 0xff60) ||
          (code >= 0xffe0 && code <= 0xffe6)
        if (wide) return size
        try {
          return font.widthOfTextAtSize(ch, size) || size * 0.55
        } catch {
          return size * 0.55
        }
      }

      const wrap = (line: string): string[] => {
        if (!line) return ['']
        const out: string[] = []
        let cur = ''
        let width = 0
        for (const ch of line) {
          const w = charWidth(ch)
          if (width + w > maxWidth && cur) {
            out.push(cur)
            cur = ch
            width = w
          } else {
            cur += ch
            width += w
          }
        }
        out.push(cur)
        return out
      }

      for (const rawLine of text.replace(/\r\n/g, '\n').split('\n')) {
        for (const line of wrap(rawLine)) {
          if (y < margin + lineHeight) {
            page = pdf.addPage([pageWidth, pageHeight])
            y = pageHeight - margin
          }
          page.drawText(line, { x: margin, y, size, font })
          y -= lineHeight
        }
      }

      const dir = join(app.getPath('userData'), 'plugin-output')
      mkdirSync(dir, { recursive: true })
      const safe = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || 'plugin-output'
      const target = join(dir, `${safe}-${Date.now()}.pdf`)
      writeFileSync(target, await pdf.save())
      await openPdfFromPlugin(target, safe)
      return target
    }

    case 'net.fetchText':
      return await fetchText(spec, args[0])

    case 'ui.notify': {
      const text = String(args[0] ?? '')
      // 通知不阻塞插件：弹框由用户关，插件流程该继续继续
      void dialog.showMessageBox({ type: 'info', message: text, buttons: ['好'] })
      return true
    }

    case 'ui.confirm': {
      const text = String(args[0] ?? '')
      const result = await dialog.showMessageBox({
        type: 'question',
        message: text,
        buttons: ['取消', '确定'],
        defaultId: 1,
        cancelId: 0
      })
      return result.response === 1
    }

    case 'ui.toast': {
      const text = String(args[0] ?? '').slice(0, 1000)
      const rawKind = typeof args[1] === 'string' ? args[1] : 'info'
      const kind = rawKind === 'success' || rawKind === 'warn' || rawKind === 'error' ? rawKind : 'info'
      /*
       * 转成普通 IPC 交给渲染层显示。
       * 这里不 import preload 的白名单，也不改 index.ts（并行开发中），
       * 渲染层只需监听 `plugin:toast` 即可。
       */
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue
        win.webContents.send('plugin:toast', { pluginId: spec.id, message: text, kind })
      }
      return true
    }

    case 'settings.get':
      return {}

    case 'settings.set':
      throw new Error('修改设置需要在界面上显式确认，当前版本尚未开放写入')

    case 'storage.get':
      return readStorage(spec.id)[storageKey(args[0])]

    case 'storage.set': {
      const key = storageKey(args[0])
      const value = args[1]
      const serialized = JSON.stringify(value)
      if (serialized === undefined) throw new Error('storage.set 的值无法序列化为 JSON')
      if (Buffer.byteLength(serialized, 'utf8') > STORAGE_VALUE_LIMIT) {
        throw new Error(`storage.set 的值超过 ${STORAGE_VALUE_LIMIT / 1024}KB 上限`)
      }
      const data = readStorage(spec.id)
      data[key] = value
      writeStorage(spec.id, data)
      return true
    }

    case 'storage.delete': {
      const key = storageKey(args[0])
      const data = readStorage(spec.id)
      if (!(key in data)) return false
      delete data[key]
      writeStorage(spec.id, data)
      return true
    }

    case 'storage.keys':
      return Object.keys(readStorage(spec.id))

    default:
      throw new Error(`未知的接口 ${fn}`)
  }
}

/* ------------------------------------------------------------------ */
/* 联网                                                                */
/* ------------------------------------------------------------------ */

function isHostAllowed(hostname: string, extra: string[]): boolean {
  const host = hostname.toLowerCase()
  return [...BASE_ALLOWED_HOSTS, ...extra].some(
    (allowed) => host === allowed.toLowerCase() || host.endsWith(`.${allowed.toLowerCase()}`)
  )
}

async function fetchText(spec: PluginHostSpec, rawUrl: unknown): Promise<string> {
  if (typeof rawUrl !== 'string' || !rawUrl) throw new Error('net.fetchText 需要 URL 字符串')

  let target: URL
  try {
    target = new URL(rawUrl)
  } catch {
    throw new Error('URL 格式不合法')
  }
  if (target.protocol !== 'https:') throw new Error('只允许 https 请求（http 可能被中间人篡改）')
  if (!isHostAllowed(target.hostname, spec.allowedHosts)) {
    throw new Error(`域名 ${target.hostname} 不在该插件的白名单里`)
  }

  const res = await net.fetch(target.toString(), {
    redirect: 'follow',
    signal: AbortSignal.timeout(NET_TIMEOUT_MS)
  })

  // 重定向可能把请求带到白名单外的域名，必须再查一次最终地址
  const finalHost = new URL(res.url || target.toString()).hostname
  if (!isHostAllowed(finalHost, spec.allowedHosts)) {
    throw new Error(`重定向到未授权的域名 ${finalHost}，已中止`)
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > NET_BODY_LIMIT) {
    throw new Error(`响应体超过 ${NET_BODY_LIMIT / 1024 / 1024}MB 上限`)
  }

  return await readBodyLimited(res, NET_BODY_LIMIT)
}

/**
 * 流式读响应体并卡上限。
 *
 * 不用 res.text()：那个会先把整包读进内存，插件请求一个几百 MB 的地址
 * 就能把主进程内存顶爆 —— 上限必须边读边算。
 */
async function readBodyLimited(res: Awaited<ReturnType<typeof net.fetch>>, limit: number): Promise<string> {
  const body = res.body as unknown as {
    getReader?: () => {
      read: () => Promise<{ done: boolean; value?: Uint8Array }>
      cancel: (reason?: unknown) => Promise<void>
    }
  } | null

  if (!body || typeof body.getReader !== 'function') {
    const text = await res.text()
    if (Buffer.byteLength(text, 'utf8') > limit) throw new Error('响应体超过上限')
    return text
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > limit) {
      try {
        await reader.cancel()
      } catch {
        /* 连接已断 */
      }
      throw new Error(`响应体超过 ${limit / 1024 / 1024}MB 上限，已中断`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
}

/* ------------------------------------------------------------------ */
/* 插件私有存储                                                        */
/* ------------------------------------------------------------------ */

function storageKey(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 128) {
    throw new Error('storage 的 key 必须是 1–128 字符的字符串')
  }
  return raw
}

function storagePath(pluginId: string): string {
  if (!ID_RE.test(pluginId)) throw new Error('插件 id 不合法，拒绝访问存储')
  return join(app.getPath('userData'), 'plugin-storage', `${pluginId}.json`)
}

function readStorage(pluginId: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(storagePath(pluginId), 'utf8')) as Record<string, unknown>
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    return raw
  } catch {
    return {}
  }
}

function writeStorage(pluginId: string, data: Record<string, unknown>): void {
  const target = storagePath(pluginId)
  const raw = JSON.stringify(data, null, 2)
  if (Buffer.byteLength(raw, 'utf8') > STORAGE_FILE_LIMIT) {
    throw new Error(`插件存储超过 ${STORAGE_FILE_LIMIT / 1024}KB 上限`)
  }
  mkdirSync(join(app.getPath('userData'), 'plugin-storage'), { recursive: true })
  // 先写临时文件再改名：写到一半崩溃也不会留下半个 JSON
  const tmp = `${target}.tmp`
  writeFileSync(tmp, raw, 'utf8')
  renameSync(tmp, target)
}

/* ------------------------------------------------------------------ */
/* 命令（给 plugins.ts 用）                                             */
/* ------------------------------------------------------------------ */

export interface HostedCommand {
  id: string
  label: string
  pluginId: string
}

export function listHostedCommands(): HostedCommand[] {
  return [...commandIndex.values()].map((entry) => ({ ...entry }))
}

export function findHostedCommand(commandId: string): HostedCommand | null {
  return commandIndex.get(commandId) ?? null
}

/**
 * 把命令发给对应的插件宿主执行。
 *
 * 子进程里 run 抛错时错误会回到这里再抛出去，由 plugins.ts 决定
 * 弹「禁用还是重试」—— 策略留在上层，这一层只负责搬运。
 */
export function runHostedCommand(commandId: string): Promise<void> {
  const entry = commandIndex.get(commandId)
  if (!entry) throw new Error('命令不存在（插件可能没加载）')
  const handle = hosts.get(entry.pluginId)
  if (!handle || !handle.ready) throw new Error('插件宿主未就绪，请重启应用或重新启用插件')

  const localId = commandId.slice(entry.pluginId.length + 1)
  const runId = nextRunId++
  return new Promise<void>((resolve, reject) => {
    handle.pendingRuns.set(runId, { resolve: () => resolve(), reject })
    postToHost(handle, { type: 'command', runId, commandId: localId })
  })
}
