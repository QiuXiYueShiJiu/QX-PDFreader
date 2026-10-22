// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 文档比较 + 批量处理两个分区。
 *
 * 比较：逐页提字 → 行级 LCS 差异 → 汇总/报告（纯渲染层，不需要主进程）。
 * 批量：
 *   页眉页脚 / 贝茨 / 加密 → 一次 IPC（adv:batch）由主进程逐份处理；
 *   水印 / 压缩 → 需要渲染层画图/光栅化，界面层循环调用单文件接口。
 */

import { useEffect, useState } from 'react'
import { FilePlus2, FolderOpen, GitCompare, Layers, Trash2 } from 'lucide-react'
import {
  extractTextPages,
  openPdfForTools,
  renderPdfPages,
  renderWatermarkImage
} from '../../pdf-tools'
import {
  buildCompareHtmlReport,
  buildCompareTextReport,
  comparePageTexts,
  composeSideBySidePage,
  type CompareSummary
} from '../../pdf-compare'
import { batchPdfToImages } from '../../batch-images'
import { baseName, describeInfo, fileName, SourcePicker, Switch, type TaskApi } from './shared'

/* ============================================================
 * 1. 文档比较
 * ============================================================ */

export function CompareSection({
  task,
  currentDoc
}: {
  task: TaskApi
  currentDoc: string
}): JSX.Element {
  const [sourceA, setSourceA] = useState(currentDoc)
  const [sourceB, setSourceB] = useState('')
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(true)
  const [ignoreCase, setIgnoreCase] = useState(false)
  const [summary, setSummary] = useState<CompareSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    setSourceA((prev) => prev || currentDoc)
  }, [currentDoc])

  const pickB = async (): Promise<void> => {
    const picked = await window.pdfApp.tools.pickPdfs()
    if (picked.length > 0) setSourceB(picked[0])
  }

  const start = async (): Promise<void> => {
    if (!sourceA || !sourceB) {
      task.setFeedback({ kind: 'error', text: '请分别选择文档 A 与文档 B' })
      return
    }
    setRunning(true)
    setError(null)
    setSummary(null)
    task.setFeedback(null)
    task.setBusy('正在提取文字…')
    task.setProgress(0)
    let docA = null
    let docB = null
    try {
      docA = await openPdfForTools(sourceA)
      const pagesA = await extractTextPages(docA, (done, total) =>
        task.setProgress(Math.round((done / total) * 40))
      )
      task.setBusy('正在提取文档 B…')
      docB = await openPdfForTools(sourceB)
      const pagesB = await extractTextPages(docB, (done, total) =>
        task.setProgress(40 + Math.round((done / total) * 40))
      )
      task.setBusy('正在比对…')
      task.setProgress(85)
      const result = comparePageTexts(pagesA, pagesB, { ignoreWhitespace, ignoreCase })
      setSummary(result)
      task.setProgress(100)
      task.setFeedback({
        kind: 'ok',
        text: `比较完成：${result.changedPages} 页有差异（新增 ${result.totalAdded} 行 / 删除 ${result.totalRemoved} 行）`
      })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      task.setFeedback({ kind: 'error', text: message })
    } finally {
      if (docA) void docA.destroy()
      if (docB) void docB.destroy()
      task.setBusy(null)
      setRunning(false)
    }
  }

  const exportReport = async (format: 'txt' | 'html'): Promise<void> => {
    if (!summary) return
    const base = baseName(sourceA || '比较结果')
    const nameA = fileName(sourceA)
    const nameB = fileName(sourceB)
    if (format === 'txt') {
      const text = buildCompareTextReport(summary, nameA, nameB)
      const result = await window.pdfApp.advanced.saveBinary({
        defaultName: `${base}-比较报告.txt`,
        ext: 'txt',
        data: new TextEncoder().encode(text).buffer
      })
      reportFeedback(result, '报告已保存')
    } else {
      const html = buildCompareHtmlReport(summary, nameA, nameB)
      const result = await window.pdfApp.advanced.saveBinary({
        defaultName: `${base}-比较报告.html`,
        ext: 'html',
        data: new TextEncoder().encode(html).buffer
      })
      reportFeedback(result, '报告已保存')
    }
  }

  const reportFeedback = (
    result: { ok: boolean; canceled?: boolean; error?: string; path?: string },
    success: string
  ): void => {
    if (result.ok) {
      task.setFeedback({ kind: 'ok', text: `${success}${result.path ? `：${result.path}` : ''}`, path: result.path })
    } else if (result.canceled) {
      task.setFeedback({ kind: 'info', text: '已取消' })
    } else {
      task.setFeedback({ kind: 'error', text: result.error ?? '保存失败' })
    }
  }

  /** 把有差异的页做成「A/B 并排」图片页，再组装成对照 PDF */
  const exportComparePdf = async (): Promise<void> => {
    if (!summary || !sourceA || !sourceB) return
    const changed = summary.pages.filter((page) => page.changed)
    if (changed.length === 0) {
      task.setFeedback({ kind: 'info', text: '两份文档内容一致，没有需要对照的页面' })
      return
    }
    setExporting(true)
    task.setFeedback(null)
    task.setBusy('正在生成并排对照页…')
    task.setProgress(0)
    let docA = null
    let docB = null
    try {
      docA = await openPdfForTools(sourceA)
      docB = await openPdfForTools(sourceB)
      const images = []
      for (let index = 0; index < changed.length; index += 1) {
        const page = changed[index]
        const image = await composeSideBySidePage(
          docA,
          docB,
          page.page,
          { added: page.added.length, removed: page.removed.length },
          { a: fileName(sourceA), b: fileName(sourceB) }
        )
        images.push(image)
        task.setProgress(Math.round(((index + 1) / changed.length) * 80))
      }
      task.setBusy('正在写入对照 PDF…')
      const result = await window.pdfApp.advanced.comparePdf({
        sourcePath: sourceA,
        defaultName: `${baseName(sourceA)}-对照.pdf`,
        pages: images.map((image) => ({
          data: image.data,
          width: image.width,
          height: image.height
        }))
      })
      reportFeedback(result, `对照 PDF 已生成（${images.length} 页）`)
    } catch (cause) {
      task.setFeedback({
        kind: 'error',
        text: cause instanceof Error ? cause.message : String(cause)
      })
    } finally {
      if (docA) void docA.destroy()
      if (docB) void docB.destroy()
      task.setBusy(null)
      setExporting(false)
    }
  }

  const changedPages = summary?.pages.filter((page) => page.changed) ?? []

  return (
    <section className="sb-card">
      <h3 className="sb-card-title">
        <GitCompare size={15} aria-hidden="true" />
        文档比较
      </h3>
      <p className="tools-hint">
        逐页提取两份 PDF 的文字，按行计算新增/删除；结果可导出为文本或网页报告。
        扫描件没有文字层，请先对两份文档做 OCR 再比较。
      </p>

      <SourcePicker value={sourceA} onChange={setSourceA} label="文档 A" disabled={running} />

      <div className="sb-field">
        <div className="sb-field-text">
          <span className="sb-field-label">文档 B</span>
          <span className="sb-field-hint" title={sourceB || undefined}>
            {sourceB ? fileName(sourceB) : '尚未选择'}
          </span>
        </div>
        <div className="sb-field-control tools-inline">
          <button type="button" className="sb-btn" onClick={() => void pickB()} disabled={running}>
            <FilePlus2 size={15} />
            选择文档 B
          </button>
        </div>
      </div>

      <div className="sb-field sb-field-inline">
        <div className="sb-field-text">
          <span className="sb-field-label">忽略空白差异</span>
          <span className="sb-field-hint">行首尾与行内连续空白不参与比较</span>
        </div>
        <Switch
          checked={ignoreWhitespace}
          onChange={setIgnoreWhitespace}
          label="忽略空白差异"
          disabled={running}
        />
      </div>

      <div className="sb-field sb-field-inline">
        <div className="sb-field-text">
          <span className="sb-field-label">忽略大小写</span>
        </div>
        <Switch checked={ignoreCase} onChange={setIgnoreCase} label="忽略大小写" disabled={running} />
      </div>

      {error ? <p className="tools-error-text">{error}</p> : null}

      {summary ? (
        <>
          <p className="tools-note">
            文档 A：{summary.pagesA} 页 · 文档 B：{summary.pagesB} 页 · 有差异 {summary.changedPages} 页 ·
            相同 {summary.identicalPages} 页 · 新增 {summary.totalAdded} 行 / 删除 {summary.totalRemoved} 行
          </p>
          {changedPages.length > 0 ? (
            <ul className="compare-list">
              {changedPages.map((page) => (
                <li key={page.page} className="compare-list__item">
                  <span className="compare-list__page">第 {page.page} 页</span>
                  <span className="compare-list__stat">
                    +{page.added.length} / -{page.removed.length}
                  </span>
                  <span className="compare-list__sample" title={[...page.removed, ...page.added].join('\n')}>
                    {[...page.removed.slice(0, 1), ...page.added.slice(0, 1)].join(' / ') || '（空白行变化）'}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="tools-empty">两份文档内容一致。</p>
          )}
          <div className="tools-actions">
            <button type="button" className="sb-btn" onClick={() => void exportReport('txt')}>
              导出文本报告
            </button>
            <button type="button" className="sb-btn" onClick={() => void exportReport('html')}>
              导出网页报告
            </button>
            <button
              type="button"
              className="sb-btn sb-btn-primary"
              onClick={() => void exportComparePdf()}
              disabled={running || exporting || changedPages.length === 0}
              title="把有差异的页做成左右并排的对照 PDF"
            >
              导出并排对照 PDF
            </button>
          </div>
        </>
      ) : null}

      <div className="tools-actions">
        <button
          type="button"
          className="sb-btn sb-btn-primary"
          onClick={() => void start()}
          disabled={running || !sourceA || !sourceB}
        >
          <GitCompare size={15} />
          {running ? '比较中…' : '开始比较'}
        </button>
      </div>
    </section>
  )
}

/* ============================================================
 * 2. 批量处理
 * ============================================================ */

type BatchOp = 'headerfooter' | 'bates' | 'encrypt' | 'watermark' | 'compress' | 'pdf2img'

const BATCH_OPERATIONS: Array<{ value: BatchOp; label: string; tip: string }> = [
  { value: 'headerfooter', label: '页眉页脚 / 页码', tip: '每份都加同一套页脚（可含 {page}/{total}）' },
  { value: 'bates', label: '贝茨编号', tip: '每份从相同起始号开始编号' },
  { value: 'encrypt', label: '加密', tip: '每份都用同一密码加密' },
  { value: 'watermark', label: '水印', tip: '每份都盖同一个中文水印' },
  { value: 'compress', label: '压缩', tip: '每份都按同一档位重新光栅化压缩' },
  { value: 'pdf2img', label: '导出图片', tip: '每份 PDF 逐页导出为 PNG / JPEG（各自一个子文件夹）' }
]

const COMPRESS_PRESETS = {
  high: { label: '高质量', dpi: 150, quality: 0.86 },
  medium: { label: '均衡', dpi: 110, quality: 0.72 },
  small: { label: '最小体积', dpi: 80, quality: 0.55 }
} as const

type CompressPreset = keyof typeof COMPRESS_PRESETS

export function BatchSection({ task }: { task: TaskApi }): JSX.Element {
  const [files, setFiles] = useState<string[]>([])
  const [operation, setOperation] = useState<BatchOp>('headerfooter')
  const [outputDir, setOutputDir] = useState('')

  const [footerCenter, setFooterCenter] = useState('第 {page} 页 / 共 {total} 页')
  const [headerRight, setHeaderRight] = useState('')
  const [fontSize, setFontSize] = useState(9)

  const [batesPrefix, setBatesPrefix] = useState('DOC-')
  const [batesStart, setBatesStart] = useState(1)
  const [batesDigits, setBatesDigits] = useState(6)

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')

  const [watermarkText, setWatermarkText] = useState('内部资料')
  const [watermarkColor, setWatermarkColor] = useState('#c62828')
  const [watermarkOpacity, setWatermarkOpacity] = useState(0.16)
  const [watermarkRotation, setWatermarkRotation] = useState(30)
  const [watermarkPosition, setWatermarkPosition] = useState<'center' | 'tile'>('center')

  const [compressPreset, setCompressPreset] = useState<CompressPreset>('medium')
  const [imageFormat, setImageFormat] = useState<'png' | 'jpeg'>('png')
  const [imageDpi, setImageDpi] = useState(150)

  const addFiles = async (): Promise<void> => {
    const picked = await window.pdfApp.tools.pickPdfs()
    if (picked.length === 0) return
    const merged = [...files]
    for (const file of picked) if (!merged.includes(file)) merged.push(file)
    setFiles(merged)
  }

  const pickFolder = async (): Promise<void> => {
    const dir = await window.pdfApp.tools.pickFolder()
    if (dir) setOutputDir(dir)
  }

  const outPath = (file: string, suffix: string): string => {
    const base = baseName(file)
    const dir = outputDir || file.replace(/[\\/][^\\/]+$/, '')
    return `${dir}\\${base}${suffix}.pdf`
  }

  const start = async (): Promise<void> => {
    if (files.length === 0) {
      task.setFeedback({ kind: 'error', text: '请先添加要处理的 PDF' })
      return
    }
    if (operation === 'encrypt') {
      if (password.length < 4) {
        task.setFeedback({ kind: 'error', text: '打开密码至少 4 位' })
        return
      }
      if (password !== confirm) {
        task.setFeedback({ kind: 'error', text: '两次输入的密码不一致' })
        return
      }
    }

    task.setFeedback(null)
    task.setBusy('正在批量处理…')
    task.setProgress(0)

    try {
      if (operation === 'pdf2img') {
        const outcome = await batchPdfToImages(
          files,
          { dpi: imageDpi, format: imageFormat, outputRoot: outputDir || undefined },
          (done, total, file) => {
            task.setProgress(Math.round((done / total) * 100))
            task.setBusy(`正在导出图片（${done}/${total}）：${fileName(file)}`)
          }
        )
        task.setFeedback({
          kind: outcome.written.length > 0 ? 'ok' : 'error',
          text:
            outcome.written.length > 0
              ? `批量导图完成：${outcome.documents} 份文档 / ${outcome.images} 张图片${outcome.failed.length ? `；失败 ${outcome.failed.length} 份（${outcome.failed.join('；')}）` : ''}`
              : `全部失败：${outcome.failed.join('；') || '未知错误'}`,
          path: outcome.written[0]
        })
        return
      }

      if (operation === 'headerfooter' || operation === 'bates' || operation === 'encrypt') {
        const result = await window.pdfApp.advanced.batch({
          operation,
          files,
          outputDir: outputDir || undefined,
          headerFooter:
            operation === 'headerfooter'
              ? {
                  header: { right: headerRight || undefined },
                  footer: { center: footerCenter || undefined },
                  fontSize
                }
              : undefined,
          bates:
            operation === 'bates'
              ? {
                  prefix: batesPrefix,
                  start: batesStart,
                  digits: batesDigits,
                  fontSize
                }
              : undefined,
          encrypt:
            operation === 'encrypt'
              ? {
                  userPassword: password,
                  permissions: { printing: true, copying: true, modifying: false }
                }
              : undefined
        })
        if (result.ok) {
          task.setFeedback({
            kind: 'ok',
            text: `批量${BATCH_OPERATIONS.find((op) => op.value === operation)?.label}完成${result.info ? ` · ${describeInfo(result.info)}` : ''}${result.error ? `；${result.error}` : ''}`,
            path: result.paths?.[0]
          })
        } else {
          task.setFeedback({ kind: 'error', text: result.error ?? '批量处理失败' })
        }
        return
      }

      /* 水印 / 压缩：渲染层逐份处理 */
      const config = COMPRESS_PRESETS[compressPreset]
      const image =
        operation === 'watermark'
          ? renderWatermarkImage({
              text: watermarkText || '内部资料',
              color: watermarkColor,
              fontSize: 48
            })
          : null

      const written: string[] = []
      const failed: string[] = []
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index]
        task.setProgress(Math.round((index / files.length) * 100))
        task.setBusy(`${operation === 'watermark' ? '正在加水印' : '正在压缩'}（${index + 1}/${files.length}）：${fileName(file)}`)
        try {
          if (operation === 'watermark' && image) {
            const suffix = '-水印'
            const result = await window.pdfApp.tools.watermark({
              sourcePath: file,
              targetPath: outPath(file, suffix),
              image,
              opacity: watermarkOpacity,
              rotation: watermarkRotation,
              position: watermarkPosition
            })
            if (result.ok && result.path) written.push(result.path)
            else failed.push(`${fileName(file)}：${result.error ?? '失败'}`)
          } else if (operation === 'compress') {
            const doc = await openPdfForTools(file)
            try {
              const pages = await renderPdfPages(doc, {
                dpi: config.dpi,
                format: 'jpeg',
                quality: config.quality
              })
              const result = await window.pdfApp.tools.compress({
                sourcePath: file,
                targetPath: outPath(file, '-压缩'),
                pages
              })
              if (result.ok && result.path) written.push(result.path)
              else failed.push(`${fileName(file)}：${result.error ?? '失败'}`)
            } finally {
              void doc.destroy()
            }
          }
        } catch (cause) {
          failed.push(`${fileName(file)}：${cause instanceof Error ? cause.message : String(cause)}`)
        }
      }
      task.setProgress(100)
      task.setFeedback({
        kind: written.length > 0 ? 'ok' : 'error',
        text: written.length > 0
          ? `批量处理完成：成功 ${written.length} 份${failed.length ? `，失败 ${failed.length} 份（${failed.join('；')}）` : ''}`
          : `全部失败：${failed.join('；')}`,
        path: written[0]
      })
    } catch (cause) {
      task.setFeedback({
        kind: 'error',
        text: cause instanceof Error ? cause.message : String(cause)
      })
    } finally {
      task.setBusy(null)
    }
  }

  return (
    <section className="sb-card">
      <h3 className="sb-card-title">
        <Layers size={15} aria-hidden="true" />
        批量处理
      </h3>
      <p className="tools-hint">
        一次对多份 PDF 套用同一操作：页眉页脚/页码、贝茨编号、加密、水印、压缩、逐页导出图片。
        结果默认写在源文件同目录（可另选输出文件夹），源文件不改动。
      </p>

      <div className="sb-field tools-inline">
        <button type="button" className="sb-btn" onClick={() => void addFiles()} disabled={task.busy}>
          <FilePlus2 size={15} />
          添加 PDF
        </button>
        {files.length > 0 ? (
          <button type="button" className="sb-btn" onClick={() => setFiles([])} disabled={task.busy}>
            <Trash2 size={15} />
            清空
          </button>
        ) : null}
        <button type="button" className="sb-btn" onClick={() => void pickFolder()} disabled={task.busy}>
          <FolderOpen size={15} />
          {outputDir ? '更改输出文件夹' : '输出文件夹（可选）'}
        </button>
      </div>
      <p className="tools-note" title={outputDir || undefined}>
        {files.length} 份 · 输出：{outputDir || '与源文件同目录'}
      </p>

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

      <div className="sb-field">
        <div className="sb-field-text">
          <span className="sb-field-label">操作</span>
        </div>
        <select
          className="sb-input"
          value={operation}
          onChange={(event) => setOperation(event.target.value as BatchOp)}
          disabled={task.busy}
          aria-label="批量操作"
        >
          {BATCH_OPERATIONS.map((op) => (
            <option key={op.value} value={op.value} title={op.tip}>
              {op.label}
            </option>
          ))}
        </select>
      </div>

      {operation === 'headerfooter' ? (
        <>
          <div className="sb-field">
            <div className="sb-field-text">
              <span className="sb-field-label">页脚居中</span>
              <span className="sb-field-hint">支持 {'{page}'} / {'{total}'} / {'{date}'} / {'{title}'}</span>
            </div>
            <input
              className="sb-input"
              value={footerCenter}
              onChange={(event) => setFooterCenter(event.target.value)}
              disabled={task.busy}
              aria-label="页脚居中"
            />
          </div>
          <div className="sb-field">
            <div className="sb-field-text">
              <span className="sb-field-label">页眉右侧</span>
              <span className="sb-field-hint">留空则不加页眉</span>
            </div>
            <input
              className="sb-input"
              value={headerRight}
              onChange={(event) => setHeaderRight(event.target.value)}
              disabled={task.busy}
              aria-label="页眉右侧"
            />
          </div>
        </>
      ) : null}

      {operation === 'bates' ? (
        <>
          <div className="sb-field">
            <div className="sb-field-text">
              <span className="sb-field-label">前缀</span>
            </div>
            <input
              className="sb-input"
              value={batesPrefix}
              onChange={(event) => setBatesPrefix(event.target.value)}
              disabled={task.busy}
              aria-label="贝茨前缀"
            />
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
                value={batesStart}
                onChange={(event) => setBatesStart(Number(event.target.value) || 1)}
                disabled={task.busy}
                aria-label="起始编号"
              />
              <input
                className="sb-input tools-num"
                type="number"
                min={1}
                max={12}
                value={batesDigits}
                onChange={(event) => setBatesDigits(Number(event.target.value) || 6)}
                disabled={task.busy}
                aria-label="补零位数"
              />
            </div>
          </div>
        </>
      ) : null}

      {operation === 'encrypt' ? (
        <>
          <div className="sb-field">
            <div className="sb-field-text">
              <span className="sb-field-label">打开密码（至少 4 位）</span>
            </div>
            <input
              type="password"
              className="sb-input"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={task.busy}
              autoComplete="new-password"
              aria-label="打开密码"
            />
          </div>
          <div className="sb-field">
            <div className="sb-field-text">
              <span className="sb-field-label">再次输入密码</span>
            </div>
            <input
              type="password"
              className="sb-input"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              disabled={task.busy}
              autoComplete="new-password"
              aria-label="再次输入密码"
            />
          </div>
        </>
      ) : null}

      {operation === 'watermark' ? (
        <>
          <div className="sb-field">
            <div className="sb-field-text">
              <span className="sb-field-label">水印文字</span>
            </div>
            <input
              className="sb-input"
              value={watermarkText}
              onChange={(event) => setWatermarkText(event.target.value)}
              disabled={task.busy}
              aria-label="水印文字"
            />
          </div>
          <div className="sb-field">
            <div className="sb-field-text">
              <span className="sb-field-label">颜色 / 透明度 / 角度</span>
            </div>
            <div className="sb-field-control tools-inline">
              <input
                className="tools-color-input"
                type="color"
                value={watermarkColor}
                onChange={(event) => setWatermarkColor(event.target.value)}
                disabled={task.busy}
                aria-label="水印颜色"
              />
              <input
                className="sb-input tools-num"
                type="number"
                min={3}
                max={80}
                value={Math.round(watermarkOpacity * 100)}
                onChange={(event) => setWatermarkOpacity(Math.max(0.03, Number(event.target.value) / 100))}
                disabled={task.busy}
                aria-label="不透明度百分比"
              />
              <span className="tools-note">%</span>
              <input
                className="sb-input tools-num"
                type="number"
                min={-90}
                max={90}
                step={5}
                value={watermarkRotation}
                onChange={(event) => setWatermarkRotation(Number(event.target.value) || 0)}
                disabled={task.busy}
                aria-label="旋转角度"
              />
              <span className="tools-note">°</span>
            </div>
          </div>
          <div className="sb-field">
            <div className="sb-field-text">
              <span className="sb-field-label">排布</span>
            </div>
            <select
              className="sb-input"
              value={watermarkPosition}
              onChange={(event) => setWatermarkPosition(event.target.value as 'center' | 'tile')}
              disabled={task.busy}
              aria-label="水印排布"
            >
              <option value="center">居中一个</option>
              <option value="tile">平铺满页</option>
            </select>
          </div>
        </>
      ) : null}

      {operation === 'compress' ? (
        <div className="sb-field">
          <div className="sb-field-text">
            <span className="sb-field-label">压缩档位</span>
          </div>
          <select
            className="sb-input"
            value={compressPreset}
            onChange={(event) => setCompressPreset(event.target.value as CompressPreset)}
            disabled={task.busy}
            aria-label="压缩档位"
          >
            {(Object.keys(COMPRESS_PRESETS) as CompressPreset[]).map((key) => (
              <option key={key} value={key}>
                {COMPRESS_PRESETS[key].label}（{COMPRESS_PRESETS[key].dpi} DPI）
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {operation === 'pdf2img' ? (
        <>
          <div className="sb-field">
            <div className="sb-field-text">
              <span className="sb-field-label">图片格式</span>
            </div>
            <select
              className="sb-input"
              value={imageFormat}
              onChange={(event) => setImageFormat(event.target.value as 'png' | 'jpeg')}
              disabled={task.busy}
              aria-label="图片格式"
            >
              <option value="png">PNG（无损）</option>
              <option value="jpeg">JPEG（体积小）</option>
            </select>
          </div>
          <div className="sb-field">
            <div className="sb-field-text">
              <span className="sb-field-label">清晰度</span>
              <span className="sb-field-hint">150 DPI 适合屏幕，300 DPI 适合打印</span>
            </div>
            <div className="sb-field-control">
              <input
                className="sb-input tools-num"
                type="number"
                min={72}
                max={300}
                step={6}
                value={imageDpi}
                onChange={(event) => setImageDpi(Math.min(300, Math.max(72, Number(event.target.value) || 150)))}
                disabled={task.busy}
                aria-label="清晰度"
              />
              <span className="tools-note">DPI</span>
            </div>
          </div>
          <p className="tools-note">
            每份 PDF 会导出到独立子文件夹（{outputDir ? `${outputDir}\\<文件名>` : '<源目录>\\<文件名>-图片'}），避免同名覆盖。
          </p>
        </>
      ) : null}

      {operation === 'headerfooter' || operation === 'bates' ? (
        <div className="sb-field">
          <div className="sb-field-text">
            <span className="sb-field-label">字号</span>
          </div>
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
        </div>
      ) : null}

      <div className="tools-actions">
        <button
          type="button"
          className="sb-btn sb-btn-primary"
          onClick={() => void start()}
          disabled={task.busy || files.length === 0}
        >
          <Layers size={15} />
          开始批量处理
        </button>
      </div>
    </section>
  )
}

