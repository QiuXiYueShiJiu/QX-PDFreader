// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 编辑工具条：内容编辑的「选项 + 导出」浮动条。
 *
 * 为什么导出按钮在这里、而不在底部那个 PPT 式 DrawToolbar：
 *   导出要拿到 pdf.js 的 PDFDocumentProxy 和源文件路径，而 DrawToolbar
 *   由 App 直接渲染、**不接任何 props**（App.tsx 属于本轮禁改文件），
 *   它拿不到文档对象。这条浮动条是编辑模块自己渲染的，文档对象现成。
 *
 * 位置放在阅读区**顶部**居中：底部已经被 .drawbar 占住，而加了 6 个编辑按钮
 * 之后那条还会换行变高，两个浮动条叠在一起会互相遮挡。
 */

import { Check, Download, ImagePlus, MousePointer2, Trash2 } from 'lucide-react'
import { EDIT_TOOL_LABEL, type EditTool } from '@shared/types'
import { FONT_SIZES, STROKE_WIDTHS } from './edit-common'
import { PEN_COLORS } from '../DrawToolbar'

interface EditBarProps {
  tool: EditTool
  color: string
  fontSize: number
  strokeWidth: number
  /** 新画的图形是否带半透明填充（矩形/椭圆） */
  fillOn: boolean
  /** 新画的图形是否用虚线描边（矩形/椭圆/直线/箭头） */
  dashOn: boolean
  /** 有内容改了还没导出：store 里 exportDirty */
  exportDirty: boolean
  exporting: boolean
  progress: { done: number; total: number } | null
  /** 当前文档里有没有可导出的编辑内容 */
  canExport: boolean
  /** 已经选好图、等着点页面放置 */
  pendingImage: boolean
  /** 已有选中物件（决定"删除"按钮是否可用） */
  hasSelection: boolean
  onColor: (color: string) => void
  onFontSize: (size: number) => void
  onStrokeWidth: (width: number) => void
  onToggleFill: () => void
  onToggleDash: () => void
  onPickImage: () => void
  onDelete: () => void
  onExport: () => void
  onExit: () => void
}

export function EditBar(props: EditBarProps): JSX.Element {
  const { tool } = props
  const showFontSize = tool === 'text'
  /* 线宽对四种手绘图形都有效：矩形、椭圆、直线、箭头 */
  const showStroke = tool === 'rect' || tool === 'ellipse' || tool === 'line' || tool === 'arrow'
  /* 涂白的颜色固定是白色，给它显示调色板只会让人以为能换色 */
  const showColors =
    tool === 'text' || tool === 'rect' || tool === 'ellipse' || tool === 'line' || tool === 'arrow'

  return (
    <div
      className="edit-bar"
      role="toolbar"
      aria-label="内容编辑工具"
      data-edit-bar="1"
      data-tool={tool}
    >
      <span className="edit-bar__badge" data-edit-tool-label="1">
        <MousePointer2 size={14} aria-hidden="true" />
        {EDIT_TOOL_LABEL[tool]}
      </span>

      {showFontSize ? (
        <div className="edit-bar__group" role="group" aria-label="字号">
          {FONT_SIZES.map((size) => (
            <button
              key={size}
              type="button"
              className={`edit-bar__chip${props.fontSize === size ? ' is-active' : ''}`}
              data-tb-id={`edit-fontsize-${size}`}
              title={`字号 ${size}`}
              aria-label={`字号 ${size}`}
              aria-pressed={props.fontSize === size}
              onClick={() => props.onFontSize(size)}
            >
              {size}
            </button>
          ))}
        </div>
      ) : null}

      {showStroke ? (
        <div className="edit-bar__group" role="group" aria-label="线宽">
          {STROKE_WIDTHS.map((width) => (
            <button
              key={width}
              type="button"
              className={`edit-bar__chip${props.strokeWidth === width ? ' is-active' : ''}`}
              data-tb-id={`edit-strokewidth-${width}`}
              title={`线宽 ${width}`}
              aria-label={`线宽 ${width}`}
              aria-pressed={props.strokeWidth === width}
              onClick={() => props.onStrokeWidth(width)}
            >
              {width}
            </button>
          ))}
        </div>
      ) : null}

      {/*
        填充只给矩形/椭圆：涂白本身已经是「填满」，直线/箭头没有内部可填。
        两个按钮做成开关（aria-pressed），对当前选中的图形也立即生效。
      */}
      {tool === 'rect' || tool === 'ellipse' ? (
        <button
          type="button"
          className={`edit-bar__btn${props.fillOn ? ' is-active' : ''}`}
          data-tb-id="edit-fill"
          title="给图形加半透明填充（看得见底下的字）"
          aria-label="填充"
          aria-pressed={props.fillOn}
          onClick={props.onToggleFill}
        >
          填充
        </button>
      ) : null}

      {showStroke ? (
        <button
          type="button"
          className={`edit-bar__btn${props.dashOn ? ' is-active' : ''}`}
          data-tb-id="edit-dash"
          title="描边改用虚线"
          aria-label="虚线"
          aria-pressed={props.dashOn}
          onClick={props.onToggleDash}
        >
          虚线
        </button>
      ) : null}

      {showColors ? (
        <div className="edit-bar__group" role="group" aria-label="颜色">
          {/*
            PEN_COLORS 是 `{ value, label }` 的对象数组（与画笔共用一份色表），
            这里一律取 `.value` 当色值、`.label` 当无障碍文案 ——
            直接把对象当字符串用会渲染成 "[object Object]"。
          */}
          {PEN_COLORS.map((c) => (
            <button
              key={c.value}
              type="button"
              className={`edit-bar__color${props.color === c.value ? ' is-active' : ''}`}
              data-tb-id={`edit-color-${c.value.replace('#', '')}`}
              title={`颜色：${c.label}`}
              aria-label={`颜色 ${c.label}`}
              aria-pressed={props.color === c.value}
              style={{ ['--edit-color' as string]: c.value }}
              onClick={() => props.onColor(c.value)}
            />
          ))}
        </div>
      ) : null}

      {tool === 'image' ? (
        <button
          type="button"
          className="edit-bar__btn"
          data-tb-id="edit-pick-image"
          title="选择一张图片，然后在页面上点一下放置"
          aria-label="选择图片"
          onClick={props.onPickImage}
        >
          <ImagePlus size={15} aria-hidden="true" />
          选择图片
        </button>
      ) : null}

      {tool !== 'none' && props.hasSelection ? (
        <button
          type="button"
          className="edit-bar__btn edit-bar__btn--danger"
          data-tb-id="edit-delete-selected"
          title="删除选中的物件（Delete）"
          aria-label="删除选中"
          onClick={props.onDelete}
        >
          <Trash2 size={15} aria-hidden="true" />
          删除
        </button>
      ) : null}

      <span className="edit-bar__hint" data-edit-hint="1">
        {hintOf(tool, props.pendingImage)}
      </span>

      {props.exportDirty ? (
        <span className="edit-bar__dirty" data-edit-dirty="1" title="改动只存在于本次会话，导出后才会写进新文件">
          有未导出的编辑
        </span>
      ) : null}

      {props.progress ? (
        <span className="edit-bar__progress" data-edit-progress="1">
          正在导出 {props.progress.done}/{props.progress.total}
        </span>
      ) : null}

      <button
        type="button"
        className="edit-bar__btn edit-bar__btn--primary"
        data-tb-id="edit-export"
        title={props.canExport ? '把编辑结果导出为新的 PDF（原文件不动）' : '还没有可导出的编辑内容'}
        aria-label="导出 PDF"
        disabled={props.exporting || !props.canExport}
        onClick={props.onExport}
      >
        <Download size={15} aria-hidden="true" />
        {props.exporting ? '导出中…' : '导出 PDF'}
      </button>

      {/* 浏览态（只有未导出改动时才出现）没有「完成」可点：那本来就是浏览 */}
      {tool !== 'none' ? (
        <button
          type="button"
          className="edit-bar__btn"
          data-tb-id="edit-done"
          title="结束编辑，回到浏览（Esc）"
          aria-label="完成编辑"
          onClick={props.onExit}
        >
          <Check size={15} aria-hidden="true" />
          完成
        </button>
      ) : null}
    </div>
  )
}

function hintOf(tool: EditTool, pendingImage: boolean): string {
  switch (tool) {
    case 'none':
      /* 只会在「有未导出改动」时出现这一条横幅 */
      return '改动还没导出：点「导出 PDF」存成新文件，或切回编辑工具继续改'
    case 'select':
      /* 触摸屏上一体机没有 Ctrl+C，提示要写清两条路 */
      return '拖动框选文字；触摸屏长按/双击选词。选中后可复制、改字、高亮'
    case 'text':
      return '点页面新增文本框；双击已有文本框改字，拖动挪位置'
    case 'image':
      return pendingImage ? '图片已就绪：在页面上点一下放置' : '先「选择图片」，或直接 Ctrl+V 粘贴'
    case 'whiteout':
      return '在原内容上拖一个框，用白色盖住它'
    case 'rect':
      return '拖动绘制矩形'
    case 'ellipse':
      return '拖动绘制椭圆'
    case 'line':
      return '按下并拖动，松手得到一条直线'
    case 'arrow':
      return '从起点拖到要指向的位置，松手得到箭头'
    default:
      return ''
  }
}
