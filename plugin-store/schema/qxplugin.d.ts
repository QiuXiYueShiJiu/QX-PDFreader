// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 秋夕-PDF阅读器 插件运行时类型声明（`.qxplugin`）。
 *
 * 用法（给插件作者的 main.ts / main.js 用 JSDoc 也能吃到）：
 *
 *   /// <reference path="../schema/qxplugin.d.ts" />
 *
 *   module.exports = {
 *     activate(api) {
 *       api.commands.register({
 *         id: 'count',
 *         label: '统计字数',
 *         run() {
 *           const n = api.document.getText().replace(/\s/g, '').length
 *           api.ui.notify(`当前页 ${n} 字`)
 *         }
 *       })
 *     }
 *   } satisfies QxPluginModule
 *
 * 本文件**只做类型声明**，不含运行时实现；实现见 src/main/plugins.ts。
 * 版本：客户端 2.0.1.0。
 */

/** 五项权限。不声明就调用即抛错，错误信息里带插件 id 与权限名。 */
export type QxPluginPermission =
  /** 读当前文档路径与当前页文本 */
  | 'document.read'
  /** 通过系统保存对话框写文本文件（用户自己选路径） */
  | 'files.write'
  /** 用 net.fetchText 取 http(s) 文本 */
  | 'network'
  /** 弹原生提示框 / 确认框 */
  | 'ui.dialog'
  /** 读写应用设置（当前只读，set 未开放） */
  | 'settings.write'

/** 包根目录的 manifest.json。 */
export interface QxPluginManifest {
  /**
   * 全局唯一 id，`^[a-z0-9][a-z0-9._-]{1,63}$`。
   * 装上之后不要再改 —— 改了等于换了一个插件。
   */
  id: string
  /** 展示名，建议 ≤ 20 字 */
  name: string
  /** 语义化版本 MAJOR.MINOR.PATCH */
  version: string
  author?: string
  /** 一句话说明，商店详情页显示 */
  description?: string
  /** 低于此版本的客户端不加载 */
  minAppVersion?: string
  /** 不写 = 无任何权限 */
  permissions?: QxPluginPermission[]
  /** 入口文件名，默认 main.js */
  main?: string
  /** 图标文件名（建议 64×64 png） */
  icon?: string
}

/** 只读快照，由客户端注入。 */
export interface QxPluginApiManifest {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly permissions: readonly QxPluginPermission[]
}

/** 需要 `document.read`。 */
export interface QxPluginDocumentApi {
  /** 当前文档路径；未打开文档时为空串。 */
  getPath(): string
  /** 当前页纯文本（渲染层在翻页时推送）。 */
  getText(): string
}

/** 需要 `files.write`。 */
export interface QxPluginFilesApi {
  /**
   * 弹系统保存对话框后写入 UTF-8 文本。
   * @param defaultName 默认文件名（不含目录）
   * @param content 文本内容
   * @returns 实际写入的完整路径；用户取消时返回空串
   */
  save(defaultName: string, content: string): Promise<string>
}

/** 需要 `network`。 */
export interface QxPluginNetApi {
  /**
   * 取文本。只接受 http/https；非 2xx 抛 `HTTP <status>`。
   * 沙箱里没有 fetch / XMLHttpRequest，联网只能走这里。
   */
  fetchText(url: string): Promise<string>
}

/** 需要 `ui.dialog`。插件不能自绘窗口，只能用系统对话框。 */
export interface QxPluginUiApi {
  /** 原生信息框，单个「好」按钮。 */
  notify(message: string): void
  /** 原生「取消 / 确定」，确定返回 true。 */
  confirm(message: string): Promise<boolean>
}

/** 需要 `settings.write`。 */
export interface QxPluginSettingsApi {
  /** 当前版本返回空对象（占位接口）。 */
  get(): Record<string, unknown>
  /**
   * 本版未开放：调用会抛
   * 「修改设置需要在界面上显式确认，当前版本尚未开放写入」。
   * 不要依赖它。
   */
  set(): void
}

/** 命令注册参数。全局 id 为 `<插件 id>:<id>`。 */
export interface QxPluginCommandInput {
  /** 本插件内的短 id，不要带冒号 */
  id: string
  /** 菜单里显示的文字 */
  label: string
  /** 点击后执行；抛错时客户端会问「禁用还是重试」 */
  run: () => void | Promise<void>
}

export interface QxPluginCommandsApi {
  register(input: QxPluginCommandInput): void
}

/**
 * 注入插件沙箱的全部能力。
 *
 * 沙箱里只有 module / exports / console / api / setTimeout / clearTimeout；
 * **没有** require、process、fetch、document、window、Buffer。
 */
export interface QxPluginApi {
  readonly manifest: QxPluginApiManifest
  readonly document: QxPluginDocumentApi
  readonly files: QxPluginFilesApi
  readonly net: QxPluginNetApi
  readonly ui: QxPluginUiApi
  readonly settings: QxPluginSettingsApi
  readonly commands: QxPluginCommandsApi
}

/**
 * 入口模块形状：`main.js` 必须导出 `activate`。
 * 入口同步执行有 5 秒超时；超时或抛错都判加载失败（不会崩应用）。
 */
export interface QxPluginModule {
  activate(api: QxPluginApi): void | Promise<void>
}
