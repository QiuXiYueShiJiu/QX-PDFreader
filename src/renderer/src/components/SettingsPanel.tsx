// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 设置面板 —— 右侧滑出抽屉。
 *
 * 为什么选滑出而不是居中模态：
 *   · 一体机上老师往往一边看课件一边调设置，抽屉只遮右侧一条，阅读区仍然可见；
 *   · 所有改动即时生效，能立刻在左侧看到效果，模态会把这块反馈挡掉。
 *
 * 组件是纯受控的：自己不读也不写 window.pdfApp.settings，
 * 数据全部来自 props，避免出现「面板里一份、主界面一份」的双份状态。
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  BookOpenCheck,
  Eye,
  Image,
  Keyboard,
  RefreshCw,
  Maximize2,
  MonitorSmartphone,
  PanelLeft,
  Palette,
  Info,
  FileImage,
  X
} from 'lucide-react'
import { useViewer } from '../store'
import type { ReaderSettings, ThemeMode, ThemePackId } from '@shared/types'

/** 缩放预设：用 as const 保留字面量类型，减少 as 断言 */
const ZOOM_PRESETS = [
  { value: 'fit-width', label: '适应宽度', Icon: Maximize2, tip: '按窗口宽度铺满，最常用' },
  { value: 'fit-page', label: '适应整页', Icon: BookOpenCheck, tip: '整页放进窗口，一眼看全' },
  { value: 'actual', label: '实际大小', Icon: Eye, tip: '100% 原始尺寸' }
] as const


const UI_SCALE_MIN = 1
const UI_SCALE_MAX = 1.6
const UI_SCALE_STEP = 0.05


/** 主题选项：swatch 用该主题的真实底色，做到所见即所得 */
const THEME_OPTIONS: ReadonlyArray<{ value: ThemeMode; label: string; swatch: string; tip: string }> = [
  { value: 'light', label: '浅色', swatch: '#f3f4f7', tip: '明亮白底，适合光线充足的教室' },
  { value: 'warm', label: '暖灰', swatch: '#ece9e3', tip: '低饱和纸感，白天室内不反光' },
  { value: 'sepia', label: '米色', swatch: '#ece0c8', tip: '纸质米黄，长时间阅读更放松' },
  { value: 'forest', label: '护眼绿', swatch: '#ddeade', tip: '绿底白字，投影与白炽灯教室最不刺眼' },
  { value: 'dark', label: '深色', swatch: '#1a1d24', tip: '关灯上课不刺眼' },
  { value: 'night', label: '深夜', swatch: '#131a26', tip: '深蓝底，比纯黑柔和' },
  { value: 'contrast', label: '高对比', swatch: '#000000', tip: '纯黑底 + 暖金强调，大屏远距离最清楚' },
  { value: 'paper', label: '纸墨', swatch: '#f4f0e8', tip: '教科书内页的暖白，正文对比强，久看不累' },
  { value: 'plum', label: '青梅', swatch: '#eceeea', tip: '灰绿底 + 梅子粉强调，护眼又不发黄' },
  { value: 'glow', label: '柔光', swatch: '#faf9f6', tip: '几乎不压暗的日光白，靠窗教室最舒服' },
  { value: 'midnight', label: '午夜蓝', swatch: '#0e1626', tip: '深蓝底 + 青色强调，比纯黑柔和' },
  {
    value: 'metro',
    label: 'Metro',
    swatch: '#0078d4',
    tip: 'Windows 10 风格：直角磁贴、Segoe UI、单一强调色'
  },
  {
    value: 'glass',
    label: '液态玻璃',
    swatch: '#dfe8ff',
    tip: '半透明磨砂面板 + 大圆角，圆角与模糊可在下面调'
  }
]

/**
 * 主题包：把 9 档配色收成 3 个「包」，每个包有自己的设置项。
 *
 * 用户 2026-10-23 的要求是「现在有主题包：默认（已有的配色，除 metro）、
 * metro、液态玻璃」——所以「默认」包里放除 metro/glass 之外的 7 档，
 * 这样分段控件从 9 项降到 3 项，窄面板里也不会横向溢出（那就是用户
 * 截图里报的 bug）。
 */
const THEME_PACKS = [
  {
    id: 'classic',
    label: '默认',
    tip: '11 档内置配色：浅色 / 暖灰 / 米色 / 纸墨 / 护眼绿 / 青梅 / 柔光 / 深色 / 深夜 / 午夜蓝 / 高对比',
    themes: [
      'light',
      'warm',
      'sepia',
      'paper',
      'forest',
      'plum',
      'glow',
      'dark',
      'night',
      'midnight',
      'contrast'
    ] as ThemeMode[],
    fallback: 'sepia' as ThemeMode
  },
  {
    id: 'metro',
    label: 'Metro',
    tip: 'Windows 10 磁贴风格：直角、平色、Segoe UI',
    themes: ['metro'] as ThemeMode[],
    fallback: 'metro' as ThemeMode
  },
  {
    id: 'glass',
    label: '液态玻璃',
    tip: '半透明磨砂 + 大圆角，可调圆角半径与模糊强度',
    themes: ['glass'] as ThemeMode[],
    fallback: 'glass' as ThemeMode
  }
] as const

/**
 * 强调色预设。
 *
 * 三个主题包共用一组（前四个就是 Win10 磁贴色板里的常用色，Metro 包原本只有这四个）：
 * 用户抱怨「改不了颜色」，根因是强调色只在 Metro 包里露出来，默认包和液态玻璃包
 * 根本没有入口；自定义取色也只对阅读区底色开放。现在每个包都有预设色 + 取色器 + 恢复默认。
 */
const ACCENT_PRESETS = [
  { value: '#0078d4', label: '蓝' },
  { value: '#107c10', label: '绿' },
  { value: '#c239b3', label: '紫' },
  { value: '#d13438', label: '红' },
  { value: '#4c6ef5', label: '靛' },
  { value: '#b5651d', label: '琥珀' },
  { value: '#0f766e', label: '青' },
  { value: '#475569', label: '灰' }
] as const

/*
 * 各主题包自己的主色不在这里写死：它已经是 packDefaults[id].accent 的一部分
 * （见 shared/settings.ts 的 DEFAULT_PACK_DEFAULTS），强调色控件的「默认」按钮
 * 与「恢复本包默认」按钮读的是同一份数据，不会出现两套口径。
 */

/**
 * 「恢复本包默认」按钮要回填的字段。
 *
 * 三个实时字段 + 强调色，正好就是设置页里能调的全部形态项：
 * 恢复默认不是重置整个设置，只重置「这个包自己的观感」。
 */
function packDefaultsPatch(settings: ReaderSettings, packId: ThemePackId): Partial<ReaderSettings> {
  const preset = settings.packDefaults[packId]
  return {
    glassRadius: preset.radius,
    glassBlur: preset.blur,
    panelAlpha: preset.panelAlpha,
    accentColor: preset.accent
  }
}

/**
 * 内置阅读底色。
 *
 * 前四个是浅色纸感（白纸 / 米黄 / 浅灰 / 浅绿），
 * 后两个是深色（深灰 / 纯黑），投影和暗环境各有一套。
 */
const PAGE_COLORS = [
  { value: '#ffffff', label: '纯白' },
  { value: '#f5f1e8', label: '米黄' },
  { value: '#e9edf2', label: '浅灰' },
  { value: '#e6f0e6', label: '浅绿' },
  { value: '#3a3f47', label: '深灰' },
  { value: '#000000', label: '纯黑' }
] as const

interface SettingsPanelProps {
  settings: ReaderSettings
  onChange: (patch: Partial<ReaderSettings>) => void
  onClose: () => void
}

/** 导出形式与同目录的 Sidebar / Toolbar / RightPanel 保持一致，统一用具名导出 */
export function SettingsPanel({ settings, onChange, onClose }: SettingsPanelProps): JSX.Element {
  /** 打开时把焦点移进来，关闭时还给原来的元素 —— 键盘和读屏用户才不会迷路 */
  const panelRef = useRef<HTMLDivElement | null>(null)
  const idPrefix = useId()

  /** 背景图预览：与主界面走同一条 pdf-file 协议 */
  const readerImageUrl = useMemo(() => {
    if (!settings.readerImage) return ''
    const encoded = settings.readerImage
      .replace(/\\/g, '/')
      .split('/')
      .map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ':'))
      .join('/')
    return `pdf-file:///${encoded}`
  }, [settings.readerImage])

  const [picking, setPicking] = useState(false)
  const onPickImage = async (): Promise<void> => {
    if (picking) return
    setPicking(true)
    try {
      const picked = await window.pdfApp.app.pickBackground()
      if (picked.ok && picked.path) onChange({ readerImage: picked.path })
    } finally {
      setPicking(false)
    }
  }

  /**
   * 「关于」里的版本号来自主进程。
   *
   * 以前这里写死成「版本 1.1.0.1」，打包升到 1.2/2.0 之后界面还显示 1.1.0.1 ——
   * 用户看到版本号和安装包对不上，会以为装错了。现在由主进程读 package.json
   * （打包后读 app.getVersion()）并通过 app:info 传过来，界面不再硬编码。
   */
  const [about, setAbout] = useState<{
    version: string
    build: string
    publisher: string
    site: string
    notice: string
    variant: string
    org: string
    usageScope: string
    support: string
  } | null>(null)

  useEffect(() => {
    let alive = true
    void window.pdfApp?.app.info().then((info) => {
      if (!alive || !info) return
      setAbout({
        version: info.version,
        build: info.build,
        publisher: info.publisher,
        site: info.site,
        notice: info.notice,
        variant: info.variant,
        org: info.org,
        usageScope: info.usageScope,
        support: info.support
      })
    })
    return () => {
      alive = false
    }
  }, [])

  /* ---------- 检查更新 ---------- */
  /**
   * 手动检查（设置页入口）。
   *
   * 查到新版本时把结果塞进全局 store —— 右下角浮层会自动出现并开始下载，
   * 用户不需要在这里再点一次「下载」。查不到就只在本卡片里回一句，
   * 不打扰界面其它部分。
   */
  const checkUpdateNow = useViewer((s) => s.checkUpdateNow)
  const setShowThemeStore = useViewer((s) => s.setShowThemeStore)
  const rollbackVersions = useViewer((s) => s.rollbackVersions)
  const loadRollback = useViewer((s) => s.loadRollback)
  const applyRollback = useViewer((s) => s.applyRollback)
  const onRollback = async (version: string): Promise<void> => {
    await applyRollback(version)
  }
  useEffect(() => {
    void loadRollback()
  }, [loadRollback])
  const [checking, setChecking] = useState(false)
  const [checkMsg, setCheckMsg] = useState('')

  const onCheckUpdate = async (): Promise<void> => {
    if (checking) return
    setChecking(true)
    setCheckMsg('')
    try {
      const result = await checkUpdateNow()
      if (!result.ok) setCheckMsg(result.error ?? '检查失败，请稍后再试')
      else if (result.newer) setCheckMsg(`发现新版本 v${result.latest}，正在下载…`)
      else setCheckMsg('已是最新版本')
    } catch {
      setCheckMsg('检查失败，请稍后再试')
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    const previous = document.activeElement
    panelRef.current?.focus()
    return () => {
      // 卸载时才还原，且只在原元素还挂在文档里时还原
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

  // Esc 关闭。挂在 document 上而不是面板上：即使焦点被浏览器挪走（比如点过颜色输入框），
  // Esc 依然要能关掉面板，否则用户会被困住。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  /**
   * 焦点循环（最小可用的焦点陷阱）。
   *
   * 面板带遮罩、且标了 aria-modal，如果不拦 Tab，键盘用户会一路 Tab 到被遮住的
   * 主界面上，读屏也会念出看不见的内容 —— 视觉上「弹窗打开着」，焦点却跑掉了。
   * 这里只做 Tab / Shift+Tab 的首尾回绕，不搞完整焦点管理（本项目没有多弹窗嵌套）。
   */
  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const items = focusableItems(panel)
      if (items.length === 0) {
        event.preventDefault()
        panel.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (event.shiftKey) {
        if (active === first || !panel.contains(active)) {
          event.preventDefault()
          last.focus()
        }
      } else if (active === last || !panel.contains(active)) {
        event.preventDefault()
        first.focus()
      }
    }

    panel.addEventListener('keydown', onKeyDown)
    return () => panel.removeEventListener('keydown', onKeyDown)
  }, [])

  // defaultZoom 是 'fit-width' | 'fit-page' | 'actual' | number 的联合类型。
  // 用一个辅助函数归一化，避免 TS 在布尔别名上的收窄不够确定（实测会报 TS2362）。

  const colorKey = settings.pageBackground.trim().toLowerCase()
  const isPresetColor = PAGE_COLORS.some((preset) => preset.value === colorKey)

  /* 当前属于哪个主题包（认不出的主题值兜底到「默认」包，不至于整块消失） */
  const activePack =
    THEME_PACKS.find((pack) => (pack.themes as readonly ThemeMode[]).includes(settings.theme)) ??
    THEME_PACKS[0]

  return (
    <div className="sb-settings-overlay">
      {/* 背板负责变暗背景，点它就当「取消」，符合抽屉类面板的普遍预期 */}
      <div className="sb-settings-scrim" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        className="sb-settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${idPrefix}-title`}
        tabIndex={-1}
      >
        <header className="sb-settings-head">
          <div className="sb-settings-head-text">
            <h2 className="sb-settings-title" id={`${idPrefix}-title`}>
              设置
            </h2>
            <p className="sb-settings-subtitle">改动会立即保存并生效，按 Esc 可关闭</p>
          </div>
          <button type="button" className="sb-icon-btn" onClick={onClose} aria-label="关闭设置" title="关闭设置">
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="sb-settings-body">
          {/* ---------------- 外观 ---------------- */}
          <section className="sb-card" aria-labelledby={`${idPrefix}-sec-look`}>
            <h3 className="sb-card-title" id={`${idPrefix}-sec-look`}>
              <Palette size={15} aria-hidden="true" />
              外观
            </h3>

            <div className="sb-field">
              <div className="sb-field-text">
                <span className="sb-field-label">主题包</span>
                <span className="sb-field-hint">
                  先选主题包，再调这个包自己的配色 / 圆角；切换包会用它默认的那一档
                </span>
              </div>
              <div className="sb-seg" role="group" aria-label="主题包">
                {THEME_PACKS.map((pack) => (
                  <button
                    key={pack.id}
                    type="button"
                    className="sb-seg-btn"
                    data-theme-pack={pack.id}
                    aria-pressed={activePack.id === pack.id}
                    title={pack.tip}
                    onClick={() => {
                      if (activePack.id === pack.id) return
                      /*
                       * 1.0.8.3：布局不再是一个独立开关，而是**主题包自带属性**。
                       * Metro（Windows 磁贴风）天生就是 Office 2019 那套功能区布局，
                       * 其余包保持经典布局 —— 切包即切布局，用户不用再理解两个概念。
                       * themeLayout 字段保留，只用于承载这个派生结果与旧设置迁移。
                       */
                      onChange({
                        theme: pack.fallback,
                        themeLayout: pack.id === 'metro' ? 'office' : 'normal',
                        /*
                         * 切包 = 套用这个包的一整套默认值，而不只是换配色。
                         * 圆角 / 模糊 / 面板透明度 / 强调色一起换，用户才有
                         * 「换了一个主题」而不是「换了个颜色」的感觉。
                         */
                        ...packDefaultsPatch(settings, pack.id)
                      })
                    }}
                  >
                    {pack.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 「默认」包：7 档内置配色的色卡 */}
            {activePack.id === 'classic' ? (
              <div className="sb-field">
                <div className="sb-field-text">
                  <span className="sb-field-label">配色</span>
                  <span className="sb-field-hint">深色适合关灯上课，米色偏纸质更护眼</span>
                </div>
                <div className="sb-seg" role="group" aria-label="主题">
                  {THEME_OPTIONS.filter((option) =>
                    (activePack.themes as readonly ThemeMode[]).includes(option.value)
                  ).map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className="sb-seg-btn"
                      data-theme-option={option.value}
                      aria-pressed={settings.theme === option.value}
                      title={option.tip}
                      onClick={() => onChange({ theme: option.value })}
                    >
                      <i className="sb-swatch" style={{ background: option.swatch }} aria-hidden="true" />
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {/* 强调色：三个主题包都能改（预设 + 自定义取色 + 恢复默认） */}
            <div className="sb-field">
              <div className="sb-field-text">
                <span className="sb-field-label">强调色</span>
                <span className="sb-field-hint">
                  按钮、选中态、图标都用这个颜色；三个主题包都能改，改完立刻生效
                </span>
              </div>
              <div className="sb-colors" role="group" aria-label="强调色">
                {ACCENT_PRESETS.map((accent) => (
                  <button
                    key={accent.value}
                    type="button"
                    className="sb-color-btn"
                    style={{ background: accent.value }}
                    aria-label={`强调色：${accent.label}`}
                    aria-pressed={settings.accentColor.toLowerCase() === accent.value}
                    data-accent-preset={accent.value}
                    title={accent.label}
                    onClick={() => onChange({ accentColor: accent.value })}
                  />
                ))}
                <label
                  className="sb-color-custom"
                  title={`自定义强调色${settings.accentColor ? `（${settings.accentColor}）` : ''}`}
                >
                  <input
                    type="color"
                    value={
                      /^#[0-9a-f]{6}$/i.test(settings.accentColor)
                        ? settings.accentColor
                        : settings.packDefaults[activePack.id].accent || '#c0392b'
                    }
                    aria-label="自定义强调色"
                    data-accent-custom="1"
                    onChange={(event) => onChange({ accentColor: event.target.value })}
                  />
                  <span>自定</span>
                </label>
                <button
                  type="button"
                  className="sb-btn sb-btn--ghost sb-color-reset"
                  onClick={() => onChange({ accentColor: '' })}
                  disabled={!settings.accentColor}
                  data-accent-reset="1"
                  title="恢复这个主题包自带的主色"
                >
                  默认
                </button>
              </div>
            </div>

            {/*
              主题包形态：圆角与面板透明度三个包都能调，模糊只有液态玻璃包露出来。
              滑块 onChange → patchSettings → applyTheme 写行内变量，所以是「拖动即见效」，
              不需要重渲染整个界面；值同时落盘，下次启动还在。
            */}
            <div className="sb-field sb-field--stack">
              <div className="sb-field-text">
                <span className="sb-field-label">形态细节</span>
                <span className="sb-field-hint">
                  圆角与面板透明度对三个包都生效；模糊只有液态玻璃包看得出来。当前包：
                  {activePack.label}
                </span>
              </div>
              <label className="sb-range" htmlFor={`${idPrefix}-theme-radius`}>
                <span className="sb-range__label">圆角 {settings.glassRadius}px</span>
                {/* 旧属性名 data-glass-radius 保留：tools/verify-theme-pack.mjs 靠它找滑块 */}
                <input
                  id={`${idPrefix}-theme-radius`}
                  type="range"
                  min={0}
                  max={28}
                  step={1}
                  value={settings.glassRadius}
                  data-tb-id="theme-radius"
                  data-glass-radius="1"
                  onChange={(event) => onChange({ glassRadius: Number(event.target.value) })}
                />
              </label>
              {activePack.id === 'glass' ? (
                <label className="sb-range" htmlFor={`${idPrefix}-glass-blur`}>
                  <span className="sb-range__label">模糊 {settings.glassBlur}px</span>
                  <input
                    id={`${idPrefix}-glass-blur`}
                    type="range"
                    min={0}
                    max={30}
                    step={1}
                    value={settings.glassBlur}
                    data-tb-id="glass-blur"
                    data-glass-blur="1"
                    onChange={(event) => onChange({ glassBlur: Number(event.target.value) })}
                  />
                </label>
              ) : null}
              <label className="sb-range" htmlFor={`${idPrefix}-theme-panel-alpha`}>
                <span className="sb-range__label">
                  面板透明度 {Math.round(settings.panelAlpha * 100)}%
                </span>
                <input
                  id={`${idPrefix}-theme-panel-alpha`}
                  type="range"
                  min={0.35}
                  max={1}
                  step={0.01}
                  value={settings.panelAlpha}
                  data-tb-id="theme-panel-alpha"
                  onChange={(event) => onChange({ panelAlpha: Number(event.target.value) })}
                />
              </label>
              <div className="sb-field-actions">
                <button
                  type="button"
                  className="sb-btn sb-btn--ghost"
                  data-tb-id="pack-reset"
                  onClick={() => onChange(packDefaultsPatch(settings, activePack.id))}
                  title="只恢复这个主题包的圆角 / 模糊 / 面板透明度 / 强调色，其它设置不动"
                >
                  恢复「{activePack.label}」默认
                </button>
              </div>
            </div>

            <div className="sb-field">
              <div className="sb-field-text">
                <span className="sb-field-label">阅读区底色</span>
                <span className="sb-field-hint">PDF 页面背后的颜色，和主题分开设置，方便长时间护眼阅读</span>
              </div>
              <div className="sb-colors" role="group" aria-label="阅读区底色">
                {PAGE_COLORS.map((preset) => (
                  <button
                    key={preset.value}
                    type="button"
                    className="sb-color-btn"
                    style={{ background: preset.value }}
                    aria-label={`阅读区底色：${preset.label}`}
                    aria-pressed={colorKey === preset.value}
                    title={preset.label}
                    onClick={() => onChange({ pageBackground: preset.value })}
                  />
                ))}
                <label
                  className={isPresetColor ? 'sb-color-custom' : 'sb-color-custom is-active'}
                  title={isPresetColor ? '自定义颜色' : `自定义颜色（${colorKey}）`}
                >
                  <input
                    type="color"
                    value={/^#[0-9a-f]{6}$/.test(colorKey) ? colorKey : '#ffffff'}
                    aria-label="自定义阅读区底色"
                    onChange={(event) => onChange({ pageBackground: event.target.value })}
                  />
                  <span>自定</span>
                </label>
              </div>
            </div>


            {/* 2026-10-28：布局设置整块删除。界面只剩 Office 一种布局，
                还留着开关只会让人以为能改（原来那个 hidden 也没真隐藏，
                .sb-field 的 display:flex 压过了 [hidden] 的默认 display:none）。 */}

            <div className="sb-field">
              <div className="sb-field-text">
                <span className="sb-field-label">
                  <Image size={14} aria-hidden="true" />
                  背景图片
                </span>
                <span className="sb-field-hint">
                  用自己的照片或壁纸垫在 PDF 页面后面；压暗与模糊只作用于背景，不影响阅读
                </span>
              </div>
              <div className="sb-bgpic">
                {settings.readerImage ? (
                  <img className="sb-bgpic-thumb" src={readerImageUrl} alt="当前背景" />
                ) : (
                  <span className="sb-bgpic-empty">未设置</span>
                )}
                <div className="sb-bgpic-actions">
                  <button type="button" className="sb-btn" onClick={onPickImage} data-tb-id="settings-bg-pick">
                    选择图片
                  </button>
                  <button
                    type="button"
                    className="sb-btn sb-btn--ghost"
                    onClick={() => onChange({ readerImage: '' })}
                    disabled={!settings.readerImage}
                    data-tb-id="settings-bg-clear"
                  >
                    清除
                  </button>
                </div>
              </div>
              <div className="sb-field-control">
                <output className="sb-readout">{Math.round(settings.readerImageDim * 100)}%</output>
                <input
                  type="range"
                  min={0}
                  max={0.85}
                  step={0.05}
                  value={settings.readerImageDim}
                  aria-label="背景压暗程度"
                  onChange={(event) => onChange({ readerImageDim: Number(event.target.value) })}
                />
              </div>
              <div className="sb-field-control">
                <output className="sb-readout">{settings.readerImageBlur}px</output>
                <input
                  type="range"
                  min={0}
                  max={24}
                  step={1}
                  value={settings.readerImageBlur}
                  aria-label="背景模糊半径"
                  onChange={(event) => onChange({ readerImageBlur: Number(event.target.value) })}
                />
              </div>
              <div className="sb-field-hint" style={{ marginTop: 4 }}>
                想要更多配色？去
                <button
                  type="button"
                  className="sb-link"
                  data-tb-id="settings-open-market"
                  onClick={() => setShowThemeStore(true)}
                >
                  主题商店
                </button>
                看看社区配色包
              </div>
            </div>

            <div className="sb-field">
              <div className="sb-field-text">
                <span className="sb-field-label">
                  <MonitorSmartphone size={14} aria-hidden="true" />
                  界面缩放
                </span>
                <span className="sb-field-hint">
                  整体放大按钮与文字，教室后排也能看清；与 PDF 的缩放互不影响
                </span>
              </div>
              <div className="sb-field-control">
                <output className="sb-readout">{settings.uiScale.toFixed(2)}×</output>
                <input
                  type="range"
                  className="sb-range"
                  min={UI_SCALE_MIN}
                  max={UI_SCALE_MAX}
                  step={UI_SCALE_STEP}
                  value={settings.uiScale}
                  aria-label="界面缩放"
                  onChange={(event) => onChange({ uiScale: Number(event.target.value) })}
                />
              </div>
            </div>
          </section>

          {/* ---------------- 阅读 ---------------- */}
          <section className="sb-card" aria-labelledby={`${idPrefix}-sec-read`}>
            <h3 className="sb-card-title" id={`${idPrefix}-sec-read`}>
              <BookOpenCheck size={15} aria-hidden="true" />
              阅读
            </h3>

            <div className="sb-field">
              <div className="sb-field-text">
                <span className="sb-field-label">默认缩放</span>
                <span className="sb-field-hint">每次打开新文档时的初始比例，也可以用下面的滑块指定百分比</span>
              </div>
              <div className="sb-seg" role="group" aria-label="默认缩放">
                {ZOOM_PRESETS.map(({ value, label, Icon, tip }) => (
                  <button
                    key={value}
                    type="button"
                    className="sb-seg-btn"
                    aria-pressed={settings.defaultZoom === value}
                    title={tip}
                    onClick={() => onChange({ defaultZoom: value })}
                  >
                    <Icon size={14} aria-hidden="true" />
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/*
              说明：这里原本还有一个「指定缩放比例」滑块。
              它与上面的「默认缩放」预设重复（预设已含适应宽度/整页/实际大小），
              两个控件都能改同一个字段，用户反而不知道该动哪个，因此移除。
              需要任意比例时用工具栏或双指捏合即可。
            */}

            <div className="sb-field sb-field-inline">
              <div className="sb-field-text">
                <span className="sb-field-label">记住上次阅读位置</span>
                <span className="sb-field-hint">
                  下次打开同一份文档时自动跳回上次那一页，中途被叫走也不怕丢进度
                </span>
              </div>
              <Switch
                id={`${idPrefix}-restore`}
                label="记住上次阅读位置"
                checked={settings.restoreLastPosition}
                onChange={(checked) => onChange({ restoreLastPosition: checked })}
              />
            </div>
          </section>

          {/* ---------------- 界面 ---------------- */}
          <section className="sb-card" aria-labelledby={`${idPrefix}-sec-ui`}>
            <h3 className="sb-card-title" id={`${idPrefix}-sec-ui`}>
              <PanelLeft size={15} aria-hidden="true" />
              界面
            </h3>

            <div className="sb-field sb-field-inline">
              <div className="sb-field-text">
                <span className="sb-field-label">
                  <PanelLeft size={14} aria-hidden="true" />
                  默认显示左侧栏
                </span>
                <span className="sb-field-hint">启动时展开左侧缩略图 / 目录栏，方便按页跳转</span>
              </div>
              <Switch
                id={`${idPrefix}-sidebar`}
                label="默认显示左侧栏"
                checked={settings.showSidebar}
                onChange={(checked) => onChange({ showSidebar: checked })}
              />
            </div>

            {/*
              说明：这里原本还有一个「最近打开记录条数」滑块。
              它对使用者没有实际价值（保留多少条并不影响体验），
              却占据一整行、还容易被误调成很小的值导致记录丢失，因此移除，
              代码里保留默认上限。
            */}

            <div className="sb-field sb-field-inline">
              <div className="sb-field-text">
                <span className="sb-field-label">
                  <Keyboard size={14} aria-hidden="true" />
                  启用键盘快捷键
                </span>
                <span className="sb-field-hint">
                  翻页、缩放等快捷键生效；外接键盘打字录入批注时可临时关掉，避免误触翻页
                </span>
              </div>
              <Switch
                id={`${idPrefix}-shortcuts`}
                label="启用键盘快捷键"
                checked={settings.enableShortcuts}
                onChange={(checked) => onChange({ enableShortcuts: checked })}
              />
            </div>
          </section>

          {/* ---------------- 文件关联 ---------------- */}
          <section className="sb-card" aria-labelledby={`${idPrefix}-sec-assoc`}>
            <h3 className="sb-card-title" id={`${idPrefix}-sec-assoc`}>
              <FileImage size={15} aria-hidden="true" />
              文件关联
            </h3>
            <div className="sb-field sb-field--stack">
              <div className="sb-field-text">
                <span className="sb-field-label">把图片交给秋夕打开</span>
                <span className="sb-field-hint">
                  安装时已登记 PDF 与常见图片格式。Windows 10/11 把「默认打开方式」锁在用户设置里，
                  安装器改不了，需要你在设置页点一次「秋夕-PDF阅读器」。
                </span>
              </div>
              <div className="sb-row">
                <button
                  type="button"
                  className="sb-btn sb-btn-primary"
                  data-tb-id="settings-open-default-apps"
                  onClick={() => {
                    void window.pdfApp.app.openDefaultApps()
                  }}
                >
                  打开默认应用设置
                </button>
                <span className="sb-field-hint">
                  改完回到这里，双击 .png / .jpg 就会用秋夕打开。
                </span>
              </div>
            </div>
          </section>
          {/* ---------------- 关于 ---------------- */}
          {/* ---------------- 更新 ---------------- */}
          <section className="sb-card" aria-labelledby={`${idPrefix}-sec-update`}>
            <h3 className="sb-card-title" id={`${idPrefix}-sec-update`}>
              <RefreshCw size={15} aria-hidden="true" />
              更新
            </h3>

            <p className="sb-field-hint" data-update-current="1">
              当前版本 {about?.build || about?.version || '…'}
            </p>

            <div className="sb-field-inline">
              <button
                type="button"
                className="sb-btn sb-btn-primary"
                data-tb-id="settings-check-update"
                disabled={checking}
                onClick={() => void onCheckUpdate()}
              >
                {checking ? '正在检查…' : '检查更新'}
              </button>
              {checkMsg ? (
                <span className="sb-field-hint" data-update-msg="1">
                  {checkMsg}
                </span>
              ) : null}
            </div>

            <Switch
              id={`${idPrefix}-update-auto`}
              label="启动时自动检查更新"
              checked={settings.updateAutoCheck}
              onChange={(v) => onChange({ updateAutoCheck: v })}
            />
            <p className="sb-field-hint">
              自动检查是静默的：只有查到新版本才会在右下角提示并开始下载，下载完由你决定什么时候装。
            </p>

            {/*
              回滚（2.0.0 / B13）。
              只列「保留着的旧安装包」，最多三份 —— 这些都是自动更新时顺手存下的，
              不是让用户自己去找安装包。连续两次启动没进界面，主进程会自己弹框问。
            */}
            {rollbackVersions.length > 0 ? (
              <div className="sb-field" data-rollback="1">
                <span className="sb-label">回滚到旧版本</span>
                <p className="sb-field-hint">
                  还留着 {rollbackVersions.length} 个旧安装包。装回去不会动设置、最近文件和批注。
                </p>
                <div className="sb-field-inline">
                  {rollbackVersions.map((entry) => (
                    <button
                      key={entry.version}
                      type="button"
                      className="sb-btn"
                      data-tb-id={`rollback-${entry.version}`}
                      onClick={() => void onRollback(entry.version)}
                      title={`${entry.version} · ${Math.round(entry.size / 1048576)}MB`}
                    >
                      回滚到 {entry.version}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {/*
              通道偏好：只有公开版能选。

              2026-10-28（需求清单 B2 / B3）：两件事一起改。
              · 原来这里有一句「静默部署版没有这个选项……」，等于在公开版里讲解一个
                用户根本装不到的版本 —— 正式版里不该出现任何特殊版本的说明，整段删掉。
              · 定制版本（variant 不是 standard）不该让用户改更新源：它只认内置通道，
                给了选择器只会让人以为能换。所以整块在非公开版不渲染，只留上面的
                「检查更新」按钮。
            */}
            {about?.variant === 'standard' ? (
              <div className="sb-field">
                <span className="sb-field-label">更新来源</span>
                <div className="sb-seg" role="radiogroup" aria-label="更新来源" data-update-channel="1">
                  {(
                    [
                      ['auto', '自动', '两条都查，取版本更高的（同版本优先镜像站）'],
                      ['mirror', '镜像站', '只查镜像站，国内最快'],
                      ['github', 'GitHub', '只查 GitHub Releases']
                    ] as const
                  ).map(([value, label, tip]) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={settings.updateChannel === value}
                      /* 与面板里其它分段控件保持同一套样式钩子（.sb-seg-btn[aria-pressed]） */
                      aria-pressed={settings.updateChannel === value}
                      data-update-channel-option={value}
                      className="sb-seg-btn"
                      title={tip}
                      onClick={() => onChange({ updateChannel: value })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="sb-field-hint">
                  自动会同时问镜像站与 GitHub，取版本更高的那个；同版本优先用镜像站，下载更快。
                </p>
              </div>
            ) : null}

          </section>

          <section className="sb-card" aria-labelledby={`${idPrefix}-sec-about`}>
            <h3 className="sb-card-title" id={`${idPrefix}-sec-about`}>
              <Info size={15} aria-hidden="true" />
              关于
            </h3>

            <div className="sb-about">
              <p className="sb-about__name">秋夕-PDF阅读器</p>
              <p className="sb-about__version">
                版本 {about?.version ?? '…'}
                {about?.build ? `（构建 ${about.build}）` : ''}
              </p>
              {/*
                著作权声明。
                单独成行、字号略大并使用主色，确保在任何主题下都清晰可读 ——
                这是归属信息，不该被当成可有可无的脚注藏起来。
              */}
              <p className="sb-about__author">
                著作权所有 <strong>by {about?.publisher ?? '秋夕月拾旧'}</strong>
              </p>

              {/* 官方网站与授权协议：品牌与合规信息，缺一不可 */}
              {about?.site ? (
                <p className="sb-about__site" data-about-site="1">
                  官方网站：<strong>{about.site}</strong>
                </p>
              ) : null}
              {about?.notice ? (
                <p className="sb-about__license" data-about-license="1">
                  {about.notice}
                </p>
              ) : null}

              {/*
                使用单位 / 适用范围 / 技术支持。
                用分隔线与上面的著作权信息分开：
                  著作权回答「谁做的」，使用单位回答「谁在用」，
                  两者性质不同，混排会让人误以为使用单位是版权方。

                ★ 公开版这三个字段**恒为空串**（主进程只在专供版注入），
                  所以公开版安装包不会渲染出任何单位信息 ——
                  这是「公开版不含隐私信息」这条要求在界面上的落点。
              */}
              {about?.org || about?.usageScope || about?.support ? (
                <div className="sb-about__meta">
                  {about.org ? (
                    <p className="sb-about__org" data-about-org="1">
                      使用单位：<strong>{about.org}</strong>
                    </p>
                  ) : null}
                  {about.usageScope ? (
                    <p className="sb-about__scope" data-about-scope="1">
                      适用范围：{about.usageScope}
                    </p>
                  ) : null}
                  {about.support ? (
                    <p className="sb-about__support" data-about-support="1">
                      {about.support}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

/* ============================================================
 * 局部工具
 * ============================================================ */

/**
 * 取容器内可聚焦的元素（用于 Tab 首尾回绕）。
 *
 * 用 getClientRects() 而不是 offsetParent 判可见性：本组件把 checkbox / color
 * 输入框做了「opacity: 0 但保留原生控件」的处理，offsetParent 对某些定位上下文
 * 会误判，而 getClientRects() 在 display: none 与 visibility: hidden 时长度才是 0，
 * 正好符合「隐藏的浮动按钮不该进 Tab 序列」的诉求。
 */
function focusableItems(container: HTMLElement): HTMLElement[] {
  const selector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',')
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => el.getClientRects().length > 0
  )
}



/* ============================================================
 * 局部控件
 * ============================================================ */

interface SwitchProps {
  id: string
  /** 控件的可访问名；视觉标签由外层 sb-field-label 提供，这里只给读屏用 */
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}

/**
 * 开关。
 *
 * 用真实的 <input type="checkbox"> 承载状态与键盘交互（Tab 聚焦、空格切换），
 * 只是把它视觉隐藏、在旁边画一个滑块 —— 用 div 假装开关会丢掉读屏播报和键盘操作。
 */
function Switch({ id, label, checked, onChange }: SwitchProps): JSX.Element {
  return (
    <label className="sb-switch" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        className="sb-switch-input"
        role="switch"
        aria-label={label}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="sb-switch-track" aria-hidden="true" />
    </label>
  )
}
