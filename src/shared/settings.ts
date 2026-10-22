// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

import type { ReaderSettings, ThemeMode } from './types'

export const SETTINGS_VERSION = 1

/**
 * 允许的主题值。
 *
 * 单独列出来而不是只靠 TS 类型：settings.json 是磁盘上的用户数据，
 * 里面可能是任意脏值（手改、旧版本、半截写入）。类型在运行时不存在，
 * 不校验就会把 "metor" 这种拼错值一路带进 CSS（html[data-theme='metor']
 * 匹配不到任何主题 → 界面直接变成无样式默认值）。
 */
export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'sepia', 'metro']

/** 把任意值收窄成合法主题；不合法就退回默认主题 */
export function normalizeTheme(value: unknown, fallback: ThemeMode): ThemeMode {
  return THEME_MODES.includes(value as ThemeMode) ? (value as ThemeMode) : fallback
}

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
  disclaimerHidden: false,
  /* 启动时静默查一次新版本：查到才提示，查不到什么都不显示 */
  updateAutoCheck: true,
  /*
   * 公开版的更新通道偏好：auto = 两条通道并行、取版本最高的（同版本镜像站优先）；
   * github / mirror = 只用那一条（GitHub 被墙或镜像站抽风时手动兜底）。
   * 特供版忽略这个字段（它只走内置令牌通道）。
   */
  updateChannel: 'auto'
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
    theme: normalizeTheme(input.theme, base.theme),
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
      typeof input.disclaimerHidden === 'boolean' ? input.disclaimerHidden : base.disclaimerHidden,
    /* 静默自动检查更新：默认开，用户可以关掉 */
    updateAutoCheck:
      typeof input.updateAutoCheck === 'boolean' ? input.updateAutoCheck : base.updateAutoCheck,
    updateChannel:
      input.updateChannel === 'github' || input.updateChannel === 'mirror' || input.updateChannel === 'auto'
        ? input.updateChannel
        : base.updateChannel
  }
}
