// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 覆盖式编辑的导出：把界面上的批注/编辑**烘焙**成一份新的 PDF。
 *
 * ============================================================
 * 为什么是「整页位图」而不是 PDF 矢量对象
 * ============================================================
 *  另存为矢量（pdf-lib 画矩形、真文字、嵌图）看起来更"高级"，
 *  但要做到**所见即所得**就得在 PDF 里重建一遍排版：
 *  DOM 的换行规则、字体度量、虚线选中框之外的字距……任何一点对不上，
 *  用户就会发现"屏幕上一行、导出来变两行"。
 *  位图路线的代价是清晰度上限（见 EXPORT_SCALE），换来的是**逐像素一致** ——
 *  对"涂白盖住原文再打上新字"这种教学场景，一致性比矢量更重要。
 *
 * ============================================================
 * ★ 坐标系（最容易错的地方，务必按这个约定）
 * ============================================================
 *  · 批注里的 rects 是**页面坐标**：scale = 1、**未旋转**的页面框像素。
 *  · 导出的 PNG 也画在**同一坐标系**里，只是整体乘 EXPORT_SCALE。
 *  · 主进程（main/index.ts 的 pdf:export）把这个 PNG **拉伸铺满整页**，
 *    不做任何旋转补偿（pdf-lib 的 page.getSize() 就是未旋转的页面框）。
 *  所以这里 `getViewport({ rotation: 0 })` 是硬要求：
 *  若跟着界面上的 rotation 走，横向页面导出来会整体转 90°，与目标页错位。
 *
 * ============================================================
 * 像素比取舍
 * ============================================================
 *  EXPORT_SCALE = 2（约 144 DPI）：A4 页 ≈ 1190×1684，一张 PNG 约 1~3MB 内存。
 *  取 3 会让整页内存翻倍多（一体机 4GB 内存、可能几十页批注），
 *  取 1 打印时肉眼可见发虚。2 是"屏幕上放大 2 倍仍可看、批量导出不炸内存"的折中。
 */

import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { Annotation, AnnotationRect } from '@shared/types'
import { toStrokeShape } from './ink-engine'
import { useViewer } from './store'

/** 导出倍率：页面坐标 × 该倍率 = PNG 像素 */
export const EXPORT_SCALE = 2

/**
 * 与界面完全一致的中文字体栈。
 *
 * 界面（edit.css）用同一串；只要两边不一致，导出后的字就会换字体、
 * 字宽随之变化，换行位置也会跟着错位 —— 这是"所见即所得"的第一道坎。
 */
export const CONTENT_FONT_STACK =
  "'Microsoft YaHei UI', 'Microsoft YaHei', system-ui, -apple-system, 'Segoe UI', sans-serif"

/** 文本框行高倍数（与 edit.css 的 --edit-line-height 一致） */
export const TEXT_LINE_HEIGHT = 1.35

/**
 * 高亮的不透明度与混合方式。
 *
 * 界面上是 `.anno-mark--highlight { opacity: .38; mix-blend-mode: multiply }`，
 * canvas 同样支持 multiply，所以这里能**照抄**而不是"近似"：
 * multiply 让高亮与下方的黑字自然叠色，纯 alpha 会把字洗淡。
 */
export const HIGHLIGHT_ALPHA = 0.38

/** 下划线/删除线的线宽（页面坐标）：界面在 100% 缩放下就是 2 CSS px */
export const RULE_WIDTH = 2

/** 便签图标的边长（页面坐标），与界面上 20px 的小方块对应 */
const NOTE_ICON_SIZE = 20

/** 没有显式字号时的默认值，与编辑工具条一致 */
const DEFAULT_FONT_SIZE = 16

/** 默认线宽，与 shared/types 的注释一致 */
const DEFAULT_STROKE_WIDTH = 2

export interface ExportAnnotatedResult {
  ok: boolean
  /** 成功时的目标路径 */
  path?: string
  /** 失败的原文（直接来自主进程或异常信息） */
  error?: string
  /** 用户在"另存为"里点了取消 */
  canceled?: boolean
  /** 成功时：真正烘焙了几页 */
  baked?: number
  /** 成功时：原文档总页数 */
  pages?: number
}

/** 图片解码缓存：同一张图在多页复用时不重复解码（dataURL 可能几百 KB） */
const imageCache = new Map<string, Promise<HTMLImageElement>>()

/**
 * 导出带批注的新 PDF。
 *
 * ★ 用传进来的 `doc`，**绝不重新加载文档**：
 *   重开一次要走 worker、重新解析 xref，大文件上要多等好几秒，
 *   而且会与阅读区正在用的那份文档抢内存。
 */
export async function exportAnnotatedPdf(options: {
  doc: PDFDocumentProxy
  /** 源文件绝对路径（主进程据此另存为） */
  filePath: string
  /** 当前文档的全部批注 */
  annotations: Annotation[]
  /** 源文件名，用于生成"xxx-已批注.pdf" */
  fileName?: string
  /** 逐页进度回调（done 从 1 开始），供工具条显示"正在导出 3/10" */
  onProgress?: (done: number, total: number) => void
}): Promise<ExportAnnotatedResult> {
  const { doc, filePath, annotations } = options
  const store = useViewer.getState()

  if (!filePath) return { ok: false, error: '还没有打开文档，无法导出' }

  const grouped = groupByPage(annotations)
  if (grouped.size === 0) {
    store.showToast('没有可导出的编辑内容')
    return { ok: false, error: '没有可导出的编辑内容' }
  }

  const total = grouped.size
  let done = 0
  const pages: Array<{ page: number; data: ArrayBuffer }> = []

  try {
    for (const [pageNumber, items] of grouped) {
      const page = await doc.getPage(pageNumber)

      /*
       * rotation 固定 0：见文件头说明。scale 用导出倍率，
       * 于是"页面坐标 × EXPORT_SCALE"就是这张 PNG 上的像素坐标，
       * 不需要任何额外的平移/旋转矩阵。
       */
      const viewport = page.getViewport({ scale: EXPORT_SCALE, rotation: 0 })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(viewport.width))
      canvas.height = Math.max(1, Math.round(viewport.height))

      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('无法创建离屏画布')

      /*
       * 先铺白底再画页面。
       * 透明 PNG 在别的阅读器里会露出上层背景（有的是深色），
       * "涂白"看起来就成了"涂黑"；而且真实纸张本来就是白的。
       */
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)

      const renderTask = page.render({ canvasContext: ctx, viewport })
      await (renderTask as unknown as { promise: Promise<void> }).promise

      // 批注按创建顺序画：后创建的压在上面，与界面上的层叠顺序一致
      for (const item of items) await paintAnnotation(ctx, item)

      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((b) => resolve(b), 'image/png')
      })
      if (!blob) throw new Error('PNG 编码失败')

      pages.push({ page: pageNumber, data: await blob.arrayBuffer() })
      done += 1
      options.onProgress?.(done, total)
    }

    const result = await window.pdfApp.doc.exportPdf({
      sourcePath: filePath,
      pages,
      defaultName: defaultExportName(filePath, options.fileName)
    })

    if (!result.ok) {
      if (result.canceled) {
        store.showToast('已取消导出')
        return { ok: false, canceled: true }
      }
      const message = result.error ?? '未知错误'
      store.showToast(`导出失败：${message}`, 3600)
      return { ok: false, error: message }
    }

    // 成功：清掉"有未导出的编辑"标记（store 内部会同步给主进程的未保存守卫）
    store.markExported()
    store.showToast(`已导出：${result.path}`, 3600)
    return { ok: true, path: result.path, baked: result.baked, pages: result.pages }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[export] 导出失败：', error)
    store.showToast(`导出失败：${message}`, 3600)
    return { ok: false, error: message }
  }
}

/**
 * 按页分组，并且**只留有内容的页**。
 *
 * 没有批注的页完全不碰：既省一次整页渲染，也避免把"什么都没改"的位图
 * 盖回原文上（那会让原本可复制、可搜索的文字变成图片）。
 */
function groupByPage(annotations: Annotation[]): Map<number, Annotation[]> {
  const map = new Map<number, Annotation[]>()
  for (const item of annotations) {
    if (item.rects.length === 0) continue
    // 纯便签（没编码笔迹）在界面上只有一个小图标，这里同样画出来
    const list = map.get(item.page)
    if (list) list.push(item)
    else map.set(item.page, [item])
  }
  // 页码升序，导出进度看上去是"从前往后"
  return new Map([...map.entries()].sort((a, b) => a[0] - b[0]))
}

/** 默认文件名：`原名-已批注.pdf`（主进程的"另存为"用得到） */
function defaultExportName(filePath: string, fileName?: string): string {
  const raw = fileName && fileName !== '' ? fileName : filePath.split(/[\\/]/).pop() ?? '文档'
  const base = raw.replace(/\.pdf$/i, '')
  return `${base}-已批注.pdf`
}

/* ============================================================
 * 逐条批注的绘制
 * ============================================================ */

/** 把一条批注画到导出画布上（坐标换算集中在这里，别的函数只管画） */
async function paintAnnotation(ctx: CanvasRenderingContext2D, item: Annotation): Promise<void> {
  const s = EXPORT_SCALE

  switch (item.type) {
    case 'highlight': {
      ctx.save()
      ctx.globalAlpha = HIGHLIGHT_ALPHA
      ctx.globalCompositeOperation = 'multiply'
      ctx.fillStyle = item.color
      for (const r of item.rects) ctx.fillRect(r.x * s, r.y * s, r.width * s, r.height * s)
      ctx.restore()
      return
    }

    case 'underline':
    case 'strikeout': {
      ctx.save()
      ctx.strokeStyle = item.color
      ctx.lineWidth = RULE_WIDTH * s
      ctx.lineCap = 'butt'
      for (const r of item.rects) {
        /*
         * 下划线贴矩形底边、删除线压中线 —— 与 viewer.css 里
         * border-bottom / ::after 的定位规则一致（差半根线宽是为了
         * 让线整体落在矩形内，和 CSS 的 border 行为一样）。
         */
        const y =
          item.type === 'underline'
            ? (r.y + r.height) * s - (RULE_WIDTH * s) / 2
            : (r.y + r.height / 2) * s
        ctx.beginPath()
        ctx.moveTo(r.x * s, y)
        ctx.lineTo((r.x + r.width) * s, y)
        ctx.stroke()
      }
      ctx.restore()
      return
    }

    case 'whiteout': {
      ctx.save()
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = '#ffffff'
      for (const r of item.rects) ctx.fillRect(r.x * s, r.y * s, r.width * s, r.height * s)
      ctx.restore()
      return
    }

    case 'rect':
    case 'ellipse': {
      const w = Math.max(1, item.strokeWidth ?? DEFAULT_STROKE_WIDTH) * s
      ctx.save()
      ctx.strokeStyle = item.color
      ctx.lineWidth = w
      ctx.lineJoin = 'round'
      for (const r of item.rects) {
        const x = r.x * s
        const y = r.y * s
        const rw = r.width * s
        const rh = r.height * s
        ctx.beginPath()
        if (item.type === 'rect') {
          // 内缩半个线宽：描边整体落在框内，与界面 SVG 的写法一致
          ctx.rect(x + w / 2, y + w / 2, Math.max(0, rw - w), Math.max(0, rh - w))
        } else {
          ctx.ellipse(
            x + rw / 2,
            y + rh / 2,
            Math.max(0.5, rw / 2 - w / 2),
            Math.max(0.5, rh / 2 - w / 2),
            0,
            0,
            Math.PI * 2
          )
        }
        ctx.stroke()
      }
      ctx.restore()
      return
    }

    case 'text':
      paintText(ctx, item)
      return

    case 'image':
      await paintImage(ctx, item)
      return

    case 'note':
      paintNoteOrInk(ctx, item)
      return

    default:
      return
  }
}

/**
 * 文字：与界面同字体、同字号、同颜色，多行按 1.35 倍行高排。
 *
 * ── 为什么自己实现换行而不是靠 `fillText(text, ...)` ─────────
 *   canvas 的 fillText 完全不换行（\n 也会被画成一个方框或缺字）。
 *   这里用 measureText 贪心断行，尽量贴近 DOM 的 `white-space: pre-wrap`：
 *   中日韩字符逐字断，拉丁文优先退到最近的空格。
 *   ★ 残留误差：canvas 的字宽度量与 DOM 排版引擎不逐像素相同，
 *     极端情况下（一行刚好卡在边界）两者换行位置可能差一个字。
 */
function paintText(ctx: CanvasRenderingContext2D, item: Annotation): void {
  const text = item.text ?? ''
  const rect = item.rects[0]
  if (!text.trim() || !rect) return

  const s = EXPORT_SCALE
  const fontSize = (item.fontSize ?? DEFAULT_FONT_SIZE) * s
  const lineHeight = fontSize * TEXT_LINE_HEIGHT

  ctx.save()
  ctx.fillStyle = item.color
  /*
   * v2.1.3：改文字继承原文的字重/斜体/字体族。
   * 顺序必须按 CSS 的 font 简写语法：style weight size family。
   * 不填时退化成 `400 normal`，与老批注的渲染结果一致。
   */
  const weight = item.fontWeight ?? 400
  const slant = item.fontStyle === 'italic' ? 'italic' : 'normal'
  const family = item.fontFamily?.trim() || CONTENT_FONT_STACK
  ctx.font = `${slant} ${weight} ${fontSize}px ${family}`
  ctx.textAlign = 'left'
  /*
   * middle + 行中心：CSS 里一行文字是"行盒居中"的（半行距上下均分），
   * 用 top 基线会比界面整体偏上约 0.17 行，多行时越往下差得越多。
   */
  ctx.textBaseline = 'middle'

  const maxWidth = rect.width * s
  const lines: string[] = []
  for (const raw of text.split('\n')) lines.push(...wrapLine(ctx, raw, maxWidth))

  lines.forEach((line, i) => {
    ctx.fillText(line, rect.x * s, rect.y * s + lineHeight * (i + 0.5))
  })
  ctx.restore()
}

/** 贪心断行：返回每一行的文字（空行保留，保持段落间距） */
function wrapLine(ctx: CanvasRenderingContext2D, line: string, maxWidth: number): string[] {
  if (maxWidth <= 0 || line === '') return [line]
  if (ctx.measureText(line).width <= maxWidth) return [line]

  const out: string[] = []
  let current = ''
  for (const ch of line) {
    const next = current + ch
    if (current !== '' && ctx.measureText(next).width > maxWidth) {
      /*
       * 拉丁文尽量在空格处断词（中文不需要，逐字断才符合排版习惯）。
       * 判据是"下一个字符不是 CJK"——CJK 断行处不该有空格。
       */
      const spaceAt = current.lastIndexOf(' ')
      const cjk = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/.test(ch)
      if (spaceAt > 0 && !cjk) {
        out.push(current.slice(0, spaceAt))
        current = `${current.slice(spaceAt + 1)}${ch}`
      } else {
        out.push(current)
        current = ch
      }
    } else {
      current = next
    }
  }
  if (current !== '') out.push(current)
  return out
}

/** 图片：dataURL → Image → drawImage；rotation 字段有值时绕中心旋转 */
async function paintImage(ctx: CanvasRenderingContext2D, item: Annotation): Promise<void> {
  const rect = item.rects[0]
  if (!rect || !item.image) return

  const s = EXPORT_SCALE
  const img = await loadImage(item.image)
  const x = rect.x * s
  const y = rect.y * s
  const w = rect.width * s
  const h = rect.height * s

  ctx.save()
  const deg = item.rotation ?? 0
  if (deg !== 0) {
    ctx.translate(x + w / 2, y + h / 2)
    ctx.rotate((deg * Math.PI) / 180)
    ctx.drawImage(img, -w / 2, -h / 2, w, h)
  } else {
    ctx.drawImage(img, x, y, w, h)
  }
  ctx.restore()
}

/**
 * 便签与笔迹。
 *
 * 笔迹：界面用 ink-engine 的变宽笔锋绘制，这里退化成**等宽折线**。
 *   取舍理由：变宽笔锋要复刻 pressure→width 的整套算法（ink-engine 内部函数
 *   没导出），折线的观感差距在"导出后打印出来看"这个场景里可接受；
 *   要完全一致就得把 paintStroke 提升成公共 API —— 那属于改公共模块，本轮不动。
 */
function paintNoteOrInk(ctx: CanvasRenderingContext2D, item: Annotation): void {
  const ink = toStrokeShape(item)
  if (!ink) {
    // 纯便签：画一个与界面同尺寸的小方块（界面是 20×20 的圆角图标）
    const r = item.rects[0]
    if (!r) return
    ctx.save()
    ctx.fillStyle = item.color
    ctx.fillRect(r.x * EXPORT_SCALE, r.y * EXPORT_SCALE, NOTE_ICON_SIZE, NOTE_ICON_SIZE)
    ctx.restore()
    return
  }

  if (ink.points.length < 2) return
  ctx.save()
  ctx.strokeStyle = ink.color
  ctx.lineWidth = Math.max(0.5, ink.width) * EXPORT_SCALE
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ink.points.forEach((p, i) => {
    const x = p.x * EXPORT_SCALE
    const y = p.y * EXPORT_SCALE
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })
  ctx.stroke()
  ctx.restore()
}

/** 解码 dataURL（带缓存）；同一张图在多页出现时只解码一次 */
function loadImage(src: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(src)
  if (cached) return cached

  const task = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解码失败（dataURL 可能已损坏）'))
    img.src = src
  })
  imageCache.set(src, task)
  // 失败的不留在缓存里，否则用户重试永远拿到同一个失败结果
  task.catch(() => imageCache.delete(src))
  return task
}

/** 供界面复用：把矩形规整成"左上角 + 正宽高"（拖拽时可能出现负宽高） */
export function normalizeRect(a: AnnotationRect, b: AnnotationRect): AnnotationRect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y)
  }
}
