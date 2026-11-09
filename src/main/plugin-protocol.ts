// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 主进程 ↔ 插件宿主（utilityProcess）之间的消息协议。
 *
 * 这个文件只放类型，不 import 任何运行时模块：
 *   · 主进程侧（plugin-broker.ts）用 `import type` 引用；
 *   · 子进程侧（plugin-host.ts）也用 `import type` 引用，编译后整份文件会被抹掉，
 *     子进程里不会因为类型文件而多加载主进程的东西。
 *
 * 方向说明：
 *   HostInbound  —— 宿主进程“收到”的消息，由主进程发出；
 *   HostOutbound —— 宿主进程“发出”的消息，由主进程处理。
 */

/** 权限：声明了才有对应能力，没声明调用即被主进程拒绝 */
export type PluginPermission =
  | 'document.read'
  | 'files.write'
  | 'network'
  | 'ui.dialog'
  | 'settings.write'

/**
 * 启动一个插件宿主时下发的静态信息。
 *
 * 由主进程从磁盘上的 manifest.json 读出，**不再回读子进程的任何声明**；
 * 子进程就算谎报权限也没用，权限判断只认这份 spec。
 */
export interface PluginHostSpec {
  id: string
  name: string
  version: string
  permissions: PluginPermission[]
  /** net.fetchText 的域名白名单（仅 https，子域自动允许） */
  allowedHosts: string[]
}

/** 主进程 → 子进程：加载插件代码并执行 activate(api) */
export interface ActivateMessage {
  type: 'activate'
  code: string
  spec: PluginHostSpec
}

/** 主进程 → 子进程：执行一个已注册的命令 */
export interface CommandMessage {
  type: 'command'
  runId: number
  /** 插件内部注册的短 id（不含 `<pluginId>:` 前缀） */
  commandId: string
}

/** 主进程 → 子进程：某个 api 调用的结果 */
export interface ApiResultMessage {
  type: 'api-result'
  callId: number
  ok: boolean
  value?: unknown
  error?: string
}

export type HostInbound = ActivateMessage | CommandMessage | ApiResultMessage

/** 子进程 → 主进程：插件调用了 api.xxx，请求主进程代劳 */
export interface ApiCallMessage {
  type: 'api'
  callId: number
  fn: string
  args: unknown[]
}

/** 子进程 → 主进程：插件注册了一个命令 */
export interface CommandRegisteredMessage {
  type: 'command-registered'
  commandId: string
  label: string
}

/** 子进程 → 主进程：命令执行完毕（成功或失败） */
export interface CommandResultMessage {
  type: 'command-result'
  runId: number
  ok: boolean
  value?: unknown
  error?: string
}

/** 子进程 → 主进程：代码已执行、activate 已调用，可以接命令了 */
export interface ReadyMessage {
  type: 'ready'
}

/** 子进程 → 主进程：加载或 activate 阶段抛错，宿主不应继续存活 */
export interface ActivateErrorMessage {
  type: 'activate-error'
  error: string
}

export type HostOutbound =
  | ApiCallMessage
  | CommandRegisteredMessage
  | CommandResultMessage
  | ReadyMessage
  | ActivateErrorMessage
