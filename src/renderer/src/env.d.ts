// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 渲染层的全局类型声明。
 */

import type { Annotation, ReaderSettings, RecentFile } from '@shared/types'
import type { OpenPayload } from '../../preload/index'

export interface OpenResult {
  ok: boolean
  error?: string
  path?: string
}

export interface PdfAppApi {
  open: {
    pick: () => Promise<OpenResult | null>
    path: (filePath: string) => Promise<OpenResult>
    reveal: (filePath: string) => Promise<boolean>
    external: (filePath: string) => Promise<boolean>
  }
  settings: {
    get: () => Promise<ReaderSettings>
    patch: (patch: Partial<ReaderSettings>) => Promise<ReaderSettings>
  }
  recent: {
    list: () => Promise<RecentFile[]>
    push: (entry: { path: string; name: string; page: number }) => Promise<RecentFile[]>
  }
  position: {
    get: (filePath: string) => Promise<number | null>
    set: (filePath: string, page: number) => Promise<boolean>
  }
  /** 批注读写：每个方法都返回该文档的最新全量列表，便于直接替换本地状态 */
  annotations: {
    list: (filePath: string) => Promise<Annotation[]>
    add: (filePath: string, item: Annotation) => Promise<Annotation[]>
    remove: (filePath: string, id: string) => Promise<Annotation[]>
    update: (filePath: string, id: string, patch: Partial<Annotation>) => Promise<Annotation[]>
    clear: (filePath: string) => Promise<Annotation[]>
  }
  win: {
    minimize: () => Promise<void>
    toggleMaximize: () => Promise<boolean>
    close: () => Promise<void>
    isMaximized: () => Promise<boolean>
    /** 全屏阅读（工具条左四按钮里的「全屏」），返回切换**后**的状态 */
    toggleFullscreen: () => Promise<boolean>
    isFullscreen: () => Promise<boolean>
    /** 问过用户之后真正关窗（有未保存编辑时主进程会先拦下 close） */
    forceClose: () => Promise<void>
    onCloseRequest: (handler: () => void) => () => void
    onFullscreenChange: (handler: (fullscreen: boolean) => void) => () => void
  }
  /** 文档级状态：未保存标记、当前标签页、导出 */
  doc: {
    setDirty: (dirty: boolean) => void
    setActive: (filePath: string) => void
    exportPdf: (payload: {
      sourcePath: string
      targetPath?: string
      defaultName?: string
      pages: Array<{ page: number; data: ArrayBuffer }>
    }) => Promise<
      | { ok: true; path: string; baked: number; pages: number }
      | { ok: false; canceled?: boolean; error?: string }
    >
    /** 有未保存编辑时的原生三选一：保存为 PDF / 不保存 / 取消 */
    confirmUnsaved: (fileName: string) => Promise<'save' | 'discard' | 'cancel'>
  }
  app: {
    /** 退出应用（渲染层已弹确认框；主进程负责落盘后退出） */
    quit: () => Promise<void>
    /** 问完用户后真正退出（不再弹一次「确定退出吗」） */
    quitNow: () => Promise<boolean>
    /** 用户点了退出但有未保存编辑：主进程把决定权交回渲染层 */
    onQuitRequest: (handler: () => void) => () => void
    /**
     * 「关于」面板要的**版本 + 品牌 + 法律声明**。
     *
     * ★ 这份类型必须与 preload 的实现保持一致 ——
     *   渲染层读的是这里的声明；preload 改了字段而这里没跟，
     *   tsc 会在**渲染层**报「属性不存在」，报错位置却看起来像渲染层的 bug。
     *   改 preload 的 `app.info` 时记得同步这里。
     *
     * variant='quick'（专供版）时 org / usageScope / support 才有值；
     * 公开版（standard）这三个字段恒为空串，界面据此不渲染任何单位信息。
     */
    /** 报到：渲染层已挂好 pdf:open 监听（主进程据此冲洗待打开队列） */
    rendererReady: () => Promise<boolean>
    info: () => Promise<{
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
    }>
  }
  /** 渲染诊断日志（只在主进程开启诊断时才落盘，平时零副作用） */
  diag: {
    log: (line: string) => void
    info: () => Promise<{ 启用: boolean; 日志: string; 标记: string }>
  }
  onOpen: (handler: (payload: OpenPayload) => void) => () => void
}

declare global {
  interface Window {
    pdfApp: PdfAppApi
  }
}

export {}
