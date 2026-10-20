// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 批注渲染与交互。
 *
 * 坐标约定（关键，改动前必读）：
 *   所有批注都存 **scale = 1 的 CSS 像素坐标**（原点在页面左上角）。
 *   页面渲染时按当前 scale 把标注乘以 scale 即可，缩放/旋转都不会漂移。
 *   之所以不用 PDF 的 1/72 英寸单位：那样每次渲染都要按 viewport 反算，
 *   旋转时还要处理坐标系翻转，容易出错。
 *
 * 与 pdf.js 文本层的配合：
 *   文本层里的 span 由 pdf.js 用 transform 定位，样式是 scale 后的像素值。
 *   因此选区矩形除以当前 scale 就得到 scale=1 的坐标。
 */

import { useEffect, useRef, useState } from 'react'
import type { Annotation, AnnotationRect, AnnotationType } from '@shared/types'
import { InkCanvas, toStrokeShape, type StrokeShape } from '../ink-engine'

/** 可选的批注颜色（效仿鸿合 π6 的多色标记） */
export const ANNOTATION_COLORS = [
  { value: '#ffd400', label: '黄' },
  { value: '#7bd88f', label: '绿' },
  { value: '#5aa9ff', label: '蓝' },
  { value: '#ff8fb1', label: '粉' },
  { value: '#c792ea', label: '紫' },
  { value: '#ff9f45', label: '橙' }
] as const

/** 默认颜色 */
export const DEFAULT_ANNOTATION_COLOR = '#ffd400'

/* ============================================================
 * 选区 → 批注矩形
 * ============================================================ */

/**
 * 把浏览器选区转成页面坐标系（scale = 1）下的矩形数组。
 *
 * @param root      选区所在的容器（这里是 .pdf-page）
 * @param scale     当前页面缩放倍数
 * @returns 每行一个矩形；空数组表示没有有效选区
 *
 * 实现要点：
 *   getClientRects() 会**按行**返回矩形，正好符合高亮的视觉需求
 *   （跨行选中要高亮每一行，而不是罩一个大矩形把行间空白也涂上）。
 */
export function selectionToRects(root: HTMLElement, scale: number): AnnotationRect[] {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return []

  const range = selection.getRangeAt(0)
  const rootRect = root.getBoundingClientRect()
  const rects: AnnotationRect[] = []

  /*
   * ★ 跨页选区：**裁到本页**，而不是整段丢弃（2026-10-18 改）。
   *
   *   原来这里有一句 `if (!root.contains(range.commonAncestorContainer)) return []`。
   *   从第 3 页拖到第 4 页时，选区的公共祖先是 `.viewer-pages`（在所有页之外），
   *   于是本页一个矩形都算不出来 → 浮动工具条当场消失、连"复制"都点不到。
   *   用户看到的就是「拖过页边界，选框突然没了」。
   *
   *   现在把每一行矩形的**可视部分**裁到页面框里：
   *     · 单页内的选区：裁切是恒等变换，行为完全不变
   *     · 跨页选区：只保留落在本页的那几行（高亮/下划线也只标这一页，
   *       反正一次批注本来就只能挂在一页上）
   */
  for (const clientRect of Array.from(range.getClientRects())) {
    // 过滤掉零宽矩形（换行符等会产生）
    if (clientRect.width < 1 || clientRect.height < 1) continue

    const left = Math.max(clientRect.left, rootRect.left)
    const right = Math.min(clientRect.right, rootRect.right)
    const top = Math.max(clientRect.top, rootRect.top)
    const bottom = Math.min(clientRect.bottom, rootRect.bottom)
    // 这一行整行都在本页之外（典型的跨页选区）
    if (right - left < 1 || bottom - top < 1) continue

    rects.push({
      x: (left - rootRect.left) / scale,
      y: (top - rootRect.top) / scale,
      width: (right - left) / scale,
      height: (bottom - top) / scale
    })
  }

  return rects
}

/** 取选区里的纯文本（用于侧栏预览与检索） */
export function selectionText(maxLength = 300): string {
  const selection = window.getSelection()
  if (!selection) return ''
  const text = selection.toString().replace(/\s+/g, ' ').trim()
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}

/* ============================================================
 * 批注层（渲染已有批注）
 * ============================================================ */

/**
 * 一页的批注覆盖层。
 *
 * 高亮/下划线/删除线用绝对定位的 div 绘制；便签用一个图标。
 * pointer-events 设为 none 以免挡住文字选择 —— 代价是批注本身不可点击，
 * 这是有意的取舍：阅读时选文字远比点标注重要。
 * 需要操作批注时走右侧栏列表。
 */
export function AnnotationLayer({
  items,
  scale,
  pageWidth,
  pageHeight,
  erasing = false
}: {
  items: Annotation[]
  scale: number
  /** 页面屏幕宽度（CSS 像素） */
  pageWidth: number
  /** 页面屏幕高度（CSS 像素）；位图墨迹要按它算长宽比 */
  pageHeight: number
  /** 橡皮模式：墨迹层需要接收点击才能命中 */
  erasing?: boolean
}): JSX.Element {
  if (items.length === 0) return <div className="anno-layer" />

  /*
   * 先把手绘笔迹挑出来，交给 SVG 图层画；
   * 剩下的才走高亮/下划线/便签的常规渲染。
   *
   * ★ 这里原先漏了一步：笔迹只被当成普通便签渲染成一个小图标，
   *   页面上完全看不到画出来的线。数据一直存着（quote 里的点序列），
   *   只是没人把它画出来 —— 属于「存了但没显示」的缺陷。
   */
  const strokes: StrokeShape[] = []
  const rest: Annotation[] = []
  for (const item of items) {
    const shape = toStrokeShape(item)
    if (shape) strokes.push(shape)
    else rest.push(item)
  }

  return (
    <div className="anno-layer">
      {/*
        位图墨迹层。
        ★ 传入**页面原始尺寸**（scale = 1 的 PDF 单位），不是屏幕尺寸。
          墨迹位图按原始尺寸 × dpr × 超采样倍率分配（固定不变），
          再用 CSS 100% 铺满页面盒子 —— 与底图共享同一布局盒，
          随页面一起缩放，因此位置永远对齐、缩放也无需重绘。
      */}
      <InkCanvas
        strokes={strokes}
        baseWidth={scale > 0 ? pageWidth / scale : pageWidth}
        baseHeight={scale > 0 ? pageHeight / scale : pageHeight}
        erasing={erasing}
      />

      {rest.map((item) =>
        item.type === 'note' ? (
          <NoteMarker key={item.id} item={item} scale={scale} />
        ) : (
          item.rects.map((rect, i) => (
            <div
              key={`${item.id}-${i}`}
              /*
               * data-anno-id 供橡皮命中检测使用：
               * 橡皮模式下 pointerdown 会先判断点到了哪个批注，
               * 再按这个 id 删除整条标记（不是只删被点中的那一段）。
               */
              data-anno-id={item.id}
              className={`anno-mark anno-mark--${item.type}`}
              title={item.note ? `${item.quote}\n备注：${item.note}` : item.quote}
              style={{
                left: rect.x * scale,
                top: rect.y * scale,
                width: rect.width * scale,
                height: rect.height * scale,
                // 用 CSS 变量传色，样式文件里统一处理各种类型的效果
                ['--anno-color' as string]: item.color
              }}
            />
          ))
        )
      )}
      {/* pageWidth 仅用于让 React 在页面宽度变化时重渲染（尺寸由父容器决定） */}
      <span className="anno-layer__probe" data-width={Math.round(pageWidth)} />
    </div>
  )
}

/** 便签标记：用一个小图标指示此处有备注 */
function NoteMarker({ item, scale }: { item: Annotation; scale: number }): JSX.Element {
  const first = item.rects[0]
  if (!first) return <></>
  return (
    <div
      // 与 anno-mark 一致，便于橡皮统一按 id 命中
      data-anno-id={item.id}
      className="anno-note"
      title={item.note || item.quote || '便签'}
      style={{
        left: first.x * scale,
        top: first.y * scale,
        ['--anno-color' as string]: item.color
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M4 3h16a1 1 0 0 1 1 1v11.5L15.5 21H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" opacity="0.9" />
      </svg>
    </div>
  )
}

/* ============================================================
 * 浮动工具条（选中文字后出现）
 * ============================================================ */

/** 工具条相对选区的定位信息 */
export interface FloatingAnchor {
  /** 视口坐标（fixed 定位用） */
  left: number
  top: number
  /** 选中的文字 */
  quote: string
  /** 页面编号 */
  page: number
  /** 页面坐标系下的矩形 */
  rects: AnnotationRect[]
  /**
   * 原文的字体长相（v2.1.3）。
   *
   * 改文字要把新文字写回原位，字号只靠矩形高度反推还不够：
   * 颜色、字重、斜体、字体族都决定「看起来是不是同一段字」。
   * 这些值由 DocumentView 从选中范围第一个 span 的 computedStyle 取，
   * 取不到就不填，渲染端走默认值。
   */
  style?: {
    /** 页面坐标（scale 已除掉）的字号 */
    fontSize?: number
    /** 十六进制颜色 */
    color?: string
    fontWeight?: number
    fontStyle?: 'normal' | 'italic'
    fontFamily?: string
  }
}

/**
 * 选中文字后弹出的浮动工具条。
 *
 * 交互设计（效仿鸿合 π6 的快速批注）：
 *   选中 → 工具条出现在选区上方 → 点类型即完成标记 → 选区自动清除。
 *   支持高亮 / 下划线 / 删除线 三种即时标记 + 颜色切换 + 写备注。
 */
export function SelectionToolbar({
  anchor,
  color,
  onColorChange,
  onApply,
  onNote,
  onDismiss
}: {
  anchor: FloatingAnchor
  color: string
  onColorChange: (color: string) => void
  onApply: (type: AnnotationType) => void
  onNote: () => void
  onDismiss: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  // 点击工具条外部就关闭（用捕获阶段，避免与页面点击冲突）
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismiss()
    }
    // 延迟绑定，避免触发本次选择的 mouseup 立刻把它关掉
    const timer = setTimeout(() => document.addEventListener('mousedown', onDown, true), 80)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', onDown, true)
    }
  }, [onDismiss])

  // 按 Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onDismiss])

  return (
    <div
      className="anno-toolbar"
      ref={ref}
      style={{ left: anchor.left, top: anchor.top }}
      role="toolbar"
      aria-label="批注工具"
    >
      <div className="anno-toolbar__types">
        <button className="anno-toolbar__btn" onClick={() => onApply('highlight')} title="高亮">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 11l-4 4v3h3l4-4M9 11l6-6 4 4-6 6M9 11l4 4" />
          </svg>
          <span>高亮</span>
        </button>
        <button className="anno-toolbar__btn" onClick={() => onApply('underline')} title="下划线">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M7 4v7a5 5 0 0 0 10 0V4M5 20h14" />
          </svg>
          <span>下划线</span>
        </button>
        <button className="anno-toolbar__btn" onClick={() => onApply('strikeout')} title="删除线">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 12h16M8 8a4 3 0 0 1 8 0M8 16a4 3 0 0 0 8 0" />
          </svg>
          <span>删除线</span>
        </button>
        <button className="anno-toolbar__btn" onClick={onNote} title="添加便签">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 4h16v11l-5 5H4z" />
            <path d="M15 20v-5h5" />
          </svg>
          <span>便签</span>
        </button>
      </div>

      <span className="anno-toolbar__sep" />

      <div className="anno-toolbar__colors" role="group" aria-label="标记颜色">
        {ANNOTATION_COLORS.map((c) => (
          <button
            key={c.value}
            className={`anno-color ${color === c.value ? 'is-active' : ''}`}
            style={{ ['--anno-color' as string]: c.value }}
            onClick={() => onColorChange(c.value)}
            title={c.label}
            aria-label={`颜色 ${c.label}`}
            aria-pressed={color === c.value}
          />
        ))}
      </div>
    </div>
  )
}


/* ============================================================
 * 便签编辑器
 * ============================================================ */

/** 便签输入弹窗（点「便签」或页面空白后出现） */
export function NoteEditor({
  anchor,
  initial,
  onSave,
  onCancel
}: {
  anchor: { left: number; top: number }
  initial: string
  onSave: (text: string) => void
  onCancel: () => void
}): JSX.Element {
  const [text, setText] = useState(initial)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  return (
    <div className="anno-note-editor" style={{ left: anchor.left, top: anchor.top }}>
      <textarea
        ref={ref}
        className="anno-note-editor__input"
        value={text}
        placeholder="写点备注…（Ctrl+Enter 保存，Esc 取消）"
        rows={4}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            onSave(text.trim())
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
      />
      <div className="anno-note-editor__actions">
        <button className="text-btn" onClick={onCancel}>
          取消
        </button>
        <button className="text-btn text-btn--primary" onClick={() => onSave(text.trim())}>
          保存
        </button>
      </div>
    </div>
  )
}
