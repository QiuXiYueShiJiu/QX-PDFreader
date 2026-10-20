// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 左侧竖排工具条 —— 批注工具。
 *
 * 布局参考鸿合 π6：竖向贴在屏幕左边缘中部，
 * 大号图标 + 中文小字，方便触屏点按与快速辨认。
 *
 * 只保留「阅读 + 批注」真正需要的工具，砍掉一体机系统级功能
 * （应用、应用切换、工具面板等）—— 那些属于桌面外壳，
 * 独立 PDF 阅读器不需要它们，留着只会让界面变乱。
 *
 * 工具分两组：
 *   批注：手绘、橡皮、颜色、清空
 *   导航：缩略图、目录、搜索
 */

import {
  Eraser,
  List,
  Pen,
  Search,
  Trash2,
  Redo2,
  Undo2
} from 'lucide-react'
import { useViewer } from '../store'

/** 左侧条上的一个工具按钮 */
function RailButton({
  icon,
  label,
  active,
  disabled,
  onClick,
  title
}: {
  icon: JSX.Element
  label: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  title: string
}): JSX.Element {
  return (
    <button
      className={`rail-btn ${active ? 'is-active' : ''}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active}
    >
      <span className="rail-btn__icon">{icon}</span>
      <span className="rail-btn__label">{label}</span>
    </button>
  )
}

export function LeftRail(): JSX.Element {
  const hasDoc = useViewer((s) => s.filePath !== '')
  const drawMode = useViewer((s) => s.drawMode)
  const eraserMode = useViewer((s) => s.eraserMode)
  const annotations = useViewer((s) => s.annotations)

  const setDrawMode = useViewer((s) => s.setDrawMode)
  const setEraserMode = useViewer((s) => s.setEraserMode)
  /** 回到漫游（画笔 / 橡皮 / 漫游 三选一，见 store.setRoam） */
  const setRoam = useViewer((s) => s.setRoam)
  /** 撤销 / 重做（多步） */
  const undo = useViewer((s) => s.undo)
  const redo = useViewer((s) => s.redo)
  /*
   * 订阅栈深而不是「能否撤销」的派生布尔值：
   * zustand 选择器返回布尔值本身是安全的，但这里直接用长度，
   * 顺带还能在按钮上显示剩余步数（见 title）。
   */
  const historyDepth = useViewer((s) => s.history.length)
  const futureDepth = useViewer((s) => s.future.length)
  const clearAnnotations = useViewer((s) => s.clearAnnotations)
  const showSidebar = useViewer((s) => s.showSidebar)
  const toggleSidebar = useViewer((s) => s.toggleSidebar)

  /**
   * 开启手绘 / 切到橡皮。
   *
   * ★ 这两件事是互斥的，必须一起设置：
   *   踩坑记录：左栏与绘图工具条曾各自维护自己的「橡皮开关」，
   *   结果出现「左栏显示橡皮开着、工具条显示画笔开着」的矛盾状态。
   *   现在统一以 store 的 drawMode / eraserMode 为准，只有一处真相。
   *
   * 另外：橡皮也属于「标记」行为，必须同时开启 drawMode，
   * 否则 DocumentView 的指针处理不会进入批注分支，点了没反应。
   *
   * ★ 再点一次不再「谁都不激活」，而是回到**漫游**（工具栏三选一）。
   *   踩坑：橡皮的旧写法是 `setDrawMode(false)` —— 只关了画笔、
   *   eraserMode 还留着 true，于是指针分支仍在擦除、
   *   而工具栏三个按钮全灭，完全看不出当前状态。
   */
  const activatePen = (): void => {
    if (drawMode && !eraserMode) {
      setRoam()
      return
    }
    setEraserMode(false)
    setDrawMode(true)
  }

  const activateEraser = (): void => {
    if (drawMode && eraserMode) {
      setRoam()
      return
    }
    setDrawMode(true)
    setEraserMode(true)
  }

  return (
    <aside className="rail rail--left" aria-label="批注工具">
      <div className="rail__group">
        <RailButton
          icon={<Pen size={20} />}
          label="批注"
          active={drawMode && !eraserMode}
          disabled={!hasDoc}
          onClick={activatePen}
          title={drawMode && !eraserMode ? '手绘批注中，点击回到漫游（Esc）' : '手绘批注：在页面上圈画'}
        />
        <RailButton
          icon={<Eraser size={20} />}
          label="橡皮"
          active={eraserMode}
          disabled={!hasDoc || annotations.length === 0}
          onClick={activateEraser}
          title="橡皮：像真实橡皮一样局部擦除（可调大小）"
        />
        <RailButton
          icon={<Undo2 size={20} />}
          label="撤销"
          disabled={!hasDoc || historyDepth === 0}
          onClick={() => undo()}
          title={
            historyDepth > 0 ? `撤销上一步（Ctrl+Z），可撤 ${historyDepth} 步` : '撤销上一步（Ctrl+Z）'
          }
        />
        <RailButton
          icon={<Redo2 size={20} />}
          label="重做"
          disabled={!hasDoc || futureDepth === 0}
          onClick={() => redo()}
          title={futureDepth > 0 ? `重做（Ctrl+Y），可重做 ${futureDepth} 步` : '重做（Ctrl+Y）'}
        />
        <RailButton
          icon={<Trash2 size={20} />}
          label="清空"
          disabled={!hasDoc || annotations.length === 0}
          onClick={() => void clearAnnotations()}
          title="清空本文档的全部批注"
        />
      </div>

      {/* 颜色与粗细已统一到绘图工具条（DrawToolbar），此处不再重复，
          避免同一设置出现两个入口、状态还不一致 */}

      <div className="rail__divider" aria-hidden="true" />

      <div className="rail__group">
        <RailButton
          icon={<List size={20} />}
          label="页面"
          active={showSidebar}
          disabled={!hasDoc}
          onClick={toggleSidebar}
          title="显示 / 隐藏页面导航栏（缩略图、目录）"
        />
        <RailButton
          icon={<Search size={20} />}
          label="搜索"
          disabled={!hasDoc}
          onClick={() => useViewer.getState().setShowSearch(true)}
          title="搜索全文（Ctrl+F）"
        />
      </div>
    </aside>
  )
}
