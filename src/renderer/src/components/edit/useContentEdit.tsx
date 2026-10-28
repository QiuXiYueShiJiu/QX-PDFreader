// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 「覆盖式内容编辑」的交互状态机。
 *
 * DocumentView 只做三件事：把指针事件先交给 `handlePointerDown`、
 * 把每页的内容批注交给 `renderLayer`、把 `overlay` 挂到根节点旁边。
 * 其余（选中、拖动、缩放、就地编辑文字、粘贴图片、右键删除、导出）
 * 全部收在这里，避免那 3000 行的文件再长一截。
 *
 * ★ 与既有手势的边界（editTool === 'none' 时行为必须一字不变）：
 *   · `handlePointerDown` 第一行就判断工具，非编辑态直接返回 false，
 *     调用方继续走原来的掌心/橡皮/画笔/漫游分支。
 *   · 选择工具在空白处返回 false，故意把事件让回去 —— 让
 *     `startRoamPan` 决定是平移还是让位给原生选字。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { Annotation, AnnotationRect, EditTool } from '@shared/types'
import { useViewer } from '../../store'
import type { FloatingAnchor } from '../AnnotationLayer'
import { EditBar } from './EditBar'
import { setEditBarRenderer } from './ContentEditBridge'
import { EditLayer, normalizeLine, type EditDraft, type ShapeDraft, type TextDraft } from './EditLayer'
import { SelectionBar } from './SelectionBar'
import {
  DEFAULT_FONT_SIZE,
  DEFAULT_STROKE_WIDTH,
  DEFAULT_TEXT_WIDTH,
  DRAG_THRESHOLD,
  IMAGE_MAX_RATIO,
  LINE_HEIGHT,
  MIN_ITEM_SIZE,
  MIN_LINE_THICKNESS,
  MIN_SHAPE_SIZE,
  clampRect,
  imageNaturalSize,
  moveRect,
  padRect,
  rectFromPoints,
  resizeRect,
  SHAPE_FILL_ALPHA,
  withAlpha,
  type Corner,
  type PageBounds
} from './edit-common'

interface ContentEditOptions {
  doc: PDFDocumentProxy | null
  /** 屏幕缩放：页面坐标 × scale = 屏幕像素 */
  scale: number
  /** 页面的屏幕尺寸（可能含视图旋转），除以 scale 得到页面坐标边界 */
  pageWidth: number
  pageHeight: number
  /** DocumentView 里那唯一一套屏幕 → 页面坐标换算 */
  toPagePoint: (
    clientX: number,
    clientY: number,
    pageEl: HTMLElement
  ) => { x: number; y: number } | null
  /** 选择工具的选区锚点（DocumentView 已有的 FloatingAnchor） */
  anchor: FloatingAnchor | null
  /** 清掉 DOM 选区与锚点 */
  dismissSelection: () => void
}

export interface ContentEditApi {
  /** true 表示事件已被编辑工具消费，调用方必须直接 return */
  handlePointerDown: (e: React.PointerEvent<HTMLDivElement>) => boolean
  handleContextMenu: (e: React.MouseEvent<HTMLDivElement>) => void
  /** 每页的内容编辑层节点 */
  renderLayer: (page: number, items: Annotation[]) => JSX.Element
  /** 浮动工具条 + 隐藏的文件选择器 + 选区条 + 右键菜单 */
  overlay: JSX.Element | null
  /** 编辑工具激活时要禁掉双击缩放，否则"画两个框"会被认成双击 */
  suppressGestures: boolean
}

/** 一次拖拽会话（移动 / 缩放 / 绘制新图形） */
interface DragSession {
  kind: 'move' | 'resize' | 'shape'
  pointerId: number
  page: number
  pageEl: HTMLElement
  id: string
  corner: Corner | null
  origin: AnnotationRect | null
  /** 等比缩放的比例（图片用）；Shift 按下时当次改为自由缩放 */
  aspect: number | null
  startX: number
  startY: number
  type: 'whiteout' | 'rect' | 'ellipse' | 'line' | 'arrow' | null
  /** 是否真的移动过：没动过就是一次点选，不该写回位置 */
  moved: boolean
}

export function useContentEdit(options: ContentEditOptions): ContentEditApi {
  const tool = useViewer((s) => s.editTool)
  const setEditTool = useViewer((s) => s.setEditTool)
  const annotations = useViewer((s) => s.annotations)
  const addAnnotation = useViewer((s) => s.addAnnotation)
  const updateAnnotation = useViewer((s) => s.updateAnnotation)
  const removeAnnotation = useViewer((s) => s.removeAnnotation)
  const drawColor = useViewer((s) => s.drawColor)
  const setDrawColor = useViewer((s) => s.setDrawColor)
  const exportDirty = useViewer((s) => s.exportDirty)
  const showToast = useViewer((s) => s.showToast)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<EditDraft | null>(null)
  const [shapeDraft, setShapeDraft] = useState<ShapeDraft | null>(null)
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null)
  const [pendingImage, setPendingImage] = useState<string | null>(null)
  const [fontSize, setFontSize] = useState<number>(DEFAULT_FONT_SIZE)
  const [strokeWidth, setStrokeWidth] = useState<number>(DEFAULT_STROKE_WIDTH)
  /* 填充与虚线是「新画出来的图形」的默认形态；选中已有图形时点这两个按钮直接改它 */
  const [fillOn, setFillOn] = useState(false)
  const [dashOn, setDashOn] = useState(false)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [exporting, setExporting] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  /*
   * 事件回调活在 window 上（拖动/粘贴/键盘），它们的闭包可能比一次渲染更长寿，
   * 所以凡是"回调里要读的最新值"都过一次 ref —— 否则会拿到按下那一刻的旧状态。
   */
  const stateRef = useRef({ tool, scale: options.scale, drawColor, strokeWidth, fontSize, fillOn, dashOn })
  stateRef.current = { tool, scale: options.scale, drawColor, strokeWidth, fontSize, fillOn, dashOn }

  const boundsRef = useRef<PageBounds>({ width: 0, height: 0 })
  boundsRef.current = {
    width: options.scale > 0 ? options.pageWidth / options.scale : 0,
    height: options.scale > 0 ? options.pageHeight / options.scale : 0
  }

  const annotationsRef = useRef<Annotation[]>(annotations)
  annotationsRef.current = annotations
  const anchorRef = useRef<FloatingAnchor | null>(options.anchor)
  anchorRef.current = options.anchor
  const dismissRef = useRef(options.dismissSelection)
  dismissRef.current = options.dismissSelection
  const toPageRef = useRef(options.toPagePoint)
  toPageRef.current = options.toPagePoint

  const draftRef = useRef<EditDraft | null>(draft)
  draftRef.current = draft
  const shapeRef = useRef<ShapeDraft | null>(shapeDraft)
  shapeRef.current = shapeDraft
  const textDraftRef = useRef<TextDraft | null>(textDraft)
  textDraftRef.current = textDraft
  const pendingImageRef = useRef<string | null>(pendingImage)
  pendingImageRef.current = pendingImage
  const selectedRef = useRef<string | null>(selectedId)
  selectedRef.current = selectedId

  const textAreaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const sessionRef = useRef<DragSession | null>(null)
  const detachRef = useRef<(() => void) | null>(null)
  const exportingRef = useRef(false)

  const pageOf = (pageEl: HTMLElement): number => Number(pageEl.dataset.page) || 1

  const detach = useCallback((): void => {
    detachRef.current?.()
    detachRef.current = null
  }, [])

  /* ---------------- 文本框 ---------------- */

  /** 丢弃正在编辑的文本框（Esc / 切工具） */
  const cancelText = useCallback((): void => {
    if (!textDraftRef.current) return
    // 先断掉 ref，避免 textarea 卸载时的 blur 又走一次 commit
    textDraftRef.current = null
    setTextDraft(null)
  }, [])

  /**
   * 确认文本框。
   *
   * 高度用 `scrollHeight` 反算页面坐标：界面里文字会撑高盒子，
   * 导出时不能再裁剪（导出只按宽度折行、不裁高度），
   * 两边都"按内容长高"才不会出现"屏幕上在框里、导出来跑到框外"。
   */
  const commitText = useCallback((): void => {
    const current = textDraftRef.current
    const el = textAreaRef.current
    if (!current || !el) return
    const text = el.value
    const scale = stateRef.current.scale > 0 ? stateRef.current.scale : 1
    textDraftRef.current = null
    setTextDraft(null)
    if (!text.trim()) return // 空框不留痕迹：用户点了空白处就消失

    const contentHeight = Math.max(el.scrollHeight, el.clientHeight) / scale
    const rect = clampRect(
      { ...current.rect, height: Math.max(current.rect.height, contentHeight) },
      boundsRef.current
    )
    if (current.id) {
      void updateAnnotation(current.id, { text, rects: [rect] })
    } else {
      void addAnnotation({
        page: current.page,
        type: 'text',
        text,
        rects: [rect],
        color: stateRef.current.drawColor,
        // quote 给右侧批注列表当预览文字用，跟笔迹的编码字符串井水不犯河水
        quote: text.slice(0, 300),
        note: '',
        fontSize: current.fontSize
      })
    }
  }, [addAnnotation, updateAnnotation])

  const onTextKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      // 回车确认、Shift+回车换行 —— 与任务约定一致（多行靠 Shift）
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        commitText()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        cancelText()
      }
    },
    [commitText, cancelText]
  )

  /** 输入时让 textarea 自己长高，所见即所得的一半靠它 */
  const onTextInput = useCallback((e: React.FormEvent<HTMLTextAreaElement>): void => {
    const el = e.currentTarget
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [])

  /** 双击已有文本框 → 就地编辑 */
  const startEditingText = useCallback((id: string): void => {
    const item = annotationsRef.current.find((a) => a.id === id)
    const rect = item?.rects[0]
    if (!item || !rect) return
    setSelectedId(id)
    setMenu(null)
    setTextDraft({ id, page: item.page, rect, fontSize: item.fontSize ?? DEFAULT_FONT_SIZE })
  }, [])

  /** 新建文本框：点哪儿就在哪儿开一个，宽度给默认值，高度随内容长 */
  const startNewText = useCallback(
    (page: number, p: { x: number; y: number }): void => {
      commitText() // 上一个没确认的先落库，避免"开了新的、丢一个旧的"
      const size = stateRef.current.fontSize
      const rect = clampRect(
        { x: p.x, y: p.y, width: DEFAULT_TEXT_WIDTH, height: size * LINE_HEIGHT },
        boundsRef.current
      )
      setSelectedId(null)
      setMenu(null)
      setTextDraft({ id: null, page, rect, fontSize: size })
    },
    [commitText]
  )

  /* ---------------- 拖拽会话 ---------------- */

  const finishSession = useCallback(
    (session: DragSession): void => {
      detach()
      sessionRef.current = null

      if (session.kind === 'shape') {
        const draftShape = shapeRef.current
        const rect = draftShape?.rect ?? null
        setShapeDraft(null)
        if (!rect || !session.type) return

        /* 直线/箭头：判「长度」而不是「外接框面积」——水平线高度为 0，
           用外接框判会被当成「点了一下」直接丢掉。 */
        if (session.type === 'line' || session.type === 'arrow') {
          const from = draftShape?.from
          const to = draftShape?.to
          if (!from || !to) return
          const length = Math.hypot(to.x - from.x, to.y - from.y)
          if (length < MIN_SHAPE_SIZE) {
            if (length > 0.5) showToast('拖长一点再松手', 1600)
            return
          }
          /*
           * 外接框至少留 6px：完全水平/垂直的线外接框会退化成 0 厚度，
           * 选中手柄和命中测试都无处落脚，连自己都点不中。
           */
          const box = padRect(rect, MIN_LINE_THICKNESS)
          void addAnnotation({
            page: session.page,
            type: session.type,
            rects: [box],
            color: stateRef.current.drawColor,
            quote: '',
            note: '',
            strokeWidth: stateRef.current.strokeWidth,
            line: normalizeLine(box, from, to),
            ...(draftShape?.dash ? { dash: true } : {})
          })
          return
        }

        if (rect.width < MIN_SHAPE_SIZE || rect.height < MIN_SHAPE_SIZE) {
          // 只是点了一下：不产生看不见的小方块，给个提示
          if (rect.width > 0.5 || rect.height > 0.5) showToast('拖大一点再松手', 1600)
          return
        }
        const white = session.type === 'whiteout'
        void addAnnotation({
          page: session.page,
          type: session.type,
          rects: [rect],
          // 涂白必须是纯白：它的语义是"盖住"，不是一种颜色
          color: white ? '#ffffff' : stateRef.current.drawColor,
          quote: '',
          note: '',
          ...(white
            ? {}
            : {
                strokeWidth: stateRef.current.strokeWidth,
                ...(draftShape?.fill ? { fill: draftShape.fill } : {}),
                ...(draftShape?.dash ? { dash: true } : {})
              })
        })
        return
      }

      const live = draftRef.current
      setDraft(null)
      // 点选（没移动过）不写回：否则每次点击都会产生一次无意义的批注更新 + 撤销记录
      if (session.moved && live && live.id === session.id) {
        void updateAnnotation(session.id, { rects: [live.rect] })
      }
    },
    [addAnnotation, detach, showToast, updateAnnotation]
  )

  const attachSession = useCallback(
    (session: DragSession): void => {
      detach()
      sessionRef.current = session

      const onMove = (ev: PointerEvent): void => {
        const s = sessionRef.current
        if (!s || ev.pointerId !== s.pointerId) return
        const p = toPageRef.current(ev.clientX, ev.clientY, s.pageEl)
        if (!p) return
        const dx = p.x - s.startX
        const dy = p.y - s.startY
        if (!s.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
        s.moved = true

        if (s.kind === 'move' && s.origin) {
          setDraft({ id: s.id, rect: moveRect(s.origin, dx, dy, boundsRef.current) })
          return
        }
        if (s.kind === 'resize' && s.origin && s.corner) {
          // 图片默认等比，按住 Shift 放开比例（自由缩放）
          const aspect = s.aspect && !ev.shiftKey ? s.aspect : null
          setDraft({
            id: s.id,
            rect: resizeRect(s.origin, s.corner, p.x, p.y, {
              bounds: boundsRef.current,
              aspect
            })
          })
          return
        }
        if (s.kind === 'shape') {
          setShapeDraft((prev) =>
            prev
              ? {
                  ...prev,
                  rect: rectFromPoints(s.startX, s.startY, p.x, p.y),
                  ...(prev.from ? { to: { x: p.x, y: p.y } } : {})
                }
              : prev
          )
        }
      }

      const onUp = (ev: PointerEvent): void => {
        const s = sessionRef.current
        if (!s || ev.pointerId !== s.pointerId) return
        finishSession(s)
      }

      window.addEventListener('pointermove', onMove, true)
      window.addEventListener('pointerup', onUp, true)
      window.addEventListener('pointercancel', onUp, true)
      detachRef.current = () => {
        window.removeEventListener('pointermove', onMove, true)
        window.removeEventListener('pointerup', onUp, true)
        window.removeEventListener('pointercancel', onUp, true)
      }
    },
    [detach, finishSession]
  )

  const cancelSession = useCallback((): void => {
    detach()
    sessionRef.current = null
    setDraft(null)
    setShapeDraft(null)
  }, [detach])

  const beginMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, id: string, pageEl: HTMLElement): void => {
      const item = annotationsRef.current.find((a) => a.id === id)
      const origin = item?.rects[0]
      const p = toPageRef.current(e.clientX, e.clientY, pageEl)
      if (!origin || !p) return
      attachSession({
        kind: 'move',
        pointerId: e.pointerId,
        page: pageOf(pageEl),
        pageEl,
        id,
        corner: null,
        origin,
        aspect: null,
        startX: p.x,
        startY: p.y,
        type: null,
        moved: false
      })
    },
    [attachSession]
  )

  const beginResize = useCallback(
    (
      e: React.PointerEvent<HTMLDivElement>,
      id: string,
      pageEl: HTMLElement,
      corner: Corner
    ): void => {
      const item = annotationsRef.current.find((a) => a.id === id)
      const origin = item?.rects[0]
      const p = toPageRef.current(e.clientX, e.clientY, pageEl)
      if (!origin || !p) return
      attachSession({
        kind: 'resize',
        pointerId: e.pointerId,
        page: pageOf(pageEl),
        pageEl,
        id,
        corner,
        origin,
        // 只有图片锁比例：文字框和图形拉伸是常见需求
        aspect: item && item.type === 'image' && origin.height > 0 ? origin.width / origin.height : null,
        startX: p.x,
        startY: p.y,
        type: null,
        moved: false
      })
    },
    [attachSession]
  )

  const beginShape = useCallback(
    (
      e: React.PointerEvent<HTMLDivElement>,
      type: 'whiteout' | 'rect' | 'ellipse' | 'line' | 'arrow',
      page: number,
      p: { x: number; y: number }
    ): void => {
      const base = boundsRef.current
      if (!(base.width > 0) || !(base.height > 0)) return
      attachSession({
        kind: 'shape',
        pointerId: e.pointerId,
        page,
        pageEl: (e.target as HTMLElement).closest<HTMLElement>('.pdf-page') as HTMLElement,
        id: '',
        corner: null,
        origin: null,
        aspect: null,
        startX: p.x,
        startY: p.y,
        type,
        moved: false
      })
      const colorNow = type === 'whiteout' ? '#ffffff' : stateRef.current.drawColor
      setShapeDraft({
        page,
        type,
        rect: { x: p.x, y: p.y, width: 0, height: 0 },
        color: colorNow,
        strokeWidth: stateRef.current.strokeWidth,
        /* 直线/箭头记下起点：外接框会丢方向，端点得单独存 */
        ...(type === 'line' || type === 'arrow' ? { from: { x: p.x, y: p.y }, to: { x: p.x, y: p.y } } : {}),
        /* 填充只对矩形/椭圆有意义（涂白本身就是填充），虚线四种都能用 */
        ...(stateRef.current.fillOn && (type === 'rect' || type === 'ellipse')
          ? { fill: withAlpha(colorNow, SHAPE_FILL_ALPHA) }
          : {}),
        ...(stateRef.current.dashOn ? { dash: true } : {})
      })
    },
    [attachSession]
  )

  /* ---------------- 图片 ---------------- */

  const placeImage = useCallback(
    async (page: number, p: { x: number; y: number }): Promise<void> => {
      const data = pendingImageRef.current
      if (!data) {
        showToast('先点「选择图片」，或按 Ctrl+V 粘贴', 2200)
        return
      }
      try {
        const size = await imageNaturalSize(data)
        const b = boundsRef.current
        /*
         * 初始尺寸：不超过页面的 60%。
         * 直接按原始像素贴会把一张 4000px 的截图放到"整页都是它"，
         * 想缩小还得先拖手柄 —— 不如一开始就放到合适的量级。
         */
        const k = Math.min(
          1,
          (b.width * IMAGE_MAX_RATIO) / Math.max(1, size.width),
          (b.height * IMAGE_MAX_RATIO) / Math.max(1, size.height)
        )
        const width = Math.max(MIN_ITEM_SIZE, size.width * k)
        const height = Math.max(MIN_ITEM_SIZE, size.height * k)
        const rect = clampRect({ x: p.x - width / 2, y: p.y - height / 2, width, height }, b)
        pendingImageRef.current = null
        setPendingImage(null)
        void addAnnotation({
          page,
          type: 'image',
          image: data,
          rects: [rect],
          color: stateRef.current.drawColor,
          quote: '',
          note: ''
        })
        showToast('图片已放置，可拖动调整', 1800)
      } catch (error) {
        showToast(error instanceof Error ? error.message : '图片解析失败', 2200)
      }
    },
    [addAnnotation, showToast]
  )

  const acceptImage = useCallback(
    (file: File): void => {
      const reader = new FileReader()
      reader.onload = () => {
        const data = typeof reader.result === 'string' ? reader.result : null
        if (!data) {
          showToast('图片读取失败', 2000)
          return
        }
        pendingImageRef.current = data
        setPendingImage(data)
        // 粘贴图片时用户可能停在别的工具上：自动切到图片工具，点一下就能放
        if (stateRef.current.tool !== 'image') setEditTool('image')
        showToast('图片已就绪：在页面上点一下放置', 2400)
      }
      reader.onerror = () => showToast('图片读取失败', 2000)
      reader.readAsDataURL(file)
    },
    [setEditTool, showToast]
  )

  /* ---------------- 指针入口 ---------------- */

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): boolean => {
      const current = stateRef.current.tool
      if (current === 'none') return false
      setMenu(null)
      // 只接管左键；右键留给 contextmenu，中键留给未来的手势
      if (e.button !== 0) return false

      const target = e.target as HTMLElement

      /*
       * 正在输入的那个 textarea 自己处理点击。
       *
       * ★ 不这样拦一下会很难用：点一下想把光标挪到中间，事件先冒泡到这里，
       *   被当成"点在物件上"→ 开始拖动并 preventDefault，
       *   于是光标动不了、整个框还跟着手指跑。
       *   返回 true 但不 preventDefault：不拖页面，光标照常落位。
       */
      if (target.closest('[data-edit-textarea]')) return true
      const pageEl = target.closest<HTMLElement>('.pdf-page')
      const itemEl = target.closest<HTMLElement>('[data-anno-id]')
      const id = itemEl?.dataset.annoId ?? null

      if (current === 'select') {
        /*
         * 选择工具不抢空白处：返回 false 让 DocumentView 继续走 startRoamPan。
         * 它会自己判断"按在文字上 → 让给原生选字，否则平移页面"，
         * 于是"选择"模式下页面手感与漫游完全一致，只是多了点选物件。
         */
        if (!id || !itemEl || !pageEl) {
          setSelectedId(null)
          return false
        }
        setSelectedId(id)
        beginMove(e, id, pageEl)
        e.stopPropagation()
        return true
      }

      if (!pageEl) {
        setSelectedId(null)
        return true
      }

      // 内容工具：点已有物件 = 选中 + 拖动 / 缩放
      if (id && itemEl) {
        setSelectedId(id)
        const handleEl = target.closest<HTMLElement>('[data-edit-handle]')
        const corner = (handleEl?.dataset.editHandle ?? null) as Corner | null
        if (corner) beginResize(e, id, pageEl, corner)
        else beginMove(e, id, pageEl)
        e.preventDefault()
        e.stopPropagation()
        return true
      }

      const p = toPageRef.current(e.clientX, e.clientY, pageEl)
      if (!p) return true
      const page = pageOf(pageEl)

      if (current === 'text') {
        startNewText(page, p)
        e.preventDefault()
        e.stopPropagation()
        return true
      }
      if (current === 'image') {
        void placeImage(page, p)
        return true
      }
      if (
        current === 'whiteout' ||
        current === 'rect' ||
        current === 'ellipse' ||
        current === 'line' ||
        current === 'arrow'
      ) {
        beginShape(e, current, page, p)
        e.preventDefault()
        e.stopPropagation()
        return true
      }
      return true
    },
    [beginMove, beginResize, beginShape, placeImage, startNewText]
  )

  const handleContextMenu = useCallback(
    (e: React.MouseEvent<HTMLDivElement>): void => {
      if (stateRef.current.tool === 'none') return
      const itemEl = (e.target as HTMLElement).closest<HTMLElement>('[data-anno-id]')
      const id = itemEl?.dataset.annoId
      if (!id) return
      e.preventDefault()
      setSelectedId(id)
      setMenu({ id, x: e.clientX, y: e.clientY })
    },
    []
  )

  /* ---------------- 选中后的动作 ---------------- */

  const deleteSelected = useCallback((): void => {
    const id = selectedRef.current
    if (!id) return
    void removeAnnotation(id)
    setSelectedId(null)
    setMenu(null)
    showToast('已删除', 1400)
  }, [removeAnnotation, showToast])

  const changeColor = useCallback(
    (color: string): void => {
      // 复用画笔颜色：工具栏那排色板和这里的色板是同一份语义
      setDrawColor(color)
      const id = selectedRef.current
      if (!id) return
      const item = annotationsRef.current.find((a) => a.id === id)
      if (item && item.type !== 'whiteout') void updateAnnotation(id, { color })
    },
    [setDrawColor, updateAnnotation]
  )

  const changeFontSize = useCallback(
    (size: number): void => {
      setFontSize(size)
      if (textDraft) setTextDraft((prev) => (prev ? { ...prev, fontSize: size } : prev))
      const id = textDraftRef.current?.id ?? selectedRef.current
      if (id) void updateAnnotation(id, { fontSize: size })
    },
    [textDraft, updateAnnotation]
  )

  const changeStrokeWidth = useCallback(
    (width: number): void => {
      setStrokeWidth(width)
      const id = selectedRef.current
      if (!id) return
      const item = annotationsRef.current.find((a) => a.id === id)
      if (item && (item.type === 'rect' || item.type === 'ellipse' || item.type === 'line' || item.type === 'arrow')) {
        void updateAnnotation(id, { strokeWidth: width })
      }
    },
    [updateAnnotation]
  )

  /*
   * 填充 / 虚线：既改「下一笔的默认形态」，也改当前选中的那一个。
   * 两件事必须一起做 —— 否则选中一个实心矩形点「虚线」，只换了默认值、
   * 眼前这个一点反应都没有，用户会以为按钮坏了。
   */
  const toggleFill = useCallback((): void => {
    setFillOn((prev) => {
      const next = !prev
      const id = selectedRef.current
      if (id) {
        const item = annotationsRef.current.find((a) => a.id === id)
        if (item && (item.type === 'rect' || item.type === 'ellipse')) {
          void updateAnnotation(id, { fill: next ? withAlpha(item.color, SHAPE_FILL_ALPHA) : undefined })
        }
      }
      return next
    })
  }, [updateAnnotation])

  const toggleDash = useCallback((): void => {
    setDashOn((prev) => {
      const next = !prev
      const id = selectedRef.current
      if (id) {
        const item = annotationsRef.current.find((a) => a.id === id)
        if (
          item &&
          (item.type === 'rect' || item.type === 'ellipse' || item.type === 'line' || item.type === 'arrow')
        ) {
          void updateAnnotation(id, { dash: next })
        }
      }
      return next
    })
  }, [updateAnnotation])

  /* ---------------- 选择工具的复制 / 高亮 / 下划线 ---------------- */

  const copySelection = useCallback(async (): Promise<void> => {
    const quote = anchorRef.current?.quote ?? ''
    if (!quote) return
    try {
      await navigator.clipboard.writeText(quote)
      showToast('已复制选中的文字', 1600)
    } catch {
      /*
       * 剪贴板 API 在窗口失焦或权限受限时会 reject（触屏一体机上很常见），
       * 退回"临时 textarea + execCommand"这条老路，它不依赖焦点状态。
       */
      try {
        const el = document.createElement('textarea')
        el.value = quote
        el.style.position = 'fixed'
        el.style.opacity = '0'
        document.body.appendChild(el)
        el.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(el)
        showToast(ok ? '已复制选中的文字' : '复制失败，请按 Ctrl+C', 2000)
      } catch {
        showToast('复制失败，请按 Ctrl+C', 2000)
      }
    }
  }, [showToast])

  /* ============================================================
   * 改文字 / 改格式（选择工具下的两个新能力）
   *
   * PDF 的文字是只读的，所以「改文字」与「改格式」都是：
   *   ① 用一块 whiteout 盖住选区覆盖的原文；
   *   ② 把（改过的）文字作为新的 text 物件叠在**原位**上。
   * 两者共用这里的数据结构，只有面板不同。
   * ============================================================ */

  /**
   * 被改写的选区快照。
   *
   * ★ 为什么要把 anchor 里的东西**拷贝**出来存 ref：
   *   点「改文字」之后用户会在输入框里打字，这期间 PDF 文本层的选区
   *   随时可能被清掉；一旦清掉，父组件算出的 anchor 也会跟着变。
   *   快照下来才不会"打到一半目标丢了"。
   */
  const rewriteRef = useRef<{
    /** 选区覆盖的页面坐标矩形（可能跨行，取并集） */
    rect: AnnotationRect
    /**
     * 逐行矩形（v2.1.3）。
     *
     * 涂白要**一行一块**，不能只用一个并集块：
     *   跨行选区（比如选了整整两行）的并集是个大矩形，
     *   会把两行之间的行距、以及右侧没选到的空白也一并涂白，
     *   视觉上就是一个突兀的大白块。逐行涂白才是"把这几行字擦掉"。
     */
    lines: AnnotationRect[]
    page: number
    quote: string
    /** 原文的字号估计值：优先取 computedStyle，取不到再由首行高度反推 */
    fontSize: number
    /** 原文的字体长相（颜色/字重/斜体/字体族），改文字时继承 */
    style?: FloatingAnchor['style']
    /** 已生成的 text 批注 id（null = 还没落地） */
    annotationId: string | null
  } | null>(null)

  const [draftText, setDraftText] = useState('')

  /** 选区矩形的并集 + 首行高度 → 原位、字号、逐行矩形 */
  const selectionGeometry = useCallback(
    (
      rects: AnnotationRect[],
      style?: FloatingAnchor['style']
    ): { rect: AnnotationRect; fontSize: number; lines: AnnotationRect[] } | null => {
      if (rects.length === 0) return null
      const left = Math.min(...rects.map((r) => r.x))
      const top = Math.min(...rects.map((r) => r.y))
      const right = Math.max(...rects.map((r) => r.x + r.width))
      const bottom = Math.max(...rects.map((r) => r.y + r.height))
      /*
       * 字号优先用 computedStyle 里的真值（已除过缩放），
       * 取不到才回落到「首行高度 × 0.92」。
       *
       * 为什么高度反推不够：矩形高度是**行盒**高度、含行距，
       * 字体越大误差越大；computedStyle 才是渲染用的字号本身。
       */
      const firstLine = [...rects].sort((a, b) => a.y - b.y)[0]
      const fromHeight = Math.max(6, Math.round(firstLine.height * 0.92))
      const fontSize = style?.fontSize ?? fromHeight

      /*
       * 逐行合并（v2.1.3）：getClientRects 会把一行拆成好几段
       * （一个 span 一段），它们 y 相同、x 相邻。
       * 以 3px（或行高 35%）为容差并成一行，涂白时一行只涂一块。
       */
      const sorted = [...rects].sort((a, b) => a.y - b.y)
      const lines: AnnotationRect[] = []
      for (const r of sorted) {
        const last = lines[lines.length - 1]
        const tol = Math.max(3, r.height * 0.35)
        if (last && Math.abs(r.y - last.y) <= tol) {
          const l = Math.min(last.x, r.x)
          const t = Math.min(last.y, r.y)
          const rt = Math.max(last.x + last.width, r.x + r.width)
          const bt = Math.max(last.y + last.height, r.y + r.height)
          lines[lines.length - 1] = { x: l, y: t, width: rt - l, height: bt - t }
        } else {
          lines.push({ ...r })
        }
      }

      return {
        rect: { x: left, y: top, width: Math.max(12, right - left), height: Math.max(10, bottom - top) },
        fontSize,
        lines
      }
    },
    []
  )
  /** 打开「改文字」：快照选区 + 把原文放进输入框 */
  const startEditSelectedText = useCallback((): void => {
    const anchor = anchorRef.current
    if (!anchor || anchor.rects.length === 0) return
    const geo = selectionGeometry(anchor.rects, anchor.style)
    if (!geo) return
    /*
     * ★ 原文取**真实选区的完整文本**，不用 anchor.quote（v2.1.4）。
     *
     *   anchor.quote 是给浮条/批注显示用的，超过 300 字会被截断并加「…」；
     *   拿它当改文字的初值，用户一按「替换」就会把被截断的半句话写回去。
     *   按钮的 mousedown 已经 preventDefault，点下去时原生选区还在。
     */
    const live = (window.getSelection()?.toString() ?? '').replace(/\s+/g, ' ').trim()
    const quote = (live.length > 0 ? live : anchor.quote).trim()
    if (!quote) return
    rewriteRef.current = {
      rect: geo.rect,
      lines: geo.lines,
      page: anchor.page,
      quote,
      fontSize: geo.fontSize,
      style: anchor.style,
      annotationId: null
    }
    setDraftText(quote)
  }, [selectionGeometry])

  /** 落库：涂白 + 新文字。已有则只更新文字 */
  const commitRewrite = useCallback(
    (text: string, patch: { fontSize?: number; color?: string } = {}): void => {
      const target = rewriteRef.current
      if (!target) return
      const clean = text.replace(/\r\n/g, '\n')
      /*
       * 颜色优先级（v2.1.3）：
       *   ① 用户在格式面板里明确选的色
       *   ② 原文自己的颜色（从 computedStyle 读出来的）
       *   ③ 当前绘图色（兜底，只在读不到原文样式时用）
       *
       * 为什么原文颜色要排在绘图色前面：改文字默认是「把这段字换个说法」，
       * 不是「把这段字涂成红色」。实测原来用绘图色时，
       * 替换出来的字会变成当前画笔色，用户第一反应是"坏了"。
       */
      const color = patch.color ?? target.style?.color ?? stateRef.current.drawColor
      const fontSize = patch.fontSize ?? target.fontSize
      const rect = clampRect(target.rect, boundsRef.current)
      /* 逐行涂白：跨行选区一行一块，避免大块白把行距也盖掉 */
      const whiteRects = (target.lines.length > 0 ? target.lines : [rect]).map((r) => {
        const c = clampRect(r, boundsRef.current)
        return { ...c, height: Math.max(8, c.height) }
      })

      /*
       * ★ 先按**位置**找有没有已经落地过的「同位置文字物件」，
       *   不要靠 addAnnotation 回传 id。
       *
       *   踩过的坑：原来记 id 的办法是 setTimeout(120ms) 之后去
       *   annotations 里按 quote+坐标回捞。实测不可靠 ——
       *   用户点两次字号就会新增**两套**涂白+文字
       *   （白块数 1 → 2，字号集合 [10, 24]），
       *   屏幕上叠了两层白块，越点越厚。
       *
       *   位置是稳定的：它由选区的 span 几何算出来，
       *   同一段文字重新选一次也落在同一处（夹具里就是同一个点）。
       *
       *   v2.1.4 起改成**按矩形重叠**判定（交集 / 较小块面积 ≥ 50%），
       *   不再只比左上角 3px —— 选择工具重做后，同一段词重新拖选可能
       *   差几个像素（几何兜底按行内比例插值），3px 容差会让它认不出来，
       *   于是格式面板点一次就多盖一层白块（实测白块 1 → 2）。
       *   重叠比既吸收抖动，又不会误伤相邻行。
       */
      const overlaps = (a: AnnotationRect, b: AnnotationRect): boolean => {
        const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
        const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
        const inter = w * h
        const smaller = Math.min(a.width * a.height, b.width * b.height)
        return smaller > 0 && inter / smaller >= 0.5
      }
      const samePlace = annotationsRef.current.find(
        (a) => a.type === 'text' && a.page === target.page && a.rects[0] && overlaps(a.rects[0], rect)
      )
      const existingId = target.annotationId ?? samePlace?.id ?? null

      /* 继承来的字体长相：除了字号/颜色，字重与斜体也写进去 */
      const face = {
        fontWeight: target.style?.fontWeight,
        fontStyle: target.style?.fontStyle,
        fontFamily: target.style?.fontFamily
      }

      if (existingId) {
        target.annotationId = existingId
        void updateAnnotation(existingId, { text: clean, fontSize, color, rects: [rect], ...face })
        return
      }

      /*
       * ① 先涂白原文。颜色固定纯白（纸色），不要用 drawColor ——
       *    用户选的是"我要改这段字"，不是"我要画一个白块"。
       */
      void addAnnotation({
        page: target.page,
        type: 'whiteout',
        rects: whiteRects,
        color: '#ffffff',
        quote: target.quote.slice(0, 300),
        note: ''
      })

      /* ② 再把新文字写到原位 */
      void addAnnotation({
        page: target.page,
        type: 'text',
        text: clean,
        rects: [rect],
        color,
        quote: clean.slice(0, 300),
        note: '',
        fontSize,
        ...face
      })
    },
    [addAnnotation, updateAnnotation]
  )

  /** 点「替换」 */
  const applyRewrite = useCallback((): void => {
    const text = draftText
    if (!text.trim()) {
      showToast('文字不能为空', 1600)
      return
    }
    commitRewrite(text)
    rewriteRef.current = null
    setDraftText('')
    showToast('已替换选中的文字', 1800)
    dismissRef.current()
  }, [commitRewrite, draftText, showToast])

  /** 点「取消」 */
  const cancelRewrite = useCallback((): void => {
    rewriteRef.current = null
    setDraftText('')
  }, [])

  /**
   * 打开「格式」：与「改文字」共用同一份快照，
   * 但输入框保持当前内容不变，只调字号/颜色。
   *
   * 若快照不存在（用户直接点了「格式」而没先点「改文字」），
   * 就用选区原文建一份 —— 这样两个入口可以独立使用。
   */
  const startFormatSelectedText = useCallback((): void => {
    if (!rewriteRef.current) startEditSelectedText()
  }, [startEditSelectedText])

  /**
   * 应用格式。
   *
   * ★ 还没落地（annotationId 为 null）时**先把文字写进去**，
   *   否则"点字号"会什么都不发生 —— 用户以为坏了。
   *   写入用当前输入框内容（若为空则用原文），行为可预测。
   */
  const applyFormat = useCallback(
    (patch: { fontSize?: number; color?: string }): void => {
      const target = rewriteRef.current
      if (!target) return
      const text = draftText.trim() ? draftText : target.quote
      if (!target.annotationId) {
        commitRewrite(text, patch)
        /* 字号也要记住，后续点颜色时才不会再退回估计值 */
        if (patch.fontSize) target.fontSize = patch.fontSize
        return
      }
      void updateAnnotation(target.annotationId, patch)
      if (patch.fontSize) target.fontSize = patch.fontSize
    },
    [commitRewrite, draftText, updateAnnotation]
  )

  const applyRule = useCallback(
    (type: 'highlight' | 'underline'): void => {
      const anchor = anchorRef.current
      if (!anchor || anchor.rects.length === 0) return
      void addAnnotation({
        page: anchor.page,
        type,
        // anchor.rects 已经是页面坐标（DocumentView 用 selectionToRects 算好的）
        rects: anchor.rects,
        color: stateRef.current.drawColor,
        quote: anchor.quote,
        note: ''
      })
      showToast(type === 'highlight' ? '已添加高亮' : '已添加下划线', 1600)
      dismissRef.current()
    },
    [addAnnotation, showToast]
  )

  /* ---------------- 导出 ---------------- */

  const runExport = useCallback(async (): Promise<void> => {
    if (!options.doc) {
      showToast('文档还没加载完，稍后再试', 2000)
      return
    }
    if (exportingRef.current) return
    exportingRef.current = true
    setExporting(true)
    setProgress(null)
    try {
      /*
       * ★ 动态 import：anno-export 会带进整页位图渲染与导出链路，
       *   只有真的要保存时才需要（App.tsx 里的导出入口也是这么做的）。
       *   写成静态 import 会让它被并进首屏包，那个懒加载就白做了。
       */
      const { exportAnnotatedPdf } = await import('../../anno-export')
      // 用即时快照：导出过程中用户可能还在改，但这一份必须是"点下去那一刻"的
      const snapshot = useViewer.getState()
      await exportAnnotatedPdf({
        doc: options.doc,
        filePath: snapshot.filePath,
        fileName: snapshot.fileName,
        annotations: snapshot.annotations,
        onProgress: (done, total) => {
          setProgress({ done, total })
          showToast(`正在导出 ${done}/${total}`, 1000)
        }
      })
    } finally {
      exportingRef.current = false
      setExporting(false)
      setProgress(null)
    }
  }, [options.doc, showToast])

  /* ---------------- 副作用 ---------------- */

  // 新建/编辑文本框时自动聚焦，光标放末尾（编辑已有文字不该全选覆盖）
  useEffect(() => {
    if (!textDraft) return
    const el = textAreaRef.current
    if (!el) return
    el.focus()
    const len = el.value.length
    el.setSelectionRange(len, len)
  }, [textDraft])

  // 切换工具：把没确认的文本框落库、丢弃拖到一半的预览、清掉选中
  const prevToolRef = useRef<EditTool>(tool)
  useEffect(() => {
    if (prevToolRef.current === tool) return
    prevToolRef.current = tool
    commitText()
    cancelSession()
    setSelectedId(null)
    setMenu(null)
    if (tool !== 'image') {
      pendingImageRef.current = null
      setPendingImage(null)
    }
  }, [tool, commitText, cancelSession])

  // 键盘：Delete 删除选中、Esc 逐层退出（工具栏退出由 App 的 Esc 负责）
  useEffect(() => {
    if (tool === 'none') return
    const onKeyDown = (ev: KeyboardEvent): void => {
      const target = ev.target as HTMLElement | null
      const typing =
        !!target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (ev.key === 'Escape') {
        if (textDraftRef.current) {
          cancelText()
          return
        }
        if (pendingImageRef.current) {
          pendingImageRef.current = null
          setPendingImage(null)
          showToast('已取消放置图片', 1400)
          return
        }
        if (selectedRef.current) setSelectedId(null)
        return
      }
      if ((ev.key === 'Delete' || ev.key === 'Backspace') && !typing && selectedRef.current) {
        ev.preventDefault()
        deleteSelected()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [tool, cancelText, deleteSelected, showToast])

  // 粘贴板里的图片：Ctrl+V 直接读 clipboardData.items
  useEffect(() => {
    if (tool === 'none') return
    const onPaste = (ev: ClipboardEvent): void => {
      const items = ev.clipboardData?.items
      if (!items) return
      for (const entry of Array.from(items)) {
        if (entry.kind !== 'file' || !entry.type.startsWith('image/')) continue
        const file = entry.getAsFile()
        if (!file) continue
        ev.preventDefault()
        acceptImage(file)
        return
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [tool, acceptImage])

  // 卸载（切文档/关标签）时别把 window 监听留在身后
  useEffect(() => detach, [detach])

  /* ---------------- 渲染片段 ---------------- */

  const renderLayer = useCallback(
    (page: number, items: Annotation[]): JSX.Element => (
      <EditLayer
        page={page}
        items={items}
        scale={options.scale}
        interactive={tool !== 'none'}
        selectedId={selectedId}
        draft={draft}
        shapeDraft={shapeDraft}
        textDraft={textDraft}
        textAreaRef={textAreaRef}
        onTextCommit={commitText}
        onTextCancel={cancelText}
        onTextKeyDown={onTextKeyDown}
        onTextInput={onTextInput}
        onTextEdit={startEditingText}
      />
    ),
    [
      tool,
      selectedId,
      draft,
      shapeDraft,
      textDraft,
      options.scale,
      commitText,
      cancelText,
      onTextKeyDown,
      onTextInput,
      startEditingText
    ]
  )

  const onFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      const file = e.target.files?.[0]
      // 清空 value：否则连续选同一张图不会再触发 change
      e.target.value = ''
      if (file) acceptImage(file)
    },
    [acceptImage]
  )

  const menuItemIsText =
    menu !== null && annotationsRef.current.find((a) => a.id === menu.id)?.type === 'text'

  /*
   * ---------- 把编辑条交给**底部工具条**渲染 ----------
   *
   * 用户要求：选择等功能唤出的这条临时工具栏要**合并到全局底部工具条**，
   * 不要再浮在阅读区顶部（两处都有工具，一体机上要来回找）。
   *
   * 做法：把「返回 EditBar 节点的函数」注册给 DrawToolbar（见 ContentEditBridge）。
   * 每次渲染都重新注册 —— 刻意不用 useMemo/useCallback：
   *   EditBar 的 props 全是每次渲染才确定的实时值（导出进度、待放置图片…），
   *   缓存住闭包会让导出按钮读到过期的 progress，点了像没反应。
   * 卸载时注册 null，避免工具条调用到已卸载组件的 setState。
   *
   * ★ 仍然保留「无编辑时返回 null」：没进编辑态就不该多占一行高度。
   *
   * ★★ 例外：**有改动还没导出**时（exportDirty）即使回到浏览态也留着这一行。
   *   原来这里只判 `tool === 'none'`，于是「涂白/改完字 → 点漫游继续看」
   *   整条编辑条瞬间消失，导出入口跟着没了 —— 用户只能凭记忆切回某个
   *   编辑工具才能导出，看起来就像「改动丢了」。留一条只有「有未导出的编辑
   *   + 导出 PDF」的窄条，是代价最小、也最符合直觉的做法。
   */
  useEffect(() => {
    if (tool === 'none' && !exportDirty) {
      setEditBarRenderer(null)
      return
    }
    setEditBarRenderer(() => (
      <EditBar
        tool={tool}
        color={drawColor}
        fontSize={fontSize}
        strokeWidth={strokeWidth}
        fillOn={fillOn}
        dashOn={dashOn}
        exportDirty={exportDirty}
        exporting={exporting}
        progress={progress}
        canExport={annotations.length > 0}
        pendingImage={pendingImage !== null}
        hasSelection={selectedId !== null}
        onColor={changeColor}
        onFontSize={changeFontSize}
        onStrokeWidth={changeStrokeWidth}
        onToggleFill={toggleFill}
        onToggleDash={toggleDash}
        onPickImage={() => fileRef.current?.click()}
        onDelete={deleteSelected}
        onExport={() => void runExport()}
        onExit={() => setEditTool('none')}
      />
    ))
    return () => setEditBarRenderer(null)
  }, [
    tool,
    drawColor,
    fontSize,
    strokeWidth,
    fillOn,
    dashOn,
    exportDirty,
    exporting,
    progress,
    annotations.length,
    pendingImage,
    selectedId,
    changeColor,
    changeFontSize,
    changeStrokeWidth,
    toggleFill,
    toggleDash,
    deleteSelected,
    runExport,
    setEditTool
  ])

  /*
   * 还留在阅读区里的浮动件：隐藏的选图 input、选区小工具条、右键菜单。
   * 它们必须贴着页面内容（选区工具条要跟着选区走），不能进底部工具条。
   */
  const overlay =
    tool !== 'none' || exportDirty ? (
      <>
        {/* 隐藏的选图入口：按钮在编辑条上，真正的 input 放在这里（触屏也能唤起系统相册） */}
        <input
          ref={fileRef}
          className="edit-file"
          data-edit-file="1"
          type="file"
          accept="image/*"
          tabIndex={-1}
          aria-hidden="true"
          onChange={onFileChange}
        />

        {tool === 'select' && options.anchor && options.anchor.quote.trim().length > 0 ? (
          <SelectionBar
            anchor={options.anchor}
            onCopy={() => void copySelection()}
            onEditText={startEditSelectedText}
            onFormat={startFormatSelectedText}
            onFormatSize={(size) => applyFormat({ fontSize: size })}
            onFormatColor={(color) => applyFormat({ color })}
            draftText={draftText}
            onDraftTextChange={setDraftText}
            onDraftConfirm={applyRewrite}
            onDraftCancel={cancelRewrite}
            onHighlight={() => applyRule('highlight')}
            onUnderline={() => applyRule('underline')}
            onCancel={() => dismissRef.current()}
          />
        ) : null}

        {menu ? (
          <>
            {/* 透明背板：点任何地方先关菜单，避免它赖在屏幕上 */}
            <div
              className="edit-menu__backdrop"
              data-edit-menu-backdrop="1"
              onPointerDown={() => setMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu(null)
              }}
            />
            <div
              className="edit-menu"
              role="menu"
              aria-label="物件操作"
              data-edit-menu="1"
              style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
            >
              {menuItemIsText ? (
                <button
                  type="button"
                  className="edit-menu__item"
                  role="menuitem"
                  data-tb-id="edit-menu-edit"
                  onClick={() => {
                    startEditingText(menu.id)
                    setMenu(null)
                  }}
                >
                  编辑文字
                </button>
              ) : null}
              <button
                type="button"
                className="edit-menu__item edit-menu__item--danger"
                role="menuitem"
                data-tb-id="edit-menu-delete"
                onClick={deleteSelected}
              >
                删除
              </button>
            </div>
          </>
        ) : null}
      </>
    ) : null

  return {
    handlePointerDown,
    handleContextMenu,
    renderLayer,
    overlay,
    suppressGestures: tool !== 'none' && tool !== 'select'
  }
}
