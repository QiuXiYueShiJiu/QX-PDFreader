// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * PDF 工具箱的渲染侧实现。
 *
 * 分工：**能画的东西在渲染层画**，文件读写在主进程做（见 src/main/pdf-tools.ts）。
 *   · 压缩：用 pdf.js 把每页光栅化成 JPEG（这才是真正的「压小」——
 *     pdf-lib 只能重新序列化，对扫描件和嵌图文档几乎压不动）；
 *   · PDF→图片：渲染每页，或把所有页纵向拼成一张长图；
 *   · 水印：用 canvas 画文字再导出 PNG（中文水印必须这么做 ——
 *     pdf-lib 内置的 14 个标准字体不含 CJK，直接画字会变成空白）。
 *
 * ★ pdf.js worker 路径与 DocumentView 必须用同一套写法（?url 让打包器解析）。
 *   写死 '/pdf.worker.min.mjs' 在 file:// 下会被解析到盘符根目录，见 DocumentView 的注释。
 */

import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

/** 把磁盘路径转成 pdf-file:// URL（冒号不能编码，理由见 DocumentView.toPdfUrl） */
function toPdfUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  /*
   * ★ 路径走 query 而不是 path。
   *   Chromium 会把 URL 首段目录当 host 并**小写化**（/Projects → /projects），
   *   Linux 区分大小写，于是每个 PDF 都 404；query 内容不会被改写，
   *   Windows 盘符与 Linux 绝对路径都能原样带走。
   */
  return `pdf-file:///?p=${encodeURIComponent(normalized)}`
}

/* ============================================================
 * 通用：打开文档
 * ============================================================ */

/**
 * 打开一份 PDF 供工具使用。
 *
 * 复用 reading 层的自定义协议，大文件也是按 Range 分块读，
 * 不需要把整份 PDF 一次性塞进内存。
 */
export async function openPdfForTools(filePath: string): Promise<PDFDocumentProxy> {
  const task = pdfjsLib.getDocument({
    url: toPdfUrl(filePath),
    verbosity: 0
  })
  try {
    return await task.promise
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/password/i.test(message)) {
      throw new Error('这份 PDF 有打开密码，请先到「加密 / 解密」里移除保护后再操作')
    }
    throw new Error(`无法读取 PDF：${message}`)
  }
}

/** 渲染进度回调：done 从 1 开始 */
export type RenderProgress = (done: number, total: number) => void

/** 一页的渲染结果 */
export interface RenderedPage {
  /** 页码，1 起 */
  page: number
  /** 页面尺寸（PDF 点，未缩放的页面框） */
  width: number
  height: number
  /** 图片字节 */
  data: ArrayBuffer
  mime: 'image/jpeg' | 'image/png'
}

/** canvas → Blob（某些环境 toBlob 会给 null，统一兜成 error） */
function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob)
        else reject(new Error('图片编码失败（画布可能过大）'))
      },
      mime,
      quality
    )
  })
}

/** 逐页渲染成图片 */
export async function renderPdfPages(
  doc: PDFDocumentProxy,
  options: {
    /** 目标 DPI（72 DPI = 1 倍） */
    dpi: number
    format: 'jpeg' | 'png'
    /** JPEG 质量 0~1 */
    quality?: number
    onProgress?: RenderProgress
  }
): Promise<RenderedPage[]> {
  const scale = Math.max(0.1, options.dpi / 72)
  const mime = options.format === 'jpeg' ? 'image/jpeg' : 'image/png'
  const pages: RenderedPage[] = []

  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i)
    const viewport = page.getViewport({ scale })

    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(viewport.width))
    canvas.height = Math.max(1, Math.round(viewport.height))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法创建离屏画布')

    /* 先铺白底：JPEG 不支持透明，PNG 透明区域在别的阅读器里会变黑 */
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    const task = page.render({ canvasContext: ctx, viewport })
    await (task as unknown as { promise: Promise<void> }).promise

    const blob = await canvasToBlob(canvas, mime, options.quality)
    pages.push({
      page: i,
      /* 视口尺寸 / 缩放 = 页面框的点数，主进程据此保证输出页面尺寸不变 */
      width: viewport.width / scale,
      height: viewport.height / scale,
      data: await blob.arrayBuffer(),
      mime
    })

    /* 及时释放这张页的位图，几十页的文档不会把内存吃满 */
    page.cleanup()
    options.onProgress?.(i, doc.numPages)
  }

  return pages
}

/* ============================================================
 * PDF → 长图
 * ============================================================ */

/** 长图分段上限（像素）。超过就切成多张，避免单张画布超出浏览器上限 */
const LONG_IMAGE_MAX_HEIGHT = 16000
/** 长图的统一宽度（像素）：约 A4 在 150 DPI 下的宽度 */
const LONG_IMAGE_WIDTH = 1240

export interface LongImage {
  /** 第几段（1 起） */
  index: number
  width: number
  height: number
  data: ArrayBuffer
  /** 这一段包含的页范围（给文件名用） */
  from: number
  to: number
}

/**
 * 把所有页纵向拼成长图。
 *
 * ★ 为什么要分段：浏览器对 canvas 高度有硬上限（Chromium 约 32767px，
 *   且总像素超限时 toBlob 直接返回 null）。60 页的 A4 拼起来轻易就超了，
 *   所以按 LONG_IMAGE_MAX_HEIGHT 自动切成若干张，界面上会提示「共 N 张」。
 */
export async function renderLongImages(
  doc: PDFDocumentProxy,
  options: {
    /** JPEG 质量 0~1（长图统一用 JPEG：PNG 在照片页上会大到离谱） */
    quality?: number
    onProgress?: RenderProgress
  }
): Promise<LongImage[]> {
  const quality = options.quality ?? 0.82
  const results: LongImage[] = []

  /** 先算出每页在目标宽度下的显示高度，再决定怎么分组 */
  const heights: number[] = []
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i)
    const base = page.getViewport({ scale: 1 })
    heights.push(Math.max(1, Math.round((LONG_IMAGE_WIDTH * base.height) / base.width)))
    page.cleanup()
  }

  const groups: Array<{ from: number; to: number; height: number }> = []
  let current = { from: 1, to: 0, height: 0 }
  heights.forEach((h, index) => {
    const pageNo = index + 1
    if (current.to > 0 && current.height + h > LONG_IMAGE_MAX_HEIGHT) {
      groups.push(current)
      current = { from: pageNo, to: pageNo, height: h }
    } else {
      current.to = pageNo
      current.height += h
    }
  })
  if (current.to > 0) groups.push(current)

  let done = 0
  for (let g = 0; g < groups.length; g += 1) {
    const group = groups[g]
    const canvas = document.createElement('canvas')
    canvas.width = LONG_IMAGE_WIDTH
    canvas.height = Math.max(1, group.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法创建离屏画布')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    let y = 0
    for (let pageNo = group.from; pageNo <= group.to; pageNo += 1) {
      const page = await doc.getPage(pageNo)
      const base = page.getViewport({ scale: 1 })
      const scale = LONG_IMAGE_WIDTH / base.width
      const viewport = page.getViewport({ scale })
      const h = Math.round(viewport.height)

      /* 每页画到临时画布再贴上去：直接在一块画布上反复改 viewport 会互相影响 */
      const temp = document.createElement('canvas')
      temp.width = LONG_IMAGE_WIDTH
      temp.height = Math.max(1, h)
      const tctx = temp.getContext('2d')
      if (!tctx) throw new Error('无法创建离屏画布')
      const task = page.render({ canvasContext: tctx, viewport })
      await (task as unknown as { promise: Promise<void> }).promise
      ctx.drawImage(temp, 0, y)
      y += h

      page.cleanup()
      done += 1
      options.onProgress?.(done, doc.numPages)
    }

    const blob = await canvasToBlob(canvas, 'image/jpeg', quality)
    results.push({
      index: g + 1,
      width: canvas.width,
      height: canvas.height,
      data: await blob.arrayBuffer(),
      from: group.from,
      to: group.to
    })
  }

  return results
}

/* ============================================================
 * 水印图片
 * ============================================================ */

/**
 * 把水印文字画成透明 PNG。
 *
 * 参数给的是「页面上的视觉大小」（字号以像素计），内部再乘 4 倍超采样，
 * 贴进 PDF 放大打印时边缘依然干净。
 *
 * 支持多行（\n 分隔），行高 1.25；返回的 width/height 是**最终像素尺寸**，
 * 主进程用它与页面宽高算比例，所以文字多少、行数多少都不会被拉伸。
 */
export function renderWatermarkImage(options: {
  text: string
  color: string
  /** 字号（CSS 像素，最终会乘超采样倍率） */
  fontSize: number
  fontFamily?: string
  /** 是否加粗 */
  bold?: boolean
}): { data: ArrayBuffer; width: number; height: number } {
  const SUPER = 4
  const text = options.text.length > 0 ? options.text : '机密'
  const fontSize = Math.max(8, Math.min(400, options.fontSize || 48)) * SUPER
  const family =
    options.fontFamily && options.fontFamily.trim()
      ? options.fontFamily
      : "'Microsoft YaHei UI', 'Microsoft YaHei', 'Segoe UI', sans-serif"
  const weight = options.bold === false ? 400 : 700

  const lines = text.split('\n')
  const lineHeight = fontSize * 1.25

  /* 先量宽度：多行以最长一行为准，画布宽度 = 最长行 + 内边距 */
  const measure = document.createElement('canvas').getContext('2d')
  if (!measure) throw new Error('无法创建离屏画布')
  measure.font = `${weight} ${fontSize}px ${family}`
  let maxWidth = 1
  for (const line of lines) {
    maxWidth = Math.max(maxWidth, measure.measureText(line || ' ').width)
  }

  const padding = Math.round(fontSize * 0.35)
  const width = Math.ceil(maxWidth + padding * 2)
  const height = Math.ceil(lineHeight * lines.length + padding * 2)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建离屏画布')

  ctx.font = `${weight} ${fontSize}px ${family}`
  ctx.fillStyle = options.color || '#000000'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  lines.forEach((line, i) => {
    const y = padding + lineHeight * (i + 0.5)
    ctx.fillText(line, width / 2, y)
  })

  /*
   * toDataURL 是同步的，比 toBlob 少一次异步等待；
   * 对一张几百 KB 的透明 PNG 来说完全够用，而且能直接取到 ArrayBuffer。
   */
  const dataUrl = canvas.toDataURL('image/png')
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)

  return { data: bytes.buffer, width, height }
}

/* ============================================================
 * 文档大纲（书签）
 * ============================================================ */

export interface OutlineNode {
  title: string
  /** 目标页码（1 起） */
  page: number
  children: OutlineNode[]
}

/**
 * 读取 PDF 书签树。
 *
 * pdf.js 给的是原始大纲：`dest` 可能是命名字符串，也可能是
 * `[页面引用, /XYZ, ...]` 形式的数组；两种情况都要能解析成页码。
 * 解析失败的条目保留标题、页码记为 1（不让整棵树因为一条坏书签消失）。
 */
export async function readOutline(doc: PDFDocumentProxy): Promise<OutlineNode[]> {
  const raw = await doc.getOutline()
  if (!raw || raw.length === 0) return []

  const resolvePage = async (item: { dest?: unknown }): Promise<number> => {
    try {
      let dest = item.dest
      if (typeof dest === 'string') {
        dest = await doc.getDestination(dest)
      }
      if (Array.isArray(dest) && dest.length > 0) {
        const ref = dest[0] as Parameters<typeof doc.getPageIndex>[0]
        const index = await doc.getPageIndex(ref)
        return index + 1
      }
    } catch {
      /* 解析不出就用第 1 页 */
    }
    return 1
  }

  const walk = async (items: Array<Record<string, unknown>>): Promise<OutlineNode[]> => {
    const out: OutlineNode[] = []
    for (const item of items) {
      const title = typeof item.title === 'string' && item.title ? item.title : '未命名书签'
      const page = await resolvePage(item as { dest?: unknown })
      const childrenRaw = Array.isArray(item.items)
        ? (item.items as Array<Record<string, unknown>>)
        : []
      out.push({
        title,
        page,
        children: childrenRaw.length > 0 ? await walk(childrenRaw) : []
      })
    }
    return out
  }

  return walk(raw as unknown as Array<Record<string, unknown>>)
}

/* ============================================================
 * 全文提取（导出文本 / Word 用）
 * ============================================================ */

export interface PdfTextPage {
  page: number
  text: string
  /** 页面尺寸（点） */
  width: number
  height: number
}

/**
 * 逐页提取文字。
 *
 * 换行策略：pdf.js 的 textContent 里每个 item 可能带 `hasEOL`，
 * 有就补一个换行；没有但两段文字之间的水平位置有明显间隔时，
 * 也补一个空格 —— 否则一整页会挤成一行，导出的 Word 无法阅读。
 */
export async function extractTextPages(
  doc: PDFDocumentProxy,
  onProgress?: (done: number, total: number) => void
): Promise<PdfTextPage[]> {
  const pages: PdfTextPage[] = []
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i)
    const viewport = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()

    let text = ''
    let lastX: number | null = null
    let lastY: number | null = null
    for (const raw of content.items) {
      const item = raw as { str?: string; transform?: number[]; hasEOL?: boolean }
      const str = item.str ?? ''
      const transform = item.transform ?? [1, 0, 0, 1, 0, 0]
      const x = transform[4]
      const y = transform[5]
      if (lastY !== null && Math.abs(y - lastY) > 1) {
        text += '\n'
      } else if (lastX !== null && x - lastX > 8) {
        text += ' '
      }
      text += str
      lastX = x + (str.length > 0 ? 10 : 0)
      lastY = y
      if (item.hasEOL) {
        text += '\n'
        lastX = null
        lastY = null
      }
    }
    pages.push({
      page: i,
      text: text.replace(/\n{3,}/g, '\n\n').trim(),
      width: viewport.width,
      height: viewport.height
    })
    onProgress?.(i, doc.numPages)
    page.cleanup()
  }
  return pages
}

/* ============================================================
 * 按版面提取表格行（Excel 导出用）
 * ============================================================ */

export interface PdfTablePage {
  page: number
  /** 每行是若干单元格（已按 x 坐标聚列，缺列补空串） */
  rows: string[][]
  width: number
  height: number
}

/** 按 y 分组时的容差（点）：同一行里文字的基线差通常在 2pt 内 */
const LINE_TOLERANCE = 4
/** 同一行内相邻文字片段合并为同一格的间隙上限（点） */
const CELL_MERGE_GAP = 10
/** 跨行聚列的横向容差（点） */
const COLUMN_TOLERANCE = 24

/**
 * 从页面文字段落还原「表格行」。
 *
 * 与 extractTextPages 的区别：
 *   · 那个按阅读顺序拼成纯文本，列与列之间只剩空格，导出 Excel 会错位；
 *   · 这个保留每个片段的 x 坐标：先按 y 分行、再按 x 间隙分格，
 *     最后把各行的格子起点聚类成列 —— 左右对齐的信息因此保留下来。
 *
 * 局限：只适合「真实文字」的表格；扫描件没有坐标信息，需要先 OCR。
 */
export async function extractTablePages(
  doc: PDFDocumentProxy,
  onProgress?: (done: number, total: number) => void
): Promise<PdfTablePage[]> {
  const result: PdfTablePage[] = []

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber)
    const viewport = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()

    interface Segment {
      x: number
      y: number
      text: string
    }
    const segments: Segment[] = []
    for (const raw of content.items) {
      const item = raw as { str?: string; transform?: number[] }
      const text = (item.str ?? '').replace(/\s+$/, '')
      if (!text.trim()) continue
      const transform = item.transform ?? [1, 0, 0, 1, 0, 0]
      segments.push({ x: transform[4], y: transform[5], text })
    }

    /* ① 按 y 聚成行（容差内视为同一行） */
    const lines: Array<{ y: number; cells: Segment[] }> = []
    for (const segment of segments) {
      let line = lines.find((candidate) => Math.abs(candidate.y - segment.y) <= LINE_TOLERANCE)
      if (!line) {
        line = { y: segment.y, cells: [] }
        lines.push(line)
      }
      line.cells.push(segment)
    }
    lines.sort((a, b) => b.y - a.y)

    /* ② 行内按 x 排序，间隙超过阈值的切成不同单元格 */
    const rowsWithX: Array<Array<{ x: number; text: string }>> = []
    for (const line of lines) {
      line.cells.sort((a, b) => a.x - b.x)
      const cells: Array<{ x: number; text: string }> = []
      for (const cell of line.cells) {
        const last = cells[cells.length - 1]
        if (last && cell.x - last.x <= CELL_MERGE_GAP) {
          last.text += cell.text
        } else {
          cells.push({ x: cell.x, text: cell.text })
        }
      }
      if (cells.length > 0) rowsWithX.push(cells)
    }

    /* ③ 收集所有格子起点，按容差聚成列 */
    const starts: number[] = []
    for (const row of rowsWithX) for (const cell of row) starts.push(cell.x)
    starts.sort((a, b) => a - b)
    const columnStarts: number[] = []
    for (const start of starts) {
      const last = columnStarts[columnStarts.length - 1]
      if (last === undefined || Math.abs(start - last) > COLUMN_TOLERANCE) {
        columnStarts.push(start)
      }
    }
    const columnOf = (x: number): number => {
      let best = 0
      let bestDistance = Infinity
      columnStarts.forEach((start, index) => {
        const distance = Math.abs(x - start)
        if (distance < bestDistance) {
          bestDistance = distance
          best = index
        }
      })
      return best
    }

    /* ④ 铺成矩形：缺列补空串 */
    const rows: string[][] = []
    for (const row of rowsWithX) {
      const cells: string[] = Array.from({ length: columnStarts.length }, () => '')
      for (const cell of row) {
        const column = columnOf(cell.x)
        cells[column] = cells[column] ? `${cells[column]} ${cell.text}` : cell.text
      }
      while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop()
      if (cells.length > 0) rows.push(cells)
    }

    result.push({
      page: pageNumber,
      rows,
      width: viewport.width,
      height: viewport.height
    })
    onProgress?.(pageNumber, doc.numPages)
    page.cleanup()
  }

  return result
}

/* ============================================================
 * 文档属性
 * ============================================================ */

export interface PdfMetadata {
  title: string
  author: string
  subject: string
  keywords: string
  creator: string
  producer: string
}

export async function readMetadata(doc: PDFDocumentProxy): Promise<PdfMetadata> {
  try {
    const meta = await doc.getMetadata()
    const info = (meta?.info ?? {}) as Record<string, unknown>
    const str = (v: unknown): string => (typeof v === 'string' ? v : '')
    return {
      title: str(info.Title),
      author: str(info.Author),
      subject: str(info.Subject),
      keywords: str(info.Keywords),
      creator: str(info.Creator),
      producer: str(info.Producer)
    }
  } catch {
    return { title: '', author: '', subject: '', keywords: '', creator: '', producer: '' }
  }
}

/* ============================================================
 * 安全遮盖：把某一页连同黑框渲染成位图
 * ============================================================ */

export interface RedactionBox {
  /** 页面坐标（scale = 1、未旋转，左上角为原点） */
  x: number
  y: number
  width: number
  height: number
}

/**
 * 渲染被遮盖的页。
 *
 * ★ 坐标系：与批注一致 —— **未旋转**页面框、左上角原点；
 *   主进程收到的是位图，不再关心坐标。
 * 渲染倍率取 150 DPI：遮盖后的页要能看清剩下的内容，
 * 又不能大到让整份文件爆掉。
 */
export async function renderRedactedPage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  boxes: RedactionBox[],
  options: { dpi?: number; quality?: number } = {}
): Promise<{ data: ArrayBuffer; width: number; height: number }> {
  const page = await doc.getPage(pageNumber)
  const dpi = Math.min(300, Math.max(72, options.dpi ?? 150))
  const scale = dpi / 72
  const viewport = page.getViewport({ scale, rotation: 0 })

  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(viewport.width))
  canvas.height = Math.max(1, Math.round(viewport.height))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建离屏画布')

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const task = page.render({ canvasContext: ctx, viewport })
  await (task as unknown as { promise: Promise<void> }).promise

  /* 黑框要在页面渲染之后画，保证盖住原文 */
  ctx.fillStyle = '#000000'
  for (const box of boxes) {
    if (box.width <= 0 || box.height <= 0) continue
    ctx.fillRect(
      Math.round(box.x * scale),
      Math.round(box.y * scale),
      Math.max(1, Math.round(box.width * scale)),
      Math.max(1, Math.round(box.height * scale))
    )
  }

  const blob = await new Promise<Blob | null>((resolveBlob) => {
    canvas.toBlob((b) => resolveBlob(b), 'image/jpeg', options.quality ?? 0.9)
  })
  if (!blob) throw new Error('遮盖页导出失败')

  page.cleanup()
  return {
    data: await blob.arrayBuffer(),
    width: viewport.width / scale,
    height: viewport.height / scale
  }
}

/* ============================================================
 * 提取内嵌图片（Acrobat 的「导出所有图片」）
 * ============================================================ */

export interface EmbeddedImage {
  /** 所在页（1 起） */
  page: number
  /** 该页内第几张（1 起） */
  index: number
  width: number
  height: number
  /** PNG 字节 */
  data: ArrayBuffer
}

/** pdf.js 里一张已解码图片的形态 */
interface PdfJsImageObject {
  width: number
  height: number
  kind?: number
  /** pdf.js v4 起图片优先以 ImageBitmap 形式给出；老版本给像素数组 */
  bitmap?: ImageBitmap | null
  data?: Uint8ClampedArray | Uint8Array | null
}

/**
 * 解析 pdf.js 的图片对象。
 *
 * page.objs 是 PDFObjects：对象已解析时 get(name) 直接返回值；
 * 尚未解析时 get(name, callback) 会在解析完成后回调。
 * 两种路径都兼容，并加 8 秒超时（坏图片不至于卡死整轮提取）。
 */
function getPageImageObject(page: unknown, name: string): Promise<PdfJsImageObject | null> {
  const objs = (page as { objs?: { get: (id: string, cb?: (data: unknown) => void) => unknown } }).objs
  if (!objs) return Promise.resolve(null)

  try {
    const direct = objs.get(name)
    if (direct) return Promise.resolve(direct as PdfJsImageObject)
  } catch {
    /* 未解析：走回调 */
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (value: unknown): void => {
      if (settled) return
      settled = true
      resolve((value as PdfJsImageObject | undefined) ?? null)
    }
    try {
      objs.get(name, finish)
    } catch {
      finish(null)
    }
    setTimeout(() => finish(null), 8000)
  })
}

/** 把 pdf.js 的图片对象画进 canvas（优先用 ImageBitmap，其次按像素格式转换） */
function imageObjectToCanvas(image: PdfJsImageObject): HTMLCanvasElement {
  const { width, height } = image
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, width)
  canvas.height = Math.max(1, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建图片画布')

  /*
   * ★ pdf.js v4 的解码结果是一个 ImageBitmap（见 {bitmap, dataLen, width, height}），
   *   `data` 为 null。直接 drawImage(bitmap) 既最准确又不用关心像素格式；
   *   老版本（或有代码强制走像素路径时）再按 RGB/RGBA/灰度展开。
   */
  if (image.bitmap) {
    ctx.drawImage(image.bitmap, 0, 0, canvas.width, canvas.height)
    return canvas
  }

  const raw = image.data
  if (!raw) throw new Error('图片缺少像素数据')

  const rgba = new Uint8ClampedArray(width * height * 4)
  const pixelCount = width * height

  if (raw.length === pixelCount * 4 || image.kind === 3) {
    /* RGBA_32BPP */
    rgba.set(raw.subarray(0, pixelCount * 4))
  } else if (raw.length === pixelCount * 3 || image.kind === 2) {
    /* RGB_24BPP */
    for (let s = 0, d = 0; d < pixelCount * 4; s += 3, d += 4) {
      rgba[d] = raw[s]
      rgba[d + 1] = raw[s + 1]
      rgba[d + 2] = raw[s + 2]
      rgba[d + 3] = 255
    }
  } else if (raw.length === pixelCount) {
    /* 8 位灰度 */
    for (let i = 0, d = 0; i < pixelCount; i += 1, d += 4) {
      const v = raw[i]
      rgba[d] = v
      rgba[d + 1] = v
      rgba[d + 2] = v
      rgba[d + 3] = 255
    }
  } else {
    /*
     * GRAYSCALE_1BPP（每行按字节对齐）：位 = 1 视为白、0 视为黑。
     * 纯黑白扫描件常见；如果个别文件反相，属于 pdf.js 的位序约定差异。
     */
    const rowBytes = Math.ceil(width / 8)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const byte = raw[y * rowBytes + (x >> 3)] ?? 0
        const bit = (byte >> (7 - (x & 7))) & 1
        const v = bit ? 255 : 0
        const d = (y * width + x) * 4
        rgba[d] = v
        rgba[d + 1] = v
        rgba[d + 2] = v
        rgba[d + 3] = 255
      }
    }
  }

  ctx.putImageData(new ImageData(rgba, width, height), 0, 0)
  return canvas
}

/** 对图片字节做简单指纹（去重用）：宽度、高度、长度和采样字节 */
function imageFingerprint(width: number, height: number, data: ArrayBuffer): string {
  const bytes = new Uint8Array(data)
  let hash = 2166136261
  const step = Math.max(1, Math.floor(bytes.length / 4096))
  for (let i = 0; i < bytes.length; i += step) {
    hash ^= bytes[i]
    hash = Math.imul(hash, 16777619)
  }
  return `${width}x${height}:${bytes.length}:${hash >>> 0}`
}

/**
 * 提取文档中所有内嵌位图。
 *
 * 只取「作为图片绘制」的对象（paintImageXObject / paintJpegXObject /
 * paintInlineImageXObject）；蒙版（paintImageMaskXObject）与矢量图形跳过。
 * 相同图片在多页重复出现时只保留第一张（Acrobat 的导出行为也是这样）。
 */
export async function extractEmbeddedImages(
  doc: PDFDocumentProxy,
  onProgress?: (done: number, total: number) => void
): Promise<EmbeddedImage[]> {
  /*
   * OPS 的枚举成员随 pdf.js 版本增删：v4 的类型里没有 paintJpegXObject
   * （JPEG 图统一走 paintImageXObject），但运行时可能仍存在。
   * 用宽松索引表按名字取代码，取不到就是 undefined，天然跳过。
   */
  const OPS = pdfjsLib.OPS as unknown as Record<string, number | undefined>
  const results: EmbeddedImage[] = []
  const seen = new Set<string>()

  const pushImage = async (
    pageNumber: number,
    index: number,
    image: PdfJsImageObject | null
  ): Promise<void> => {
    if (!image || image.width <= 0 || image.height <= 0) return
    if (!image.bitmap && !image.data) return
    let canvas: HTMLCanvasElement
    try {
      canvas = imageObjectToCanvas(image)
    } catch {
      return
    }
    const blob = await new Promise<Blob | null>((resolveBlob) => {
      canvas.toBlob((b) => resolveBlob(b), 'image/png')
    })
    if (!blob) return
    const data = await blob.arrayBuffer()
    const fingerprint = imageFingerprint(canvas.width, canvas.height, data)
    if (seen.has(fingerprint)) return
    seen.add(fingerprint)
    results.push({ page: pageNumber, index, width: canvas.width, height: canvas.height, data })
  }

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber)
    const opList = await page.getOperatorList()

    let index = 0
    for (let i = 0; i < opList.fnArray.length; i += 1) {
      const fn = opList.fnArray[i]
      const args = opList.argsArray[i] as unknown[]

      if (fn === OPS.paintInlineImageXObject) {
        const image = args[0] as {
          width: number
          height: number
          kind?: number
          data: Uint8ClampedArray
        }
        await pushImage(pageNumber, (index += 1), image)
        continue
      }

      if (
        fn === OPS.paintImageXObject ||
        (OPS.paintJpegXObject !== undefined && fn === OPS.paintJpegXObject)
      ) {
        const name = args[0]
        if (typeof name !== 'string') continue
        const image = await getPageImageObject(page, name)
        await pushImage(pageNumber, (index += 1), image)
      }
    }

    page.cleanup()
    onProgress?.(pageNumber, doc.numPages)
  }

  return results
}
