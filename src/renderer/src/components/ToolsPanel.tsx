// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * PDF 工具箱面板 —— 右侧滑出抽屉。
 *
 * 左侧竖排导航分区（23 项）：
 *   文件级：合并 / 拆分 / 水印 / 压缩 / 加密 / 图片互转 / Office→PDF
 *   文档级：页面整理 / 页眉页脚 / 贝茨编号 / 属性 / 书签 / 附件 /
 *           表单填写 / 建表单 / 签名 / PDF/A / 打印 / 提图 / 文档比较 /
 *           批量处理 / 导出文本·Word·Excel / 安全遮盖
 *
 * 设计取舍：
 *   · 与设置面板同一套视觉（sb-card / sb-field / sb-btn），用户不必学两套界面；
 *   · 每个操作都是「选文件 → 设参数 → 点执行」，执行中显示进度，
 *     完成后把结果路径列出来，并给一个「在文件夹中显示」按钮；
 *   · 渲染层的活儿（页面光栅化、水印转图、文字提取）由 pdf-tools.ts 完成，
 *     面板只负责调度与状态展示，不直接摸 canvas / pdf.js。
 */

import { useEffect, useRef, useState } from 'react'
import {
  AlignCenter,
  Archive,
  Bookmark,
  Briefcase,
  ChevronLeft,
  ClipboardList,
  Combine,
  Download,
  Droplets,
  EyeOff,
  FileImage,
  FileOutput,
  FilePlus2,
  FolderOpen,
  GitCompare,
  Hash,
  Images,
  Info,
  Layers,
  LayoutGrid,
  ListOrdered,
  Loader2,
  Lock,
  Minimize2,
  Paperclip,
  PenLine,
  Printer,
  Scissors,
  ShieldCheck,
  ShieldOff,
  SquarePen,
  Trash2,
  X
} from 'lucide-react'
import type { OfficeConverterInfo } from '@shared/pdf-tools'
import { useViewer } from '../store'
import {
  openPdfForTools,
  renderLongImages,
  renderPdfPages,
  renderWatermarkImage
} from '../pdf-tools'
import {
  baseName,
  describeInfo,
  FileList,
  runTask,
  SourcePicker,
  Switch,
  type Feedback,
  type TaskApi
} from './advanced/shared'
import {
  AttachmentsSection,
  BatesSection,
  BookmarksSection,
  ExportSection,
  FormsSection,
  HeaderFooterSection,
  MetadataSection,
  PdfaSection,
  SignatureSection
} from './advanced/AdvancedSections'
import {
  ExtractImagesSection,
  FormDesignSection,
  PrintSection
} from './advanced/DesignSections'
import { BatchSection, CompareSection } from './advanced/CompareBatchSections'
import { PagesSection } from './advanced/PagesSection'
import { RedactSection } from './advanced/RedactSection'

/* ============================================================
 * 类型与常量
 * ============================================================ */

type SectionId =
  | 'home'
  | 'merge'
  | 'split'
  | 'watermark'
  | 'compress'
  | 'protect'
  | 'convert'
  | 'office'
  /* ---- 文档编辑（Acrobat 级） ---- */
  | 'pages'
  | 'header'
  | 'bates'
  | 'meta'
  | 'bookmarks'
  | 'attach'
  | 'forms'
  | 'formdesign'
  | 'sign'
  | 'pdfa'
  | 'print'
  | 'extractimg'
  | 'compare'
  | 'batch'
  | 'export'
  | 'redact'

const SECTIONS: ReadonlyArray<{
  id: SectionId
  label: string
  icon: JSX.Element
  tip: string
  /** 首页工具列表里的分组：整份文档处理 / 文档级编辑 */
  group: 'file' | 'doc'
}> = [
  { id: 'merge', label: '合并', icon: <Combine size={17} />, tip: '把多个 PDF 拼成一份', group: 'file' },
  { id: 'split', label: '拆分', icon: <Scissors size={17} />, tip: '按页拆开或提取页码范围', group: 'file' },
  { id: 'watermark', label: '水印', icon: <Droplets size={17} />, tip: '加文字水印（居中或平铺）', group: 'file' },
  { id: 'compress', label: '压缩', icon: <Minimize2 size={17} />, tip: '重新栅格化，显著减小体积', group: 'file' },
  { id: 'protect', label: '加密', icon: <Lock size={17} />, tip: '加打开密码 / 移除保护', group: 'file' },
  { id: 'convert', label: '图片', icon: <FileImage size={17} />, tip: 'PDF 与图片互转（长图 / 分页）', group: 'file' },
  { id: 'office', label: 'Office', icon: <FileOutput size={17} />, tip: 'Word / Excel / PPT 转 PDF', group: 'file' },
  { id: 'pages', label: '页面', icon: <ListOrdered size={17} />, tip: '整理页面：排序 / 删除 / 旋转 / 裁剪', group: 'doc' },
  { id: 'header', label: '页眉', icon: <AlignCenter size={17} />, tip: '页眉页脚与页码（支持中文）', group: 'doc' },
  { id: 'bates', label: '编号', icon: <Hash size={17} />, tip: '贝茨编号（Bates numbering）', group: 'doc' },
  { id: 'meta', label: '属性', icon: <Info size={17} />, tip: '文档属性与元数据', group: 'doc' },
  { id: 'bookmarks', label: '书签', icon: <Bookmark size={17} />, tip: '编辑文档目录 / 书签', group: 'doc' },
  { id: 'attach', label: '附件', icon: <Paperclip size={17} />, tip: '给 PDF 添加或导出附件', group: 'doc' },
  { id: 'forms', label: '表单', icon: <ClipboardList size={17} />, tip: '填写 AcroForm 表单并扁平化', group: 'doc' },
  {
    id: 'formdesign',
    label: '建表单',
    icon: <SquarePen size={17} />,
    tip: '在页面上框选创建文本域/复选框/下拉框/单选组',
    group: 'doc'
  },
  { id: 'sign', label: '签名', icon: <PenLine size={17} />, tip: '手写 / 图片签名盖章', group: 'doc' },
  { id: 'pdfa', label: '归档', icon: <Archive size={17} />, tip: '转换为 PDF/A 长期归档格式', group: 'doc' },
  { id: 'print', label: '打印', icon: <Printer size={17} />, tip: '调用系统打印对话框打印当前 PDF', group: 'doc' },
  {
    id: 'extractimg',
    label: '提图',
    icon: <Images size={17} />,
    tip: '提取 PDF 内嵌的位图并导出 PNG',
    group: 'doc'
  },
  { id: 'compare', label: '比较', icon: <GitCompare size={17} />, tip: '比较两份 PDF 的文字差异并导出报告', group: 'doc' },
  { id: 'batch', label: '批量', icon: <Layers size={17} />, tip: '一次对多份 PDF 做同一处理', group: 'doc' },
  { id: 'export', label: '导出', icon: <Download size={17} />, tip: '导出文本 / 网页 / Word / Excel', group: 'doc' },
  { id: 'redact', label: '遮盖', icon: <EyeOff size={17} />, tip: '安全遮盖敏感信息（永久删除）', group: 'doc' }
]

/** 压缩档位 → 渲染参数 */
const COMPRESS_PRESETS = {
  high: { label: '高质量', dpi: 150, quality: 0.86, tip: '接近原清晰度，体积约为中等档的 2 倍' },
  medium: { label: '均衡', dpi: 110, quality: 0.72, tip: '屏幕阅读够清晰，体积明显变小（推荐）' },
  small: { label: '最小体积', dpi: 80, quality: 0.55, tip: '适合发微信 / 邮件，放大后字会发虚' }
} as const

type CompressPreset = keyof typeof COMPRESS_PRESETS

/* ============================================================
 * 面板主体
 * ============================================================ */

interface ToolsPanelProps {
  onClose: () => void
}

export function ToolsPanel({ onClose }: ToolsPanelProps): JSX.Element {
  const [section, setSection] = useState<SectionId>('home')
  const [busyText, setBusyText] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  /** 当前打开的文档（各分区默认就拿它当输入，避免重复选文件） */
  const currentDoc = useViewer((s) => s.filePath)
  const showToast = useViewer((s) => s.showToast)

  const busy = busyText !== null
  /** 供「按 Esc 关闭」判断：任务进行中不允许关闭（关闭按钮也是禁用态） */
  const busyRef = useRef(false)
  busyRef.current = busy
  const task: TaskApi = {
    busy,
    setBusy: (text) => {
      setBusyText(text)
      if (text === null) setProgress(null)
    },
    setProgress,
    setFeedback
  }

  /* Esc 关闭（哪怕焦点在输入框里）—— 与设置面板一致；处理中不允许关闭 */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        /* 任务进行中关掉面板会让进度与结果无处显示，直接忽略这次 Esc */
        if (busyRef.current) return
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  /* 打开时把焦点移进面板（读屏能读到对话框标题） */
  useEffect(() => {
    const previous = document.activeElement
    panelRef.current?.focus()
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

  const switchSection = (id: SectionId): void => {
    if (busy) return
    setSection(id)
    setFeedback(null)
    setProgress(null)
  }

  const reveal = (path: string): void => {
    void window.pdfApp.open.reveal(path)
  }

  return (
    <div className="sb-settings-overlay">
      <div className="sb-settings-scrim" aria-hidden="true" onClick={busy ? undefined : onClose} />
      <div
        ref={panelRef}
        className="sb-settings-panel tools-panel"
        role="dialog"
        aria-modal="true"
        aria-label="PDF 工具箱"
        tabIndex={-1}
      >
        <header className="sb-settings-head">
          <div className="sb-settings-head-text">
            <h2 className="sb-settings-title">
              <Briefcase size={18} aria-hidden="true" />
              PDF 工具箱
            </h2>
            <p className="sb-settings-subtitle">
              点下面的工具卡片开始；左侧一列也可直接切换分类
            </p>
          </div>
          <button
            type="button"
            className="sb-icon-btn"
            onClick={onClose}
            disabled={busy}
            aria-label="关闭工具箱"
            title={busy ? '正在处理，请稍候' : '关闭工具箱'}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="tools-body">
          {/* 左侧分区切换 */}
          <nav className="tools-nav" aria-label="工具分类">
            {SECTIONS.map((item) => (
              <button
                key={item.id}
                type="button"
                className="tools-nav__item"
                aria-current={section === item.id}
                title={item.tip}
                disabled={busy && section !== item.id}
                onClick={() => switchSection(item.id)}
              >
                <span className="tools-nav__icon">{item.icon}</span>
                <span className="tools-nav__label">{item.label}</span>
              </button>
            ))}
          </nav>

          {/* 右侧内容 */}
          <div className="tools-content">
            {section !== 'home' ? (
              <button
                type="button"
                className="tools-back"
                onClick={() => switchSection('home')}
                disabled={busy}
                title="返回工具列表"
              >
                <ChevronLeft size={15} aria-hidden="true" />
                全部工具
              </button>
            ) : null}

            {feedback ? (
              <div className={`tools-feedback tools-feedback--${feedback.kind}`} role="status">
                <span className="tools-feedback__text">{feedback.text}</span>
                {feedback.path ? (
                  <button
                    type="button"
                    className="sb-btn sb-btn-icon"
                    title="在文件夹中显示"
                    onClick={() => reveal(feedback.path!)}
                  >
                    <FolderOpen size={15} />
                  </button>
                ) : null}
              </div>
            ) : null}

            {section === 'home' ? (
              <div className="tools-home">
                {(
                  [
                    { id: 'file', title: '文件级处理', hint: '针对整份 PDF 文件' },
                    { id: 'doc', title: '文档级编辑', hint: '改内容、加标注、出报告' }
                  ] as const
                ).map((group) => (
                  <section key={group.id} className="tools-home__group">
                    <h3 className="tools-home__title">
                      {group.title}
                      <span className="tools-home__hint">{group.hint}</span>
                    </h3>
                    <div className="tools-home__grid">
                      {SECTIONS.filter((item) => item.group === group.id).map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          className="tools-home__tile"
                          disabled={busy}
                          data-tool-id={item.id}
                          onClick={() => switchSection(item.id)}
                        >
                          <span className="tools-home__icon">{item.icon}</span>
                          <span className="tools-home__label">{item.label}</span>
                          <span className="tools-home__tip">{item.tip}</span>
                        </button>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            ) : null}

            {section === 'merge' ? <MergeTool task={task} /> : null}
            {section === 'split' ? <SplitTool task={task} currentDoc={currentDoc} /> : null}
            {section === 'watermark' ? (
              <WatermarkTool task={task} currentDoc={currentDoc} />
            ) : null}
            {section === 'compress' ? (
              <CompressTool task={task} currentDoc={currentDoc} showToast={showToast} />
            ) : null}
            {section === 'protect' ? <ProtectTool task={task} currentDoc={currentDoc} /> : null}
            {section === 'convert' ? (
              <ConvertTool task={task} currentDoc={currentDoc} showToast={showToast} />
            ) : null}
            {section === 'office' ? <OfficeTool task={task} /> : null}

            {/* ---------- 文档编辑（Acrobat 级） ---------- */}
            {section === 'pages' ? <PagesSection task={task} currentDoc={currentDoc} /> : null}
            {section === 'header' ? (
              <HeaderFooterSection task={task} currentDoc={currentDoc} />
            ) : null}
            {section === 'bates' ? <BatesSection task={task} currentDoc={currentDoc} /> : null}
            {section === 'meta' ? (
              <MetadataSection task={task} currentDoc={currentDoc} />
            ) : null}
            {section === 'bookmarks' ? (
              <BookmarksSection task={task} currentDoc={currentDoc} />
            ) : null}
            {section === 'attach' ? (
              <AttachmentsSection task={task} currentDoc={currentDoc} />
            ) : null}
            {section === 'forms' ? <FormsSection task={task} currentDoc={currentDoc} /> : null}
            {section === 'formdesign' ? (
              <FormDesignSection task={task} currentDoc={currentDoc} />
            ) : null}
            {section === 'sign' ? (
              <SignatureSection task={task} currentDoc={currentDoc} />
            ) : null}
            {section === 'pdfa' ? <PdfaSection task={task} currentDoc={currentDoc} /> : null}
            {section === 'print' ? <PrintSection task={task} currentDoc={currentDoc} /> : null}
            {section === 'extractimg' ? (
              <ExtractImagesSection task={task} currentDoc={currentDoc} />
            ) : null}
            {section === 'compare' ? <CompareSection task={task} currentDoc={currentDoc} /> : null}
            {section === 'batch' ? <BatchSection task={task} /> : null}
            {section === 'export' ? (
              <ExportSection task={task} currentDoc={currentDoc} showToast={showToast} />
            ) : null}
            {section === 'redact' ? <RedactSection task={task} currentDoc={currentDoc} /> : null}
          </div>
        </div>

        {busyText ? (
          <footer className="tools-busy" role="status">
            <Loader2 size={16} className="tools-spin" aria-hidden="true" />
            <span>{busyText}</span>
            {progress !== null ? <span className="tools-busy__pct">{progress}%</span> : null}
          </footer>
        ) : null}
      </div>
    </div>
  )
}

/* ============================================================
 * 1. 合并
 * ============================================================ */

function MergeTool({ task }: { task: TaskApi }): JSX.Element {
  const [files, setFiles] = useState<string[]>([])

  const add = async (): Promise<void> => {
    const picked = await window.pdfApp.tools.pickPdfs()
    if (picked.length === 0) return
    const merged = [...files]
    for (const file of picked) if (!merged.includes(file)) merged.push(file)
    setFiles(merged)
  }

  const start = async (): Promise<void> => {
    if (files.length < 2) {
      task.setFeedback({ kind: 'error', text: '请至少选择两个 PDF' })
      return
    }
    await runTask(
      task,
      '正在合并…',
      () => window.pdfApp.tools.merge({ inputs: files }),
      '合并完成'
    )
  }

  return (
    <section className="sb-card">
      <h3 className="sb-card-title">
        <LayoutGrid size={15} aria-hidden="true" />
        合并 PDF
      </h3>
      <p className="tools-hint">
        按列表顺序拼成一份新文件；点上下箭头调整顺序。原文件都不会被修改。
      </p>

      <div className="sb-field tools-inline">
        <button type="button" className="sb-btn" onClick={() => void add()} disabled={task.busy}>
          <FilePlus2 size={15} />
          添加 PDF
        </button>
        {files.length > 0 ? (
          <button
            type="button"
            className="sb-btn"
            onClick={() => setFiles([])}
            disabled={task.busy}
          >
            <Trash2 size={15} />
            清空列表
          </button>
        ) : null}
      </div>

      <FileList files={files} onChange={setFiles} disabled={task.busy} showOrder />

      <div className="tools-actions">
        <button
          type="button"
          className="sb-btn sb-btn-primary"
          onClick={() => void start()}
          disabled={task.busy || files.length < 2}
        >
          <Combine size={15} />
          开始合并
        </button>
        <span className="tools-note">输出位置：点开始后选择保存路径</span>
      </div>
    </section>
  )
}

/* ============================================================
 * 2. 拆分
 * ============================================================ */

function SplitTool({ task, currentDoc }: { task: TaskApi; currentDoc: string }): JSX.Element {
  const [source, setSource] = useState(currentDoc)
  const [mode, setMode] = useState<'each' | 'ranges'>('each')
  const [ranges, setRanges] = useState('1-3,5')
  const [outputDir, setOutputDir] = useState('')

  useEffect(() => {
    setSource((prev) => prev || currentDoc)
  }, [currentDoc])

  const pickFolder = async (): Promise<void> => {
    const dir = await window.pdfApp.tools.pickFolder()
    if (dir) setOutputDir(dir)
  }

  const start = async (): Promise<void> => {
    if (mode === 'ranges' && ranges.trim() === '') {
      task.setFeedback({ kind: 'error', text: '按范围拆分需要填写页码范围，例如 1-3,5' })
      return
    }
    await runTask(
      task,
      mode === 'each' ? '正在逐页拆分…' : '正在提取页面…',
      () =>
        window.pdfApp.tools.split({
          sourcePath: source || undefined,
          mode,
          ranges: mode === 'ranges' ? ranges : undefined,
          outputDir: outputDir || undefined
        }),
      '拆分完成'
    )
  }

  return (
    <section className="sb-card">
      <h3 className="sb-card-title">
        <Scissors size={15} aria-hidden="true" />
        拆分 PDF
      </h3>

      <SourcePicker value={source} onChange={setSource} disabled={task.busy} />

      <div className="sb-field">
        <div className="sb-field-text">
          <span className="sb-field-label">拆分方式</span>
        </div>
        <div className="sb-seg" role="group" aria-label="拆分方式">
          <button
            type="button"
            className="sb-seg-btn"
            aria-pressed={mode === 'each'}
            onClick={() => setMode('each')}
            disabled={task.busy}
          >
            每页一个文件
          </button>
          <button
            type="button"
            className="sb-seg-btn"
            aria-pressed={mode === 'ranges'}
            onClick={() => setMode('ranges')}
            disabled={task.busy}
          >
            按页码范围
          </button>
        </div>
      </div>

      {mode === 'ranges' ? (
        <div className="sb-field">
          <div className="sb-field-text">
            <span className="sb-field-label">页码范围</span>
            <span className="sb-field-hint">逗号分隔；"-" 表示连续区间，例如 1-3,5,8-10</span>
          </div>
          <input
            className="sb-input"
            value={ranges}
            onChange={(e) => setRanges(e.target.value)}
            disabled={task.busy}
            placeholder="1-3,5,8-10"
            aria-label="页码范围"
          />
        </div>
      ) : null}

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
        <button
          type="button"
          className="sb-btn sb-btn-primary"
          onClick={() => void start()}
          disabled={task.busy}
        >
          <Scissors size={15} />
          开始拆分
        </button>
      </div>
    </section>
  )
}

/* ============================================================
 * 3. 水印
 * ============================================================ */

const WATERMARK_COLORS = ['#e5484d', '#2f7fe8', '#1a9e5c', '#8a8f99', '#000000']

function WatermarkTool({
  task,
  currentDoc
}: {
  task: TaskApi
  currentDoc: string
}): JSX.Element {
  const [source, setSource] = useState(currentDoc)
  const [text, setText] = useState('内部资料')
  const [fontSize, setFontSize] = useState(48)
  const [color, setColor] = useState('#e5484d')
  const [opacity, setOpacity] = useState(0.18)
  const [rotation, setRotation] = useState(30)
  const [position, setPosition] = useState<'center' | 'tile'>('center')

  useEffect(() => {
    setSource((prev) => prev || currentDoc)
  }, [currentDoc])

  const start = async (): Promise<void> => {
    if (text.trim() === '') {
      task.setFeedback({ kind: 'error', text: '请填写水印文字' })
      return
    }
    await runTask(
      task,
      '正在加水印…',
      async () => {
        const image = renderWatermarkImage({ text, color, fontSize })
        return window.pdfApp.tools.watermark({
          sourcePath: source || undefined,
          image,
          opacity,
          rotation,
          position
        })
      },
      '水印添加完成'
    )
  }

  return (
    <section className="sb-card">
      <h3 className="sb-card-title">
        <Droplets size={15} aria-hidden="true" />
        加水印
      </h3>
      <p className="tools-hint">
        文字用 canvas 渲染成透明图片再贴到每一页 —— 中文、标点、多行都能原样显示。
      </p>

      <SourcePicker value={source} onChange={setSource} disabled={task.busy} />

      <div className="sb-field">
        <div className="sb-field-text">
          <span className="sb-field-label">水印文字</span>
          <span className="sb-field-hint">支持换行（Enter），例如「内部资料\n禁止外传」</span>
        </div>
        <textarea
          className="sb-input tools-textarea"
          value={text}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          disabled={task.busy}
          aria-label="水印文字"
        />
      </div>

      <div className="sb-field">
        <div className="sb-field-text">
          <span className="sb-field-label">字号</span>
        </div>
        <div className="sb-field-control">
          <output className="sb-readout">{fontSize}px</output>
          <input
            type="range"
            className="sb-range"
            min={12}
            max={120}
            step={2}
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.target.value))}
            disabled={task.busy}
            aria-label="水印字号"
          />
        </div>
      </div>

      <div className="sb-field">
        <div className="sb-field-text">
          <span className="sb-field-label">颜色</span>
        </div>
        <div className="sb-field-control tools-inline">
          {WATERMARK_COLORS.map((value) => (
            <button
              key={value}
              type="button"
              className="tools-swatch"
              style={{ background: value }}
              aria-label={`水印颜色 ${value}`}
              aria-pressed={color === value}
              title={value}
              onClick={() => setColor(value)}
              disabled={task.busy}
            />
          ))}
          <input
            type="color"
            className="tools-color-input"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            aria-label="自定义水印颜色"
            disabled={task.busy}
          />
        </div>
      </div>

      <div className="sb-field">
        <div className="sb-field-text">
          <span className="sb-field-label">不透明度</span>
          <span className="sb-field-hint">建议 10%–25%：盖不住正文，又能看清</span>
        </div>
        <div className="sb-field-control">
          <output className="sb-readout">{Math.round(opacity * 100)}%</output>
          <input
            type="range"
            className="sb-range"
            min={3}
            max={80}
            step={1}
            value={Math.round(opacity * 100)}
            onChange={(e) => setOpacity(Number(e.target.value) / 100)}
            disabled={task.busy}
            aria-label="水印不透明度"
          />
        </div>
      </div>

      <div className="sb-field">
        <div className="sb-field-text">
          <span className="sb-field-label">旋转角度</span>
        </div>
        <div className="sb-field-control">
          <output className="sb-readout">{rotation}°</output>
          <input
            type="range"
            className="sb-range"
            min={-90}
            max={90}
            step={5}
            value={rotation}
            onChange={(e) => setRotation(Number(e.target.value))}
            disabled={task.busy}
            aria-label="水印旋转角度"
          />
        </div>
      </div>

      <div className="sb-field">
        <div className="sb-field-text">
          <span className="sb-field-label">排布</span>
        </div>
        <div className="sb-seg" role="group" aria-label="水印排布">
          <button
            type="button"
            className="sb-seg-btn"
            aria-pressed={position === 'center'}
            onClick={() => setPosition('center')}
            disabled={task.busy}
          >
            居中一个
          </button>
          <button
            type="button"
            className="sb-seg-btn"
            aria-pressed={position === 'tile'}
            onClick={() => setPosition('tile')}
            disabled={task.busy}
          >
            平铺满页
          </button>
        </div>
      </div>

      <div className="tools-actions">
        <button
          type="button"
          className="sb-btn sb-btn-primary"
          onClick={() => void start()}
          disabled={task.busy}
        >
          <Droplets size={15} />
          加水印并另存
        </button>
      </div>
    </section>
  )
}

/* ============================================================
 * 4. 压缩
 * ============================================================ */

function CompressTool({
  task,
  currentDoc,
  showToast
}: {
  task: TaskApi
  currentDoc: string
  showToast: (text: string, ms?: number) => void
}): JSX.Element {
  const [source, setSource] = useState(currentDoc)
  const [preset, setPreset] = useState<CompressPreset>('medium')

  useEffect(() => {
    setSource((prev) => prev || currentDoc)
  }, [currentDoc])

  const start = async (): Promise<void> => {
    if (!source) {
      task.setFeedback({ kind: 'error', text: '请先选择要压缩的 PDF' })
      return
    }
    const config = COMPRESS_PRESETS[preset]
    task.setFeedback(null)
    task.setBusy('正在渲染页面…')
    task.setProgress(0)
    let doc: Awaited<ReturnType<typeof openPdfForTools>> | null = null
    try {
      doc = await openPdfForTools(source)
      const pages = await renderPdfPages(doc, {
        dpi: config.dpi,
        format: 'jpeg',
        quality: config.quality,
        onProgress: (done, total) => task.setProgress(Math.round((done / total) * 90))
      })
      task.setBusy('正在写入压缩后的 PDF…')
      const result = await window.pdfApp.tools.compress({ sourcePath: source, pages })
      if (result.ok) {
        const info = describeInfo(result.info)
        task.setFeedback({
          kind: 'ok',
          text: `压缩完成${result.path ? `：${result.path}` : ''}${info ? ` · ${info}` : ''}`,
          path: result.path
        })
        showToast('压缩完成')
      } else if (result.canceled) {
        task.setFeedback({ kind: 'info', text: '已取消' })
      } else {
        task.setFeedback({ kind: 'error', text: result.error ?? '压缩失败' })
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
        <Minimize2 size={15} aria-hidden="true" />
        压缩 PDF
      </h3>
      <p className="tools-hint">
        把每页重新渲染成 JPEG 再组装成新 PDF —— 扫描件、图片型文档通常能小一大截。
        代价：页面变成图片，文字不再可选中/搜索；以文字、矢量为主的文档（如 Word 直接导出的 PDF）
        反而可能变大。需要保留文字层时请勿使用本功能。
      </p>

      <SourcePicker value={source} onChange={setSource} disabled={task.busy} />

      <div className="sb-field">
        <div className="sb-field-text">
          <span className="sb-field-label">压缩档位</span>
        </div>
        <div className="sb-seg" role="group" aria-label="压缩档位">
          {(Object.keys(COMPRESS_PRESETS) as CompressPreset[]).map((key) => (
            <button
              key={key}
              type="button"
              className="sb-seg-btn"
              aria-pressed={preset === key}
              title={COMPRESS_PRESETS[key].tip}
              onClick={() => setPreset(key)}
              disabled={task.busy}
            >
              {COMPRESS_PRESETS[key].label}
            </button>
          ))}
        </div>
      </div>

      <p className="tools-note">
        当前参数：{COMPRESS_PRESETS[preset].dpi} DPI · 质量{' '}
        {Math.round(COMPRESS_PRESETS[preset].quality * 100)}%
      </p>

      <div className="tools-actions">
        <button
          type="button"
          className="sb-btn sb-btn-primary"
          onClick={() => void start()}
          disabled={task.busy || !source}
        >
          <Minimize2 size={15} />
          开始压缩
        </button>
      </div>
    </section>
  )
}

/* ============================================================
 * 5. 加密 / 解密
 * ============================================================ */

function ProtectTool({ task, currentDoc }: { task: TaskApi; currentDoc: string }): JSX.Element {
  const [mode, setMode] = useState<'encrypt' | 'decrypt'>('encrypt')
  const [source, setSource] = useState(currentDoc)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [ownerPassword, setOwnerPassword] = useState('')
  const [allowPrint, setAllowPrint] = useState(true)
  const [allowCopy, setAllowCopy] = useState(true)
  const [allowModify, setAllowModify] = useState(false)

  useEffect(() => {
    setSource((prev) => prev || currentDoc)
  }, [currentDoc])

  const start = async (): Promise<void> => {
    if (mode === 'encrypt') {
      if (password.length < 4) {
        task.setFeedback({ kind: 'error', text: '打开密码至少 4 位' })
        return
      }
      if (password !== confirm) {
        task.setFeedback({ kind: 'error', text: '两次输入的密码不一致' })
        return
      }
    } else if (password.trim() === '') {
      task.setFeedback({ kind: 'error', text: '请输入文档当前的打开密码' })
      return
    }

    await runTask(
      task,
      mode === 'encrypt' ? '正在加密…' : '正在移除保护…',
      () =>
        mode === 'encrypt'
          ? window.pdfApp.tools.encrypt({
              sourcePath: source || undefined,
              userPassword: password,
              ownerPassword: ownerPassword || undefined,
              permissions: {
                printing: allowPrint,
                copying: allowCopy,
                modifying: allowModify
              }
            })
          : window.pdfApp.tools.decrypt({
              sourcePath: source || undefined,
              password
            }),
      mode === 'encrypt' ? '已加密并另存' : '已移除保护并另存'
    )
    setPassword('')
    setConfirm('')
    setOwnerPassword('')
  }

  return (
    <section className="sb-card">
      <h3 className="sb-card-title">
        <ShieldCheck size={15} aria-hidden="true" />
        加密 / 解密
      </h3>

      <div className="sb-seg tools-seg-wide" role="group" aria-label="保护方式">
        <button
          type="button"
          className="sb-seg-btn"
          aria-pressed={mode === 'encrypt'}
          onClick={() => setMode('encrypt')}
          disabled={task.busy}
        >
          <Lock size={14} />
          添加密码
        </button>
        <button
          type="button"
          className="sb-seg-btn"
          aria-pressed={mode === 'decrypt'}
          onClick={() => setMode('decrypt')}
          disabled={task.busy}
        >
          <ShieldOff size={14} />
          移除保护
        </button>
      </div>

      <SourcePicker value={source} onChange={setSource} disabled={task.busy} />

      <div className="sb-field">
        <div className="sb-field-text">
          <span className="sb-field-label">
            {mode === 'encrypt' ? '打开密码（至少 4 位）' : '当前打开密码'}
          </span>
        </div>
        <input
          type="password"
          className="sb-input"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={task.busy}
          autoComplete="new-password"
          aria-label={mode === 'encrypt' ? '打开密码' : '当前打开密码'}
        />
      </div>

      {mode === 'encrypt' ? (
        <>
          <div className="sb-field">
            <div className="sb-field-text">
              <span className="sb-field-label">再次输入密码</span>
            </div>
            <input
              type="password"
              className="sb-input"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={task.busy}
              autoComplete="new-password"
              aria-label="再次输入密码"
            />
          </div>

          <div className="sb-field">
            <div className="sb-field-text">
              <span className="sb-field-label">权限密码（可选）</span>
              <span className="sb-field-hint">不填则与打开密码相同</span>
            </div>
            <input
              type="password"
              className="sb-input"
              value={ownerPassword}
              onChange={(e) => setOwnerPassword(e.target.value)}
              disabled={task.busy}
              autoComplete="new-password"
              aria-label="权限密码"
            />
          </div>

          <div className="sb-field sb-field-inline">
            <div className="sb-field-text">
              <span className="sb-field-label">允许打印</span>
            </div>
            <Switch checked={allowPrint} onChange={setAllowPrint} label="允许打印" disabled={task.busy} />
          </div>
          <div className="sb-field sb-field-inline">
            <div className="sb-field-text">
              <span className="sb-field-label">允许复制文字</span>
            </div>
            <Switch checked={allowCopy} onChange={setAllowCopy} label="允许复制文字" disabled={task.busy} />
          </div>
          <div className="sb-field sb-field-inline">
            <div className="sb-field-text">
              <span className="sb-field-label">允许修改内容</span>
            </div>
            <Switch checked={allowModify} onChange={setAllowModify} label="允许修改内容" disabled={task.busy} />
          </div>
        </>
      ) : (
        <p className="tools-hint">
          移除保护会生成一份不带密码的新文件（页内容完整保留；书签与表单域不随复制）。
          请只对自己有权限的文档使用。
        </p>
      )}

      <div className="tools-actions">
        <button
          type="button"
          className="sb-btn sb-btn-primary"
          onClick={() => void start()}
          disabled={task.busy}
        >
          {mode === 'encrypt' ? <Lock size={15} /> : <ShieldOff size={15} />}
          {mode === 'encrypt' ? '加密并另存' : '移除保护并另存'}
        </button>
      </div>
    </section>
  )
}

/* ============================================================
 * 6. PDF ↔ 图片
 * ============================================================ */

function ConvertTool({
  task,
  currentDoc,
  showToast
}: {
  task: TaskApi
  currentDoc: string
  showToast: (text: string, ms?: number) => void
}): JSX.Element {
  const [direction, setDirection] = useState<'pdf2img' | 'img2pdf'>('pdf2img')
  const [source, setSource] = useState(currentDoc)
  const [format, setFormat] = useState<'png' | 'jpeg'>('png')
  const [dpi, setDpi] = useState(150)
  const [imgMode, setImgMode] = useState<'pages' | 'long'>('pages')
  const [images, setImages] = useState<string[]>([])
  const [pageSize, setPageSize] = useState<'fit' | 'a4' | 'a4-landscape'>('fit')

  useEffect(() => {
    setSource((prev) => prev || currentDoc)
  }, [currentDoc])

  const pickImages = async (): Promise<void> => {
    const picked = await window.pdfApp.tools.pickImages()
    if (picked.length === 0) return
    const merged = [...images]
    for (const file of picked) if (!merged.includes(file)) merged.push(file)
    setImages(merged)
  }

  /** PDF → 图片 */
  const exportImages = async (): Promise<void> => {
    if (!source) {
      task.setFeedback({ kind: 'error', text: '请先选择要转换的 PDF' })
      return
    }
    task.setFeedback(null)
    task.setBusy(imgMode === 'long' ? '正在拼接长图…' : '正在渲染页面…')
    task.setProgress(0)
    let doc: Awaited<ReturnType<typeof openPdfForTools>> | null = null
    try {
      doc = await openPdfForTools(source)
      const base = baseName(source)

      if (imgMode === 'long') {
        const chunks = await renderLongImages(doc, {
          quality: 0.82,
          onProgress: (done, total) => task.setProgress(Math.round((done / total) * 90))
        })
        task.setBusy('正在保存长图…')
        const single = chunks.length === 1
        const result = await window.pdfApp.tools.saveImages({
          singleFile: single,
          baseName: `${base}-长图`,
          images: chunks.map((chunk) => ({
            name: single ? `${base}-长图.jpg` : `${base}-长图-${chunk.index}.jpg`,
            mime: 'image/jpeg' as const,
            data: chunk.data
          }))
        })
        reportSave(result, single ? '长图已保存' : `长图已保存（共 ${chunks.length} 张）`)
        return
      }

      const pages = await renderPdfPages(doc, {
        dpi,
        format,
        quality: 0.9,
        onProgress: (done, total) => task.setProgress(Math.round((done / total) * 90))
      })
      const ext = format === 'png' ? 'png' : 'jpg'
      task.setBusy('正在保存图片…')
      const result = await window.pdfApp.tools.saveImages({
        singleFile: false,
        baseName: base,
        images: pages.map((page) => ({
          name: `${base}-第${page.page}页.${ext}`,
          mime: page.mime,
          data: page.data
        }))
      })
      reportSave(result, `已导出 ${pages.length} 张图片`)
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

  const reportSave = (
    result: { ok: boolean; canceled?: boolean; error?: string; path?: string; paths?: string[]; info?: Record<string, string | number> },
    success: string
  ): void => {
    if (result.ok) {
      const paths = result.paths ?? (result.path ? [result.path] : [])
      task.setFeedback({
        kind: 'ok',
        text: `${success}${paths.length > 1 ? `（${paths.length} 个文件）` : paths[0] ? `：${paths[0]}` : ''}`,
        path: paths[0]
      })
      showToast(success)
    } else if (result.canceled) {
      task.setFeedback({ kind: 'info', text: '已取消' })
    } else {
      task.setFeedback({ kind: 'error', text: result.error ?? '保存失败' })
    }
  }

  /** 图片 → PDF */
  const imagesToPdf = async (): Promise<void> => {
    if (images.length === 0) {
      task.setFeedback({ kind: 'error', text: '请先添加图片' })
      return
    }
    await runTask(
      task,
      '正在合成 PDF…',
      () => window.pdfApp.tools.imagesToPdf({ files: images, pageSize }),
      'PDF 合成完成'
    )
  }

  return (
    <section className="sb-card">
      <h3 className="sb-card-title">
        <FileImage size={15} aria-hidden="true" />
        PDF ↔ 图片
      </h3>

      <div className="sb-seg tools-seg-wide" role="group" aria-label="转换方向">
        <button
          type="button"
          className="sb-seg-btn"
          aria-pressed={direction === 'pdf2img'}
          onClick={() => setDirection('pdf2img')}
          disabled={task.busy}
        >
          PDF 转图片
        </button>
        <button
          type="button"
          className="sb-seg-btn"
          aria-pressed={direction === 'img2pdf'}
          onClick={() => setDirection('img2pdf')}
          disabled={task.busy}
        >
          图片转 PDF
        </button>
      </div>

      {direction === 'pdf2img' ? (
        <>
          <SourcePicker value={source} onChange={setSource} disabled={task.busy} />

          <div className="sb-field">
            <div className="sb-field-text">
              <span className="sb-field-label">输出形式</span>
            </div>
            <div className="sb-seg" role="group" aria-label="输出形式">
              <button
                type="button"
                className="sb-seg-btn"
                aria-pressed={imgMode === 'pages'}
                onClick={() => setImgMode('pages')}
                disabled={task.busy}
              >
                每页一张
              </button>
              <button
                type="button"
                className="sb-seg-btn"
                aria-pressed={imgMode === 'long'}
                onClick={() => setImgMode('long')}
                disabled={task.busy}
              >
                拼成一张长图
              </button>
            </div>
          </div>

          {imgMode === 'pages' ? (
            <>
              <div className="sb-field">
                <div className="sb-field-text">
                  <span className="sb-field-label">图片格式</span>
                </div>
                <div className="sb-seg" role="group" aria-label="图片格式">
                  <button
                    type="button"
                    className="sb-seg-btn"
                    aria-pressed={format === 'png'}
                    onClick={() => setFormat('png')}
                    disabled={task.busy}
                  >
                    PNG（无损）
                  </button>
                  <button
                    type="button"
                    className="sb-seg-btn"
                    aria-pressed={format === 'jpeg'}
                    onClick={() => setFormat('jpeg')}
                    disabled={task.busy}
                  >
                    JPEG（体积小）
                  </button>
                </div>
              </div>

              <div className="sb-field">
                <div className="sb-field-text">
                  <span className="sb-field-label">清晰度</span>
                  <span className="sb-field-hint">150 DPI 适合屏幕，300 DPI 适合打印</span>
                </div>
                <div className="sb-field-control">
                  <output className="sb-readout">{dpi} DPI</output>
                  <input
                    type="range"
                    className="sb-range"
                    min={72}
                    max={300}
                    step={6}
                    value={dpi}
                    onChange={(e) => setDpi(Number(e.target.value))}
                    disabled={task.busy}
                    aria-label="清晰度"
                  />
                </div>
              </div>
            </>
          ) : (
            <p className="tools-hint">
              所有页按统一宽度纵向拼成一张长图；太长时会自动切成多张（每段不超过约
              16000px），避免超出浏览器画布上限。
            </p>
          )}

          <div className="tools-actions">
            <button
              type="button"
              className="sb-btn sb-btn-primary"
              onClick={() => void exportImages()}
              disabled={task.busy || !source}
            >
              <FileImage size={15} />
              导出图片
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="sb-field tools-inline">
            <button type="button" className="sb-btn" onClick={() => void pickImages()} disabled={task.busy}>
              <FilePlus2 size={15} />
              添加图片
            </button>
            {images.length > 0 ? (
              <button type="button" className="sb-btn" onClick={() => setImages([])} disabled={task.busy}>
                <Trash2 size={15} />
                清空列表
              </button>
            ) : null}
          </div>

          <FileList files={images} onChange={setImages} disabled={task.busy} showOrder />

          <div className="sb-field">
            <div className="sb-field-text">
              <span className="sb-field-label">页面尺寸</span>
              <span className="sb-field-hint">「与图片同比例」最适合截图/照片；A4 会自动留白居中</span>
            </div>
            <div className="sb-seg" role="group" aria-label="页面尺寸">
              <button
                type="button"
                className="sb-seg-btn"
                aria-pressed={pageSize === 'fit'}
                onClick={() => setPageSize('fit')}
                disabled={task.busy}
              >
                同比例
              </button>
              <button
                type="button"
                className="sb-seg-btn"
                aria-pressed={pageSize === 'a4'}
                onClick={() => setPageSize('a4')}
                disabled={task.busy}
              >
                A4 纵
              </button>
              <button
                type="button"
                className="sb-seg-btn"
                aria-pressed={pageSize === 'a4-landscape'}
                onClick={() => setPageSize('a4-landscape')}
                disabled={task.busy}
              >
                A4 横
              </button>
            </div>
          </div>

          <div className="tools-actions">
            <button
              type="button"
              className="sb-btn sb-btn-primary"
              onClick={() => void imagesToPdf()}
              disabled={task.busy || images.length === 0}
            >
              <FileOutput size={15} />
              合成 PDF
            </button>
          </div>
        </>
      )}
    </section>
  )
}

/* ============================================================
 * 7. Office → PDF
 * ============================================================ */

function OfficeTool({ task }: { task: TaskApi }): JSX.Element {
  const [files, setFiles] = useState<string[]>([])
  const [converters, setConverters] = useState<OfficeConverterInfo[]>([])

  useEffect(() => {
    let alive = true
    void window.pdfApp.tools
      .converterInfo()
      .then((list) => {
        if (alive) setConverters(list)
      })
      .catch(() => {
        if (alive) setConverters([])
      })
    return () => {
      alive = false
    }
  }, [])

  const add = async (): Promise<void> => {
    const picked = await window.pdfApp.tools.pickOffice()
    if (picked.length === 0) return
    const merged = [...files]
    for (const file of picked) if (!merged.includes(file)) merged.push(file)
    setFiles(merged)
  }

  const start = async (): Promise<void> => {
    if (files.length === 0) {
      task.setFeedback({ kind: 'error', text: '请先添加 Word / Excel / PPT 文件' })
      return
    }
    await runTask(
      task,
      '正在调用本机 Office 转换…',
      () => window.pdfApp.tools.officeToPdf({ inputs: files }),
      'Office 转 PDF 完成'
    )
  }

  const labels = converters.map((c) => c.label).filter(Boolean)

  return (
    <section className="sb-card">
      <h3 className="sb-card-title">
        <FileOutput size={15} aria-hidden="true" />
        Office 文档转 PDF
      </h3>
      <p className="tools-hint">
        支持 Word / Excel / PowerPoint（doc、docx、rtf、xls、xlsx、csv、ppt、pptx 等）。
        转换使用本机已安装的 Office 软件，文件不会上传到任何服务器。
      </p>

      <p className="tools-note">
        将按顺序尝试本机已安装的转换器（无需联网）：
        {labels.length > 0 ? labels.join(' · ') : '检测中…'}
      </p>

      <div className="sb-field tools-inline">
        <button type="button" className="sb-btn" onClick={() => void add()} disabled={task.busy}>
          <FilePlus2 size={15} />
          添加 Office 文件
        </button>
        {files.length > 0 ? (
          <button type="button" className="sb-btn" onClick={() => setFiles([])} disabled={task.busy}>
            <Trash2 size={15} />
            清空列表
          </button>
        ) : null}
      </div>

      <FileList files={files} onChange={setFiles} disabled={task.busy} />

      <div className="tools-actions">
        <button
          type="button"
          className="sb-btn sb-btn-primary"
          onClick={() => void start()}
          disabled={task.busy || files.length === 0}
        >
          <FileOutput size={15} />
          转换为 PDF
        </button>
        <span className="tools-note">PDF 与源文件保存在同一目录</span>
      </div>
    </section>
  )
}
