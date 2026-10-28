// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 分屏对比（2.0.0，需求清单 B12）。
 *
 * ── 为什么单独写一个渲染器 ────────────────────────────────────
 *   主阅读区 `<DocumentView>` 与 zustand store 深度耦合（页码、缩放、
 *   批注、编辑工具、OCR 全在一份状态里）。要让它出第二份实例，
 *   就得把 store 改成「按窗格分片」，那是把整个渲染层重构一遍，
 *   风险远大于收益。
 *
 *   对比阅读的真实诉求是「左边教材、右边习题，两边各滚各的」——
 *   不需要在参考窗里批注。所以这里做一个**独立的轻量渲染器**：
 *   自己拿 pdf.js 文档、自己算缩放、自己滚、自己记页码，
 *   与主窗格零共享状态，互不干扰。
 *
 * ── 明确的边界 ───────────────────────────────────────────────
 *   · 参考窗只读：不画批注、不选中编辑，标题栏写明「参考窗」；
 *   · 主窗格能力完全不变（导出的批注、OCR、编辑都仍作用在左侧）；
 *   · 关掉分屏不丢状态：主窗格页码/缩放不受影响（本来就分开存）。
 */

import { useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { ChevronsLeftRight, FilePlus2, Minus, Plus, X } from 'lucide-react'
import { useViewer } from '../store'

/** 与 DocumentView 里的同名函数保持一致：盘符冒号不能编码 */
function toPdfUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const encoded = normalized
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ':'))
    .join('/')
  return `pdf-file:///${encoded}`
}

function baseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

export function ComparePane(): JSX.Element | null {
  const open = useViewer((s) => s.compareOpen)
  const path = useViewer((s) => s.comparePath)
  const close = useViewer((s) => s.closeComparePane)
  const openCompare = useViewer((s) => s.openComparePane)

  const hostRef = useRef<HTMLDivElement | null>(null)
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [width, setWidth] = useState(0)
  const [zoom, setZoom] = useState(1)
  /** 每一页在滚动容器里的纵向位置，用于算「当前第几页」 */
  const offsets = useRef<number[]>([])

  /* 面板宽度 —— 缩放基准，宽度变了要重排 */
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      setWidth(Math.max(0, Math.round(w)))
    })
    ro.observe(host)
    return () => ro.disconnect()
  }, [open])

  /* 加载文档 */
  useEffect(() => {
    if (!open || !path) {
      setDoc(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError('')
    setPage(1)
    const task = pdfjsLib.getDocument({ url: toPdfUrl(path), disableAutoFetch: false, verbosity: 0 })
    task.promise
      .then((loaded) => {
        if (cancelled) {
          void loaded.destroy()
          return
        }
        setDoc(loaded)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setDoc(null)
        setLoading(false)
        setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
      void task.destroy()
    }
  }, [open, path])

  /* 渲染全部页面（对比用，一次画完；20 页级别的文件足够快） */
  useEffect(() => {
    const host = hostRef.current
    const scroller = host
    if (!doc || !scroller || width <= 0) return
    let cancelled = false

    const render = async (): Promise<void> => {
      scroller.innerHTML = ''
      offsets.current = []
      const usable = Math.max(160, width - 28)
      const items: { page: number; top: number }[] = []

      for (let n = 1; n <= doc.numPages; n += 1) {
        if (cancelled) return
        // eslint-disable-next-line no-await-in-loop
        const pdfPage = await doc.getPage(n)
        const base = pdfPage.getViewport({ scale: 1 })
        const scale = (usable / base.width) * zoom
        const viewport = pdfPage.getViewport({ scale })
        const canvas = document.createElement('canvas')
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        canvas.className = 'compare-pane__canvas'
        canvas.dataset.page = String(n)
        const ctx = canvas.getContext('2d')
        if (!ctx) continue
        const box = document.createElement('div')
        box.className = 'compare-pane__page'
        box.dataset.page = String(n)
        box.appendChild(canvas)
        const tag = document.createElement('span')
        tag.className = 'compare-pane__tag'
        tag.textContent = String(n)
        box.appendChild(tag)
        scroller.appendChild(box)
        items.push({ page: n, top: box.offsetTop })
        // eslint-disable-next-line no-await-in-loop
        await pdfPage.render({ canvasContext: ctx, viewport }).promise
      }

      if (cancelled) return
      offsets.current = items.map((i) => i.top)
    }

    void render()
    return () => {
      cancelled = true
    }
  }, [doc, width, zoom])

  /* 滚动时更新「当前第几页」—— 取第一个仍在视口内的页 */
  useEffect(() => {
    const scroller = hostRef.current
    if (!scroller) return
    const onScroll = (): void => {
      const y = scroller.scrollTop + 24
      const tops = offsets.current
      let current = 1
      for (let i = 0; i < tops.length; i += 1) {
        if (tops[i] <= y) current = i + 1
        else break
      }
      setPage(current)
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [doc, width, zoom, open])

  if (!open) return null

  const pick = async (): Promise<void> => {
    const picked = await window.pdfApp.open.pick()
    if (picked?.path) openCompare(picked.path)
  }

  return (
    <aside className="compare-pane" data-compare-pane="1" aria-label="对比参考窗">
      <header className="compare-pane__head">
        <ChevronsLeftRight size={15} aria-hidden="true" />
        <span className="compare-pane__title" title={path || '参考窗'}>
          {path ? baseName(path) : '对比参考窗'}
        </span>
        <span className="compare-pane__tagline">参考窗 · 只读</span>
        <div className="compare-pane__tools">
          <button
            type="button"
            className="compare-pane__btn"
            data-tb-id="compare-pick"
            onClick={() => void pick()}
            title="换一个文件来做对比"
          >
            <FilePlus2 size={14} />
          </button>
          <button
            type="button"
            className="compare-pane__btn"
            data-tb-id="compare-zoom-out"
            onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.1).toFixed(2))))}
            title="缩小"
          >
            <Minus size={14} />
          </button>
          <span className="compare-pane__page" data-compare-page={page}>
            {doc ? `${page} / ${doc.numPages}` : '—'}
          </span>
          <button
            type="button"
            className="compare-pane__btn"
            data-tb-id="compare-zoom-in"
            onClick={() => setZoom((z) => Math.min(3, Number((z + 0.1).toFixed(2))))}
            title="放大"
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            className="compare-pane__btn"
            data-tb-id="compare-close"
            aria-label="关闭对比"
            onClick={close}
            title="关闭对比"
          >
            <X size={14} />
          </button>
        </div>
      </header>

      {!path ? (
        <div className="compare-pane__empty">
          <p>选一个 PDF 放在右边，和左边的文件对照着看。</p>
          <p className="compare-pane__hint">也可以把文件直接拖到右半区。</p>
          <button
            type="button"
            className="compare-pane__pick"
            data-tb-id="compare-pick-empty"
            onClick={() => void pick()}
          >
            <FilePlus2 size={15} /> 选择对比文件
          </button>
        </div>
      ) : null}

      {loading ? <p className="compare-pane__note">正在加载…</p> : null}
      {error ? (
        <p className="compare-pane__note compare-pane__note--bad" data-compare-error="1">
          打不开这个文件：{error}
        </p>
      ) : null}

      <div className="compare-pane__scroll" data-compare-scroll="1" ref={hostRef}>
        {/* 画布由上面的 effect 直接挂进这个容器 */}
      </div>
    </aside>
  )
}
