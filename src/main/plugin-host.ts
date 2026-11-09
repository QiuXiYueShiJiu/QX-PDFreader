// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 插件宿主进程（utilityProcess 入口）。
 *
 * ── 为什么要有这个文件 ───────────────────────────────────────────
 *   旧实现把插件代码放在**主进程**里用 `vm.runInNewContext` 跑。vm 不是安全边界：
 *   沙箱里只要摸到一个宿主对象（比如 `api` 的函数），就能顺着
 *   `constructor.constructor` 拿到主进程的 `Function`，进而拿到 `process`、
 *   `require`、`fs` —— 等于任意代码执行（RCE）。
 *
 *   现在插件跑在 Electron 的 utilityProcess 里：就算插件拿到本进程的
 *   `process` / `require` / `fs`，那也只是这个一次性的子进程，
 *   碰不到主进程的窗口、IPC、用户数据目录。插件真正需要的外部能力
 *   （读写文件、联网、弹提示、持久化）一律以消息形式请求主进程，
 *   由主进程按 manifest 里的 permissions 逐条放行。
 *
 * ── 这个进程只做三件事 ──────────────────────────────────────────
 *   1. 收 activate / command 指令；
 *   2. 在本进程内执行插件代码（vm.runInThisContext 包一层函数，
 *      只注入 module / exports / api / console / 定时器，
 *      并把 process / require / global 用同名参数遮蔽掉）；
 *   3. 把 api.* 调用转发给主进程，等待 api-result。
 *
 *   这里**不做任何权限判断**：子进程不可信，权限只认主进程手里的 spec。
 */

import vm from 'node:vm'
import type {
  ApiResultMessage,
  CommandMessage,
  HostInbound,
  HostOutbound,
  PluginHostSpec
} from './plugin-protocol'

/* ------------------------------------------------------------------ */
/* 与主进程的通道                                                      */
/* ------------------------------------------------------------------ */

const port = process.parentPort

if (!port) {
  // 只有在 utilityProcess.fork() 里才有 parentPort；直接 node 跑说明用错了入口。
  console.error('[plugin-host] 只能由 utilityProcess 启动，缺少 parentPort')
  process.exit(1)
}

function post(message: HostOutbound): void {
  try {
    port.postMessage(message)
  } catch {
    /* 主进程已经退出，消息发不出去就算了；本进程随后也会被回收 */
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* ------------------------------------------------------------------ */
/* api 代理：所有能力都回到主进程执行                                   */
/* ------------------------------------------------------------------ */

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

const pending = new Map<number, PendingCall>()
let nextCallId = 1

/**
 * 发起一次远程 api 调用。
 *
 * 注意：迁移到子进程后 api 全部变成 **Promise**（消息只能异步往返）。
 * 旧插件里 `api.document.getPath()` 直接当字符串用的写法需要改成 await；
 * 这是隔离带来的必然代价，写在这里提醒后续维护者。
 */
function callApi(fn: string, args: unknown[]): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const callId = nextCallId++
    pending.set(callId, { resolve, reject })
    try {
      port.postMessage({ type: 'api', callId, fn, args })
    } catch (error) {
      pending.delete(callId)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

/* ------------------------------------------------------------------ */
/* 插件代码执行状态                                                     */
/* ------------------------------------------------------------------ */

let spec: PluginHostSpec | null = null
let activated = false
const commandHandlers = new Map<string, () => unknown>()

function buildApi(current: PluginHostSpec): Record<string, unknown> {
  return {
    /** 静态信息：manifest 由主进程读盘后下发，插件改不了 */
    manifest: {
      id: current.id,
      name: current.name,
      version: current.version,
      permissions: [...current.permissions]
    },
    document: {
      getPath: () => callApi('document.getPath', []),
      getText: () => callApi('document.getText', [])
    },
    files: {
      /** 文本读取/保存：路径由用户在对话框里选 */
      read: (defaultPath?: string) => callApi('files.read', [defaultPath]),
      save: (defaultName: string, content: string) => callApi('files.save', [defaultName, content]),
      /** 二进制读取（docx/xlsx 这类 zip 容器按文本读会废掉），返回 base64 */
      readBytes: (defaultPath?: string) => callApi('files.readBytes', [defaultPath])
    },
    zip: {
      /** 从 zip/docx 包里取一个文本条目，解压在宿主侧做 */
      readText: (base64: string, entry: string) => callApi('zip.readText', [base64, entry])
    },
    pdf: {
      /** 文本 → PDF 并交给应用打开（插件没法自己生成 PDF 再展示） */
      createFromText: (title: string, text: string) => callApi('pdf.createFromText', [title, text])
    },
    net: {
      /** 仅 https + 域名白名单 + 5MB 响应上限，全部在主进程校验 */
      fetchText: (url: string) => callApi('net.fetchText', [url])
    },
    ui: {
      notify: (message: string) => callApi('ui.notify', [message]),
      confirm: (message: string) => callApi('ui.confirm', [message]),
      /** 渲染层轻提示；主进程负责广播到窗口 */
      toast: (message: string, kind?: string) => callApi('ui.toast', [message, kind])
    },
    settings: {
      get: () => callApi('settings.get', []),
      set: (key: string, value: unknown) => callApi('settings.set', [key, value])
    },
    storage: {
      get: (key: string) => callApi('storage.get', [key]),
      set: (key: string, value: unknown) => callApi('storage.set', [key, value]),
      delete: (key: string) => callApi('storage.delete', [key]),
      keys: () => callApi('storage.keys', [])
    },
    commands: {
      /**
       * 注册命令。命令表在本进程里保存（run 是函数，无法跨进程传），
       * 同时把 id/label 报给主进程，主进程据此生成工具栏按钮。
       */
      register(input: { id: string; label: string; run: () => unknown }): void {
        if (!input || typeof input !== 'object') {
          throw new Error('commands.register 需要 { id, label, run }')
        }
        const { id, label, run } = input
        if (typeof id !== 'string' || id.length === 0 || id.length > 64) {
          throw new Error('commands.register 的 id 必须是 1–64 字符的字符串')
        }
        if (typeof label !== 'string' || !label.trim() || label.length > 200) {
          throw new Error('commands.register 的 label 必须是 1–200 字符的字符串')
        }
        if (typeof run !== 'function') {
          throw new Error('commands.register 缺少 run')
        }
        commandHandlers.set(id, () => run())
        post({ type: 'command-registered', commandId: id, label })
      }
    }
  }
}

/**
 * 执行插件代码。
 *
 * 用 `vm.runInThisContext` 把代码包成一个函数再调用 —— 这样 `module` /
 * `exports` / `api` 都是函数参数，不会污染本进程的全局对象。
 * 同时把 `process` / `require` / `global` / `globalThis` 也声明成参数并传
 * 空值/受控对象，挡掉最常见的“顺手拿宿主能力”写法。
 *
 * 注意：这不是密码学级别的沙箱（`Function` 构造器仍然能摸到本进程全局），
 * 但本进程是 utilityProcess，摸到也只是子进程 —— 安全边界在进程，不在 vm。
 */
function runPluginCode(code: string, current: PluginHostSpec): void {
  const moduleObject: { exports: Record<string, unknown> } = { exports: {} }

  const pluginConsole = {
    log: (...args: unknown[]) => console.log(`[plugin:${current.id}]`, ...args),
    warn: (...args: unknown[]) => console.warn(`[plugin:${current.id}]`, ...args),
    error: (...args: unknown[]) => console.error(`[plugin:${current.id}]`, ...args)
  }

  const api = buildApi(current)

  // 旧 vm 沙箱里 globalThis 就是 sandbox 本身，这里保持同样的可见面
  const sandboxGlobal: Record<string, unknown> = {
    module: moduleObject,
    exports: moduleObject.exports,
    api,
    console: pluginConsole,
    setTimeout,
    clearTimeout
  }

  type PluginFactory = (
    module: { exports: Record<string, unknown> },
    exports: Record<string, unknown>,
    api: Record<string, unknown>,
    console: typeof pluginConsole,
    setTimeout: typeof globalThis.setTimeout,
    clearTimeout: typeof globalThis.clearTimeout,
    process: undefined,
    require: undefined,
    global: Record<string, unknown>,
    globalThis: Record<string, unknown>
  ) => void

  let factory: PluginFactory
  try {
    factory = vm.runInThisContext(
      `(function (module, exports, api, console, setTimeout, clearTimeout, process, require, global, globalThis) {\n${code}\n})`,
      { filename: `${current.id}/main.js`, displayErrors: true }
    ) as PluginFactory
  } catch (error) {
    post({ type: 'activate-error', error: `插件代码语法错误：${errorText(error)}` })
    return
  }

  try {
    factory(
      moduleObject,
      moduleObject.exports,
      api,
      pluginConsole,
      setTimeout,
      clearTimeout,
      undefined,
      undefined,
      sandboxGlobal,
      sandboxGlobal
    )
  } catch (error) {
    post({ type: 'activate-error', error: `插件代码执行失败：${errorText(error)}` })
    return
  }

  const exported = moduleObject.exports as Record<string, unknown>
  const activate = exported?.activate
  if (typeof activate !== 'function') {
    post({ type: 'activate-error', error: '插件没有导出 activate(api)' })
    return
  }

  try {
    const result = (activate as (apiValue: unknown) => unknown)(api)
    // activate 允许返回 Promise，但不阻塞 ready：命令注册通常发生在 activate 内，
    // 主进程收到 ready 后照常可以接受后续的 command-registered 消息。
    void Promise.resolve(result).catch((error: unknown) => {
      console.error(`[plugin:${current.id}] activate 异步失败`, error)
    })
  } catch (error) {
    post({ type: 'activate-error', error: `activate 抛错：${errorText(error)}` })
    return
  }

  post({ type: 'ready' })
}

/* ------------------------------------------------------------------ */
/* 指令处理                                                            */
/* ------------------------------------------------------------------ */

async function handleActivate(message: Extract<HostInbound, { type: 'activate' }>): Promise<void> {
  if (activated) {
    post({ type: 'activate-error', error: '同一个宿主进程里重复 activate' })
    return
  }
  activated = true
  spec = message.spec
  if (!spec) {
    post({ type: 'activate-error', error: '缺少 manifest 信息' })
    return
  }
  runPluginCode(message.code, spec)
}

async function handleCommand(message: CommandMessage): Promise<void> {
  const handler = commandHandlers.get(message.commandId)
  if (!handler) {
    post({
      type: 'command-result',
      runId: message.runId,
      ok: false,
      error: '命令不存在（插件进程重启后需要重新 activate）'
    })
    return
  }
  try {
    const value = await handler()
    // value 必须是可结构化克隆的；函数/循环引用会让 postMessage 抛错，这里兜住
    post({ type: 'command-result', runId: message.runId, ok: true, value })
  } catch (error) {
    post({ type: 'command-result', runId: message.runId, ok: false, error: errorText(error) })
  }
}

function handleMessage(raw: HostInbound): void {
  switch (raw.type) {
    case 'activate':
      void handleActivate(raw)
      break
    case 'command':
      void handleCommand(raw)
      break
    case 'api-result': {
      const message = raw as ApiResultMessage
      const entry = pending.get(message.callId)
      if (!entry) return
      pending.delete(message.callId)
      if (message.ok) entry.resolve(message.value)
      else entry.reject(new Error(message.error ?? '主进程拒绝了这个调用'))
      break
    }
    default:
      break
  }
}

port.on('message', (event) => {
  const message = event.data as HostInbound
  if (!message || typeof message !== 'object') return
  handleMessage(message)
})

// 子进程自己兜底：未捕获异常直接打到 stderr，由主进程的 exit 事件记崩溃日志
process.on('uncaughtException', (error) => {
  console.error('[plugin-host] 未捕获异常', error)
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  console.error('[plugin-host] 未处理的 Promise 拒绝', reason)
})
