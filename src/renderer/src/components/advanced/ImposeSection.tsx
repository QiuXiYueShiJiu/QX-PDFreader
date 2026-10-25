import { useState } from 'react'
import { PDFDocument as PDFLib } from 'pdf-lib'
import { openPdfForTools, renderPdfPages } from '../../pdf-tools'
import type { TaskApi } from './shared'

/**
 * 拼版（N-up）：把多页 PDF 按 2/4/6/9 页拼到一张 A4 上。
 *
 * 教室场景里最实用的一档——两面印、四页拼一张，试卷和讲义能省一半纸。
 * 页序按「先行后列」铺，缩放默认「适应格子」（不变形、留白居中），
 * 也可以选「填满格子」（裁边填满，适合满版图片）。
 */

const SHEETS = [
  { id: '2', cols: 1, rows: 2, label: '2 页 / 张', tip: '纵向对开，最常见的双面拼版' },
  { id: '4', cols: 2, rows: 2, label: '4 页 / 张', tip: '试卷讲义最省纸的一档' },
  { id: '6', cols: 2, rows: 3, label: '6 页 / 张', tip: '小册子 / 提纲' },
  { id: '9', cols: 3, rows: 3, label: '9 页 / 张', tip: '缩印速查表，字会比较小' }
] as const

const A4_W = 595.28
const A4_H = 841.89
const mmToPt = (mm: number): number => (mm * 72) / 25.4

interface SheetSpec {
  cols: number
  rows: number
  label: string
}

const specOf = (id: string): SheetSpec => {
  const found = SHEETS.find((item) => item.id === id) ?? SHEETS[1]
  return { cols: found.cols, rows: found.rows, label: found.label }
}

export function ImposeSection({ task, currentDoc }: { task: TaskApi; currentDoc: string }): JSX.Element {
  const [source] = useState(currentDoc)
  const [sheet, setSheet] = useState<string>('4')
  const [gap, setGap] = useState(4)
  const [margin, setMargin] = useState(6)
  const [fill, setFill] = useState(false)
  const [cutLine, setCutLine] = useState(true)
  const [dpi, setDpi] = useState(150)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (): Promise<void> => {
    if (!source) {
      setError('先在主界面打开一份 PDF，再来这里拼版')
      return
    }
    const { cols, rows } = specOf(sheet)
    setError(null)
    setMessage(null)
    task.setBusy('正在拼版…')
    task.setProgress(0)
    try {
      const doc = await openPdfForTools(source)
      const pages = await renderPdfPages(doc, {
        dpi,
        format: 'jpeg',
        quality: 0.86,
        onProgress: (done, total) => task.setProgress(total > 0 ? done / total : 0)
      })

      const marginPt = mmToPt(margin)
      const gapPt = mmToPt(gap)
      const cellW = (A4_W - marginPt * 2 - gapPt * (cols - 1)) / cols
      const cellH = (A4_H - marginPt * 2 - gapPt * (rows - 1)) / rows
      const pxPerPt = dpi / 72
      const canvasW = Math.round(A4_W * pxPerPt)
      const canvasH = Math.round(A4_H * pxPerPt)

      const out = await PDFLib.create()
      const perSheet = cols * rows
      const sheetCount = Math.ceil(pages.length / perSheet)

      for (let start = 0; start < pages.length; start += perSheet) {
        const slice = pages.slice(start, start + perSheet)
        const canvas = document.createElement('canvas')
        canvas.width = canvasW
        canvas.height = canvasH
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('当前环境不支持 Canvas 2D')

        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvasW, canvasH)

        for (let i = 0; i < slice.length; i += 1) {
          const col = i % cols
          const row = Math.floor(i / cols)
          const cw = cellW * pxPerPt
          const ch = cellH * pxPerPt
          const cx = marginPt * pxPerPt + col * (cw + gapPt * pxPerPt)
          const cy = marginPt * pxPerPt + row * (ch + gapPt * pxPerPt)

          const page = slice[i]
          const bitmap = await createImageBitmap(new Blob([page.data], { type: page.mime }))
          const ratio = fill
            ? Math.max(cw / bitmap.width, ch / bitmap.height)
            : Math.min(cw / bitmap.width, ch / bitmap.height)
          const drawW = bitmap.width * ratio
          const drawH = bitmap.height * ratio
          ctx.drawImage(bitmap, cx + (cw - drawW) / 2, cy + (ch - drawH) / 2, drawW, drawH)
          bitmap.close()
        }

        if (cutLine) {
          ctx.save()
          ctx.strokeStyle = 'rgba(120, 120, 120, 0.55)'
          ctx.lineWidth = Math.max(1, Math.round(pxPerPt * 0.5))
          ctx.setLineDash([8, 6])
          for (let c = 1; c < cols; c += 1) {
            const x = marginPt * pxPerPt + c * (cellW * pxPerPt + gapPt * pxPerPt) - (gapPt * pxPerPt) / 2
            ctx.beginPath()
            ctx.moveTo(x, 0)
            ctx.lineTo(x, canvasH)
            ctx.stroke()
          }
          for (let r = 1; r < rows; r += 1) {
            const y = marginPt * pxPerPt + r * (cellH * pxPerPt + gapPt * pxPerPt) - (gapPt * pxPerPt) / 2
            ctx.beginPath()
            ctx.moveTo(0, y)
            ctx.lineTo(canvasW, y)
            ctx.stroke()
          }
          ctx.restore()
        }

        const dataUrl = canvas.toDataURL('image/jpeg', 0.9)
        const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
        const binary = atob(base64)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)

        const page = out.addPage([A4_W, A4_H])
        const image = await out.embedJpg(bytes)
        page.drawImage(image, { x: 0, y: 0, width: A4_W, height: A4_H })
        task.setProgress(Math.min(1, (start + slice.length) / pages.length))
      }

      const data = await out.save()
      const base = source.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
      // 测试钩子：verify-impose 会先把目标路径塞进 window.__imposeTarget，
      // 走主进程的 targetPath 分支直接落盘，避免在隐藏窗口里弹原生保存框。
      const forced = (window as unknown as { __imposeTarget?: string }).__imposeTarget
      const result = await window.pdfApp.advanced.saveBinary({
        defaultName: `${base}-拼版${cols}x${rows}.pdf`,
        ext: 'pdf',
        targetPath: forced || undefined,
        data: data.buffer as ArrayBuffer
      })
      if (result && result.ok === false) {
        setError(result.error ?? '保存失败')
      } else {
        setMessage(
          `已生成 ${sheetCount} 张拼版（每张 ${perSheet} 页，共 ${pages.length} 页）${result?.path ? `：${result.path}` : ''}`
        )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      task.setBusy(null)
      task.setProgress(null)
    }
  }

  const spec = specOf(sheet)

  return (
    <section className="sb-card">
      <h3 className="sb-card-title">拼版印刷</h3>
      <p className="tools-hint">
        把多页 PDF 拼到一张 A4 上，两面印、四页拼一张，一学期能省下不少纸。页序按先行后列铺，
        被缩小的页面默认保持比例居中，不会拉变形。
      </p>

      <div className="sb-field">
        <span>当前文档</span>
        <div className="tools-inline">
          <code className="tools-path">{source || '（还没打开 PDF）'}</code>
        </div>
      </div>

      <div className="sb-field">
        <span>每张页数</span>
        <div className="tools-inline">
          {SHEETS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`sb-btn${sheet === item.id ? ' is-active' : ''}`}
              data-tb-id={`impose-sheet-${item.id}`}
              title={item.tip}
              onClick={() => setSheet(item.id)}
              disabled={task.busy}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="sb-field">
        <span>页间距 {gap} mm</span>
        <input
          type="range"
          min={0}
          max={12}
          step={1}
          value={gap}
          data-tb-id="impose-gap"
          onChange={(event) => setGap(Number(event.target.value))}
          disabled={task.busy}
        />
      </div>

      <div className="sb-field">
        <span>页边距 {margin} mm</span>
        <input
          type="range"
          min={0}
          max={20}
          step={1}
          value={margin}
          data-tb-id="impose-margin"
          onChange={(event) => setMargin(Number(event.target.value))}
          disabled={task.busy}
        />
      </div>

      <div className="sb-field">
        <span>渲染精度 {dpi} DPI</span>
        <input
          type="range"
          min={96}
          max={240}
          step={6}
          value={dpi}
          data-tb-id="impose-dpi"
          onChange={(event) => setDpi(Number(event.target.value))}
          disabled={task.busy}
        />
      </div>

      <div className="sb-field tools-inline">
        <label className="tools-check">
          <input
            type="checkbox"
            checked={fill}
            data-tb-id="impose-fill"
            onChange={(event) => setFill(event.target.checked)}
            disabled={task.busy}
          />
          填满格子（会裁切）
        </label>
        <label className="tools-check">
          <input
            type="checkbox"
            checked={cutLine}
            data-tb-id="impose-cut"
            onChange={(event) => setCutLine(event.target.checked)}
            disabled={task.busy}
          />
          画裁切线
        </label>
      </div>

      <div className="tools-inline">
        <button
          type="button"
          className="sb-btn sb-btn--primary"
          data-tb-id="impose-run"
          onClick={() => void run()}
          disabled={task.busy || !source}
        >
          {task.busy ? '处理中…' : `拼成 ${spec.label}`}
        </button>
      </div>

      {message ? <p className="tools-hint">{message}</p> : null}
      {error ? <p className="tools-error-text">{error}</p> : null}
    </section>
  )
}
