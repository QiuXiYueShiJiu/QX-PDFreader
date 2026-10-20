// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 「选择」工具下的选区小工具条：复制 / 改文字 / 格式 / 高亮 / 下划线 / 取消。
 *
 * 为什么自己再做一个、不复用 AnnotationLayer 的 SelectionToolbar：
 *   那个工具条带"便签"和调色板，是给漫游模式随手标注用的；选择工具的主诉是
 *   「我要把这段文字搬走、改掉或标出来」，按钮多了反而误触。两个工具条按
 *   editTool 互斥显示，同一个选区不会同时冒出两条。
 *
 * 位置沿用 DocumentView 已经算好的 FloatingAnchor（left/top 是**屏幕**坐标，
 * 因为外层用 position: fixed）—— 那片逻辑处理了贴在窗口边缘时的夹取，
 * 这里不再重算。
 *
 * ── 「改文字」与「格式」的关系（用户 2026-07-17 要求：两个都要）──
 *   PDF 里的文字是只读的，无法真正改写原文字。所以两个功能都走同一条路：
 *     ① 在白out 掉选区覆盖的那块原文；
 *     ② 把（改过的）文字作为一个新的 text 物件叠在**原位**上。
 *   「改文字」让用户改内容；「格式」在同一份数据上改字号与颜色。
 *   实现上共用一次 openTextEditor，只是入口不同、面板内容不同。
 */

import { useEffect, useState } from 'react'
import { Check, Copy, Highlighter, Palette, Pencil, Underline, X } from 'lucide-react'
import type { FloatingAnchor } from '../AnnotationLayer'

/** 可选的字号档位（页面坐标像素，scale = 1 的坐标系） */
const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32]

/** 可选的文字颜色（与涂白、高亮同一套色板风格） */
const TEXT_COLORS = ['#111827', '#dc2626', '#2563eb', '#16a34a', '#d97706', '#7c3aed']

interface SelectionBarProps {
  anchor: FloatingAnchor
  onCopy: () => void
  /** 进入「改文字」：编辑内容，确认后替换原文字 */
  onEditText: () => void
  /** 进入「格式」：只调字号与颜色，不改内容 */
  onFormat: () => void
  /** 应用字号（页面坐标像素） */
  onFormatSize: (size: number) => void
  /** 应用文字颜色 */
  onFormatColor: (color: string) => void
  /*
   * 「改文字」面板的输入缓冲。
   *
   * ★ 为什么值放在父组件、而不是这里 useState：
   *   点「改文字」通常会清掉 PDF 文本层的选区（要开始编辑了），
   *   一旦选区没了，父组件算出来的 anchor 也会变，
   *   工具条可能被重挂载 —— 放在子组件里的草稿会跟着丢。
   *   由父组件用一个 ref 兜住草稿，工具条只负责展示与回调。
   */
  draftText: string
  onDraftTextChange: (next: string) => void
  onDraftConfirm: () => void
  onDraftCancel: () => void
  onHighlight: () => void
  onUnderline: () => void
  onCancel: () => void
}

export function SelectionBar({
  anchor,
  onCopy,
  onEditText,
  onFormat,
  onFormatSize,
  onFormatColor,
  draftText,
  onDraftTextChange,
  onDraftConfirm,
  onDraftCancel,
  onHighlight,
  onUnderline,
  onCancel
}: SelectionBarProps): JSX.Element {
  /*
   * 展开哪一个面板：null = 都不展开（默认只显示按钮行）。
   *
   * 为什么把面板做在同一个组件里而不是各自弹一个浮层：
   *   选区工具条是跟着选区位置走的，再叠一层浮层容易出现
   *   「面板和工具条错位」；就地展开最稳，也不会遮住选区本身。
   */
  const [panel, setPanel] = useState<null | 'text' | 'format'>(null)

  /*
   * 换了一段选区就把面板收起来（v2.1.4）。
   *
   * 面板是组件内 state，浮条跟着 anchor 重渲染但不会重挂载：
   * 用户重新拖选后，上一轮的「改文字」面板还开着、输入框是空的，
   * 看起来就像「点了没反应 / 改的是上一次的字」。
   * 以「页号 + 选区文本」为界，重新选就回到按钮行。
   */
  useEffect(() => {
    setPanel(null)
  }, [anchor.page, anchor.quote])

  return (
    <div
      className="edit-selbar"
      role="toolbar"
      aria-label="选中文字操作"
      data-edit-selbar="1"
      data-page={anchor.page}
      data-panel={panel ?? 'none'}
      style={{ left: `${anchor.left}px`, top: `${anchor.top}px` }}
    >
      <div className="edit-selbar__row">
        <button
          type="button"
          className="edit-selbar__btn"
          data-tb-id="sel-copy"
          title="复制选中的文字（Ctrl+C）"
          aria-label="复制"
          // 用 onMouseDown 阻止默认：否则按下按钮会先清掉选区，复制就落空了
          onMouseDown={(e) => e.preventDefault()}
          onClick={onCopy}
        >
          <Copy size={16} aria-hidden="true" />
          <span className="edit-selbar__text">复制</span>
        </button>

        <button
          type="button"
          className={`edit-selbar__btn ${panel === 'text' ? 'is-active' : ''}`}
          data-tb-id="sel-edit-text"
          title="改写这段文字（原文会被覆盖，新文字写在原位）"
          aria-label="改文字"
          aria-pressed={panel === 'text'}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setPanel((p) => (p === 'text' ? null : 'text'))
            onEditText()
          }}
        >
          <Pencil size={16} aria-hidden="true" />
          <span className="edit-selbar__text">改文字</span>
        </button>

        <button
          type="button"
          className={`edit-selbar__btn ${panel === 'format' ? 'is-active' : ''}`}
          data-tb-id="sel-format"
          title="调整这段文字的字号与颜色"
          aria-label="格式"
          aria-pressed={panel === 'format'}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setPanel((p) => (p === 'format' ? null : 'format'))
            onFormat()
          }}
        >
          <Palette size={16} aria-hidden="true" />
          <span className="edit-selbar__text">格式</span>
        </button>

        <button
          type="button"
          className="edit-selbar__btn"
          data-tb-id="sel-highlight"
          title="把选中的文字加为高亮批注"
          aria-label="高亮"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onHighlight}
        >
          <Highlighter size={16} aria-hidden="true" />
          <span className="edit-selbar__text">高亮</span>
        </button>

        <button
          type="button"
          className="edit-selbar__btn"
          data-tb-id="sel-underline"
          title="把选中的文字加为下划线批注"
          aria-label="下划线"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onUnderline}
        >
          <Underline size={16} aria-hidden="true" />
          <span className="edit-selbar__text">下划线</span>
        </button>

        <button
          type="button"
          className="edit-selbar__btn edit-selbar__btn--plain"
          data-tb-id="sel-cancel"
          title="取消选择"
          aria-label="取消选择"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onCancel}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      {/*
        「改文字」面板：就地改内容，确认后覆盖原文。
        多行用 Shift+回车（与项目里文本框的约定一致）。
      */}
      {panel === 'text' ? (
        <div className="edit-selbar__panel edit-selbar__panel--text" data-selbar-panel="text">
          <textarea
            className="edit-selbar__input"
            data-tb-id="sel-text-input"
            value={draftText}
            aria-label="改写文字"
            spellCheck={false}
            /* 自动聚焦：用户点「改文字」就是想马上打字 */
            autoFocus
            onChange={(e) => onDraftTextChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                onDraftConfirm()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                onDraftCancel()
              }
              /* 阻止冒泡：否则会撞上外层快捷键（Delete 删物件、Esc 关面板等） */
              e.stopPropagation()
            }}
          />
          <button
            type="button"
            className="edit-selbar__btn edit-selbar__btn--primary"
            data-tb-id="sel-text-apply"
            title="确认替换（回车）"
            aria-label="确认替换"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onDraftConfirm}
          >
            <Check size={16} aria-hidden="true" />
            <span className="edit-selbar__text">替换</span>
          </button>
          <button
            type="button"
            className="edit-selbar__btn edit-selbar__btn--plain"
            data-tb-id="sel-text-cancel"
            title="取消（Esc）"
            aria-label="取消改写"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onDraftCancel}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {/*
        格式面板：字号 + 颜色。
        这里只做「提示」，真正的应用由外部回调完成 ——
        工具条不持有文档状态，保持它是纯展示组件。
      */}
      {panel === 'format' ? (
        <div className="edit-selbar__panel" data-selbar-panel="format">
          <span className="edit-selbar__panel-label">字号</span>
          {FONT_SIZES.map((size) => (
            <button
              key={size}
              type="button"
              className="edit-selbar__size"
              data-tb-id={`sel-size-${size}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onFormatSize(size)}
            >
              {size}
            </button>
          ))}
          <span className="edit-selbar__panel-label">颜色</span>
          {TEXT_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className="edit-selbar__swatch"
              data-tb-id={`sel-color-${color.replace('#', '')}`}
              style={{ background: color }}
              aria-label={`文字颜色 ${color}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onFormatColor(color)}
            />
          ))}
          <button
            type="button"
            className="edit-selbar__btn edit-selbar__btn--plain"
            data-tb-id="sel-format-done"
            title="收起格式面板"
            aria-label="完成"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setPanel(null)}
          >
            <Check size={16} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  )
}
