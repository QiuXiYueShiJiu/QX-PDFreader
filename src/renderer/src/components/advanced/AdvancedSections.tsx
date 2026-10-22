// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 「Acrobat 级」文档编辑分区（除页面整理与安全遮盖外的全部）。
 *
 * 每个分区都是独立组件，由 ToolsPanel 按导航切换渲染；
 * 运行状态（busy / 进度 / 结果提示）由 ToolsPanel 通过 TaskApi 统一管理。
 *
 * 文件与主进程的分工：
 *   · 读取类（表单字段、书签、附件、元数据）在渲染层用 pdf.js 读或向主进程查询；
 *   · 写入类一律走 window.pdfApp.advanced（主进程用 @cantoo/pdf-lib 完成）。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import {
  BookmarkPlus,
  FilePlus2,
  FolderOpen,
  Info,
  Loader2,
  PenLine,
  RefreshCw,
  Trash2
} from 'lucide-react'
import type { AttachmentInfo } from '@shared/pdf-advanced'
import { useViewer } from '../../store'
import {
  extractTablePages,
  extractTextPages,
  openPdfForTools,
  readMetadata,
  readOutline,
  type OutlineNode as PdfOutlineNode,
  type PdfMetadata
} from '../../pdf-tools'
import { describeInfo, fileName, SourcePicker, Switch, runTask, type TaskApi } from './shared'

/* ============================================================
 * 页眉页脚 / 页码
 * ============================================================ */

const HEADER_FOOTER_PRESETS: ReadonlyArray<{
  label: string
  header?: { left?: string; center?: string; right?: string }
  footer?: { left?: string; center?: string; right?: string }
}> = [
  {
    label: '页码：底部居中 X / Y',
    footer: { center: '{page} / {total}' }
  },
  {
    label: '页码：底部右侧第 X 页',
    footer: { right: '第 {page} 页 / 共 {total} 页' }
  },
  {
    label: '页眉：右上标题 + 底部页码',
    header: { right: '{title}' },
    footer: { center: '{page} / {total}' }
  }
]

export function HeaderFooterSection({
  task,
  currentDoc
}: {
  task: TaskApi
  currentDoc: string
}): JSX.Element {
  const [source, setSource] = useState(currentDoc)
  const [header, setHeader] = useState({ left: '', center: '', right: '' })
  const [footer, setFooter] = useState({ left: '', center: '', right: '' })
  const [fontSize, setFontSize] = useState(9)
  const [margin, setMargin] = useState(24)
  const [color, setColor] = useState('#666666')
  const [skipFirst, setSkipFirst] = useState(false)
  const [startNumber, setStartNumber] = useState(1)
  const [title, setTitle] = useState('')

  useEffect(() => {
    setSource((prev) => prev || currentDoc)
  }, [currentDoc])

  const applyPreset = (preset: (typeof HEADER_FOOTER_PRESETS)[number]): void => {
    setHeader({ left: '', center: '', right: '', ...(preset.header ?? {}) })
    setFooter({ left: '', center: '', right: '', ...(preset.footer ?? {}) })
  }

  const start = (): void => {
    void runTask(
      task,
      '正在写入页眉页脚…',
      () =>
        window.pdfApp.advanced.headerFooter({
          sourcePath: source || undefined,
          header: {
            left: header.left || undefined,
            center: header.center || undefined,
            right: header.right || undefined
          },
          footer: {
            left: footer.left || undefined,
            center: footer.center || undefined,
            right: footer.right || undefined
          },
          fontSize,
          margin,
          color,
          skipFirst,
          startNumber,
          title
        }),
      '页眉页脚已写入'
    )
  }

  const sideFields = (
    side: { left: string; center: string; right: string },
    setSide: (value: { left: string; center: string; right: string }) => void,
    label: string
  ): JSX.Element => (
    <>
      {(['left', 'center', 'right'] as const).map((position) => (
        <div className="sb-field" key={`${label}-${position}`}>
          <div className="sb-field-text">
            <span className="sb-field-label">
              {label}
              {position === 'left' ? '左' : position === 'center' ? '中' : '右'}
            </span>
          </div>
          <input
            className="sb-input"
            value={side[position]}
            onChange={(event) => setSide({ ...side, [position]: event.target.value })}
            placeholder={
              label === '页脚' ? '例如：第 {page} 页 / 共 {total} 页' : '例如：{title}'
            }
            disabled={task.busy}
            aria-label={`${label}${position}`}
          />
        </div>
      ))}
    </>
  )

  return (
    <section className="sb-card">
      <h3 className="sb-card-title">
        <Info size={15} aria-hidden="true" />
        页眉页脚与页码
      </h3>
      <p className="tools-hint">
        支持变量：{'{page}'} 当前页、{'{total}'} 总页数、{'{date}'} 日期、{'{time}'} 时间、
        {'{title}'} 标题。全部使用中文字体嵌入，不会出现乱码。
      </p>

      <div className="sb-field tools-inline">
        {HEADER_FOOTER_PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            className="sb-btn"
            onClick={() => applyPreset(preset)}
            disabled={task.busy}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <SourcePicker value={source} onChange={setSource} disabled={task.busy} />
      {sideFields(header, setHeader, '页眉')}
      {sideFields(footer, setFooter, '页脚')}

      <div className="sb-field">
        <div className="sb-field-text">
          <span className="sb-field-label">标题（{'{title}'} 的值）</span>
          <span className="sb-field-hint">不填则用文档当前的标题属性</span>
        </div>
        <input
          className="sb-input"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          disabled={task.busy}
          aria-label="标题"
        />
      </div>

      <div className="sb-field">
        <div className="sb-field-text">
          <span className="sb-field-label">字号 / 边距</span>
        </div>
        <div className="sb-field-control tools-inline">
          <input
            className="sb-input tools-num"
            type="number"
            min={6}
            max={36}
            value={fontSize}
            onChange={(event) => setFontSize(Number(event.target.value) || 9)}
            disabled={task.busy}
            aria-label="字号"
          />
          <span className="tools-note">pt</span>
          <input
            className="sb-input tools-num"
            type="number"
            min={8}
            max={120}
            value={margin}
            onChange={(event) => setMargin(Number(event.target.value) || 24)}
            disabled={task.busy}
            aria-label="边距"
          />
          <span className="tools-note">pt</span>
          <input
            className="tools-color-input"
            type="color"
            value={color}
            onChange={(event) => setColor(event.target.value)}
            disabled={task.busy}
            aria-label="文字颜色"
            title="文字颜色"
          />
        </div>
      </div>

      <div className="sb-field sb-field-inline">
        <div className="sb-field-text">
          <span className="sb-field-label">跳过第一页</span>
          <span className="sb-field-hint">封面通常不加页码</span>
        </div>
        <Switch checked={skipFirst} onChange={setSkipFirst} label="跳过第一页" disabled={task.busy} />
      </div>

      <div className="sb-field">
        <div className="sb-field-text">
          <span className="sb-field-label">起始页码</span>
          <span className="sb-field-hint">第一页显示成几（从 1 开始计）</span>
        </div>
        <input
          className="sb-input tools-num"
          type="number"
          min={1}
          value={startNumber}
          onChange={(event) => setStartNumber(Number(event.target.value) || 1)}
          disabled={task.busy}
          aria-label="起始页码"
        />
      </div>

      <div className="tools-actions">
        <button
          type="button"
          className="sb-btn sb-btn-primary"
          onClick={() => void start()}
          disabled={task.busy}
        >
          写入并另存
        </button>
      </div>
    </section>
  )
}

/* ============================================================
 * 贝茨编号
 * ============================================================ */

const BATES_POSITIONS = [
  ['bottom-right', '右下'],
  ['bottom-center', '底部居中'],
  ['bottom-left', '左下'],
  ['top-right', '右上'],
  ['top-center', '顶部居中'],
  ['top-left', '左上']
] as const

export function BatesSection({
  task,
  currentDoc
}: {
  task: TaskApi
  currentDoc: string
}): JSX.Element {
  const [source, setSource] = useState(currentDoc)
  const [prefix, setPrefix] = useState('')
  const [suffix, setSuffix] = useState('')
  const [start, setStart] = useState(1)
  const [digits, setDigits] = useState(6)
  const [fontSize, setFontSize] = useState(9)
  const [margin, setMargin] = useState(24)
  const [position, setPosition] = useState<(typeof BATES_POSITIONS)[number][0]>('bottom-right')

  useEffect(() => {
    setSource((prev) => prev || currentDoc)
  }, [currentDoc])

  const preview = `${prefix}${String(start).padStart(digits, '0')}${suffix}`

  return (
    <section className="sb-card">
      <h3 className="sb-card-title">
        <Info size={15} aria-hidden="true" />
        贝茨编号（Bates）
      </h3>
      <p className="tools-hint">
        诉讼、合同卷宗常用的连续编号：每页一个「前缀 + 定长数字 + 后缀」，编号从起始值递增。
      </p>

      <SourcePicker value={source} onChange={setSource} disabled={task.busy} />

      <div className="sb-field">
        <div className="sb-field-text">
          <span className="sb-field-label">前缀 / 后缀</span>
        </div>
        <div className="sb-field-control tools-inline">
          <input
            className="sb-input"
            value={prefix}
            onChange={(event) => setPrefix(event.target.value)}
            placeholder="如 ABC-"
            disabled={task.busy}
            aria-label="前缀"
          />
          <input
            className="sb-input"
            value={suffix}
            onChange={(event) => setSuffix(event.target.value)}
            placeholder="如 -2026"
            disabled={task.busy}
            aria-label="后缀"
          />
        </div>
      </div>

      <div className="sb-field">
        <div className="sb-field-text">
          <span className="sb-field-label">起始编号 / 位数</span>
        </div>
        <div className="sb-field-control tools-inline">
          <input
            className="sb-input tools-num"
            type="number"
            min={0}
            value={start}
            onChange={(event) => setStart(Number(event.target.value) || 1)}
            disabled={task.busy}
            aria-label="起始编号"
          />
          <input
            className="sb-input tools-num"
            type="number"
            min={1}
            max={12}
            value={digits}
            onChange={(event) => setDigits(Number(event.target.value) || 6)}
            disabled={task.busy}
            aria-label="补零位数"
          />
          <span className="tools-note">预览：{preview}</span>
        </div>
      </div>

      <div className="sb-field">
        <div className="sb-field-text">
          <span className="sb-field-label">位置</span>
        </div>
        <select
          className="sb-input"
          value={position}
          onChange={(event) => setPosition(event.target.value as typeof position)}
          disabled={task.busy}
          aria-label="编号位置"
        >
          {BATES_POSITIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <div className="sb-field">
        <div className="sb-field-text">
          <span className="sb-field-label">字号 / 边距</span>
        </div>
        <div className="sb-field-control tools-inline">
          <input
            className="sb-input tools-num"
            type="number"
            min={6}
            max={36}
            value={fontSize}
            onChange={(event) => setFontSize(Number(event.target.value) || 9)}
            disabled={task.busy}
            aria-label="字号"
          />
          <span className="tools-note">pt</span>
          <input
            className="sb-input tools-num"
            type="number"
            min={8}
            max={120}
            value={margin}
            onChange={(event) => setMargin(Number(event.target.value) || 24)}
            disabled={task.busy}
            aria-label="边距"
          />
          <span className="tools-note">pt</span>
        </div>
      </div>

      <div className="tools-actions">
        <button
          type="button"
          className="sb-btn sb-btn-primary"
          onClick={() =>
            void runTask(
              task,
              '正在写入贝茨编号…',
              () =>
                window.pdfApp.advanced.bates({
                  sourcePath: source || undefined,
                  prefix,
                  suffix,
                  start,
                  digits,
                  fontSize,
                  margin,
                  position
                }),
              '贝茨编号已写入'
            )
          }
          disabled={task.busy}
        >
          写入并另存
        </button>
      </div>
    </section>
  )
}

/* ============================================================
 * 元数据
 * ============================================================ */

export function MetadataSection({
  task,
  currentDoc
}: {
  task: TaskApi
  currentDoc: string
}): JSX.Element {
  const [source, setSource] = useState(currentDoc)
  const [meta, setMeta] = useState<PdfMetadata & { producer: string }>({
    title: '',
    author: '',
    subject: '',
    keywords: '',
    creator: '',
    producer: ''
  })
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (filePath: string): Promise<void> => {
    if (!filePath) return
    setLoading(true)
    try {
      const doc = await openPdfForTools(filePath)
      const info = await readMetadata(doc)
      setMeta({ ...info })
      void doc.destroy()
    } catch {
      /* 读不到就保持空表，不打扰用户 */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    setSource((prev) => prev || currentDoc)
  }, [currentDoc])

  useEffect(() => {
    if (source) void load(source)
  }, [source, load])

  const field = (
    key: 'title' | 'author' | 'subject' | 'keywords' | 'creator',
    label: string,
    placeholder: string
  ): JSX.Element => (
    <div className="sb-field">
      <div className="sb-field-text">
        <span className="sb-field-label">{label}</span>
      </div>
      <input
        className="sb-input"
        value={meta[key]}
        placeholder={placeholder}
        onChange={(event) => setMeta({ ...meta, [key]: event.target.value })}
        disabled={task.busy}
        aria-label={label}
      />
    </div>
  )

  return (
    <section className="sb-card">
      <h3 className="sb-card-title">
        <Info size={15} aria-hidden="true" />
        文档属性（元数据）
      </h3>
      <p className="tools-hint">
        修改标题、作者、主题、关键字等属性，另存为新文件。只改属性，不动页面内容。
      </p>

      <SourcePicker value={source} onChange={setSource} disabled={task.busy || loading} />

      <div className="sb-field tools-inline">
        <button
          type="button"
          className="sb-btn"
          onClick={() => void load(source)}
          disabled={task.busy || !source || loading}
        >
          <RefreshCw size={14} />
          重新读取
        </button>
        {loading ? <span className="tools-note">读取中…</span> : null}
      </div>

      {field('title', '标题', '文档标题')}
      {field('author', '作者', '作者 / 单位')}
      {field('subject', '主题', '文档主题')}
      {field('keywords', '关键字', '用逗号分隔，如：教学, 试卷')}
      {field('creator', '创建工具', '例如：Microsoft Word')}

      <p className="tools-note">生成工具（Producer）：{meta.producer || '（无）'}</p>

      <div className="tools-actions">
        <button
          type="button"
          className="sb-btn sb-btn-primary"
          onClick={() =>
            void runTask(
              task,
              '正在写入属性…',
              () =>
                window.pdfApp.advanced.metadata({
                  sourcePath: source || undefined,
                  title: meta.title,
                  author: meta.author,
                  subject: meta.subject,
                  keywords: meta.keywords,
                  creator: meta.creator
                }),
              '属性已更新'
            )
          }
          disabled={task.busy}
        >
          保存副本
        </button>
      </div>
    </section>
  )
}

/* ============================================================
 * 书签
 * ============================================================ */

interface EditNode {
  id: string
  title: string
  page: number
  children: EditNode[]
}

let bookmarkNodeSeq = 0
function toEditNodes(nodes: PdfOutlineNode[]): EditNode[] {
  return nodes.map((node) => ({
    id: `bm-${(bookmarkNodeSeq += 1)}`,
    title: node.title,
    page: node.page,
    children: toEditNodes(node.children ?? [])
  }))
}

function toOutlineNodes(nodes: EditNode[]): PdfOutlineNode[] {
  return nodes.map((node) => ({
    title: node.title,
    page: node.page,
    children: toOutlineNodes(node.children)
  }))
}

export function BookmarksSection({
  task,
  currentDoc
}: {
  task: TaskApi
  currentDoc: string
}): JSX.Element {
  const [source, setSource] = useState(currentDoc)
  const [nodes, setNodes] = useState<EditNode[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const currentPage = useViewer((s) => s.page)
  const pageCount = useViewer((s) => s.pageCount)

  const load = useCallback(async (filePath: string): Promise<void> => {
    if (!filePath) return
    setLoading(true)
    setError(null)
    try {
      const doc = await openPdfForTools(filePath)
      const outline = await readOutline(doc)
      setNodes(toEditNodes(outline))
      void doc.destroy()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    setSource((prev) => prev || currentDoc)
  }, [currentDoc])

  useEffect(() => {
    if (source) void load(source)
  }, [source, load])

  /* 树操作：路径数组定位，递归替换/删除/插入 */
  const updateAt = (path: number[], patch: Partial<EditNode>): void => {
    const clone = JSON.parse(JSON.stringify(nodes)) as EditNode[]
    let level = clone
    for (let i = 0; i < path.length - 1; i += 1) level = level[path[i]].children
    Object.assign(level[path[path.length - 1]], patch)
    setNodes(clone)
  }

  const removeAt = (path: number[]): void => {
    const clone = JSON.parse(JSON.stringify(nodes)) as EditNode[]
    let level = clone
    for (let i = 0; i < path.length - 1; i += 1) level = level[path[i]].children
    level.splice(path[path.length - 1], 1)
    setNodes(clone)
  }

  const addChildAt = (path: number[]): void => {
    const clone = JSON.parse(JSON.stringify(nodes)) as EditNode[]
    let level = clone
    for (const index of path) level = level[index].children
    level.push({
      id: `bm-${(bookmarkNodeSeq += 1)}`,
      title: '新书签',
      page: currentPage || 1,
      children: []
    })
    setNodes(clone)
  }

  const renderRows = (level: EditNode[], path: number[], depth: number): JSX.Element[] =>
    level.flatMap((node, index) => {
      const here = [...path, index]
      return [
        <div className="bm-row" key={node.id} style={{ paddingLeft: `${depth * 14}px` }}>
          <input
            className="sb-input bm-row__title"
            value={node.title}
            onChange={(event) => updateAt(here, { title: event.target.value })}
            disabled={task.busy}
            aria-label="书签标题"
          />
          <input
            className="sb-input tools-num"
            type="number"
            min={1}
            max={pageCount || 9999}
            value={node.page}
            onChange={(event) => updateAt(here, { page: Number(event.target.value) || 1 })}
            disabled={task.busy}
            aria-label="书签页码"
            title="跳转页码"
          />
          <button
            type="button"
            className="sb-btn sb-btn-icon"
            title="添加子书签"
            onClick={() => addChildAt(here)}
            disabled={task.busy}
          >
            <BookmarkPlus size={14} />
          </button>
          <button
            type="button"
            className="sb-btn sb-btn-icon"
            title="删除书签"
            onClick={() => removeAt(here)}
            disabled={task.busy}
          >
            <Trash2 size={14} />
          </button>
        </div>,
        ...renderRows(node.children, here, depth + 1)
      ]
    })

  return (
    <section className="sb-card">
      <h3 className="sb-card-title">
        <BookmarkPlus size={15} aria-hidden="true" />
        书签（文档目录）
      </h3>
      <p className="tools-hint">
        编辑书签标题与跳转页码，可添加子书签。保存时会重建整棵目录树（原有书签被这份列表替换）。
      </p>

      <SourcePicker value={source} onChange={setSource} disabled={task.busy || loading} />

      <div className="sb-field tools-inline">
        <button
          type="button"
          className="sb-btn"
          onClick={() => void load(source)}
          disabled={task.busy || !source || loading}
        >
          <RefreshCw size={14} />
          重新读取
        </button>
        <button
          type="button"
          className="sb-btn"
          onClick={() =>
            setNodes([
              ...nodes,
              { id: `bm-${(bookmarkNodeSeq += 1)}`, title: '新书签', page: currentPage || 1, children: [] }
            ])
          }
          disabled={task.busy}
        >
          <BookmarkPlus size={14} />
          添加书签（当前页 {currentPage}）
        </button>
        <button
          type="button"
          className="sb-btn"
          onClick={() => setNodes([])}
          disabled={task.busy || nodes.length === 0}
        >
          <Trash2 size={14} />
          清空
        </button>
        {loading ? <Loader2 size={14} className="tools-spin" /> : null}
      </div>

      {error ? <p className="tools-error-text">{error}</p> : null}

      {nodes.length === 0 ? (
        <p className="tools-empty">这份文档没有书签。点「添加书签」从当前页开始创建。</p>
      ) : (
        <div className="bm-list">{renderRows(nodes, [], 0)}</div>
      )}

      <div className="tools-actions">
        <button
          type="button"
          className="sb-btn sb-btn-primary"
          onClick={() =>
            void runTask(
              task,
              '正在重建书签…',
              () =>
                window.pdfApp.advanced.bookmarks({
                  sourcePath: source || undefined,
                  items: toOutlineNodes(nodes)
                }),
              '书签已保存'
            )
          }
          disabled={task.busy}
        >
          保存副本
        </button>
      </div>
    </section>
  )
}

/* ============================================================
 * 附件
 * ============================================================ */

export function AttachmentsSection({
  task,
  currentDoc
}: {
  task: TaskApi
  currentDoc: string
}): JSX.Element {
  const [source, setSource] = useState(currentDoc)
  const [list, setList] = useState<AttachmentInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [files, setFiles] = useState<string[]>([])

  const load = useCallback(
    async (filePath: string): Promise<void> => {
      if (!filePath) return
      setLoading(true)
      try {
        const result = await window.pdfApp.advanced.attachments({
          action: 'list',
          sourcePath: filePath
        })
        if (result.ok) setList(result.attachments ?? [])
      } finally {
        setLoading(false)
      }
    },
    []
  )

  useEffect(() => {
    setSource((prev) => prev || currentDoc)
  }, [currentDoc])

  useEffect(() => {
    if (source) void load(source)
  }, [source, load])

  const addFiles = async (): Promise<void> => {
    const picked = await window.pdfApp.advanced.pickFiles()
    if (picked.length === 0) return
    const merged = [...files]
    for (const file of picked) if (!merged.includes(file)) merged.push(file)
    setFiles(merged)
  }

  return (
    <section className="sb-card">
      <h3 className="sb-card-title">
        <FolderOpen size={15} aria-hidden="true" />
        附件
      </h3>
      <p className="tools-hint">
        把其它文件（图片、表格、原始 Word 等）打包进 PDF；也可以把已有附件导出到文件夹。
      </p>

      <SourcePicker value={source} onChange={setSource} disabled={task.busy || loading} />

      <div className="sb-field tools-inline">
        <button
          type="button"
          className="sb-btn"
          onClick={() => void load(source)}
          disabled={task.busy || !source || loading}
        >
          <RefreshCw size={14} />
          刷新列表
        </button>
        {loading ? <Loader2 size={14} className="tools-spin" /> : null}
      </div>

      {list.length > 0 ? (
        <ul className="tools-filelist">
          {list.map((item) => (
            <li key={item.name} className="tools-filelist__item">
              <span className="tools-filelist__name" title={item.name}>
                {item.name}
              </span>
              <span className="tools-note">{(item.size / 1024).toFixed(1)} KB</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="tools-empty">当前文档没有附件</p>
      )}

      <div className="tools-actions">
        <button
          type="button"
          className="sb-btn sb-btn-primary"
          onClick={() =>
            void runTask(
              task,
              '正在导出附件…',
              () =>
                window.pdfApp.advanced.attachments({
                  action: 'extract',
                  sourcePath: source || undefined
                }),
              '附件已导出'
            ).then(() => void load(source))
          }
          disabled={task.busy || list.length === 0}
        >
          导出全部附件
        </button>
      </div>

      <div className="sb-field tools-inline">
        <button type="button" className="sb-btn" onClick={() => void addFiles()} disabled={task.busy}>
          <FilePlus2 size={15} />
          选择要附加的文件
        </button>
        {files.length > 0 ? (
          <button type="button" className="sb-btn" onClick={() => setFiles([])} disabled={task.busy}>
            清空
          </button>
        ) : null}
      </div>

      {files.length > 0 ? (
        <ul className="tools-filelist">
          {files.map((file) => (
            <li key={file} className="tools-filelist__item">
              <span className="tools-filelist__name" title={file}>
                {fileName(file)}
              </span>
              <button
                type="button"
                className="sb-btn sb-btn-icon"
                title="移除"
                onClick={() => setFiles(files.filter((f) => f !== file))}
                disabled={task.busy}
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="tools-actions">
        <button
          type="button"
          className="sb-btn sb-btn-primary"
          onClick={() =>
            void runTask(
              task,
              '正在写入附件…',
              () =>
                window.pdfApp.advanced.attachments({
                  action: 'add',
                  sourcePath: source || undefined,
                  files
                }),
              '附件已附加'
            ).then(() => {
              setFiles([])
              void load(source)
            })
          }
          disabled={task.busy || files.length === 0}
        >
          附加到 PDF 并另存
        </button>
      </div>
    </section>
  )
}

/* ============================================================
 * 表单填写
 * ============================================================ */

export function FormsSection({
  task,
  currentDoc
}: {
  task: TaskApi
  currentDoc: string
}): JSX.Element {
  const [source, setSource] = useState(currentDoc)
  const [fields, setFields] = useState<
    Array<{ name: string; type: string; value: string | boolean | string[]; options?: string[]; readonly?: boolean }>
  >([])
  const [hasForm, setHasForm] = useState(false)
  const [loading, setLoading] = useState(false)
  const [flatten, setFlatten] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (filePath: string): Promise<void> => {
    if (!filePath) return
    setLoading(true)
    setError(null)
    try {
      const result = await window.pdfApp.advanced.formsQuery({ sourcePath: filePath })
      if (result.ok) {
        setHasForm(result.hasForm)
        setFields(result.fields)
      } else {
        setError(result.error ?? '读取表单失败')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    setSource((prev) => prev || currentDoc)
  }, [currentDoc])

  useEffect(() => {
    if (source) void load(source)
  }, [source, load])

  const setValue = (name: string, value: string | boolean | string[]): void => {
    setFields(
      fields.map((field) => (field.name === name ? { ...field, value } : field))
    )
  }

  const start = (): void => {
    const values: Record<string, string | boolean | string[]> = {}
    for (const field of fields) values[field.name] = field.value
    void runTask(
      task,
      '正在填写表单…',
      () =>
        window.pdfApp.advanced.formsFill({
          sourcePath: source || undefined,
          values,
          flatten
        }),
      '表单已保存'
    )
  }

  return (
    <section className="sb-card">
      <h3 className="sb-card-title">
        <Info size={15} aria-hidden="true" />
        表单填写
      </h3>
      <p className="tools-hint">
        读取 PDF 里的交互表单（文本框、复选框、单选、下拉框），填好后另存；
        勾选「扁平化」会把填写结果烘焙成普通页面内容，之后无法再修改。
      </p>

      <SourcePicker value={source} onChange={setSource} disabled={task.busy || loading} />

      <div className="sb-field tools-inline">
        <button
          type="button"
          className="sb-btn"
          onClick={() => void load(source)}
          disabled={task.busy || !source || loading}
        >
          <RefreshCw size={14} />
          重新读取
        </button>
        {loading ? <Loader2 size={14} className="tools-spin" /> : null}
      </div>

      {error ? <p className="tools-error-text">{error}</p> : null}

      {!hasForm ? (
        <p className="tools-empty">这份文档没有可填写的表单字段</p>
      ) : (
        <>
          {fields.map((field) => (
            <div className="sb-field" key={field.name}>
              <div className="sb-field-text">
                <span className="sb-field-label">{field.name}</span>
                <span className="sb-field-hint">
                  {field.type === 'text'
                    ? '文本'
                    : field.type === 'checkbox'
                      ? '复选框'
                      : field.type === 'radio'
                        ? '单选'
                        : field.type === 'dropdown'
                          ? '下拉框'
                          : field.type === 'optionlist'
                            ? '列表框'
                            : field.type}
                  {field.readonly ? ' · 只读' : ''}
                </span>
              </div>
              <div className="sb-field-control tools-inline">
                {field.type === 'text' ? (
                  <input
                    className="sb-input"
                    value={String(field.value ?? '')}
                    onChange={(event) => setValue(field.name, event.target.value)}
                    disabled={task.busy || field.readonly}
                    aria-label={field.name}
                  />
                ) : null}
                {field.type === 'checkbox' ? (
                  <Switch
                    checked={Boolean(field.value)}
                    onChange={(value) => setValue(field.name, value)}
                    label={field.name}
                    disabled={task.busy || field.readonly}
                  />
                ) : null}
                {field.type === 'radio' || field.type === 'dropdown' ? (
                  <select
                    className="sb-input"
                    value={Array.isArray(field.value) ? field.value[0] ?? '' : String(field.value ?? '')}
                    onChange={(event) => setValue(field.name, event.target.value)}
                    disabled={task.busy || field.readonly}
                    aria-label={field.name}
                  >
                    <option value="">（未选择）</option>
                    {(field.options ?? []).map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : null}
                {field.type === 'optionlist' ? (
                  <select
                    className="sb-input"
                    multiple
                    size={Math.min(4, Math.max(2, (field.options ?? []).length))}
                    value={Array.isArray(field.value) ? field.value : []}
                    onChange={(event) =>
                      setValue(
                        field.name,
                        Array.from(event.target.selectedOptions).map((option) => option.value)
                      )
                    }
                    disabled={task.busy || field.readonly}
                    aria-label={field.name}
                  >
                    {(field.options ?? []).map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : null}
                {field.type !== 'text' &&
                field.type !== 'checkbox' &&
                field.type !== 'radio' &&
                field.type !== 'dropdown' &&
                field.type !== 'optionlist' ? (
                  <span className="tools-note">该字段类型暂不支持在阅读器里填写</span>
                ) : null}
              </div>
            </div>
          ))}

          <div className="sb-field sb-field-inline">
            <div className="sb-field-text">
              <span className="sb-field-label">扁平化</span>
              <span className="sb-field-hint">把填写结果变成普通内容，之后不可再编辑</span>
            </div>
            <Switch checked={flatten} onChange={setFlatten} label="扁平化" disabled={task.busy} />
          </div>

          <div className="tools-actions">
            <button
              type="button"
              className="sb-btn sb-btn-primary"
              onClick={start}
              disabled={task.busy}
            >
              填写并另存
            </button>
          </div>
        </>
      )}
    </section>
  )
}

/* ============================================================
 * 签名
 * ============================================================ */

const SIGN_POSITIONS = [
  ['right-bottom', '右下角'],
  ['left-bottom', '左下角'],
  ['right-top', '右上角'],
  ['left-top', '左上角'],
  ['center', '页面居中']
] as const

export function SignatureSection({
  task,
  currentDoc
}: {
  task: TaskApi
  currentDoc: string
}): JSX.Element {
  const [source, setSource] = useState(currentDoc)
  const [mode, setMode] = useState<'draw' | 'image'>('draw')
  const [page, setPage] = useState(1)
  const [position, setPosition] = useState<(typeof SIGN_POSITIONS)[number][0]>('right-bottom')
  const [widthPt, setWidthPt] = useState(160)
  const [withDate, setWithDate] = useState(true)
  const [imageInfo, setImageInfo] = useState<{
    dataUrl: string
    data: ArrayBuffer
    width: number
    height: number
  } | null>(null)
  /* 在页面上手动放置的签名位置（PDF 坐标，左下角原点）；null = 用预设位置 */
  const [placed, setPlaced] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
  const [preview, setPreview] = useState('')
  const [pageSize, setPageSize] = useState({ width: 595.28, height: 841.89 })
  const [previewLoading, setPreviewLoading] = useState(false)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const docRef = useRef<PDFDocumentProxy | null>(null)
  const docPathRef = useRef('')
  const draggingRef = useRef<{ dx: number; dy: number } | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const drawingRef = useRef(false)
  const pageCount = useViewer((s) => s.pageCount)
  const currentPage = useViewer((s) => s.page)

  useEffect(() => {
    setSource((prev) => prev || currentDoc)
  }, [currentDoc])

  useEffect(() => {
    setPage((prev) => (prev > 1 ? prev : currentPage || 1))
  }, [currentPage])

  /* 画布准备：白纸透明底，黑色笔迹 */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = 640
    canvas.height = 200
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.lineWidth = 4
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = '#111111'
  }, [mode])

  /* ---------- 页面预览：手动放置签名 ---------- */

  useEffect(() => {
    let alive = true
    const run = async (): Promise<void> => {
      if (!source) return
      setPreviewLoading(true)
      try {
        let doc = docRef.current
        if (!doc || docPathRef.current !== source) {
          if (doc) void doc.destroy()
          doc = await openPdfForTools(source)
          docRef.current = doc
          docPathRef.current = source
        }
        const target = Math.min(Math.max(1, page), doc.numPages)
        const pdfPage = await doc.getPage(target)
        const base = pdfPage.getViewport({ scale: 1, rotation: 0 })
        if (!alive) return
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
          const task = pdfPage.render({ canvasContext: ctx, viewport })
          await (task as unknown as { promise: Promise<void> }).promise
          if (alive) setPreview(canvas.toDataURL('image/jpeg', 0.85))
        }
        pdfPage.cleanup()
      } catch {
        if (alive) setPreview('')
      } finally {
        if (alive) setPreviewLoading(false)
      }
    }
    void run()
    return () => {
      alive = false
    }
  }, [source, page])

  useEffect(
    () => () => {
      if (docRef.current) void docRef.current.destroy()
      docRef.current = null
    },
    []
  )

  /** 当前签名图片的宽高比（画板固定 640×200；图片签名按实际比例） */
  const signatureRatio = (): number => {
    if (mode === 'image' && imageInfo) return imageInfo.height / imageInfo.width
    return 200 / 640
  }

  const clampPlaced = (rect: { x: number; y: number; width: number; height: number }) => {
    const width = Math.min(Math.max(30, rect.width), pageSize.width)
    const height = Math.min(Math.max(10, rect.height), pageSize.height)
    return {
      x: Math.min(Math.max(0, rect.x), pageSize.width - width),
      y: Math.min(Math.max(0, rect.y), pageSize.height - height),
      width,
      height
    }
  }

  const toPdfPoint = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const stage = stageRef.current
    if (!stage) return null
    const rect = stage.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    return {
      x: ((clientX - rect.left) / rect.width) * pageSize.width,
      y: ((clientY - rect.top) / rect.height) * pageSize.height
    }
  }

  /*
   * ★ placed 统一存「页面左上角原点」坐标（与鼠标一致），
   *   到真正签名时再换算成 PDF 左下角原点。这样交互逻辑不用来回换轴，
   *   只有 sign() 调用处做一次换算（见 start 里）。
   */
  const onStagePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (task.busy) return
    const point = toPdfPoint(event.clientX, event.clientY)
    if (!point) return
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* 合成事件/指针已释放时捕获会抛错，忽略即可，拖动依然可用 */
    }
    const width = Math.min(Math.max(40, widthPt), pageSize.width * 0.8)
    const height = width * signatureRatio()

    /* 已经放好了：点中签名就拖动；点到别处则重新放置 */
    if (placed) {
      const inside =
        point.x >= placed.x &&
        point.x <= placed.x + placed.width &&
        point.y >= placed.y &&
        point.y <= placed.y + placed.height
      if (inside) {
        draggingRef.current = { dx: point.x - placed.x, dy: point.y - placed.y }
        return
      }
    }
    const next = clampPlaced({
      x: point.x - width / 2,
      y: point.y - height / 2,
      width,
      height
    })
    setPlaced(next)
    draggingRef.current = { dx: point.x - next.x, dy: point.y - next.y }
  }

  const onStagePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = draggingRef.current
    if (!drag || task.busy) return
    const point = toPdfPoint(event.clientX, event.clientY)
    if (!point || !placed) return
    setPlaced(
      clampPlaced({
        x: point.x - drag.dx,
        y: point.y - drag.dy,
        width: placed.width,
        height: placed.height
      })
    )
  }

  const onStagePointerUp = (): void => {
    draggingRef.current = null
  }

  /** placed 是左上角原点坐标；覆盖层直接按百分比铺 */
  const placedStyle = placed
    ? {
        left: `${(placed.x / pageSize.width) * 100}%`,
        top: `${(placed.y / pageSize.height) * 100}%`,
        width: `${(placed.width / pageSize.width) * 100}%`,
        height: `${(placed.height / pageSize.height) * 100}%`
      }
    : undefined

  const toPoint = (event: ReactPointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const canvas = event.currentTarget
    const rect = canvas.getBoundingClientRect()
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height
    }
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (task.busy) return
    const ctx = event.currentTarget.getContext('2d')
    if (!ctx) return
    drawingRef.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = toPoint(event)
    ctx.beginPath()
    ctx.moveTo(point.x, point.y)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (!drawingRef.current || task.busy) return
    const ctx = event.currentTarget.getContext('2d')
    if (!ctx) return
    const point = toPoint(event)
    ctx.lineTo(point.x, point.y)
    ctx.stroke()
  }

  const onPointerUp = (): void => {
    drawingRef.current = false
  }

  const clearPad = (): void => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
  }

  /** 从画布导出透明 PNG 的字节 */
  const capturePad = (): { dataUrl: string; data: ArrayBuffer; width: number; height: number } | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    /* 检查是否真的画了东西：全透明就没有签名 */
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    let painted = false
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] !== 0) {
        painted = true
        break
      }
    }
    if (!painted) return null
    const dataUrl = canvas.toDataURL('image/png')
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return { dataUrl, data: bytes.buffer, width: canvas.width, height: canvas.height }
  }

  const pickImage = (): void => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = String(reader.result)
        const img = new Image()
        img.onload = () => {
          const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
          const binary = atob(base64)
          const bytes = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
          setImageInfo({ dataUrl, data: bytes.buffer, width: img.width, height: img.height })
        }
        img.src = dataUrl
      }
      reader.readAsDataURL(file)
    }
    input.click()
  }

  const start = async (): Promise<void> => {
    if (!source) {
      task.setFeedback({ kind: 'error', text: '请先选择要签名的 PDF' })
      return
    }
    const captured = mode === 'image' ? imageInfo : capturePad()
    if (!captured) {
      task.setFeedback({
        kind: 'error',
        text: mode === 'image' ? '请选择签名图片' : '请先在画板上手写签名'
      })
      return
    }

    task.setBusy('正在放置签名…')
    try {
      const doc = await openPdfForTools(source)
      const targetPage = Math.min(Math.max(1, page), doc.numPages)
      const pdfPage = await doc.getPage(targetPage)
      const viewport = pdfPage.getViewport({ scale: 1, rotation: 0 })
      const pageWidth = viewport.width
      const pageHeight = viewport.height

      const ratio = captured.height / captured.width
      let width = Math.min(Math.max(40, widthPt), pageWidth * 0.8)
      let height = width * ratio
      const margin = 36

      let x = pageWidth - margin - width
      let y = margin

      if (placed) {
        /*
         * 手动放置：placed 存的是左上角原点坐标，
         * PDF 的 y 从底边算，所以 y = 页高 - 顶边 - 高度。
         */
        width = Math.min(placed.width, pageWidth)
        height = Math.min(placed.height, pageHeight)
        x = Math.min(Math.max(0, placed.x), pageWidth - width)
        y = Math.min(Math.max(0, pageHeight - placed.y - height), pageHeight - height)
      } else {
        if (position === 'left-bottom') x = margin
        if (position === 'right-top') y = pageHeight - margin - height
        if (position === 'left-top') {
          x = margin
          y = pageHeight - margin - height
        }
        if (position === 'center') {
          x = (pageWidth - width) / 2
          y = (pageHeight - height) / 2
        }
      }

      const now = new Date()
      const dateText = withDate
        ? `签署日期：${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
        : undefined

      const result = await window.pdfApp.advanced.sign({
        sourcePath: source,
        image: { data: captured.data, width: captured.width, height: captured.height },
        page: targetPage,
        rect: { x, y, width, height },
        dateText
      })
      if (result.ok) {
        task.setFeedback({
          kind: 'ok',
          text: `签名完成${result.path ? `：${result.path}` : ''}`,
          path: result.path
        })
      } else if (result.canceled) {
        task.setFeedback({ kind: 'info', text: '已取消' })
      } else {
        task.setFeedback({ kind: 'error', text: result.error ?? '签名失败' })
      }
    } catch (error) {
      task.setFeedback({
        kind: 'error',
        text: error instanceof Error ? error.message : String(error)
      })
    } finally {
      task.setBusy(null)
    }
  }

  return (
    <section className="sb-card">
      <h3 className="sb-card-title">
        <PenLine size={15} aria-hidden="true" />
        签名
      </h3>
      <p className="tools-hint">
        手写签名或导入签名图片，作为图片盖章到指定页面。签名为位图，写入后不可再编辑。
      </p>

      <SourcePicker value={source} onChange={setSource} disabled={task.busy} />

      <div className="sb-seg tools-seg-wide" role="group" aria-label="签名方式">
        <button
          type="button"
          className="sb-seg-btn"
          aria-pressed={mode === 'draw'}
          onClick={() => setMode('draw')}
          disabled={task.busy}
        >
          手写签名
        </button>
        <button
          type="button"
          className="sb-seg-btn"
          aria-pressed={mode === 'image'}
          onClick={() => setMode('image')}
          disabled={task.busy}
        >
          图片签名
        </button>
      </div>

      {mode === 'draw' ? (
        <div className="sign-pad">
          <canvas
            ref={canvasRef}
            className="sign-pad__canvas"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            aria-label="手写签名画板"
          />
          <button type="button" className="sb-btn sign-pad__clear" onClick={clearPad} disabled={task.busy}>
            清空
          </button>
        </div>
      ) : (
        <div className="sign-pad sign-pad--image">
          {imageInfo ? (
            <img src={imageInfo.dataUrl} alt="签名预览" className="sign-image" />
          ) : (
            <span className="tools-note">还没有选择签名图片</span>
          )}
          <button type="button" className="sb-btn" onClick={pickImage} disabled={task.busy}>
            {imageInfo ? '重新选择' : '选择图片'}
          </button>
        </div>
      )}

      <div className="sb-field">
        <div className="sb-field-text">
          <span className="sb-field-label">页面放置</span>
          <span className="sb-field-hint">
            在下方预览上点一下把签名放到该处，按住可拖动；不使用则按「位置」预设
          </span>
        </div>
        <div className="sb-field-control tools-inline">
          {placed ? (
            <button type="button" className="sb-btn" onClick={() => setPlaced(null)} disabled={task.busy}>
              清除手动位置
            </button>
          ) : null}
          {previewLoading ? <span className="tools-note">渲染中…</span> : null}
        </div>
      </div>

      <div
        className="sign-stage"
        ref={stageRef}
        onPointerDown={onStagePointerDown}
        onPointerMove={onStagePointerMove}
        onPointerUp={onStagePointerUp}
        onPointerLeave={onStagePointerUp}
        role="application"
        aria-label="签名放置预览：点击或拖动放置签名"
      >
        {preview ? (
          <img className="sign-stage__page" src={preview} alt={`第 ${page} 页预览`} draggable={false} />
        ) : (
          <div className="sign-stage__empty">预览加载中…</div>
        )}
        {placed ? <div className="sign-place-box" style={placedStyle} /> : null}
      </div>

      <div className="sb-field">
        <div className="sb-field-text">
          <span className="sb-field-label">页码</span>
          <span className="sb-field-hint">共 {pageCount || '—'} 页</span>
        </div>
        <input
          className="sb-input tools-num"
          type="number"
          min={1}
          max={pageCount || 9999}
          value={page}
          onChange={(event) => {
            setPlaced(null)
            setPage(Number(event.target.value) || 1)
          }}
          disabled={task.busy}
          aria-label="页码"
        />
      </div>

      <div className="sb-field">
        <div className="sb-field-text">
          <span className="sb-field-label">位置</span>
        </div>
        <select
          className="sb-input"
          value={position}
          onChange={(event) => setPosition(event.target.value as typeof position)}
          disabled={task.busy}
          aria-label="位置"
        >
          {SIGN_POSITIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <div className="sb-field">
        <div className="sb-field-text">
          <span className="sb-field-label">签名宽度</span>
          <span className="sb-field-hint">PDF 点（72 点 = 1 英寸）</span>
        </div>
        <div className="sb-field-control">
          <output className="sb-readout">{widthPt} pt</output>
          <input
            type="range"
            className="sb-range"
            min={60}
            max={300}
            step={5}
            value={widthPt}
            onChange={(event) => setWidthPt(Number(event.target.value))}
            disabled={task.busy}
            aria-label="签名宽度"
          />
        </div>
      </div>

      <div className="sb-field sb-field-inline">
        <div className="sb-field-text">
          <span className="sb-field-label">附加签署日期</span>
          <span className="sb-field-hint">在签名下方写入「签署日期：年-月-日」</span>
        </div>
        <Switch checked={withDate} onChange={setWithDate} label="附加签署日期" disabled={task.busy} />
      </div>

      <div className="tools-actions">
        <button type="button" className="sb-btn sb-btn-primary" onClick={() => void start()} disabled={task.busy}>
          签名并另存
        </button>
      </div>
    </section>
  )
}

/* ============================================================
 * PDF/A 归档
 * ============================================================ */

export function PdfaSection({
  task,
  currentDoc
}: {
  task: TaskApi
  currentDoc: string
}): JSX.Element {
  const [source, setSource] = useState(currentDoc)
  const [conformance, setConformance] = useState<'1B' | '2B' | '3B'>('2B')

  useEffect(() => {
    setSource((prev) => prev || currentDoc)
  }, [currentDoc])

  return (
    <section className="sb-card">
      <h3 className="sb-card-title">
        <Info size={15} aria-hidden="true" />
        PDF/A 归档
      </h3>
      <p className="tools-hint">
        PDF/A 是长期归档标准：字体全部嵌入、颜色与元数据规范化，适合存档与提交。
        若原始文档有未嵌入字体，转换可能失败，届时请先用 Office/打印方式生成 PDF。
      </p>

      <SourcePicker value={source} onChange={setSource} disabled={task.busy} />

      <div className="sb-seg tools-seg-wide" role="group" aria-label="PDF/A 级别">
        {(['1B', '2B', '3B'] as const).map((value) => (
          <button
            key={value}
            type="button"
            className="sb-seg-btn"
            aria-pressed={conformance === value}
            onClick={() => setConformance(value)}
            disabled={task.busy}
          >
            PDF/A-{value}
          </button>
        ))}
      </div>

      <p className="tools-note">
        1B：最严格的长期归档；2B：ISO 19005-2（推荐）；3B：允许嵌入任意文件。
      </p>

      <div className="tools-actions">
        <button
          type="button"
          className="sb-btn sb-btn-primary"
          onClick={() =>
            void runTask(
              task,
              '正在转换为 PDF/A…',
              () => window.pdfApp.advanced.pdfa({ sourcePath: source || undefined, conformance }),
              'PDF/A 转换完成'
            )
          }
          disabled={task.busy}
        >
          转换并另存
        </button>
      </div>
    </section>
  )
}

/* ============================================================
 * 导出（文本 / HTML / Word）
 * ============================================================ */

export function ExportSection({
  task,
  currentDoc,
  showToast
}: {
  task: TaskApi
  currentDoc: string
  showToast: (text: string, ms?: number) => void
}): JSX.Element {
  const [source, setSource] = useState(currentDoc)
  const [format, setFormat] = useState<'txt' | 'html' | 'docx' | 'xlsx'>('docx')

  useEffect(() => {
    setSource((prev) => prev || currentDoc)
  }, [currentDoc])

  const start = async (): Promise<void> => {
    if (!source) {
      task.setFeedback({ kind: 'error', text: '请先选择要导出的 PDF' })
      return
    }
    task.setFeedback(null)
    task.setBusy('正在提取文字…')
    task.setProgress(0)
    let doc: Awaited<ReturnType<typeof openPdfForTools>> | null = null
    try {
      doc = await openPdfForTools(source)
      const base = source.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? '导出'
      let result

      if (format === 'xlsx') {
        /*
         * Excel 走「按版面聚列」的提取：保留每个文字片段的 x 坐标，
         * 跨行聚类成列，列与列之间不会因为空格数量不同而错位。
         */
        task.setBusy('正在分析表格版面…')
        const tables = await extractTablePages(doc, (done, total) =>
          task.setProgress(Math.round((done / total) * 85))
        )
        task.setBusy('正在生成 Excel…')
        result = await window.pdfApp.advanced.exportExcel({
          sourcePath: source,
          pages: tables.map((table) => ({ page: table.page, rows: table.rows }))
        })
      } else {
        const pages = await extractTextPages(doc, (done, total) =>
          task.setProgress(Math.round((done / total) * 85))
        )

        if (format === 'docx') {
          task.setBusy('正在生成 Word…')
          result = await window.pdfApp.advanced.exportWord({ sourcePath: source, pages })
        } else if (format === 'html') {
          const body = pages
            .map(
              (page) =>
                `<section class="pdf-page" data-page="${page.page}"><h2>第 ${page.page} 页</h2><pre>${escapeHtml(
                  page.text
                )}</pre></section>`
            )
            .join('\n')
          const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(
            base
          )}</title><style>body{font-family:"Microsoft YaHei",sans-serif;max-width:900px;margin:32px auto;line-height:1.7}.pdf-page{border-bottom:1px solid #ddd;padding:16px 0}pre{white-space:pre-wrap;word-break:break-word}</style></head><body><h1>${escapeHtml(
            base
          )}</h1>${body}</body></html>`
          result = await window.pdfApp.advanced.saveBinary({
            defaultName: `${base}.html`,
            ext: 'html',
            data: new TextEncoder().encode(html).buffer
          })
        } else {
          const text = pages
            .map((page) => `===== 第 ${page.page} 页 =====\n${page.text}`)
            .join('\n\n')
          result = await window.pdfApp.advanced.saveBinary({
            defaultName: `${base}.txt`,
            ext: 'txt',
            data: new TextEncoder().encode(text).buffer
          })
        }
      }

      if (result.ok) {
        task.setFeedback({
          kind: 'ok',
          text: `导出完成${result.path ? `：${result.path}` : ''}${result.info ? ` · ${describeInfo(result.info)}` : ''}`,
          path: result.path
        })
        showToast('导出完成')
      } else if (result.canceled) {
        task.setFeedback({ kind: 'info', text: '已取消' })
      } else {
        task.setFeedback({ kind: 'error', text: result.error ?? '导出失败' })
      }
    } catch (error) {
      task.setFeedback({
        kind: 'error',
        text: error instanceof Error ? error.message : String(error)
      })
    } finally {
      if (doc) void doc.destroy()
      task.setBusy(null)
    }
  }

  return (
    <section className="sb-card">
      <h3 className="sb-card-title">
        <FolderOpen size={15} aria-hidden="true" />
        导出文本 / Word / Excel
      </h3>
      <p className="tools-hint">
        提取全部页面文字，导出为纯文本、网页、可编辑 Word 或 Excel 表格。扫描件（无文字层）请先做 OCR。
        版式不会随原文保留，适合把内容搬运到其它文档里再排版。
      </p>

      <SourcePicker value={source} onChange={setSource} disabled={task.busy} />

      <div className="sb-seg tools-seg-wide tools-seg-wrap" role="group" aria-label="导出格式">
        {(
          [
            ['docx', 'Word（.docx）'],
            ['xlsx', 'Excel（.xlsx）'],
            ['txt', '纯文本（.txt）'],
            ['html', '网页（.html）']
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className="sb-seg-btn"
            aria-pressed={format === value}
            onClick={() => setFormat(value)}
            disabled={task.busy}
          >
            {label}
          </button>
        ))}
      </div>

      {format === 'xlsx' ? (
        <p className="tools-note">
          按行导出：Tab 或连续两个空格视为分列符，纯数字写成数值单元格；页与页之间插入页码分隔行。
        </p>
      ) : null}

      <div className="tools-actions">
        <button
          type="button"
          className="sb-btn sb-btn-primary"
          onClick={() => void start()}
          disabled={task.busy || !source}
        >
          导出
        </button>
      </div>
    </section>
  )
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
