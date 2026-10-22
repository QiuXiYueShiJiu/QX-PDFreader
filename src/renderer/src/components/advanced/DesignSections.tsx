// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 「表单设计 / 提取图片 / 打印」三个分区。
 *
 * 放在单独文件里，是因为它们各自带一块画布或对话框交互，
 * 与 AdvancedSections 里那些「填字段 + 点按钮」的分区体量差很多。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { FileImage, FolderOpen, Printer, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { extractEmbeddedImages, openPdfForTools } from '../../pdf-tools'
import { describeInfo, fileName, SourcePicker, runTask, type TaskApi } from './shared'

/* ============================================================
 * 1. 表单设计（创建 AcroForm 字段）
 * ============================================================ */

interface DraftRect {
  /** PDF 坐标（左下角原点） */
  x: number
  y: number
  width: number
  height: number
}

interface PendingField {
  id: string
  name: string
  type: 'text' | 'checkbox' | 'radio' | 'dropdown'
  page: number
  rect: DraftRect
  options?: string[]
  defaultValue?: string | boolean
  fontSize?: number
}

let fieldSeq = 0
const newFieldId = (): string => `fd-${(fieldSeq += 1)}`

export function FormDesignSection({
  task,
  currentDoc
}: {
  task: TaskApi
  currentDoc: string
}): JSX.Element {
  const [source, setSource] = useState(currentDoc)
  const [page, setPage] = useState(1)
  const [pageCount, setPageCount] = useState(0)
  const [pageSize, setPageSize] = useState({ width: 595.28, height: 841.89 })
  const [preview, setPreview] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /* 正在拖出的矩形（屏幕坐标换算后的 PDF 坐标） */
  const [draft, setDraft] = useState<DraftRect | null>(null)
  const [pending, setPending] = useState<PendingField[]>([])
  const [editor, setEditor] = useState<PendingField | null>(null)

  const overlayRef = useRef<HTMLDivElement | null>(null)
  const dragStartRef = useRef<{ x: number; y: number } | null>(null)
  const docRef = useRef<PDFDocumentProxy | null>(null)
  const docPathRef = useRef('')

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
        const scale = 460 / base.width
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

  const toPdfPoint = (clientX: number, clientY: number): { x: number; y: number } | null => {
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
    const point = toPdfPoint(event.clientX, event.clientY)
    if (!point) return
    dragStartRef.current = point
    setDraft({ x: point.x, y: point.y, width: 0, height: 0 })
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = dragStartRef.current
    if (!start || task.busy) return
    const point = toPdfPoint(event.clientX, event.clientY)
    if (!point) return
    setDraft({
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x),
      height: Math.abs(point.y - start.y)
    })
  }

  const onPointerUp = (): void => {
    const start = dragStartRef.current
    dragStartRef.current = null
    if (!start || !draft) return
    setDraft(null)
    if (draft.width < 10 || draft.height < 8) return

    /*
     * 界面坐标是「左上角原点」，PDF 坐标是「左下角原点」：
     * y_pdf = 页高 - y_上沿 - 高度。换算只在这里做一次。
     */
    const rect: DraftRect = {
      x: Math.max(0, draft.x),
      y: Math.max(0, pageSize.height - draft.y - draft.height),
      width: Math.min(draft.width, pageSize.width),
      height: Math.min(draft.height, pageSize.height)
    }
    setEditor({
      id: newFieldId(),
      name: `字段${pending.length + 1}`,
      type: 'text',
      page,
      rect,
      fontSize: 12
    })
  }

  const addPending = (): void => {
    if (!editor) return
    const name = editor.name.trim()
    if (!name) {
      task.setFeedback({ kind: 'error', text: '请填写字段名' })
      return
    }
    if (pending.some((item) => item.name === name)) {
      task.setFeedback({ kind: 'error', text: `字段名「${name}」已存在` })
      return
    }
    if ((editor.type === 'dropdown' || editor.type === 'radio') && (editor.options ?? []).length === 0) {
      task.setFeedback({ kind: 'error', text: '下拉框/单选组至少需要一个选项（逗号分隔）' })
      return
    }
    setPending((prev) => [...prev, editor])
    setEditor(null)
  }

  const rectStyle = (rect: DraftRect): CSSProperties => ({
    left: `${(rect.x / pageSize.width) * 100}%`,
    top: `${((pageSize.height - rect.y - rect.height) / pageSize.height) * 100}%`,
    width: `${(rect.width / pageSize.width) * 100}%`,
    height: `${(rect.height / pageSize.height) * 100}%`
  })

  const save = (): void => {
    if (pending.length === 0) {
      task.setFeedback({ kind: 'error', text: '还没有添加任何字段' })
      return
    }
    void runTask(
      task,
      '正在创建表单字段…',
      () =>
        window.pdfApp.advanced.formsCreate({
          sourcePath: source || undefined,
          fields: pending.map((item) => ({
            name: item.name,
            type: item.type,
            page: item.page,
            rect: item.rect,
            options: item.options,
            defaultValue: item.defaultValue,
            fontSize: item.fontSize
          }))
        }),
      '表单字段已创建'
    )
  }

  return (
    <section className="sb-card">
      <h3 className="sb-card-title">
        <ShieldCheck size={15} aria-hidden="true" />
        表单设计（创建字段）
      </h3>
      <p className="tools-hint">
        在页面预览上拖出一个框，选择字段类型并命名，即可创建可交互的表单域。
        支持文本、复选框、下拉框、单选组（选项用逗号分隔，横排等分摆放）。
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
        {loading ? <span className="tools-note">渲染中…</span> : null}
      </div>

      {error ? <p className="tools-error-text">{error}</p> : null}

      <div
        className="formdesign-stage"
        ref={overlayRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        role="application"
        aria-label="表单字段放置预览：拖动框出字段区域"
      >
        {preview ? (
          <img className="formdesign-stage__page" src={preview} alt={`第 ${page} 页预览`} draggable={false} />
        ) : (
          <div className="formdesign-stage__empty">预览加载中…</div>
        )}
        {pending
          .filter((item) => item.page === page)
          .map((item) => (
            <div className="formdesign-box" style={rectStyle(item.rect)} key={item.id}>
              <span className="formdesign-box__label">
                {item.type} · {item.name}
              </span>
            </div>
          ))}
        {draft && draft.width > 1 && draft.height > 1 ? (
          <div className="formdesign-box formdesign-box--draft" style={rectStyle(draft)} />
        ) : null}
      </div>

      {editor ? (
        <div className="formdesign-editor">
          <div className="sb-field">
            <div className="sb-field-text">
              <span className="sb-field-label">字段名</span>
            </div>
            <input
              className="sb-input"
              value={editor.name}
              onChange={(event) => setEditor({ ...editor, name: event.target.value })}
              aria-label="字段名"
            />
          </div>
          <div className="sb-field">
            <div className="sb-field-text">
              <span className="sb-field-label">类型</span>
            </div>
            <select
              className="sb-input"
              value={editor.type}
              onChange={(event) =>
                setEditor({ ...editor, type: event.target.value as PendingField['type'] })
              }
              aria-label="字段类型"
            >
              <option value="text">文本输入框</option>
              <option value="checkbox">复选框</option>
              <option value="dropdown">下拉框</option>
              <option value="radio">单选组</option>
            </select>
          </div>
          {editor.type === 'dropdown' || editor.type === 'radio' ? (
            <div className="sb-field">
              <div className="sb-field-text">
                <span className="sb-field-label">选项</span>
                <span className="sb-field-hint">用逗号分隔，例如：同意, 不同意</span>
              </div>
              <input
                className="sb-input"
                value={(editor.options ?? []).join(',')}
                onChange={(event) =>
                  setEditor({
                    ...editor,
                    options: event.target.value
                      .split(/[,，]/)
                      .map((s) => s.trim())
                      .filter(Boolean)
                  })
                }
                aria-label="选项"
              />
            </div>
          ) : null}
          {editor.type === 'text' ? (
            <>
              <div className="sb-field">
                <div className="sb-field-text">
                  <span className="sb-field-label">默认值（可选）</span>
                </div>
                <input
                  className="sb-input"
                  value={String(editor.defaultValue ?? '')}
                  onChange={(event) => setEditor({ ...editor, defaultValue: event.target.value })}
                  aria-label="默认值"
                />
              </div>
              <div className="sb-field">
                <div className="sb-field-text">
                  <span className="sb-field-label">字号</span>
                </div>
                <input
                  className="sb-input tools-num"
                  type="number"
                  min={4}
                  max={72}
                  value={editor.fontSize ?? 12}
                  onChange={(event) => setEditor({ ...editor, fontSize: Number(event.target.value) || 12 })}
                  aria-label="字号"
                />
              </div>
            </>
          ) : null}
          <div className="tools-actions">
            <button type="button" className="sb-btn sb-btn-primary" onClick={addPending}>
              添加到列表
            </button>
            <button type="button" className="sb-btn" onClick={() => setEditor(null)}>
              取消
            </button>
          </div>
        </div>
      ) : null}

      {pending.length > 0 ? (
        <ul className="tools-filelist">
          {pending.map((item) => (
            <li key={item.id} className="tools-filelist__item">
              <span className="tools-filelist__name">
                第 {item.page} 页 · {item.type} · {item.name}
              </span>
              <button
                type="button"
                className="sb-btn sb-btn-icon"
                title="移除"
                onClick={() => setPending((prev) => prev.filter((p) => p.id !== item.id))}
                disabled={task.busy}
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="tools-empty">在预览图上拖一个框开始添加字段</p>
      )}

      <div className="tools-actions">
        <button
          type="button"
          className="sb-btn sb-btn-primary"
          onClick={save}
          disabled={task.busy || pending.length === 0}
        >
          创建并另存
        </button>
      </div>
    </section>
  )
}

/* ============================================================
 * 2. 提取内嵌图片
 * ============================================================ */

export function ExtractImagesSection({
  task,
  currentDoc
}: {
  task: TaskApi
  currentDoc: string
}): JSX.Element {
  const [source, setSource] = useState(currentDoc)
  const [outputDir, setOutputDir] = useState('')

  useEffect(() => {
    setSource((prev) => prev || currentDoc)
  }, [currentDoc])

  const pickFolder = async (): Promise<void> => {
    const dir = await window.pdfApp.tools.pickFolder()
    if (dir) setOutputDir(dir)
  }

  const start = async (): Promise<void> => {
    if (!source) {
      task.setFeedback({ kind: 'error', text: '请先选择 PDF' })
      return
    }
    task.setFeedback(null)
    task.setBusy('正在扫描内嵌图片…')
    task.setProgress(0)
    let doc: PDFDocumentProxy | null = null
    try {
      doc = await openPdfForTools(source)
      const images = await extractEmbeddedImages(doc, (done, total) =>
        task.setProgress(Math.round((done / total) * 80))
      )
      if (images.length === 0) {
        task.setFeedback({
          kind: 'info',
          text: '这份 PDF 没有内嵌位图（纯文字/矢量文档很常见）'
        })
        return
      }
      task.setBusy('正在保存图片…')
      const result = await window.pdfApp.tools.saveImages({
        singleFile: false,
        outputDir: outputDir || undefined,
        baseName: '图片',
        images: images.map((image) => ({
          name: `第${image.page}页-图片${image.index}.png`,
          mime: 'image/png' as const,
          data: image.data
        }))
      })
      if (result.ok) {
        task.setFeedback({
          kind: 'ok',
          text: `已导出 ${images.length} 张图片${result.paths?.length ? `（保存到 ${result.info?.['输出目录'] ?? outputDir}）` : ''}`,
          path: result.paths?.[0]
        })
      } else if (result.canceled) {
        task.setFeedback({ kind: 'info', text: '已取消' })
      } else {
        task.setFeedback({ kind: 'error', text: result.error ?? '保存失败' })
      }
    } catch (cause) {
      task.setFeedback({
        kind: 'error',
        text: cause instanceof Error ? cause.message : String(cause)
      })
    } finally {
      if (doc) void doc.destroy()
      task.setBusy(null)
    }
  }

  return (
    <section className="sb-card">
      <h3 className="sb-card-title">
        <FileImage size={15} aria-hidden="true" />
        提取内嵌图片
      </h3>
      <p className="tools-hint">
        把 PDF 里嵌入的位图（照片、扫描页里的图片、插画）按原始分辨率导出为 PNG。
        相同图片只导出一次；纯文字/矢量文档没有可提取的图片。
      </p>

      <SourcePicker value={source} onChange={setSource} disabled={task.busy} />

      <div className="sb-field">
        <div className="sb-field-text">
          <span className="sb-field-label">输出文件夹</span>
          <span className="sb-field-hint" title={outputDir || undefined}>
            {outputDir || '不选则执行时弹出文件夹选择框'}
          </span>
        </div>
        <div className="sb-field-control tools-inline">
          <button type="button" className="sb-btn" onClick={() => void pickFolder()} disabled={task.busy}>
            <FolderOpen size={15} />
            选择文件夹
          </button>
        </div>
      </div>

      <div className="tools-actions">
        <button type="button" className="sb-btn sb-btn-primary" onClick={() => void start()} disabled={task.busy}>
          提取并保存
        </button>
      </div>
    </section>
  )
}

/* ============================================================
 * 3. 打印
 * ============================================================ */

export function PrintSection({
  task,
  currentDoc
}: {
  task: TaskApi
  currentDoc: string
}): JSX.Element {
  const [source, setSource] = useState(currentDoc)
  const [copies, setCopies] = useState(1)
  const [checking, setChecking] = useState(false)
  const [pageRange, setPageRange] = useState('')

  useEffect(() => {
    setSource((prev) => prev || currentDoc)
  }, [currentDoc])

  const print = (): void => {
    void runTask(
      task,
      '正在准备打印…',
      () =>
        window.pdfApp.advanced.print({
          sourcePath: source || undefined,
          copies,
          pageRange: pageRange.trim() || undefined
        }),
      '打印'
    )
  }

  const dryRun = async (): Promise<void> => {
    if (!source) return
    setChecking(true)
    try {
      const result = await window.pdfApp.advanced.print({
        sourcePath: source,
        pageRange: pageRange.trim() || undefined,
        dryRun: true
      })
      if (result.ok) {
        task.setFeedback({
          kind: 'ok',
          text: `打印渲染检查通过：${describeInfo(result.info)}`
        })
      } else {
        task.setFeedback({ kind: 'error', text: result.error ?? '渲染检查失败' })
      }
    } finally {
      setChecking(false)
    }
  }

  return (
    <section className="sb-card">
      <h3 className="sb-card-title">
        <Printer size={15} aria-hidden="true" />
        打印
      </h3>
      <p className="tools-hint">
        用 pdf.js 把每页画成高分辨率位图，再交给系统打印对话框；纸张大小自动匹配页面尺寸。
        打印内容只含页面本身，不含工具栏与批注层。
      </p>

      <SourcePicker value={source} onChange={setSource} disabled={task.busy} />

      <div className="sb-field">
        <div className="sb-field-text">
          <span className="sb-field-label">份数</span>
        </div>
        <div className="sb-field-control">
          <input
            className="sb-input tools-num"
            type="number"
            min={1}
            max={20}
            value={copies}
            onChange={(event) => setCopies(Math.min(20, Math.max(1, Number(event.target.value) || 1)))}
            disabled={task.busy}
            aria-label="份数"
          />
        </div>
      </div>

      <div className="sb-field">
        <div className="sb-field-text">
          <span className="sb-field-label">页码范围</span>
          <span className="sb-field-hint">留空 = 全部页；支持 1-3,5 这种写法</span>
        </div>
        <input
          className="sb-input"
          value={pageRange}
          onChange={(event) => setPageRange(event.target.value)}
          placeholder="例如：1-3,5"
          disabled={task.busy}
          aria-label="页码范围"
        />
      </div>

      <p className="tools-note">当前文档：{source ? fileName(source) : '未选择'}</p>

      <div className="tools-actions">
        <button
          type="button"
          className="sb-btn sb-btn-primary"
          onClick={print}
          disabled={task.busy || !source}
        >
          <Printer size={15} />
          打印
        </button>
        <button
          type="button"
          className="sb-btn"
          onClick={() => void dryRun()}
          disabled={task.busy || checking || !source}
        >
          <ShieldCheck size={15} />
          {checking ? '检查中…' : '渲染检查'}
        </button>
      </div>
    </section>
  )
}
