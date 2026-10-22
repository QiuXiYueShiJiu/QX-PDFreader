// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 整理页面（Acrobat 的 Organize Pages）。
 *
 * 能力：缩略图浏览、多选、拖拽排序、旋转、删除、插入空白页、
 * 从其它 PDF 插入页面、按边距裁剪选中页、提取选中为新 PDF、
 * 整份另存。
 *
 * 数据模型：最终列表 `entries` 的顺序就是输出顺序；
 * 主进程（adv:pages）按这份列表复制/旋转/裁剪页面并保存 ——
 * 因此「删除一页」在界面上就是把它从列表里拿掉，不涉及任何原地修改。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  FilePlus2,
  FolderOpen,
  Scissors,
  Trash2
} from 'lucide-react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { openPdfForTools } from '../../pdf-tools'
import { runTask, fileName, type TaskApi } from './shared'

interface CropMargins {
  left: number
  top: number
  right: number
  bottom: number
}

interface Entry {
  id: string
  /** 源 PDF 路径（空白页为空串） */
  sourcePath: string
  /** 源文档页序（0 起；-1 = 空白页） */
  index: number
  /** 展示用页码（1 起） */
  pageNo: number
  /** 绝对旋转角 */
  rotation: number
  /** 用户是否手动转过（转动过就一直保留，不再被原页面角度覆盖） */
  userRotated: boolean
  /** 裁剪边距（点），四个 0 表示不裁剪 */
  cropMargins: CropMargins
  thumb?: string
  blank?: boolean
}

let entrySeq = 0
const newId = (): string => `pg-${(entrySeq += 1)}`

const THUMB_WIDTH = 104
/** 缩略图渲染并发（隐藏窗口下也不至于把主线程拖垮） */
const THUMB_CONCURRENCY = 3

function zeroMargins(): CropMargins {
  return { left: 0, top: 0, right: 0, bottom: 0 }
}

function hasCrop(entry: Entry): boolean {
  const m = entry.cropMargins
  return m.left > 0 || m.top > 0 || m.right > 0 || m.bottom > 0
}

export function PagesSection({
  task,
  currentDoc
}: {
  task: TaskApi
  currentDoc: string
}): JSX.Element {
  const [source, setSource] = useState(currentDoc)
  const [entries, setEntries] = useState<Entry[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [dragId, setDragId] = useState<string | null>(null)
  const [crop, setCrop] = useState<CropMargins>(zeroMargins())
  const [pageSize, setPageSize] = useState({ width: 595.28, height: 841.89 })
  const [error, setError] = useState<string | null>(null)
  const lastClickedRef = useRef<string | null>(null)

  const docsRef = useRef(new Map<string, PDFDocumentProxy>())
  const aliveRef = useRef(true)
  const renderingRef = useRef(new Set<string>())

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      for (const doc of docsRef.current.values()) void doc.destroy()
      docsRef.current.clear()
    }
  }, [])

  const ensureDoc = useCallback(async (filePath: string): Promise<PDFDocumentProxy> => {
    const cached = docsRef.current.get(filePath)
    if (cached) return cached
    const doc = await openPdfForTools(filePath)
    docsRef.current.set(filePath, doc)
    return doc
  }, [])

  /** 逐张渲染缩略图：只渲染还空着的条目，并发 3 张 */
  const renderThumbs = useCallback(
    async (list: Entry[]): Promise<void> => {
      const queue = list.filter((entry) => !entry.blank && !entry.thumb)
      const worker = async (): Promise<void> => {
        while (queue.length > 0) {
          const entry = queue.shift()
          if (!entry || !aliveRef.current) return
          if (entry.thumb || renderingRef.current.has(entry.id)) continue
          renderingRef.current.add(entry.id)
          try {
            const doc = await ensureDoc(entry.sourcePath)
            const page = await doc.getPage(entry.index + 1)
            const base = page.getViewport({ scale: 1 })
            const scale = THUMB_WIDTH / base.width
            const viewport = page.getViewport({ scale })
            const canvas = document.createElement('canvas')
            canvas.width = Math.max(1, Math.round(viewport.width))
            canvas.height = Math.max(1, Math.round(viewport.height))
            const ctx = canvas.getContext('2d')
            if (ctx) {
              ctx.fillStyle = '#ffffff'
              ctx.fillRect(0, 0, canvas.width, canvas.height)
              const renderTask = page.render({ canvasContext: ctx, viewport })
              await (renderTask as unknown as { promise: Promise<void> }).promise
              const thumb = canvas.toDataURL('image/jpeg', 0.72)
              const rotate = page.rotate
              page.cleanup()
              if (!aliveRef.current) return
              setEntries((prev) =>
                prev.map((item) =>
                  item.id === entry.id
                    ? {
                        ...item,
                        thumb,
                        /* 首次渲染时把原文的 /Rotate 带进来，避免保存后方向被改回 0 */
                        rotation: item.userRotated ? item.rotation : rotate ?? 0
                      }
                    : item
                )
              )
            }
          } catch {
            /* 单页失败不影响其它页 */
          } finally {
            renderingRef.current.delete(entry.id)
          }
        }
      }
      await Promise.all(Array.from({ length: THUMB_CONCURRENCY }, () => worker()))
    },
    [ensureDoc]
  )

  const buildEntries = useCallback(async (filePath: string): Promise<Entry[]> => {
    const doc = await ensureDoc(filePath)
    const first = await doc.getPage(1)
    const viewport = first.getViewport({ scale: 1, rotation: 0 })
    setPageSize({ width: viewport.width, height: viewport.height })
    first.cleanup()
    const list: Entry[] = []
    for (let i = 0; i < doc.numPages; i += 1) {
      list.push({
        id: newId(),
        sourcePath: filePath,
        index: i,
        pageNo: i + 1,
        rotation: 0,
        userRotated: false,
        cropMargins: zeroMargins()
      })
    }
    return list
  }, [ensureDoc])

  const load = useCallback(
    async (filePath: string): Promise<void> => {
      if (!filePath) return
      setLoading(true)
      setError(null)
      try {
        const list = await buildEntries(filePath)
        setEntries(list)
        setSelected(new Set())
        void renderThumbs(list)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setLoading(false)
      }
    },
    [buildEntries, renderThumbs]
  )

  useEffect(() => {
    setSource((prev) => prev || currentDoc)
  }, [currentDoc])

  useEffect(() => {
    if (source) void load(source)
  }, [source, load])

  /* ---------- 选择 ---------- */

  const toggleSelect = (id: string, shiftKey: boolean): void => {
    const index = entries.findIndex((entry) => entry.id === id)
    if (index < 0) return
    const lastIndex = lastClickedRef.current
      ? entries.findIndex((entry) => entry.id === lastClickedRef.current)
      : -1

    setSelected((prev) => {
      const next = new Set(prev)
      if (shiftKey && lastIndex >= 0) {
        const [from, to] = [Math.min(index, lastIndex), Math.max(index, lastIndex)]
        for (let i = from; i <= to; i += 1) next.add(entries[i].id)
      } else if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
    lastClickedRef.current = id
  }

  const selectedIds = useMemo(() => Array.from(selected), [selected])
  const targetIds = (): string[] => (selectedIds.length > 0 ? selectedIds : entries.map((e) => e.id))

  /* ---------- 页面操作 ---------- */

  const rotate = (delta: number): void => {
    const ids = new Set(targetIds())
    setEntries((prev) =>
      prev.map((entry) =>
        ids.has(entry.id)
          ? {
              ...entry,
              rotation: (((entry.rotation + delta) % 360) + 360) % 360,
              userRotated: true
            }
          : entry
      )
    )
  }

  const removeSelected = (): void => {
    if (selectedIds.length === 0) return
    const ids = new Set(selectedIds)
    setEntries((prev) => prev.filter((entry) => !ids.has(entry.id)))
    setSelected(new Set())
  }

  const insertBlank = (afterSelection: boolean): void => {
    const blank: Entry = {
      id: newId(),
      sourcePath: '',
      index: -1,
      pageNo: 0,
      rotation: 0,
      userRotated: false,
      cropMargins: zeroMargins(),
      blank: true
    }
    setEntries((prev) => {
      if (!afterSelection || selectedIds.length === 0) return [...prev, blank]
      const lastId = selectedIds[selectedIds.length - 1]
      const at = prev.findIndex((entry) => entry.id === lastId)
      if (at < 0) return [...prev, blank]
      const next = [...prev]
      next.splice(at + 1, 0, blank)
      return next
    })
    setSelected(new Set([blank.id]))
  }

  const insertFromPdf = async (): Promise<void> => {
    const picked = await window.pdfApp.tools.pickPdfs()
    if (picked.length === 0) return
    setLoading(true)
    try {
      const doc = await ensureDoc(picked[0])
      const added: Entry[] = []
      for (let i = 0; i < doc.numPages; i += 1) {
        added.push({
          id: newId(),
          sourcePath: picked[0],
          index: i,
          pageNo: i + 1,
          rotation: 0,
          userRotated: false,
          cropMargins: zeroMargins()
        })
      }
      setEntries((prev) => [...prev, ...added])
      void renderThumbs(added)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  /* ---------- 拖拽排序 ---------- */

  const moveEntry = (fromId: string, toId: string): void => {
    if (fromId === toId) return
    setEntries((prev) => {
      const from = prev.findIndex((entry) => entry.id === fromId)
      const to = prev.findIndex((entry) => entry.id === toId)
      if (from < 0 || to < 0) return prev
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }

  const moveToEnd = (id: string): void => {
    setEntries((prev) => {
      const from = prev.findIndex((entry) => entry.id === id)
      if (from < 0 || from === prev.length - 1) return prev
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.push(moved)
      return next
    })
  }

  /* ---------- 裁剪 ---------- */

  const applyCrop = (): void => {
    if (selectedIds.length === 0) {
      task.setFeedback({ kind: 'error', text: '请先选择要裁剪的页面' })
      return
    }
    const ids = new Set(selectedIds)
    setEntries((prev) =>
      prev.map((entry) => (ids.has(entry.id) ? { ...entry, cropMargins: { ...crop } } : entry))
    )
    task.setFeedback({
      kind: 'info',
      text: `已对 ${selectedIds.length} 页设置裁剪边距，保存时生效`
    })
  }

  /* ---------- 应用 ---------- */

  const computeCrop = async (
    entry: Entry
  ): Promise<(CropMargins & { width: number; height: number }) | undefined> => {
    if (!hasCrop(entry)) return undefined
    const doc = await ensureDoc(entry.sourcePath)
    const page = await doc.getPage(entry.index + 1)
    const viewport = page.getViewport({ scale: 1, rotation: 0 })
    const width = Math.max(1, viewport.width - entry.cropMargins.left - entry.cropMargins.right)
    const height = Math.max(1, viewport.height - entry.cropMargins.top - entry.cropMargins.bottom)
    page.cleanup()
    return { ...entry.cropMargins, width, height }
  }

  const apply = async (onlySelected: boolean): Promise<void> => {
    if (!source) {
      task.setFeedback({ kind: 'error', text: '请先选择源 PDF' })
      return
    }
    const list = onlySelected
      ? entries.filter((entry) => selectedIds.includes(entry.id))
      : entries
    if (list.length === 0) {
      task.setFeedback({ kind: 'error', text: '输出不能是空的' })
      return
    }

    await runTask(
      task,
      onlySelected ? '正在提取选中页面…' : '正在保存整理结果…',
      async () => {
        const pages = await Promise.all(
          list.map(async (entry) => {
            if (entry.blank) {
              return { index: -1, rotation: 0, blankSize: { ...pageSize } }
            }
            const margins = await computeCrop(entry)
            const page: {
              sourcePath: string
              index: number
              rotation: number
              crop?: { x: number; y: number; width: number; height: number }
            } = {
              sourcePath: entry.sourcePath,
              index: entry.index,
              rotation: entry.rotation
            }
            if (margins) {
              /*
               * 渲染层用「上/下边距」描述裁剪（符合看图直觉），
               * 主进程的 crop 用 PDF 坐标（左下角原点）——
               * y 由底部边距决定，高度已扣掉上下边距。
               */
              page.crop = {
                x: margins.left,
                y: margins.bottom,
                width: margins.width,
                height: margins.height
              }
            }
            return page
          })
        )
        return window.pdfApp.advanced.pages({ sourcePath: source, pages })
      },
      onlySelected ? '已提取选中页面' : '整理结果已保存'
    )
  }

  /* ---------- 渲染 ---------- */

  return (
    <section className="sb-card">
      <h3 className="sb-card-title">
        <Scissors size={15} aria-hidden="true" />
        整理页面
      </h3>
      <p className="tools-hint">
        点选页面（Shift 连选）后可旋转、删除；拖动缩略图可调整顺序。
        所有改动都在保存时写成**新文件**，原文件不动。
      </p>

      <div className="sb-field tools-inline">
        <button type="button" className="sb-btn" onClick={() => void load(source)} disabled={loading}>
          <FolderOpen size={14} />
          {loading ? '读取中…' : '重新载入'}
        </button>
        <button
          type="button"
          className="sb-btn"
          onClick={() => void window.pdfApp.tools.pickPdfs().then((p) => p[0] && setSource(p[0]))}
          disabled={task.busy}
        >
          换一份 PDF
        </button>
        <button
          type="button"
          className="sb-btn"
          onClick={() => setSelected(new Set(entries.map((e) => e.id)))}
          disabled={entries.length === 0}
        >
          全选
        </button>
        <button
          type="button"
          className="sb-btn"
          onClick={() => setSelected(new Set())}
          disabled={selectedIds.length === 0}
        >
          取消选择
        </button>
      </div>

      {error ? <p className="tools-error-text">{error}</p> : null}

      <div className="pages-toolbar">
        <button type="button" className="sb-btn" onClick={() => rotate(-90)} disabled={task.busy || entries.length === 0}>
          <ChevronLeft size={14} />
          左转
        </button>
        <button type="button" className="sb-btn" onClick={() => rotate(90)} disabled={task.busy || entries.length === 0}>
          右转
          <ChevronRight size={14} />
        </button>
        <button
          type="button"
          className="sb-btn sb-btn-danger"
          onClick={removeSelected}
          disabled={task.busy || selectedIds.length === 0}
        >
          <Trash2 size={14} />
          删除选中
        </button>
        <button type="button" className="sb-btn" onClick={() => insertBlank(true)} disabled={task.busy}>
          插入空白页
        </button>
        <button type="button" className="sb-btn" onClick={() => void insertFromPdf()} disabled={task.busy || loading}>
          <FilePlus2 size={14} />
          从 PDF 插页
        </button>
      </div>

      <div className="pages-crop">
        <span className="tools-note">裁剪选中页（点，边距）</span>
        {(
          [
            ['left', '左'],
            ['top', '上'],
            ['right', '右'],
            ['bottom', '下']
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="pages-crop__item">
            <span>{label}</span>
            <input
              className="sb-input tools-num"
              type="number"
              min={0}
              value={crop[key]}
              onChange={(event) => setCrop({ ...crop, [key]: Math.max(0, Number(event.target.value) || 0) })}
              disabled={task.busy}
              aria-label={`裁剪${label}边距`}
            />
          </label>
        ))}
        <button type="button" className="sb-btn" onClick={applyCrop} disabled={task.busy || selectedIds.length === 0}>
          应用裁剪
        </button>
        <button
          type="button"
          className="sb-btn"
          onClick={() => {
            setCrop(zeroMargins())
            const ids = new Set(selectedIds)
            setEntries((prev) =>
              prev.map((entry) => (ids.has(entry.id) ? { ...entry, cropMargins: zeroMargins() } : entry))
            )
          }}
          disabled={task.busy || selectedIds.length === 0}
        >
          清除裁剪
        </button>
      </div>

      <div className="pages-counter tools-note">
        共 {entries.length} 页 · 已选 {selectedIds.length} 页 · 原文档 {fileName(source)}
      </div>

      <div
        className="pages-grid"
        onDragOver={(event) => event.preventDefault()}
        onDrop={() => {
          if (dragId) moveToEnd(dragId)
          setDragId(null)
        }}
      >
        {entries.map((entry) => (
          <div
            key={entry.id}
            className={[
              'pages-cell',
              selected.has(entry.id) ? 'is-selected' : '',
              dragId === entry.id ? 'is-dragging' : ''
            ]
              .filter(Boolean)
              .join(' ')}
            draggable={!task.busy}
            onDragStart={() => setDragId(entry.id)}
            onDragEnd={() => setDragId(null)}
            onDragOver={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onDrop={(event) => {
              event.preventDefault()
              event.stopPropagation()
              if (dragId) moveEntry(dragId, entry.id)
              setDragId(null)
            }}
            onClick={(event) => toggleSelect(entry.id, event.shiftKey)}
            role="button"
            aria-pressed={selected.has(entry.id)}
            title={entry.blank ? '空白页' : `原第 ${entry.pageNo} 页`}
          >
            {entry.blank ? (
              <div className="pages-cell__blank">空白页</div>
            ) : entry.thumb ? (
              <img
                className="pages-cell__thumb"
                src={entry.thumb}
                alt={`第 ${entry.pageNo} 页缩略图`}
                draggable={false}
                style={{ transform: `rotate(${entry.rotation}deg)` }}
              />
            ) : (
              <div className="pages-cell__blank">渲染中…</div>
            )}
            <div className="pages-cell__bar">
              <span className="pages-cell__no">
                {entry.blank ? '空白' : entry.pageNo}
                {entry.rotation ? ` · ${entry.rotation}°` : ''}
                {hasCrop(entry) ? ' · 裁' : ''}
                {entry.sourcePath && entry.sourcePath !== source ? ' · 外来' : ''}
              </span>
              <button
                type="button"
                className="pages-cell__del"
                title="删除这一页"
                onClick={(event) => {
                  event.stopPropagation()
                  setEntries((prev) => prev.filter((item) => item.id !== entry.id))
                  setSelected((prev) => {
                    const next = new Set(prev)
                    next.delete(entry.id)
                    return next
                  })
                }}
                disabled={task.busy}
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>

      {entries.length === 0 && !loading ? (
        <p className="tools-empty">没有页面。点「重新载入」或「从 PDF 插页」。</p>
      ) : null}

      <div className="tools-actions">
        <button
          type="button"
          className="sb-btn sb-btn-primary"
          onClick={() => void apply(false)}
          disabled={task.busy || entries.length === 0}
        >
          保存为新 PDF
        </button>
        <button
          type="button"
          className="sb-btn"
          onClick={() => void apply(true)}
          disabled={task.busy || selectedIds.length === 0}
        >
          提取选中为新 PDF
        </button>
      </div>
    </section>
  )
}
