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
export const THEME_MODES: readonly ThemeMode[] = [
  'light',
  'dark',
  'sepia',
  'metro',
  'night',
  'forest',
  'warm',
  'contrast',
  'paper',
  'midnight',
  'plum',
  'glow',
  'glass',
  'custom'
]

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
  themeLayout: 'normal',
  pageBackground: '#f5f1e8',
  readerImage: '',
  readerImageDim: 0.35,
  readerImageBlur: 0,
  /*
   * 液态玻璃主题包的两个参数。
   *   · glassRadius：圆角半径（px），0 就是直角，24 已经很圆润；
   *   · glassBlur：面板/工具条的背景模糊（px），0 关掉磨砂效果。
   * 只在 theme='glass' 时生效，切到别的主题不影响其它主题的观感。
   */
  glassRadius: 14,
  glassBlur: 12,
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
   * 静默部署版忽略这个字段（它只走内置校验值通道）。
   */
  updateChannel: 'auto',
  /* 强调色覆盖：空串 = 跟随主题；用户可换成自己的主题色 */
  accentColor: '',
  /* 插件市场装的主题包与当前选用项（默认空） */
  customThemes: [],
  customThemeId: ''
}

export function cloneDefaults(): ReaderSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as ReaderSettings
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function clamp01(value: number): number {
  return clamp(value, 0, 0.85)
}

/** 把可能残缺的配置合并到默认值上，保证字段完整 */
export function mergeSettings(raw: unknown): ReaderSettings {
  const base = cloneDefaults()
  if (!raw || typeof raw !== 'object') return base
  const input = raw as Partial<ReaderSettings>
  return {
    version: SETTINGS_VERSION,
    theme: normalizeTheme(input.theme, base.theme),
    themeLayout: input.themeLayout === 'office' ? 'office' : 'normal',
    pageBackground: input.pageBackground ?? base.pageBackground,
    readerImage: typeof input.readerImage === 'string' ? input.readerImage : base.readerImage,
    readerImageDim: clamp01(input.readerImageDim ?? base.readerImageDim),
    readerImageBlur: clamp(input.readerImageBlur ?? base.readerImageBlur, 0, 24),
    glassRadius: clamp(input.glassRadius ?? base.glassRadius, 0, 24),
    glassBlur: clamp(input.glassBlur ?? base.glassBlur, 0, 30),
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
        : base.updateChannel,
    accentColor:
      typeof input.accentColor === 'string' && /^#[0-9a-f]{6}$/i.test(input.accentColor)
        ? input.accentColor.toLowerCase()
        : base.accentColor,
    customThemes: Array.isArray(input.customThemes)
      ? input.customThemes.filter((item): item is ReaderSettings['customThemes'][number] =>
          Boolean(item) &&
          typeof item.id === 'string' &&
          typeof item.name === 'string' &&
          /^[0-9 ]+$/.test(String(item.bg)) &&
          /^[0-9 ]+$/.test(String(item.text))
        ).slice(0, 12)
      : base.customThemes,
    customThemeId: typeof input.customThemeId === 'string' ? input.customThemeId : base.customThemeId
  }
}
