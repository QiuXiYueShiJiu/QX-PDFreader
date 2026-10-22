// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 文档比较（Acrobat 的「比较文档」）。
 *
 * 做法：逐页提取文字（pdf.js）→ 行级差异（LCS）→ 汇总。
 * 为什么不做「高亮套印版 PDF」：那种输出要把两份文档的页面重绘并叠加，
 * 版面稍有不同就会满屏错位，实际用处不大；而「哪些页变了、变了哪几行」
 * 是老师/校对者真正要看的信息，用它生成报告更可靠。
 *
 * 另外提供「并排对照页」：把 A/B 同页渲染成左右两栏的一张图片，
 * 用于导出对照 PDF（见 composeSideBySidePage）。
 *
 * LCS 是 O(n·m)：两页都是几千行时内存会暴涨，所以超过阈值
 * 退化为「多重集合差」（仍能准确报增删行，只是丢了顺序信息）。
 */

import type { PDFDocumentProxy } from 'pdfjs-dist'

export interface PageDiff {
  page: number
  added: string[]
  removed: string[]
  changed: boolean
}

export interface CompareOptions {
  /** 忽略首尾空白与行内连续空白差异（默认 true） */
  ignoreWhitespace?: boolean
  /** 忽略大小写（默认 false） */
  ignoreCase?: boolean
}

export interface CompareSummary {
  pages: PageDiff[]
  identicalPages: number
  changedPages: number
  totalAdded: number
  totalRemoved: number
  pagesA: number
  pagesB: number
}

/** LCS 的 DP 上限（a 行数 × b 行数），超过就走集合差 */
const LCS_LIMIT = 3_000_000

function normalizeLine(line: string, options: CompareOptions): string {
  let value = line
  if (options.ignoreWhitespace !== false) value = value.replace(/\s+/g, ' ').trim()
  if (options.ignoreCase) value = value.toLowerCase()
  return value
}

/**
 * 行级差异：返回「B 比 A 多出来的行」与「A 里有但 B 里没有的行」。
 */
export function diffLines(
  aLines: string[],
  bLines: string[],
  options: CompareOptions = {}
): { added: string[]; removed: string[] } {
  const a = aLines.map((line) => normalizeLine(line, options))
  const b = bLines.map((line) => normalizeLine(line, options))

  if (a.length * b.length > LCS_LIMIT) {
    return multisetDiff(a, b)
  }

  /* 经典 LCS 长度表（Int32Array 控制内存） */
  const n = a.length
  const m = b.length
  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const added: string[] = []
  const removed: string[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      removed.push(aLines[i])
      i += 1
    } else {
      added.push(bLines[j])
      j += 1
    }
  }
  while (i < n) removed.push(aLines[i++])
  while (j < m) added.push(bLines[j++])
  return { added, removed }
}

/** 大文档回退：按多重集合算差（不保序） */
function multisetDiff(a: string[], b: string[]): { added: string[]; removed: string[] } {
  const counts = new Map<string, number>()
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1)
  const added: string[] = []
  for (const line of b) {
    const left = counts.get(line) ?? 0
    if (left > 0) counts.set(line, left - 1)
    else added.push(line)
  }
  const removed: string[] = []
  for (const line of a) {
    const left = counts.get(line) ?? 0
    /* 已经被 B 消耗掉的不再算「被删」 */
    if (left > 0) {
      removed.push(line)
      counts.set(line, left - 1)
    }
  }
  return { added, removed }
}

/** 逐页比较两份已提取的文本 */
export function comparePageTexts(
  aPages: Array<{ page: number; text: string }>,
  bPages: Array<{ page: number; text: string }>,
  options: CompareOptions = {}
): CompareSummary {
  const max = Math.max(aPages.length, bPages.length)
  const pages: PageDiff[] = []
  let identical = 0
  let totalAdded = 0
  let totalRemoved = 0

  for (let i = 0; i < max; i += 1) {
    const textA = aPages[i]?.text ?? ''
    const textB = bPages[i]?.text ?? ''
    const linesA = textA === '' ? [] : textA.split('\n')
    const linesB = textB === '' ? [] : textB.split('\n')
    const { added, removed } = diffLines(linesA, linesB, options)
    const changed = added.length > 0 || removed.length > 0
    if (!changed) identical += 1
    totalAdded += added.length
    totalRemoved += removed.length
    pages.push({ page: i + 1, added, removed, changed })
  }

  return {
    pages,
    identicalPages: identical,
    changedPages: pages.length - identical,
    totalAdded,
    totalRemoved,
    pagesA: aPages.length,
    pagesB: bPages.length
  }
}

/* ============================================================
 * 报告生成（txt / html）
 * ============================================================ */

export function buildCompareTextReport(
  summary: CompareSummary,
  nameA: string,
  nameB: string
): string {
  const lines: string[] = []
  lines.push('PDF 文档比较报告')
  lines.push('='.repeat(40))
  lines.push(`文档 A：${nameA}（${summary.pagesA} 页）`)
  lines.push(`文档 B：${nameB}（${summary.pagesB} 页）`)
  lines.push(
    `结果：${summary.changedPages} 页有差异，${summary.identicalPages} 页相同；新增 ${summary.totalAdded} 行，删除 ${summary.totalRemoved} 行`
  )
  lines.push('')

  for (const page of summary.pages) {
    if (!page.changed) continue
    lines.push(`—— 第 ${page.page} 页 ——`)
    for (const line of page.removed) lines.push(`- ${line}`)
    for (const line of page.added) lines.push(`+ ${line}`)
    lines.push('')
  }
  return lines.join('\n')
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function buildCompareHtmlReport(
  summary: CompareSummary,
  nameA: string,
  nameB: string
): string {
  const sections = summary.pages
    .filter((page) => page.changed)
    .map((page) => {
      const rows = [
        ...page.removed.map((line) => `<li class="del">- ${escapeHtml(line)}</li>`),
        ...page.added.map((line) => `<li class="add">+ ${escapeHtml(line)}</li>`)
      ].join('')
      return `<section><h3>第 ${page.page} 页</h3><ul>${rows}</ul></section>`
    })
    .join('\n')

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>PDF 比较报告</title>
<style>body{font-family:"Microsoft YaHei",sans-serif;max-width:960px;margin:24px auto;line-height:1.6}
h1{font-size:20px}.meta{color:#555}.del{color:#c62828}.add{color:#2e7d32}
section{border-top:1px solid #ddd;padding-top:8px;margin-top:12px}li{white-space:pre-wrap;word-break:break-word}</style>
</head><body>
<h1>PDF 文档比较报告</h1>
<p class="meta">文档 A：${escapeHtml(nameA)}（${summary.pagesA} 页）<br/>
文档 B：${escapeHtml(nameB)}（${summary.pagesB} 页）<br/>
${summary.changedPages} 页有差异 · ${summary.identicalPages} 页相同 · 新增 ${summary.totalAdded} 行 · 删除 ${summary.totalRemoved} 行</p>
${sections || '<p>两份文档内容一致。</p>'}
</body></html>`
}

/* ============================================================
 * 并排对照页（导出「对照 PDF」用）
 * ============================================================ */

export interface SideBySideImage {
  page: number
  /** 目标页面尺寸（点） */
  width: number
  height: number
  /** JPEG 字节 */
  data: ArrayBuffer
  added: number
  removed: number
}

/** 边距 / 间距 / 单侧宽度（点） */
const SBS_MARGIN = 24
const SBS_GAP = 24
const SBS_SIDE_WIDTH = 420
const SBS_HEADER = 46
/** 渲染倍率：2 px/pt，打印/放大都够清晰 */
const SBS_PIXEL_SCALE = 2

/**
 * 把 A/B 两份文档的同一页并排画成一张图片页。
 *
 * 输出为「一个新 PDF 页」：左边原文 A、右边原文 B，上方标注页码与差异行数。
 * 只用于「有差异的页」——完全相同的页没有必要进入对照文件。
 */
export async function composeSideBySidePage(
  docA: PDFDocumentProxy,
  docB: PDFDocumentProxy,
  pageNumber: number,
  diff: { added: number; removed: number },
  labels: { a: string; b: string } = { a: 'A', b: 'B' }
): Promise<SideBySideImage> {
  const pageA = await docA.getPage(pageNumber)
  const pageB = await docB.getPage(pageNumber)
  const viewA = pageA.getViewport({ scale: 1, rotation: 0 })
  const viewB = pageB.getViewport({ scale: 1, rotation: 0 })

  const scaleA = SBS_SIDE_WIDTH / viewA.width
  const scaleB = SBS_SIDE_WIDTH / viewB.width
  const heightA = viewA.height * scaleA
  const heightB = viewB.height * scaleB
  const sideHeight = Math.max(heightA, heightB)

  const pageWidth = SBS_MARGIN * 2 + SBS_SIDE_WIDTH * 2 + SBS_GAP
  const pageHeight = SBS_MARGIN * 2 + SBS_HEADER + sideHeight

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(pageWidth * SBS_PIXEL_SCALE)
  canvas.height = Math.round(pageHeight * SBS_PIXEL_SCALE)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建对照画布')

  const px = (value: number): number => Math.round(value * SBS_PIXEL_SCALE)

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  /* 标题栏 */
  ctx.fillStyle = '#1a1a1a'
  ctx.font = `600 ${px(15)}px "Microsoft YaHei", sans-serif`
  ctx.textBaseline = 'middle'
  ctx.fillText(`对照 · 第 ${pageNumber} 页`, px(SBS_MARGIN), px(SBS_MARGIN + SBS_HEADER / 2))
  ctx.fillStyle = '#c62828'
  ctx.font = `${px(12)}px "Microsoft YaHei", sans-serif`
  ctx.fillText(
    `差异：-${diff.removed} 行 / +${diff.added} 行`,
    px(SBS_MARGIN + 180),
    px(SBS_MARGIN + SBS_HEADER / 2)
  )

  const drawSide = async (
    page: typeof pageA,
    sourceHeight: number,
    xPt: number,
    label: string
  ): Promise<void> => {
    /* 先把「A/B + 文档名」写在图上方 */
    ctx.fillStyle = '#444444'
    ctx.font = `${px(11)}px "Microsoft YaHei", sans-serif`
    ctx.textBaseline = 'bottom'
    ctx.fillText(label.slice(0, 60), px(xPt), px(SBS_MARGIN + SBS_HEADER - 2))

    const viewport = page.getViewport({
      scale: (SBS_SIDE_WIDTH / page.getViewport({ scale: 1 }).width) * SBS_PIXEL_SCALE
    })
    const temp = document.createElement('canvas')
    temp.width = Math.max(1, Math.round(viewport.width))
    temp.height = Math.max(1, Math.round(viewport.height))
    const tempCtx = temp.getContext('2d')
    if (!tempCtx) return
    const task = page.render({ canvasContext: tempCtx, viewport })
    await (task as unknown as { promise: Promise<void> }).promise

    ctx.drawImage(
      temp,
      px(xPt),
      px(SBS_MARGIN + SBS_HEADER),
      px(SBS_SIDE_WIDTH),
      Math.round((sourceHeight / SBS_SIDE_WIDTH) * px(SBS_SIDE_WIDTH))
    )

    /* 侧边淡灰边框，明确 A/B 两块的分界 */
    ctx.strokeStyle = '#c8c8c8'
    ctx.lineWidth = Math.max(1, Math.round(SBS_PIXEL_SCALE))
    ctx.strokeRect(
      px(xPt) + 0.5,
      px(SBS_MARGIN + SBS_HEADER) + 0.5,
      px(SBS_SIDE_WIDTH) - 1,
      Math.round((sourceHeight / SBS_SIDE_WIDTH) * px(SBS_SIDE_WIDTH)) - 1
    )
    page.cleanup()
  }

  await drawSide(pageA, heightA, SBS_MARGIN, `A · ${labels.a}`)
  await drawSide(pageB, heightB, SBS_MARGIN + SBS_SIDE_WIDTH + SBS_GAP, `B · ${labels.b}`)

  const blob = await new Promise<Blob | null>((resolveBlob) => {
    canvas.toBlob((value) => resolveBlob(value), 'image/jpeg', 0.9)
  })
  if (!blob) throw new Error('对照页导出失败')

  return {
    page: pageNumber,
    width: pageWidth,
    height: pageHeight,
    data: await blob.arrayBuffer(),
    added: diff.added,
    removed: diff.removed
  }
}
