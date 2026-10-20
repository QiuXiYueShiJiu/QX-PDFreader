// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

import type { ReaderSettings } from './types'

export const SETTINGS_VERSION = 1

/**
 * 默认设置。
 *
 * 取值理由：
 *   · theme 用 sepia（米色）而不是纯白：教室长时间阅读更护眼，投影也不刺眼
 *   · defaultZoom 用 fit-width：绝大多数文档按宽度铺满最易读
 *   · restoreLastPosition 开启：老师经常接着上次的位置继续讲
 *   · uiScale 1.15：一体机屏幕大、观看距离远，默认放大一点更清楚
 */
export const DEFAULT_SETTINGS: ReaderSettings = {
  version: SETTINGS_VERSION,
  /*
   * ★ 默认主题 = 米色（sepia）。
   *
   * 用户明确要求「默认主题改为米色（因为好看）」「就是现在的米色主题
   * 不过是默认主题」—— 原来这里写的是 'light'，而上面的注释一直写着
   * 用 sepia，属于注释与代码不一致的遗留，2026-10-16 一并改正。
   *
   * 注意：mergeSettings 是 `input.theme ?? base.theme`，老用户
   * settings.json 里已有的 theme 仍然生效，不会被这次改默认值覆盖。
   */
  theme: 'sepia',
  pageBackground: '#f5f1e8',
  defaultZoom: 'fit-width',
  restoreLastPosition: true,
  recentLimit: 12,
  showSidebar: true,
  /*
   * 右侧批注列表默认关闭。
   *
   * 用户明确要求「右侧批注记录不需要，就是简单的白板绘画就行」——
   * 页面上画了什么一眼就能看到，再列一份列表属于重复信息，
   * 还占掉正文宽度。批注数据照常保存（不丢），
   * 需要时仍可从工具栏打开。
   */
  showRightPanel: false,
  uiScale: 1.15,
  enableShortcuts: true,
  /* 启动声明默认显示：第一次用的人需要知道「免费 / 早期版本 / 到哪反馈」 */
  disclaimerHidden: false
}

export function cloneDefaults(): ReaderSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as ReaderSettings
}

/** 把可能残缺的配置合并到默认值上，保证字段完整 */
export function mergeSettings(raw: unknown): ReaderSettings {
  const base = cloneDefaults()
  if (!raw || typeof raw !== 'object') return base
  const input = raw as Partial<ReaderSettings>
  return {
    version: SETTINGS_VERSION,
    theme: input.theme ?? base.theme,
    pageBackground: input.pageBackground ?? base.pageBackground,
    defaultZoom: input.defaultZoom ?? base.defaultZoom,
    restoreLastPosition:
      typeof input.restoreLastPosition === 'boolean' ? input.restoreLastPosition : base.restoreLastPosition,
    recentLimit: Number.isFinite(input.recentLimit) ? Number(input.recentLimit) : base.recentLimit,
    showSidebar: typeof input.showSidebar === 'boolean' ? input.showSidebar : base.showSidebar,
    showRightPanel: typeof input.showRightPanel === 'boolean' ? input.showRightPanel : base.showRightPanel,
    uiScale: Number.isFinite(input.uiScale) ? Number(input.uiScale) : base.uiScale,
    enableShortcuts:
      typeof input.enableShortcuts === 'boolean' ? input.enableShortcuts : base.enableShortcuts,
    disclaimerHidden:
      typeof input.disclaimerHidden === 'boolean' ? input.disclaimerHidden : base.disclaimerHidden
  }
}
