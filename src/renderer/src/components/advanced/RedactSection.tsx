// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 安全遮盖（红色遮盖 / 永久删除）。
 *
 * 交互：选定一页 → 在预览图上拖出黑框 → 可以切到别的页继续画 →
 * 一次性「应用」，把这些页连同黑框渲染成位图后替换原页。
 *
 * 为什么这样"安全"：输出文件里这些页已经是图片，
 * 被遮住的文字在内容流中**不存在**了，复制、搜索、提取都拿不到；
 * 未被遮盖的页仍是原矢量页，文字可搜索。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { ChevronLeft, ChevronRight, EyeOff, RefreshCw, Trash2 } from 'lucide-react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { openPdfForTools, renderRedactedPage, type RedactionBox } from '../../pdf-tools'
import { SourcePicker, runTask, type TaskApi } from './shared'

interface TempBox {
  x1: number
  y1: number
  x2: number
  y2: number
}

function normalizeBox(box: TempBox): RedactionBox {
  return {
    x: Math.min(box.x1, box.x2),
    y: Math.min(box.y1, box.y2),
    width: Math.abs(box.x2 - box.x1),
    height: Math.abs(box.y2 - box.y1)
  }
}

export function RedactSection({
  task,
  currentDoc
}: {
  task: TaskApi
  currentDoc: string
}): JSX.Element {
  const [source, setSource] = useState(currentDoc)
  const [page, setPage] = useState(1)
  const [pageCount, setPageCount] = useState(0)
  const [pageSize, setPageSize] = useState({ width: 595.28, height: 841.69 })
  const [preview, setPreview] = useState<string>('')
  const [boxesByPage, setBoxesByPage] = useState<Record<number, RedactionBox[]>>({})
  const [temp, setTemp] = useState<TempBox | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dragStartRef = useRef<{ x: number; y: number } | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const docRef = useRef<PDFDocumentProxy | null>(null)
  const docPathRef = useRef<string>('')

  const ensureDoc = useCallback(async (filePath: string): Promise<PDFDocumentProxy> => {
    if (docRef.current && docPathRef.current === filePath) return docRef.current
    if (docRef.current) void docRef.current.destroy()
    const doc = await openPdfForTools(filePath)
    docRef.current = doc
    docPathRef.current = filePath
    return doc
  }, [])

  const renderPreview = useCallback(
    async (filePath: string, pageNo: number): Promise<void> => {
      if (!filePath) return
      setLoading(true)
      setError(null)
      try {
        const doc = await ensureDoc(filePath)
        setPageCount(doc.numPages)
        const target = Math.min(Math.max(1, pageNo), doc.numPages)
        const pdfPage = await doc.getPage(target)
        const base = pdfPage.getViewport({ scale: 1, rotation: 0 })
        setPageSize({ width: base.width, height: base.height })
        const displayWidth = 460
        const scale = displayWidth / base.width
        const viewport = pdfPage.getViewport({ scale })
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(viewport.width))
        canvas.height = Math.max(1, Math.round(viewport.height))
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.fillStyle = '#ffffff'
          ctx.fillRect(0, 0, canvas.width, canvas.height)
          const renderTask = pdfPage.render({ canvasContext: ctx, viewport })
          await (renderTask as unknown as { promise: Promise<void> }).promise
          setPreview(canvas.toDataURL('image/jpeg', 0.85))
        }
        pdfPage.cleanup()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setLoading(false)
      }
    },
    [ensureDoc]
  )

  useEffect(() => {
    setSource((prev) => prev || currentDoc)
  }, [currentDoc])

  useEffect(() => {
    if (source) void renderPreview(source, page)
  }, [source, page, renderPreview])

  useEffect(
    () => () => {
      if (docRef.current) void docRef.current.destroy()
      docRef.current = null
    },
    []
  )

  /* ---------- 拖框 ---------- */

  const toPagePoint = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const overlay = overlayRef.current
    if (!overlay) return null
    const rect = overlay.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    return {
      x: ((clientX - rect.left) / rect.width) * pageSize.width,
      y: ((clientY - rect.top) / rect.height) * pageSize.height
    }
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (task.busy) return
    const point = toPagePoint(event.clientX, event.clientY)
    if (!point) return
    dragStartRef.current = point
    setTemp({ x1: point.x, y1: point.y, x2: point.x, y2: point.y })
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = dragStartRef.current
    if (!start || task.busy) return
    const point = toPagePoint(event.clientX, event.clientY)
    if (!point) return
    setTemp({ x1: start.x, y1: start.y, x2: point.x, y2: point.y })
  }

  const onPointerUp = (): void => {
    const start = dragStartRef.current
    dragStartRef.current = null
    if (!start || !temp) return
    const box = normalizeBox(temp)
    setTemp(null)
    /* 面积太小的当作误触 */
    if (box.width < 4 || box.height < 4) return
    setBoxesByPage((prev) => ({ ...prev, [page]: [...(prev[page] ?? []), box] }))
  }

  const currentBoxes = boxesByPage[page] ?? []
  const totalBoxes = Object.values(boxesByPage).reduce((sum, list) => sum + list.length, 0)
  const redactedPages = Object.keys(boxesByPage).filter((key) => (boxesByPage[Number(key)] ?? []).length > 0)

  const undo = (): void => {
    setBoxesByPage((prev) => {
      const list = [...(prev[page] ?? [])]
      list.pop()
      return { ...prev, [page]: list }
    })
  }

  const clearPage = (): void => {
    setBoxesByPage((prev) => ({ ...prev, [page]: [] }))
  }

  const apply = async (): Promise<void> => {
    const pagesWithBoxes = Object.entries(boxesByPage)
      .map(([key, list]) => ({ page: Number(key), boxes: list }))
      .filter((item) => item.boxes.length > 0)
    if (pagesWithBoxes.length === 0) {
      task.setFeedback({ kind: 'error', text: '还没有画任何遮盖框' })
      return
    }
    if (!source) {
      task.setFeedback({ kind: 'error', text: '请先选择源 PDF' })
      return
    }

    await runTask(
      task,
      '正在应用安全遮盖…',
      async () => {
        const doc = await ensureDoc(source)
        const pages = []
        for (const item of pagesWithBoxes) {
          const rendered = await renderRedactedPage(doc, item.page, item.boxes, { dpi: 150 })
          pages.push({
            page: item.page,
            data: rendered.data,
            mime: 'image/jpeg' as const,
            width: rendered.width,
            height: rendered.height
          })
        }
        return window.pdfApp.advanced.redact({ sourcePath: source, pages })
      },
      '安全遮盖完成'
    )
  }

  const boxStyle = (box: RedactionBox): CSSProperties => ({
    left: `${(box.x / pageSize.width) * 100}%`,
    top: `${(box.y / pageSize.height) * 100}%`,
    width: `${(box.width / pageSize.width) * 100}%`,
    height: `${(box.height / pageSize.height) * 100}%`
  })

  return (
    <section className="sb-card">
      <h3 className="sb-card-title">
        <EyeOff size={15} aria-hidden="true" />
        安全遮盖（永久删除）
      </h3>
      <p className="tools-hint">
        在预览图上拖出黑框，盖住的文字会随该页一起被**转成图片**，
        原文字从文件里彻底消失（不可复制、不可搜索）。未遮盖的页保持原样。
        此操作不可撤销，请务必保留原文件。
      </p>

      <SourcePicker value={source} onChange={setSource} disabled={task.busy || loading} />

      <div className="sb-field tools-inline">
        <button
          type="button"
          className="sb-btn"
          onClick={() => void renderPreview(source, page)}
          disabled={task.busy || !source || loading}
        >
          <RefreshCw size={14} />
          刷新预览
        </button>
        <button
          type="button"
          className="sb-btn sb-btn-icon"
          title="上一页"
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page <= 1}
        >
          <ChevronLeft size={14} />
        </button>
        <label className="tools-inline">
          <input
            className="sb-input tools-num"
            type="number"
            min={1}
            max={pageCount || 9999}
            value={page}
            onChange={(event) => setPage(Math.max(1, Number(event.target.value) || 1))}
            aria-label="页码"
          />
          <span className="tools-note">/ {pageCount || '—'} 页</span>
        </label>
        <button
          type="button"
          className="sb-btn sb-btn-icon"
          title="下一页"
          onClick={() => setPage((p) => Math.min(pageCount || p, p + 1))}
          disabled={!pageCount || page >= pageCount}
        >
          <ChevronRight size={14} />
        </button>
        {loading ? <span className="tools-note">渲染中…</span> : null}
      </div>

      {error ? <p className="tools-error-text">{error}</p> : null}

      <div
        className="redact-stage"
        ref={overlayRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        role="application"
        aria-label="遮盖预览：拖动鼠标框出要遮盖的区域"
      >
        {preview ? (
          <img className="redact-stage__page" src={preview} alt={`第 ${page} 页预览`} draggable={false} />
        ) : (
          <div className="redact-stage__empty">预览加载中…</div>
        )}
        {currentBoxes.map((box, index) => (
          <div className="redact-box" style={boxStyle(box)} key={`box-${page}-${index}`} />
        ))}
        {temp ? <div className="redact-box redact-box--temp" style={boxStyle(normalizeBox(temp))} /> : null}
      </div>

      <div className="sb-field tools-inline">
        <button type="button" className="sb-btn" onClick={undo} disabled={currentBoxes.length === 0 || task.busy}>
          <Trash2 size={14} />
          撤销本页最后一处
        </button>
        <button
          type="button"
          className="sb-btn"
          onClick={clearPage}
          disabled={currentBoxes.length === 0 || task.busy}
        >
          清空本页
        </button>
        <button
          type="button"
          className="sb-btn sb-btn-danger"
          onClick={() => setBoxesByPage({})}
          disabled={totalBoxes === 0 || task.busy}
        >
          清空全部
        </button>
      </div>

      <p className="tools-note">
        已标记 {totalBoxes} 处，涉及 {redactedPages.length} 页
        {redactedPages.length > 0 ? `（第 ${redactedPages.map(Number).sort((a, b) => a - b).join('、')} 页）` : ''}
      </p>

      <div className="tools-actions">
        <button
          type="button"
          className="sb-btn sb-btn-primary"
          onClick={() => void apply()}
          disabled={task.busy || totalBoxes === 0 || !source}
        >
          <EyeOff size={15} />
          应用遮盖并另存
        </button>
      </div>
    </section>
  )
}
