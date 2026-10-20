// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 右侧竖排工具条 —— 视图与页面控制。
 *
 * 与左侧（批注工具）分工明确：
 *   左 = 对内容做标记，右 = 控制怎么看、看第几页。
 * 这样在触屏上左右手各管一边，不用来回找。
 *
 * 同样砍掉一体机系统级功能（应用、应用切换等），只留阅读相关的。
 */

import {
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Minus,
  Moon,
  Plus,
  Power,
  RotateCw,
  Settings,
  StretchHorizontal,
  ZoomIn
} from 'lucide-react'
import { useViewer } from '../store'

/*
 * 连续缩放滑条的量程已随控件一起移到状态栏（见 Toolbar.tsx 的 StatusBar）——
 * 这里不再需要，留着会变成「改了没人用」的死常量。
 */

function RailButton({
  icon,
  label,
  active,
  disabled,
  danger,
  onClick,
  title
}: {
  icon: JSX.Element
  label: string
  active?: boolean
  disabled?: boolean
  /**
   * 危险操作（如退出应用）：用警示色区分，避免与日常功能混淆。
   * 只改视觉，不改行为 —— 真正的防误触靠确认框。
   */
  danger?: boolean
  onClick: () => void
  title: string
}): JSX.Element {
  return (
    <button
      className={`rail-btn ${active ? 'is-active' : ''} ${danger ? 'is-danger' : ''}`}
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

/**
 * 退出应用的确认 —— 已改为**主进程原生对话框**。
 *
 * ★ 为什么把这里的 DOM 浮层删掉
 *   原先这里有个 ExitConfirm 组件自绘浮层，问题在于它只是 DOM 节点：
 *     · 不进任务栏、Alt+Tab 切不到；
 *     · 主窗口被遮挡或最小化时，它跟着一起看不见 ——
 *       用户点了「退出应用」会觉得按钮失灵；
 *     · 观感与 Windows 原生确认框不一致。
 *   现在确认逻辑整体搬到 src/main/index.ts 的 `app:quit` 里，
 *   用 dialog.showMessageBox(mainWindow, …) 做成模态子窗口，
 *   一定浮在阅读器之上，回车/Esc 都落到「取消」。
 *   渲染层只负责把请求发出去（见本文件底部的 RailButton）。
 */

export function RightRail(): JSX.Element {
  const hasDoc = useViewer((s) => s.filePath !== '')
  const page = useViewer((s) => s.page)
  const pageCount = useViewer((s) => s.pageCount)
  const zoom = useViewer((s) => s.zoom)
  const actualScale = useViewer((s) => s.actualScale)

  const nextPage = useViewer((s) => s.nextPage)
  const prevPage = useViewer((s) => s.prevPage)
  const zoomIn = useViewer((s) => s.zoomIn)
  const zoomOut = useViewer((s) => s.zoomOut)
  const setZoom = useViewer((s) => s.setZoom)
  const rotate = useViewer((s) => s.rotate)
  const setShowSettings = useViewer((s) => s.setShowSettings)
  // 课堂辅助遮罩（黑屏 / 聚光灯 / 放大镜）
  const maskMode = useViewer((s) => s.maskMode)
  const setMaskMode = useViewer((s) => s.setMaskMode)

  /** 是否处于适应宽度（用于高亮该按钮） */
  const fitWidth = zoom === 'fit-width'

  return (
    <aside className="rail rail--right" aria-label="视图工具">
      <div className="rail__group">
        <RailButton
          icon={<ChevronLeft size={20} />}
          label="上一页"
          disabled={!hasDoc || page <= 1}
          onClick={prevPage}
          title="上一页（← / PageUp）"
        />
        <span className="rail__page" title={`第 ${page} / ${pageCount || '—'} 页`}>
          {hasDoc ? `${page}/${pageCount || '—'}` : '—'}
        </span>
        <RailButton
          icon={<ChevronRight size={20} />}
          label="下一页"
          disabled={!hasDoc || page >= pageCount}
          onClick={nextPage}
          title="下一页（→ / PageDown）"
        />
      </div>

      <div className="rail__divider" aria-hidden="true" />

      <div className="rail__group">
        <RailButton
          icon={<Plus size={20} />}
          label="放大"
          disabled={!hasDoc}
          onClick={zoomIn}
          title="放大（Ctrl++，触屏可双指捏合）"
        />
        <span className="rail__scale" title={`当前 ${Math.round(actualScale * 100)}%`}>
          {Math.round(actualScale * 100)}%
        </span>
        <RailButton
          icon={<Minus size={20} />}
          label="缩小"
          disabled={!hasDoc}
          onClick={zoomOut}
          title="缩小（Ctrl+滚轮可连续调，触屏可双指捏合）"
        />

        {/*
          连续缩放滑条已移到右下角状态栏 ——
          这里原本是竖排滑块，但竖排在触屏上很难拖准、
          还占掉一整行高度。状态栏是横向的，更自然。
        */}

        <RailButton
          icon={<StretchHorizontal size={20} />}
          label="适宽"
          active={fitWidth}
          disabled={!hasDoc}
          onClick={() => setZoom('fit-width')}
          title="适应宽度（Ctrl+0）"
        />
      </div>

      <div className="rail__divider" aria-hidden="true" />

      {/*
        ---------- 课堂辅助工具 ----------
        来源：鸿合 π6 的「教辅工具」面板（实测确认可用）。
        只挑了对独立阅读器真正有用的三个：
          黑屏     讲评时压暗屏幕，让学生抬头看老师
          聚光灯   只照亮指针附近，引导注意力
          放大镜   局部放大正文
        π6 里的时钟/骰子/大转盘属于课堂活动道具，
        学科模拟器（物理化学实验）属于整机生态，都不并入。
      */}
      <div className="rail__group">
        <RailButton
          icon={<CircleDot size={20} />}
          label="聚光"
          active={maskMode === 'spotlight'}
          onClick={() => setMaskMode(maskMode === 'spotlight' ? 'off' : 'spotlight')}
          title="聚光灯：只照亮指针附近，滚轮调光圈大小"
        />
        <RailButton
          icon={<Moon size={20} />}
          label="黑屏"
          active={maskMode === 'black'}
          onClick={() => setMaskMode(maskMode === 'black' ? 'off' : 'black')}
          title="黑屏：把屏幕压暗，便于讲评"
        />
        <RailButton
          icon={<ZoomIn size={20} />}
          label="放大镜"
          active={maskMode === 'magnifier'}
          onClick={() => setMaskMode(maskMode === 'magnifier' ? 'off' : 'magnifier')}
          title="放大镜：局部放大正文，滚轮调区域大小"
        />
      </div>

      <div className="rail__divider" aria-hidden="true" />

      <div className="rail__group">
        <RailButton
          icon={<RotateCw size={20} />}
          label="旋转"
          disabled={!hasDoc}
          onClick={() => rotate(90)}
          title="顺时针旋转 90°（Ctrl+R）"
        />
        <RailButton
          icon={<Settings size={20} />}
          label="设置"
          onClick={() => setShowSettings(true)}
          title="设置（Ctrl+S）"
        />
      </div>

      {/*
        ---------- 退出应用 ----------
        放在最底部、与其他功能用分隔线隔开：
          关闭程序是破坏性操作，位置上要和日常功能拉开距离，避免误点。

        确认框由**主进程的原生对话框**弹（src/main/index.ts 的 app:quit）：
          挂在主窗口上做模态子窗口，一定浮在阅读器之上，
          进任务栏也能 Alt+Tab 到 —— 这些是 DOM 浮层做不到的
          （主窗口最小化时浮层跟着一起看不见，用户会以为按钮失灵）。
        所以这里只负责把请求发出去，不再自己渲染确认框。
      */}
      <div className="rail__divider" aria-hidden="true" />
      <div className="rail__group">
        <RailButton
          icon={<Power size={20} />}
          label="退出应用"
          danger
          onClick={() => {
            void window.pdfApp?.app?.quit?.()
          }}
          title="退出应用（会弹出确认）"
        />
      </div>
    </aside>
  )
}
