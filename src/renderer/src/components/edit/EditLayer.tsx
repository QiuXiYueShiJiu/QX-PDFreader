// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 每页的「内容编辑层」：负责把涂白 / 矩形 / 椭圆 / 文字 / 图片画出来，
 * 以及拖拽中的临时预览、选中外框、右下角缩放手柄和就地编辑的文本框。
 *
 * 为什么不复用 AnnotationLayer：
 *   那一层是**标记类**批注（高亮/下划线/删除线/便签）的渲染器，它把
 *   不认识的类型一律画成色块。内容编辑的物件既要正确的外观，又要能被
 *   点选、拖动、缩放，命中测试也必须落在真实 DOM 上（`[data-anno-id]`），
 *   两者诉求不同，硬塞在一起会互相牵制。
 *
 * ★ 本层默认 `pointer-events: none`：编辑工具没激活时，它绝不能挡住
 *   文字选中和页面拖动 —— 否则 `editTool === 'none'` 的现有用例全废。
 *   只有 `is-interactive` 时物件才重新吃指针事件。
 */

import type { Annotation, AnnotationRect } from '@shared/types'
import { CORNERS, DEFAULT_FONT_SIZE, DEFAULT_STROKE_WIDTH, LINE_HEIGHT } from './edit-common'

/** 拖动中物件的临时矩形（松手前不写 store，避免每帧一次批注更新） */
export interface EditDraft {
  id: string
  rect: AnnotationRect
}

/** 拖拽绘制中的新图形预览 */
export interface ShapeDraft {
  page: number
  type: 'whiteout' | 'rect' | 'ellipse'
  rect: AnnotationRect
  color: string
  strokeWidth: number
}

/** 文本框的就地编辑态：id 为 null 表示新建（还没落库） */
export interface TextDraft {
  id: string | null
  page: number
  rect: AnnotationRect
  fontSize: number
}

interface EditLayerProps {
  page: number
  items: Annotation[]
  /** 屏幕缩放：页面坐标 × scale = 屏幕像素 */
  scale: number
  interactive: boolean
  selectedId: string | null
  draft: EditDraft | null
  shapeDraft: ShapeDraft | null
  textDraft: TextDraft | null
  textAreaRef: React.RefObject<HTMLTextAreaElement>
  onTextCommit: () => void
  onTextCancel: () => void
  onTextKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onTextInput: (e: React.FormEvent<HTMLTextAreaElement>) => void
  /** 双击已有文本框 → 就地改字 */
  onTextEdit: (id: string) => void
}

export function EditLayer(props: EditLayerProps): JSX.Element {
  const { page, items, scale, interactive, selectedId, draft, shapeDraft, textDraft } = props

  return (
    <div
      className={`edit-layer${interactive ? ' is-interactive' : ''}`}
      data-edit-layer={page}
      data-page={page}
      data-edit-interactive={interactive ? '1' : '0'}
    >
      {items.map((item) => {
        const base = item.rects[0]
        if (!base) return null
        // 拖动中的物件用临时矩形渲染，松手才写回（其余物件不受影响）
        const rect = draft && draft.id === item.id ? draft.rect : base
        const selected = selectedId === item.id
        const editing = textDraft !== null && textDraft.id === item.id
        const editingRect = editing && textDraft ? textDraft.rect : rect

        return (
          <div
            key={item.id}
            className={`edit-item edit-item--${item.type}${selected ? ' is-selected' : ''}${
              editing ? ' is-editing' : ''
            }`}
            data-anno-id={item.id}
            data-anno-type={item.type}
            data-page={page}
            data-selected={selected ? '1' : '0'}
            style={boxStyle(editingRect, scale)}
            /*
             * 双击已有文本框进入改字。只有文字类挂这个事件：
             * 图形/图片双击没有语义，挂上去只会让单击被延迟判定。
             */
            onDoubleClick={
              interactive && item.type === 'text' && !editing
                ? (e) => {
                    e.stopPropagation()
                    props.onTextEdit(item.id)
                  }
                : undefined
            }
          >
            {editing ? (
              <textarea
                ref={props.textAreaRef}
                className="edit-textarea"
                data-edit-textarea={item.id}
                defaultValue={item.text ?? ''}
                spellCheck={false}
                style={{
                  fontSize: (item.fontSize ?? DEFAULT_FONT_SIZE) * scale,
                  lineHeight: LINE_HEIGHT,
                  color: item.color
                }}
                onKeyDown={props.onTextKeyDown}
                onInput={props.onTextInput}
                onBlur={props.onTextCommit}
              />
            ) : (
              renderVisual(item, scale)
            )}

            {/*
              缩放手柄只在选中时出现：平时它们会盖住物件的边角，
              点选时要先命中手柄才能拖动，体验会很别扭。
            */}
            {selected && interactive
              ? CORNERS.map((corner) => (
                  <span
                    key={corner}
                    className={`edit-handle edit-handle--${corner}`}
                    data-edit-handle={corner}
                  />
                ))
              : null}
          </div>
        )
      })}

      {/* 新建中的文本框：还没有 id，单独渲染一个虚线框 */}
      {textDraft && textDraft.id === null && textDraft.page === page ? (
        <div
          className="edit-item edit-item--text is-editing"
          data-edit-new-text="1"
          data-page={page}
          style={boxStyle(textDraft.rect, scale)}
        >
          <textarea
            ref={props.textAreaRef}
            className="edit-textarea"
            data-edit-textarea="new"
            placeholder="输入文字，回车确认（Shift+回车换行）"
            spellCheck={false}
            style={{
              fontSize: textDraft.fontSize * scale,
              lineHeight: LINE_HEIGHT,
              color: '#111418'
            }}
            onKeyDown={props.onTextKeyDown}
            onInput={props.onTextInput}
            onBlur={props.onTextCommit}
          />
        </div>
      ) : null}

      {/* 拖拽绘制中的图形预览 */}
      {shapeDraft && shapeDraft.page === page ? (
        <div
          className={`edit-item edit-item--${shapeDraft.type} is-draft`}
          data-edit-draft={shapeDraft.type}
          data-page={page}
          style={boxStyle(shapeDraft.rect, scale)}
        >
          {renderShape(
            shapeDraft.type,
            shapeDraft.rect,
            shapeDraft.color,
            shapeDraft.strokeWidth
          )}
        </div>
      ) : null}
    </div>
  )
}

function boxStyle(rect: AnnotationRect, scale: number): React.CSSProperties {
  return {
    left: `${rect.x * scale}px`,
    top: `${rect.y * scale}px`,
    width: `${rect.width * scale}px`,
    height: `${rect.height * scale}px`
  }
}

/** 一条已落库批注的外观 */
function renderVisual(item: Annotation, scale: number): JSX.Element | null {
  switch (item.type) {
    case 'whiteout':
      return <span className="edit-visual edit-visual--whiteout" />

    case 'rect':
    case 'ellipse':
      return renderShape(item.type, item.rects[0], item.color, item.strokeWidth ?? DEFAULT_STROKE_WIDTH)

    case 'text':
      return (
        <span
          className="edit-visual edit-visual--text"
          style={{
            fontSize: `${(item.fontSize ?? DEFAULT_FONT_SIZE) * scale}px`,
            lineHeight: LINE_HEIGHT,
            color: item.color,
            /*
             * v2.1.3：改文字继承来的字体长相。
             * 不填就保持 CSS 里的默认值，老批注的观感一个像素都不变。
             */
            fontWeight: item.fontWeight,
            fontStyle: item.fontStyle,
            fontFamily: item.fontFamily
          }}
        >
          {item.text ?? ''}
        </span>
      )

    case 'image':
      return item.image ? (
        <img className="edit-visual edit-visual--image" src={item.image} alt="" draggable={false} />
      ) : null

    default:
      return null
  }
}

/**
 * 矩形/椭圆用 SVG 画。
 *
 * 关键点：`viewBox` 用**页面坐标**、元素尺寸用屏幕像素，
 * 于是 strokeWidth 直接写页面坐标下的线宽即可自动跟随缩放 ——
 * 线宽是"文档的一部分"（导出后也是这么粗），不该随缩放忽粗忽细。
 */
function renderShape(
  type: 'whiteout' | 'rect' | 'ellipse',
  rect: AnnotationRect | undefined,
  color: string,
  strokeWidth: number
): JSX.Element {
  if (!rect) return <span className="edit-visual edit-visual--whiteout" />
  if (type === 'whiteout') return <span className="edit-visual edit-visual--whiteout" />

  const w = Math.max(1, rect.width)
  const h = Math.max(1, rect.height)
  const sw = Math.max(1, strokeWidth)

  return (
    <svg
      className="edit-visual edit-visual--shape"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {type === 'rect' ? (
        // 内缩半个线宽：描边整条落在框内，和界面上看到的边框位置一致
        <rect
          x={sw / 2}
          y={sw / 2}
          width={Math.max(0, w - sw)}
          height={Math.max(0, h - sw)}
          fill="none"
          stroke={color}
          strokeWidth={sw}
        />
      ) : (
        <ellipse
          cx={w / 2}
          cy={h / 2}
          rx={Math.max(0.5, w / 2 - sw / 2)}
          ry={Math.max(0.5, h / 2 - sw / 2)}
          fill="none"
          stroke={color}
          strokeWidth={sw}
        />
      )}
    </svg>
  )
}
