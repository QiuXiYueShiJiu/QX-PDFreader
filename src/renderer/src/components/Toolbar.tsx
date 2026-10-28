// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 顶部工具条（已并入单条功能区）与底部状态栏。
 *
 * ── 为什么要留一个「什么都不渲染」的 Toolbar ──────────────────
 *   用户报的四个 UI 病里，第一条就是**上下栏重复**：
 *   原来屏幕上有两条工具条 —— 顶部 Toolbar（打开/新建/翻页/缩放/视图…）
 *   和底部悬浮的 DrawToolbar（画笔/橡皮/编辑工具…），各放一半功能，
 *   而且底部那条还是 fixed，会盖住正文最后一行。
 *
 *   现在所有按钮都搬进了唯一的那条功能区
 *   （`components/RibbonTabs.tsx`，由 `DrawToolbar` 挂载）：
 *     · 文件页：打开 / 新建 / 保存副本 / 导出 PDF / 打印 / 最近文件
 *     · 视图页：放大 / 缩小 / 适应宽度 / 单页 / 双页 / 旋转 / 聚光 / 黑屏 /
 *               放大镜 / 左侧栏 / 搜索 / 工具箱 / 设置
 *     · 页码、OCR、收起：常驻在目录条右侧
 *
 *   保留这个导出（并让它返回 null）而不是删掉 <Toolbar/>，是为了
 *   让 App 的挂载顺序与其它分支/自动化用例保持兼容；
 *   一旦它再渲染点什么，屏幕上立刻会多出第二条栏 —— 正是用户投诉的病。
 */

import { Minus, Plus } from 'lucide-react'
import { useViewer } from '../store'

/**
 * 旧顶栏的占位。
 *
 * @deprecated 顶栏已并入 RibbonTabs，这里永远不渲染任何 DOM。
 */
export function Toolbar(): null {
  return null
}

/* ============================================================
 * 底部状态栏
 * ============================================================ */

/**
 * 连续缩放滑条的量程（百分比）。
 *
 * 与 store / DocumentView / useTouchGestures 的缩放下限保持一致：
 *   0.25 ~ 6 倍 → 25% ~ 600%
 * 几处不一致会出现「滑块拖到底了但还能继续缩小」这种怪状态。
 */
const ZOOM_SLIDER_MIN = 25
const ZOOM_SLIDER_MAX = 600

/**
 * 状态栏。
 *
 * 显示：文件名、页码、缩放、阅读模式 —— 都是「一眼要看到」的信息，
 * 因此放底部常驻而不是藏进面板。
 */
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
