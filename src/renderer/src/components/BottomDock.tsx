// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 底部悬浮画笔条（用户 2026-10-27 要求）。
 *
 * ── 为什么画笔类工具单独在下栏 ────────────────────────────────
 *   上栏是「目录式功能区」，放的是**文档级**操作（打开、插入、页面结构、编辑）；
 *   画笔、橡皮、颜色、粗细、清屏是**手上正在用的东西**，讲课时一分钟要点很多次，
 *   贴着屏幕底部放，手腕落在触摸屏下沿就能点到，不像上栏那样要抬手臂。
 *   这也是用户的原话：「画笔与橡皮还有调色盘还有粗细选择还有清屏是放在下栏悬浮栏」。
 *
 * ── 与上栏「开始」页的分工（别再合回去）──────────────────────
 *   下栏：漫游 / 画笔 / 橡皮 / 六个颜色 / 粗细（橡皮态自动换成橡皮大小）/ 滑动清屏
 *   上栏：选择 / 文字 / 图片 / 涂白 / 矩形 / 椭圆 / 直线 / 箭头 / 加页 / 删页 / 撤销重做
 *   两边共用 store 的同一批 action，九选一的互斥关系不受位置影响。
 *
 * ── 为什么悬浮而不是占一条布局高度 ────────────────────────────
 *   阅读区要尽量高；悬浮条只在视觉上压住页面底部一小块，
 *   鼠标穿过去照样能滚页面（`pointer-events: none` 的外壳 + 条身自己接管点击）。
 */

import { Eraser, Hand, Pencil } from 'lucide-react'
import { useViewer } from '../store'
import { PEN_COLORS } from './pen-colors'
import { SlideToClear } from './SlideToClear'

/** 橡皮大小范围（与 store 的 setEraserSize 保持一致） */
const ERASER_MIN = 3
const ERASER_MAX = 48

/**
 * 画笔粗细范围。
 *
 * 用连续滑块而不是离散档位：教学场景里「稍微粗一点」这种微调很常见，
 * 档位跨度太大反而不好用。
 */
const WIDTH_MIN = 1
const WIDTH_MAX = 16
const WIDTH_STEP = 0.5

export function BottomDock(): JSX.Element {
  const drawMode = useViewer((s) => s.drawMode)
  const drawColor = useViewer((s) => s.drawColor)
  const drawWidth = useViewer((s) => s.drawWidth)
  const eraserMode = useViewer((s) => s.eraserMode)
  const eraserSize = useViewer((s) => s.eraserSize)
  const editTool = useViewer((s) => s.editTool)
  const annotations = useViewer((s) => s.annotations)

  const setDrawColor = useViewer((s) => s.setDrawColor)
  const setDrawWidth = useViewer((s) => s.setDrawWidth)
  const setDrawMode = useViewer((s) => s.setDrawMode)
  const setEraserMode = useViewer((s) => s.setEraserMode)
  const setEraserSize = useViewer((s) => s.setEraserSize)
  const setRoam = useViewer((s) => s.setRoam)
  const clearAnnotations = useViewer((s) => s.clearAnnotations)

  /*
   * 面板打开时把悬浮条收起来（2026-10-31，用户第 5 条）。
   *
   *   它是 position: fixed，层级又高于部分面板的内容区，
   *   设置页拉到底部时会被这条画笔条压住 —— 实测就是「遮挡设置页」。
   *   与其调 z-index（面板层级各自不同，容易按下一个冒出另一个），
   *   不如在面板打开期间整条收掉：这时候用户在处理设置，不需要画笔。
   */
  const panelOpen = useViewer(
    (s) => s.showSettings || s.showTools || s.showPluginStore || s.showThemeStore || s.showImageTools
  )

  /** 漫游态：没有画笔、没有橡皮、也没选编辑工具 */
  const roaming = editTool === 'none' && !drawMode && !eraserMode

  return (
    <aside
      className="dock"
      data-dock="1"
      data-hidden={panelOpen ? '1' : '0'}
      role="toolbar"
      aria-label="画笔工具条"
    >
      <div className="dock__group">
        <button
          type="button"
          className={`dock__btn ${roaming ? 'is-active' : ''}`}
          data-tb-id="roam"
          aria-pressed={roaming}
          onClick={() => setRoam()}
          title={roaming ? '漫游中：拖动页面平移' : '漫游：拖动页面平移（Esc 直接回到漫游）'}
        >
          <Hand size={17} aria-hidden="true" />
          <span className="dock__lbl">漫游</span>
        </button>
        <button
          type="button"
          className={`dock__btn ${drawMode && !eraserMode ? 'is-active' : ''}`}
          data-tb-id="pen"
          aria-pressed={drawMode && !eraserMode}
          onClick={() => {
            setEraserMode(false)
            setDrawMode(true)
          }}
          title={
            drawMode && !eraserMode
              ? '正在绘画（已是当前工具）；要回到漫游请点「漫游」或按 Esc'
              : '画笔：在页面上圈画'
          }
        >
          <Pencil size={17} aria-hidden="true" />
          <span className="dock__lbl">{drawMode && !eraserMode ? '绘画中' : '画笔'}</span>
        </button>
        <button
          type="button"
          className={`dock__btn ${eraserMode ? 'is-active' : ''}`}
          data-tb-id="eraser"
          aria-pressed={eraserMode}
          disabled={annotations.length === 0}
          onClick={() => {
            setDrawMode(true)
            setEraserMode(true)
          }}
          title={eraserMode ? '橡皮中；要回到漫游请点「漫游」或按 Esc' : '橡皮：点住笔迹擦除'}
        >
          <Eraser size={17} aria-hidden="true" />
          <span className="dock__lbl">橡皮</span>
        </button>
      </div>

      <span className="dock__divider" aria-hidden="true" />

      <div className={`dock__group ${eraserMode ? 'is-muted' : ''}`} data-dock-group="colors">
        {PEN_COLORS.map((c) => (
          <button
            type="button"
            key={c.value}
            className={`dock__btn dock__btn--swatch ${drawColor === c.value ? 'is-active' : ''}`}
            data-tb-id={`pen-color-${c.value.replace('#', '')}`}
            aria-pressed={drawColor === c.value}
            disabled={eraserMode || !drawMode}
            onClick={() => setDrawColor(c.value)}
            title={
              !drawMode
                ? '先点「画笔」进入绘画模式，再选颜色'
                : eraserMode
                  ? '橡皮模式下不改颜色，切回画笔即可'
                  : `画笔颜色：${c.label}`
            }
          >
            <span className="ribbon__swatch" style={{ background: c.value }} aria-hidden="true" />
            <span className="dock__lbl">{c.label}</span>
          </button>
        ))}
      </div>

      <span className="dock__divider" aria-hidden="true" />

      <div className={`dock__group dock__group--width ${eraserMode ? '' : drawMode ? '' : 'is-muted'}`}>
        {eraserMode ? (
          <div className="ribbon__width">
            <span
              className="ribbon__preview ribbon__preview--eraser"
              aria-hidden="true"
              style={{
                width: `${Math.min(22, eraserSize * 0.8 + 6)}px`,
                height: `${Math.min(22, eraserSize * 0.8 + 6)}px`
              }}
            />
            <input
              type="range"
              className="ribbon__slider"
              min={ERASER_MIN}
              max={ERASER_MAX}
              step={1}
              value={eraserSize}
              onChange={(e) => setEraserSize(Number(e.target.value))}
              aria-label="橡皮大小"
              title={`橡皮大小：${eraserSize}px（拖动可连续调节）`}
            />
            <output className="ribbon__readout">{eraserSize}</output>
          </div>
        ) : (
          <div className={`ribbon__width ${!drawMode ? 'is-muted' : ''}`}>
            <span
              className="ribbon__preview"
              aria-hidden="true"
              style={{
                width: `${Math.min(22, drawWidth * 1.6 + 4)}px`,
                height: `${Math.min(22, drawWidth * 1.6 + 4)}px`
              }}
            />
            <input
              type="range"
              className="ribbon__slider"
              min={WIDTH_MIN}
              max={WIDTH_MAX}
              step={WIDTH_STEP}
              value={drawWidth}
              onChange={(e) => setDrawWidth(Number(e.target.value))}
              disabled={!drawMode}
              aria-label="画笔粗细"
              title={drawMode ? `画笔粗细：${drawWidth}px` : '先点「画笔」进入绘画模式，再调粗细'}
            />
            <output className="ribbon__readout">{drawWidth}</output>
          </div>
        )}
      </div>

      <span className="dock__divider" aria-hidden="true" />

      <div className="dock__group">
        <SlideToClear
          label="滑动清屏"
          disabled={annotations.length === 0}
          onConfirm={() => void clearAnnotations()}
        />
      </div>
    </aside>
  )
}
