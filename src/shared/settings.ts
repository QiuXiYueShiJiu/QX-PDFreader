// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

import type { ReaderSettings, ThemeMode, ThemePackDefaults, ThemePackId } from './types'

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

/** 主题包 id 列表（顺序与设置页的分段控件一致） */
export const PACK_IDS: readonly ThemePackId[] = ['classic', 'metro', 'glass']

/**
 * 主题 → 主题包。
 *
 * 配色是包内部的选项，形态由包决定：metro 主题属于 Metro 包、glass 主题属于
 * 液态玻璃包，其余 11 档配色（含插件市场装的 custom）都归「默认」包。
 * store.ts 用它写 `html[data-pack]`，CSS 的包级规则全部挂在这个属性上 ——
 * 所以液态玻璃的半透明对**任何一档配色**都成立，不是只对 glass 那一档写死。
 */
export function themePackOf(theme: ThemeMode): ThemePackId {
  if (theme === 'metro') return 'metro'
  if (theme === 'glass') return 'glass'
  return 'classic'
}

/**
 * 三个主题包各自的全套默认值。
 *
 * 这些是「出厂口径」，会随设置一起落盘（ReaderSettings.packDefaults），
 * 切包时由设置页套用到实时字段上；CSS 不直接读它们。
 *
 * 取值理由：
 *   · classic：10px 圆角 + 一层很浅的投影，和原来的观感最接近，不喧宾夺主；
 *   · metro：直角、无阴影、纯色（Metro 磁贴本来就没有立体感），工具栏更矮更紧凑；
 *   · glass：22px 大圆角 + 55% 半透明 + 18px 模糊 + 四周 10px 玻璃缝隙，
 *     投影比默认包更大更散，才像一块浮在背景上的玻璃。
 */
export const DEFAULT_PACK_DEFAULTS: Record<ThemePackId, ThemePackDefaults> = {
  classic: {
    radius: 10,
    blur: 0,
    panelAlpha: 1,
    shadow: '0 10px 24px rgb(0 0 0 / 0.12)',
    toolbarHeight: 46,
    gap: 0,
    accent: ''
  },
  metro: {
    radius: 0,
    blur: 0,
    panelAlpha: 1,
    shadow: '',
    toolbarHeight: 40,
    gap: 0,
    accent: '#0078d4'
  },
  glass: {
    radius: 22,
    blur: 18,
    panelAlpha: 0.55,
    shadow: '0 18px 40px rgb(0 0 0 / 0.18)',
    toolbarHeight: 46,
    /*
     * ★ gap 从 10 改成 0（2026-10-31，用户第 2 条）。
     *
     *   Windows 的窗口本身是方形的，缝隙露出来的是读写区底色而不是
     *   「桌面上浮着一块玻璃」—— 实际观感就是四周多了一圈没用的填充。
     *   归零之后外壳直接顶到窗口边缘，只在内部靠半透明与圆角表现质感。
     */
    gap: 0,
    accent: '#4c6ef5'
  }
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
  /* 2026-10-28：布局只保留 Office 一种，此项保留字段只为读旧设置，永远写 office。 */
  themeLayout: 'office',
  pageBackground: '#f5f1e8',
  readerImage: '',
  readerImageDim: 0.35,
  readerImageBlur: 0,
  /*
   * 主题包的三组实时参数（切包时会被该包的默认值整套替换，之后用户可单独调）。
   *   · glassRadius：圆角半径（px，0~28），三个包共用同一个值；
   *   · glassBlur：背景模糊（px，0~30），只有液态玻璃包会真的去糊；
   *   · panelAlpha：面板不透明度（0.35~1），1 = 纯色，越小越透背景。
   * 默认主题是 sepia（属于「默认」包），所以这里的初值就是 classic 包的口径。
   */
  glassRadius: 10,
  glassBlur: 0,
  panelAlpha: 1,
  /* 三个主题包各自的全套默认值：切包与「恢复本包默认」都读它 */
  packDefaults: DEFAULT_PACK_DEFAULTS,
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
   * 静默部署版忽略这个字段（它只走内置变量通道）。
   */
  updateChannel: 'auto',
  /* 强调色覆盖：空串 = 跟随主题；用户可换成自己的主题色 */
  accentColor: '',
  /* 插件市场装的主题包与当前选用项（默认空） */
  customThemes: [],
  customThemeId: '',
  /*
   * 插件市场的清单来源（2026-10-27 用户要求：默认 GitHub 源，可选镜像源）。
   * github = 直接读仓库里的 plugins/index.json（原始入口，别人提 PR 加包也走这里）；
   * mirror = 中转站 plugins.php（国内快，含还没同步到 GitHub 的包）。
   * 两个源同一份 schema，切换只影响「先问谁」，失败时仍会退到另一个。
   */
  marketSource: 'github' as const
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

/**
 * 过滤投影字符串。
 *
 * 这个值会被 store.ts 直接 setProperty('--panel-shadow', ...)，而 settings.json
 * 是磁盘上能被手改的数据；只放行「数字 + 常用长度/颜色/函数字符」，
 * 出现分号、花括号、url() 之类就退回默认包的投影。
 */
function sanitizeShadow(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const text = value.trim()
  if (!text) return ''
  if (/[;{}<>\\]/.test(text) || /url\s*\(/i.test(text) || /expression/i.test(text)) return fallback
  return /^[0-9a-z\s.,#/%()+-]+$/i.test(text) ? text : fallback
}

/** 校验并补齐三个主题包的默认值 */
function mergePackDefaults(raw: unknown): Record<ThemePackId, ThemePackDefaults> {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, Partial<ThemePackDefaults> | undefined>
  const out = {} as Record<ThemePackId, ThemePackDefaults>
  for (const id of PACK_IDS) {
    const base = DEFAULT_PACK_DEFAULTS[id]
    const input = src[id] && typeof src[id] === 'object' ? (src[id] as Partial<ThemePackDefaults>) : {}
    const accent = typeof input.accent === 'string' ? input.accent.trim().toLowerCase() : base.accent
    out[id] = {
      radius: clamp(input.radius ?? base.radius, 0, 28),
      blur: clamp(input.blur ?? base.blur, 0, 30),
      panelAlpha: clamp(input.panelAlpha ?? base.panelAlpha, 0.35, 1),
      shadow: sanitizeShadow(input.shadow ?? base.shadow, base.shadow),
      toolbarHeight: clamp(input.toolbarHeight ?? base.toolbarHeight, 32, 72),
      gap: clamp(input.gap ?? base.gap, 0, 24),
      accent: /^#[0-9a-f]{6}$/i.test(accent) || accent === '' ? accent : base.accent
    }
  }
  return out
}

/** 把可能残缺的配置合并到默认值上，保证字段完整 */
export function mergeSettings(raw: unknown): ReaderSettings {
  const base = cloneDefaults()
  if (!raw || typeof raw !== 'object') return base
  const input = raw as Partial<ReaderSettings>
  return {
    version: SETTINGS_VERSION,
    theme: normalizeTheme(input.theme, base.theme),
    // 旧设置里的 'normal' 一律升级成 office：布局设置已从界面移除，只剩一种。
    themeLayout: 'office',
    pageBackground: input.pageBackground ?? base.pageBackground,
    readerImage: typeof input.readerImage === 'string' ? input.readerImage : base.readerImage,
    readerImageDim: clamp01(input.readerImageDim ?? base.readerImageDim),
    readerImageBlur: clamp(input.readerImageBlur ?? base.readerImageBlur, 0, 24),
    glassRadius: clamp(input.glassRadius ?? base.glassRadius, 0, 28),
    glassBlur: clamp(input.glassBlur ?? base.glassBlur, 0, 30),
    panelAlpha: clamp(input.panelAlpha ?? base.panelAlpha, 0.35, 1),
    packDefaults: mergePackDefaults(input.packDefaults),
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
    customThemeId: typeof input.customThemeId === 'string' ? input.customThemeId : base.customThemeId,
    /* 只认这两个值；旧 settings.json 没有这个键时落回默认的 github */
    marketSource:
      input.marketSource === 'mirror' || input.marketSource === 'github'
        ? input.marketSource
        : base.marketSource
  }
}
