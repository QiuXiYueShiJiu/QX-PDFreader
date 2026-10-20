// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 预加载脚本 —— 渲染层与主进程之间的唯一桥。
 *
 * 安全约定：
 *   · contextIsolation: true，渲染层拿不到 Node API
 *   · 只暴露白名单方法，不暴露 ipcRenderer 本体
 *   · 所有路径校验都在主进程做，渲染层传过来的路径不被信任
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { Annotation, OpenResult, ReaderSettings, RecentFile } from '@shared/types'

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>
}

/** 主进程推来的「打开文件」通知载荷 */
export interface OpenPayload {
  path: string
  name: string
  size: number
}

const api = {
  /* ---------- 打开 ---------- */
  open: {
    /** 弹系统文件选择框 */
    pick: () => invoke<OpenResult | null>('pdf:pick'),
    /** 打开指定路径（最近列表 / 拖放 / 命令行） */
    path: (filePath: string) => invoke<OpenResult>('pdf:open-path', filePath),
    /** 在文件管理器中定位 */
    reveal: (filePath: string) => invoke<boolean>('pdf:reveal', filePath),
    /** 用系统默认程序打开（对照用） */
    external: (filePath: string) => invoke<boolean>('pdf:open-external', filePath)
  },

  /* ---------- 设置 ---------- */
  settings: {
    get: () => invoke<ReaderSettings>('pdf:settings-get'),
    patch: (patch: Partial<ReaderSettings>) => invoke<ReaderSettings>('pdf:settings-patch', patch)
  },

  /* ---------- 最近打开 ---------- */
  recent: {
    list: () => invoke<RecentFile[]>('pdf:recent'),
    push: (entry: { path: string; name: string; page: number }) =>
      invoke<RecentFile[]>('pdf:recent-push', entry)
  },

  /* ---------- 阅读位置 ---------- */
  position: {
    get: (filePath: string) => invoke<number | null>('pdf:position-get', filePath),
    set: (filePath: string, page: number) => invoke<boolean>('pdf:position-set', filePath, page)
  },

  /* ---------- 批注 ---------- */
  annotations: {
    list: (filePath: string) => invoke<Annotation[]>('pdf:anno-list', filePath),
    add: (filePath: string, item: Annotation) => invoke<Annotation[]>('pdf:anno-add', filePath, item),
    remove: (filePath: string, id: string) => invoke<Annotation[]>('pdf:anno-remove', filePath, id),
    update: (filePath: string, id: string, patch: Partial<Annotation>) =>
      invoke<Annotation[]>('pdf:anno-update', filePath, id, patch),
    clear: (filePath: string) => invoke<Annotation[]>('pdf:anno-clear', filePath)
  },

  /* ---------- 窗口控制（自绘标题栏用） ---------- */
  win: {
    minimize: () => invoke<void>('win:minimize'),
    toggleMaximize: () => invoke<boolean>('win:toggle-maximize'),
    close: () => invoke<void>('win:close'),
    isMaximized: () => invoke<boolean>('win:is-maximized'),
    /**
     * 关闭确认流程：
     *   · 有未保存编辑时，主进程拦下 close 并发 'win:close-request'
     *   · 渲染层问完用户后再调 forceClose() 真正关窗
     */
    forceClose: () => invoke<void>('win:force-close'),
    onCloseRequest: (handler: () => void): (() => void) => {
      const listener = (): void => handler()
      ipcRenderer.on('win:close-request', listener)
      return () => ipcRenderer.removeListener('win:close-request', listener)
    }
  },

  /* ---------- 文档编辑状态 ---------- */
  doc: {
    /**
     * 同步「当前文档有未保存的编辑」给主进程。
     *
     * 主进程不解析内容，只存一个布尔：点右上角关闭按钮时据此
     * 决定直接关还是先问渲染层（保存 / 不保存 / 取消）。
     */
    setDirty: (dirty: boolean): void => {
      ipcRenderer.send('doc:dirty', dirty)
    },

    /** 标签页切换时同步窗口标题（任务栏 / Alt+Tab 里显示当前文件） */
    setActive: (filePath: string): void => {
      ipcRenderer.send('doc:active', filePath)
    },

    /**
     * 导出为新的 PDF：把渲染层画好的批注图层（每页一张透明 PNG）
     * 烘焙进去。原文件不会被修改。
     *
     * targetPath 只在自动化测试里给（避免弹系统对话框卡住主进程），
     * 正常用户路径不给，由主进程弹「另存为」。
     */
    exportPdf: (payload: {
      sourcePath: string
      targetPath?: string
      defaultName?: string
      pages: Array<{ page: number; data: ArrayBuffer }>
    }): Promise<
      | { ok: true; path: string; baked: number; pages: number }
      | { ok: false; canceled?: boolean; error?: string }
    > => invoke('pdf:export', payload),

    /**
     * 有未保存编辑时的三选一（原生对话框）。
     *
     * 返回 'save' | 'discard' | 'cancel'：渲染层据此决定是跑导出、
     * 直接放行，还是什么都不做（取消关闭/退出）。
     */
    confirmUnsaved: (fileName: string): Promise<'save' | 'discard' | 'cancel'> =>
      invoke('doc:confirm-unsaved', fileName)
  },

  /* ---------- 应用级操作 ---------- */
  app: {
    /**
     * 退出应用。
     *
     * 由渲染进程的「退出应用」按钮调用（已经过确认弹窗）。
     * 走 IPC 而不是 window.close()：主进程需要在此刻把待写数据
     * （设置、阅读位置）落盘后再退出，直接关窗口会跳过这一步。
     */
    quit: () => invoke<void>('app:quit'),

    /**
     * 问完用户之后真正退出（不再弹确认框）。
     *
     * 与 quit 的区别：quit 会再弹一次「确定退出吗」——
     * 用户刚在「保存/不保存」里选完，不该被问第二遍。
     */
    quitNow: () => invoke<boolean>('app:quit-now'),

    /** 订阅「用户点了退出，但有未保存编辑」的通知（渲染层负责问用户） */
    onQuitRequest: (handler: () => void): (() => void) => {
      const listener = (): void => handler()
      ipcRenderer.on('win:quit-request', listener)
      return () => ipcRenderer.removeListener('win:quit-request', listener)
    },

    /**
     * 「关于」面板的版本信息（productName / version / buildVersion）。
     *
     * 从主进程读打包内的 package.json 得到 —— 界面上不再硬编码版本号，
     * 否则每次发版都会忘改（此前「关于」里一直写着 1.1.0.1）。
     */
    /**
     * 告诉主进程「渲染层已挂好 pdf:open 监听」。
     *
     * 主进程在收到这个信号之前，所有打开文件的请求都排队 ——
     * 否则 `webContents.send` 会发给空气（无监听者时消息静默丢失），
     * 表现为「有概率打不开」。详见 src/main/index.ts 的 pendingOpens。
     */
    rendererReady: (): Promise<boolean> => invoke('app:renderer-ready'),
    info: () =>
      invoke<{
        product: string
        version: string
        build: string
        /** 著作权人 */
        publisher: string
        /** 官方网站 */
        site: string
        /** 授权协议摘要 */
        notice: string
        /** 'standard' = 公开发行版；'quick' = 专供版 */
        variant: string
        /** ↓ 仅专供版非空；公开版恒为空串（不得泄漏任何单位信息） */
        org: string
        usageScope: string
        support: string
      }>('app:info')
  },

  /* ---------- 渲染诊断日志 ---------- */
  /**
   * 把一行诊断文本交给主进程写盘。
   *
   * 只在主进程处于诊断模式（--diag-render 或 userData 下有 render-diag.on）时才真正落盘，
   * 否则主进程直接丢弃 —— 所以生产包里调用它是零副作用的。
   * 用 send 不用 invoke：诊断不能让渲染层的滑动多等一个往返。
   */
  diag: {
    log: (line: string): void => {
      ipcRenderer.send('diag:log', line)
    },
    info: () => invoke<{ 启用: boolean; 日志: string; 标记: string }>('diag:info'),
    /**
     * 运行期开关「原生对话框探针」（仅主进程带 --test-hooks 时生效）。
     *
     * 为什么需要：隐藏实例默认会跳过原生确认框，而「框到底弹不弹得出来」
     * 是用户报过的缺陷点，必须能单独验；但整轮都开着又会让「点退出就退出」
     * 的判据失真，且模态框一旦没人关就会卡死主进程、连累后续用例。
     * 因此做成「谁要验谁自己开关」，用例用完必须关掉。
     */
    setDialogProbe: (on: boolean): Promise<boolean> => invoke('diag:set-dialog-probe', on)
  },

  /* ---------- 事件订阅 ---------- */
  /**
   * 订阅「打开文件」通知，返回取消订阅函数。
   * 组件卸载时必须调用，否则热更新时会累积监听器。
   */
  onOpen: (handler: (payload: OpenPayload) => void): (() => void) => {
    const listener = (_e: unknown, payload: OpenPayload): void => handler(payload)
    ipcRenderer.on('pdf:open', listener)
    return () => ipcRenderer.removeListener('pdf:open', listener)
  }
}

contextBridge.exposeInMainWorld('pdfApp', api)

export type PdfAppApi = typeof api
