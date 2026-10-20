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

import { useEffect, useId, useRef, useState } from 'react'
import {
  BookOpenCheck,
  Eye,
  Keyboard,
  Maximize2,
  MonitorSmartphone,
  PanelLeft,
  Palette,
  Info,
  RefreshCw,
  X
} from 'lucide-react'
import type { ReaderSettings, ThemeMode } from '@shared/types'
import { useViewer } from '../store'

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
const THEME_OPTIONS: ReadonlyArray<{ value: ThemeMode; label: string; swatch: string }> = [
  { value: 'light', label: '浅色', swatch: '#f3f4f7' },
  { value: 'dark', label: '深色', swatch: '#1a1d24' },
  { value: 'sepia', label: '米色', swatch: '#ece0c8' }
]

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
                <span className="sb-field-label">主题</span>
                <span className="sb-field-hint">切换整体明暗风格，深色适合关灯上课，米色偏纸质、眼睛更放松</span>
              </div>
              <div className="sb-seg" role="group" aria-label="主题">
                {THEME_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className="sb-seg-btn"
                    aria-pressed={settings.theme === option.value}
                    onClick={() => onChange({ theme: option.value })}
                  >
                    <i className="sb-swatch" style={{ background: option.swatch }} aria-hidden="true" />
                    {option.label}
                  </button>
                ))}
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
          </section>

          {/* ---------------- 关于 ---------------- */}
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
