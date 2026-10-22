// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 工具栏。
 *
 * 布局：左侧（导航）｜中间（页码）｜右侧（缩放、视图、面板开关）
 *
 * 触屏优先：按钮 34×34 起，页码输入框可直接点开输入跳转 ——
 * 讲课时老师常要「跳到第 37 页」，比连续点翻页快得多。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Briefcase,
  ChevronLeft,
  ChevronRight,
  Columns2,
  File,
  LayoutPanelLeft,
  Minus,
  MoreHorizontal,
  Plus,
  RotateCw,
  Rows3,
  ScanText,
  Search,
  Settings,
  Square
} from 'lucide-react'
import { useViewer } from '../store'

/**
 * 工具栏自适应参数。
 *
 * 用户的要求是「两者都要」：按钮本身可以在一定范围内缩小，
 * 缩到下限还放不下，就把次要按钮收进溢出菜单。
 * 只有一段区间是没用的 —— 窄窗口下要么按钮小到看不清，
 * 要么一路挤到换行，两种都难看。
 */
const MIN_TOOLBAR_SCALE = 0.82
const MAX_TOOLBAR_SCALE = 1

/**
 * 收进溢出菜单的优先顺序（**先收前面的**）。
 *
 * 排序原则是「讲课时的使用频率」：
 *   设置、右栏、左栏都是装一次就不再动的，最先收；
 *   旋转偶尔用；视图模式会切；缩放是每节课都要用的，最后才收。
 * 翻页与「打开」永远不进这个列表 —— 它们不见了工具栏就没意义了。
 */
const OVERFLOW_ORDER = ['settings', 'left-panel', 'rotate', 'viewmode', 'zoom-out', 'zoom-in']


export function Toolbar(): JSX.Element {
  const page = useViewer((s) => s.page)
  const pageCount = useViewer((s) => s.pageCount)
  const zoom = useViewer((s) => s.zoom)
  const actualScale = useViewer((s) => s.actualScale)
  const viewMode = useViewer((s) => s.viewMode)
  const showSidebar = useViewer((s) => s.showSidebar)
const requestOcr = useViewer((s) => s.requestOcr)
  const setShowTools = useViewer((s) => s.setShowTools)
  const showSearch = useViewer((s) => s.showSearch)
  const hasDoc = useViewer((s) => s.filePath !== '')

  const pickFile = useViewer((s) => s.pickFile)
  const prevPage = useViewer((s) => s.prevPage)
  const nextPage = useViewer((s) => s.nextPage)
  const setPage = useViewer((s) => s.setPage)
  const zoomIn = useViewer((s) => s.zoomIn)
  const zoomOut = useViewer((s) => s.zoomOut)
  const setZoom = useViewer((s) => s.setZoom)
  const rotate = useViewer((s) => s.rotate)
  const setViewMode = useViewer((s) => s.setViewMode)
  const toggleSidebar = useViewer((s) => s.toggleSidebar)
  const setShowSearch = useViewer((s) => s.setShowSearch)
  const setShowSettings = useViewer((s) => s.setShowSettings)

  /** 页码输入框的本地值（允许用户输入过程中不被同步覆盖） */
  const [pageInput, setPageInput] = useState(String(page))

  useEffect(() => {
    setPageInput(String(page))
  }, [page])

  const commitPage = (): void => {
    const n = Number(pageInput)
    if (Number.isFinite(n)) setPage(n)
    else setPageInput(String(page))
  }

  /* ---------- 自适应：缩放 + 溢出 ---------- */

  const barRef = useRef<HTMLDivElement>(null)
  /** 已经收进溢出菜单的按钮 id */
  const [hidden, setHidden] = useState<string[]>([])
  /** 当前缩放系数，写到 CSS 变量上由样式消费 */
  const [scale, setScale] = useState(MAX_TOOLBAR_SCALE)

  /*
   * 重新测量并决定「缩放多少、收哪几个」。
   *
   * 为什么要用 useLayoutEffect + ResizeObserver 而不是「只在窗口 resize 时算」：
   *   工具栏的可用宽度并不只由窗口决定 —— 左侧栏、右侧栏一开一关，
   *   中间那段就跟着变，而这类变化不触发 window.resize。
   *   用 ResizeObserver 直接盯工具栏自己的宽度，来源唯一且必然准确。
   */
  const remeasure = useCallback((): void => {
    const bar = barRef.current
    if (!bar) return
    const avail = bar.clientWidth
    if (avail <= 0) return

    /*
     * ★ 量「自然宽度」不能读 scrollWidth。
     *
     *   踩坑记录：一开始用 `bar.scrollWidth`，结果从 1440px 一路缩到
     *   520px 它都恒等于 clientWidth，看起来「永远放得下」——
     *   因为子元素是 flex 项、能被压到内容宽度以下，
     *   溢出的内容直接在盒子内部被裁掉，从不进入 scrollWidth。
     *   于是自适应永远不触发，工具栏右边就这么被切没了。
     *
     *   正确的做法是让工具栏**脱离弹性布局**量一次：
     *   `width: max-content` 让它按内容自然撑开，
     *   量到的才是「内容真正需要多宽」。量完立刻还原，
     *   这个赋值不会进入渲染帧（同一个任务内读回即可）。
     */
    bar.style.setProperty('--tb-scale', '1')
    const prevWidth = bar.style.width
    const prevPos = bar.style.position
    bar.style.width = 'max-content'
    bar.style.position = 'absolute'
    const natural = bar.getBoundingClientRect().width
    bar.style.width = prevWidth
    bar.style.position = prevPos
    if (natural <= 0) return

    if (natural <= avail + 0.5) {
      /* 放得下：全展开、不缩放 */
      setScale(MAX_TOOLBAR_SCALE)
      setHidden((prev) => (prev.length === 0 ? prev : []))
      return
    }

    /*
     * ① 先试缩放。按钮最多缩到 MIN_TOOLBAR_SCALE ——
     *    再小触屏就点不准了，宁可把按钮收起来。
     */
    const needed = avail / natural
    if (needed >= MIN_TOOLBAR_SCALE) {
      setScale(needed)
      setHidden((prev) => (prev.length === 0 ? prev : []))
      return
    }

    /*
     * ② 缩到下限还不够就收按钮，一次收一个、量一次。
     *
     *    逐个收而不是一次算完，是因为每收走一个按钮，
     *    分隔符（.toolbar__sep）也可能跟着消失，宽度不是线性的 ——
     *    估算会留下几像素的溢出，表现为工具栏最右边被切掉一点。
     */
    setScale(MIN_TOOLBAR_SCALE)
    setHidden((prev) => {
      const next = [...prev]
      const measureWith = (ids: string[]): number => {
        const probe = new Set(ids)
        const touched: HTMLElement[] = []
        bar.querySelectorAll<HTMLElement>('[data-tb-id]').forEach((el) => {
          const key = el.dataset.tbId ?? ''
          if (!key) return
          touched.push(el)
          el.style.display = probe.has(key) ? 'none' : ''
        })
        bar.style.width = 'max-content'
        bar.style.position = 'absolute'
        const w = bar.getBoundingClientRect().width * MIN_TOOLBAR_SCALE
        bar.style.width = prevWidth
        bar.style.position = prevPos
        touched.forEach((el) => {
          el.style.display = ''
        })
        return w
      }

      for (const id of OVERFLOW_ORDER) {
        if (next.includes(id)) continue
        next.push(id)
        if (measureWith(next) <= avail) break
      }
      const changed = next.length !== prev.length || next.some((v, i) => v !== prev[i])
      return changed ? next : prev
    })
  }, [])

  useLayoutEffect(() => {
    remeasure()
    const bar = barRef.current
    if (!bar) return
    const ro = new ResizeObserver(() => remeasure())
    ro.observe(bar)
    return () => ro.disconnect()
  }, [remeasure, hasDoc, pageCount, showSearch, showSidebar, viewMode])

  /** 某个按钮是否该收起来 */
  const isHidden = (id: string): boolean => hidden.includes(id)

  /** 溢出菜单的开关 */
  const [showOverflow, setShowOverflow] = useState(false)

  const zoomLabel =
    typeof zoom === 'number'
      ? `${Math.round(zoom * 100)}%`
      : zoom === 'fit-width'
        ? '适应宽度'
        : zoom === 'fit-page'
          ? '适应整页'
          : '实际大小'

  return (
    <div
      className="toolbar"
      ref={barRef}
      style={{ ['--tb-scale' as string]: String(scale) }}
    >
      {/* ---------- 左：文件与导航 ---------- */}
      <div className="toolbar__group">
        <button className="tb" onClick={() => void pickFile()} title="打开 PDF（Ctrl+O）">
          <File size={17} />
          <span className="tb__label">打开</span>
        </button>

        <span className="toolbar__sep" />

        <button
          className="icon-btn"
          onClick={prevPage}
          disabled={!hasDoc || page <= 1}
          title="上一页（← / PageUp）"
          aria-label="上一页"
        >
          <ChevronLeft size={18} />
        </button>

        <div className="pagebox">
          <input
            className="pagebox__input"
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value.replace(/[^\d]/g, ''))}
            onBlur={commitPage}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                commitPage()
                ;(e.target as HTMLInputElement).blur()
              }
            }}
            disabled={!hasDoc}
            aria-label="页码"
          />
          <span className="pagebox__total">/ {pageCount || '—'}</span>
        </div>

        <button
          className="icon-btn"
          onClick={nextPage}
          disabled={!hasDoc || page >= pageCount}
          title="下一页（→ / PageDown）"
          aria-label="下一页"
        >
          <ChevronRight size={18} />
        </button>
      </div>

      {/* ---------- 中：搜索 ---------- */}
      <div className="toolbar__group toolbar__group--center">
        <button
          className="tb"
          onClick={() => setShowSearch(!showSearch)}
          aria-pressed={showSearch}
          disabled={!hasDoc}
          title="搜索全文（Ctrl+F）"
        >
          <Search size={16} />
          <span className="tb__label">搜索</span>
        </button>

        <span className="toolbar__sep" />

              </div>

      {/* ---------- 右：缩放、视图、面板 ---------- */}
      <div className="toolbar__group toolbar__group--end">
        <button
          className="icon-btn"
          data-tb-id="zoom-out"
          style={isHidden('zoom-out') ? { display: 'none' } : undefined}
          onClick={zoomOut}
          disabled={!hasDoc}
          title="缩小（Ctrl+-）"
          aria-label="缩小"
        >
          <Minus size={16} />
        </button>

        <select
          className="zoom-select"
          value={typeof zoom === 'number' ? 'custom' : zoom}
          onChange={(e) => {
            const v = e.target.value
            if (v === 'custom') return
            setZoom(v as 'fit-width' | 'fit-page' | 'actual')
          }}
          disabled={!hasDoc}
          title={`当前：${zoomLabel}（实际 ${Math.round(actualScale * 100)}%）`}
          aria-label="缩放"
        >
          {typeof zoom === 'number' ? <option value="custom">{zoomLabel}</option> : null}
          <option value="fit-width">适应宽度</option>
          <option value="fit-page">适应整页</option>
          <option value="actual">实际大小</option>
        </select>

        <button
          className="icon-btn"
          data-tb-id="zoom-in"
          style={isHidden('zoom-in') ? { display: 'none' } : undefined}
          onClick={zoomIn}
          disabled={!hasDoc}
          title="放大（Ctrl++）"
          aria-label="放大"
        >
          <Plus size={16} />
        </button>

        <span className="toolbar__sep" />

        <button
          className="icon-btn"
          data-tb-id="rotate"
          style={isHidden('rotate') ? { display: 'none' } : undefined}
          onClick={() => rotate(90)}
          disabled={!hasDoc}
          title="顺时针旋转（Ctrl+R）"
          aria-label="旋转"
        >
          <RotateCw size={16} />
        </button>

        <div
          className="viewmode"
          role="group"
          aria-label="视图模式"
          data-tb-id="viewmode"
          style={isHidden('viewmode') ? { display: 'none' } : undefined}
        >
          <button
            className="icon-btn"
            aria-pressed={viewMode === 'single'}
            onClick={() => setViewMode('single')}
            disabled={!hasDoc}
            title="单页"
            aria-label="单页"
          >
            <Square size={15} />
          </button>
          <button
            className="icon-btn"
            aria-pressed={viewMode === 'continuous'}
            onClick={() => setViewMode('continuous')}
            disabled={!hasDoc}
            title="连续滚动"
            aria-label="连续滚动"
          >
            <Rows3 size={15} />
          </button>
          <button
            className="icon-btn"
            aria-pressed={viewMode === 'facing-continuous'}
            onClick={() => setViewMode('facing-continuous')}
            disabled={!hasDoc}
            title="双栏滚动"
            aria-label="双栏滚动"
          >
            <Columns2 size={15} />
          </button>
        </div>

        <span className="toolbar__sep" />

        <button
          className="icon-btn"
          data-tb-id="left-panel"
          style={isHidden('left-panel') ? { display: 'none' } : undefined}
          onClick={toggleSidebar}
          aria-pressed={showSidebar}
          title="左侧栏（缩略图/目录/搜索）"
          aria-label="左侧栏"
        >
          <LayoutPanelLeft size={16} />
        </button>
        <button
          className="icon-btn"
          data-tb-id="settings"
          style={isHidden('settings') ? { display: 'none' } : undefined}
          onClick={() => setShowSettings(true)}
          title="设置"
          aria-label="设置"
        >
          <Settings size={16} />
        </button>

        {/*
          PDF 工具箱：点开先显示工具列表，再选具体工具。
          与「设置」同属右侧抽屉，互斥打开。
        */}
        <button
          className="icon-btn"
          data-tb-id="tools"
          style={isHidden('tools') ? { display: 'none' } : undefined}
          onClick={() => setShowTools(true)}
          title="PDF 工具箱（点开查看全部工具）"
          aria-label="PDF 工具箱"
        >
          <Briefcase size={16} />
        </button>

        {/*
          溢出菜单。
          只有真的收起了按钮才出现 —— 宽窗口下多一个用不到的图标
          反而是噪声。它自己不参与溢出计算（永不隐藏），
          否则会出现「按钮全收起来了、连菜单入口都没了」的死局。
        */}
        {hidden.length > 0 ? (
          <div className="tb-overflow">
            <button
              className="icon-btn"
              aria-pressed={showOverflow}
              onClick={() => setShowOverflow((v) => !v)}
              title={`还有 ${hidden.length} 个功能（窗口太窄）`}
              aria-label="更多功能"
            >
              <MoreHorizontal size={16} />
            </button>
            {showOverflow ? (
              <>
                <div
                  className="tb-overflow__scrim"
                  onClick={() => setShowOverflow(false)}
                  aria-hidden="true"
                />
                <div className="tb-overflow__menu" role="menu">
                  {hidden.includes('zoom-in') ? (
                    <button
                      className="tb-overflow__item"
                      onClick={() => {
                        zoomIn()
                        setShowOverflow(false)
                      }}
                      disabled={!hasDoc}
                    >
                      <Plus size={15} />
                      <span>放大</span>
                    </button>
                  ) : null}
                  {hidden.includes('zoom-out') ? (
                    <button
                      className="tb-overflow__item"
                      onClick={() => {
                        zoomOut()
                        setShowOverflow(false)
                      }}
                      disabled={!hasDoc}
                    >
                      <Minus size={15} />
                      <span>缩小</span>
                    </button>
                  ) : null}
                  {hidden.includes('viewmode') ? (
                    <>
                      <button
                        className="tb-overflow__item"
                        onClick={() => {
                          setViewMode('single')
                          setShowOverflow(false)
                        }}
                        disabled={!hasDoc}
                      >
                        <Square size={15} />
                        <span>单页</span>
                      </button>
                      <button
                        className="tb-overflow__item"
                        onClick={() => {
                          setViewMode('continuous')
                          setShowOverflow(false)
                        }}
                        disabled={!hasDoc}
                      >
                        <Rows3 size={15} />
                        <span>连续滚动</span>
                      </button>
                      <button
                        className="tb-overflow__item"
                        onClick={() => {
                          setViewMode('facing')
                          setShowOverflow(false)
                        }}
                        disabled={!hasDoc}
                      >
                        <Columns2 size={15} />
                        <span>双页并排</span>
                      </button>
                      <button
                        className="tb-overflow__item"
                        onClick={() => {
                          setViewMode('facing-continuous')
                          setShowOverflow(false)
                        }}
                        disabled={!hasDoc}
                      >
                        <Columns2 size={15} />
                        <span>双栏滚动</span>
                      </button>
                    </>
                  ) : null}
                  {hidden.includes('rotate') ? (
                    <button
                      className="tb-overflow__item"
                      onClick={() => {
                        rotate(90)
                        setShowOverflow(false)
                      }}
                      disabled={!hasDoc}
                    >
                      <RotateCw size={15} />
                      <span>顺时针旋转</span>
                    </button>
                  ) : null}
                  {hidden.includes('left-panel') ? (
                    <button
                      className="tb-overflow__item"
                      onClick={() => {
                        toggleSidebar()
                        setShowOverflow(false)
                      }}
                    >
                      <LayoutPanelLeft size={15} />
                      <span>{showSidebar ? '隐藏左侧栏' : '显示左侧栏'}</span>
                    </button>
                  ) : null}
                  {/*
                    OCR 入口（v2.1.3）：固定放在溢出菜单里，不参与工具条自适应。
                    扫描件没有文字层，用户点哪里都选不中字，所以入口必须显眼且
                    不随窗口宽度被挤掉 —— 溢出菜单是唯一"永远都在"的位置。
                  */}
                  <div className="tb-overflow__seam" aria-hidden="true" />
                  <button
                    className="tb-overflow__item"
                    data-tb-id="ocr-page"
                    onClick={() => {
                      requestOcr()
                      setShowOverflow(false)
                    }}
                    disabled={!hasDoc}
                  >
                    <ScanText size={15} />
                    <span>识别扫描页文字</span>
                  </button>
                  {hidden.includes('settings') ? (
                    <button
                      className="tb-overflow__item"
                      onClick={() => {
                        setShowSettings(true)
                        setShowOverflow(false)
                      }}
                    >
                      <Settings size={15} />
                      <span>设置</span>
                    </button>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/* ============================================================
 * 底部状态栏
 * ============================================================ */

/**
 * 状态栏。
 *
 * 显示：文件名、页码、缩放、阅读模式 —— 都是「一眼要看到」的信息，
 * 因此放底部常驻而不是藏进面板。
 */
/**
 * 连续缩放滑条的量程（百分比）。
 *
 * 与 store / DocumentView / useTouchGestures 的缩放下限保持一致：
 *   0.25 ~ 6 倍 → 25% ~ 600%
 * 几处不一致会出现「滑块拖到底了但还能继续缩小」这种怪状态。
 */
const ZOOM_SLIDER_MIN = 25
const ZOOM_SLIDER_MAX = 600

export function StatusBar(): JSX.Element {
  const fileName = useViewer((s) => s.fileName)
  const page = useViewer((s) => s.page)
  const pageCount = useViewer((s) => s.pageCount)
  const actualScale = useViewer((s) => s.actualScale)
  const viewMode = useViewer((s) => s.viewMode)
  const loading = useViewer((s) => s.loading)
  const rotation = useViewer((s) => s.rotation)
  /** 右下角连续缩放滑条用 */
  const setZoom = useViewer((s) => s.setZoom)

  const modeLabel: Record<string, string> = {
    single: '单页',
    continuous: '连续滚动',
    facing: '双页并排',
    'facing-continuous': '双栏滚动'
  }

  return (
    <footer className="statusbar">
      <span className="statusbar__file" title={fileName}>
        {fileName || '未打开文档'}
      </span>

      <span className="statusbar__spacer" />

      {loading ? <span className="statusbar__loading">{loading}</span> : null}

      {filePathPresent(page, pageCount) ? (
        <span className="statusbar__item">
          第 {page} / {pageCount} 页
        </span>
      ) : null}

      {/*
        连续缩放滑条（右下角）。
        ── 为什么放在状态栏而不是右栏 ────────────────────────
          右栏是竖排，滑块要竖着放；竖排滑块在触屏上很难拖准，
          而且占掉一整行高度。
          状态栏是横向的，滑条顺着方向放最自然，
          也符合「右下角放缩放」的通行做法（浏览器、看图软件都这样）。
        ── 为什么保留百分比文字 ──────────────────────────────
          滑块给的是相对位置感，具体数值还得靠文字读。
          拖的时候两者同步变化，一眼就能看到停在了多少。
      */}
      <label className="statusbar__zoom" title={`缩放：${Math.round(actualScale * 100)}%（左右拖动可连续调节）`}>
        <span className="statusbar__zoom-icon" aria-hidden="true">
          <Minus size={12} />
        </span>
        <input
          type="range"
          className="statusbar__zoom-slider"
          min={ZOOM_SLIDER_MIN}
          max={ZOOM_SLIDER_MAX}
          step={1}
          value={Math.round(actualScale * 100)}
          disabled={!filePathPresent(page, pageCount)}
          onChange={(e) => setZoom(Number(e.target.value) / 100)}
          aria-label="缩放比例"
        />
        <span className="statusbar__zoom-icon" aria-hidden="true">
          <Plus size={12} />
        </span>
        <span className="statusbar__zoom-value">{Math.round(actualScale * 100)}%</span>
      </label>

      <span className="statusbar__item">{modeLabel[viewMode] ?? viewMode}</span>
      {rotation !== 0 ? <span className="statusbar__item">旋转 {rotation}°</span> : null}
    </footer>
  )
}

function filePathPresent(page: number, pageCount: number): boolean {
  return page > 0 && pageCount > 0
}
