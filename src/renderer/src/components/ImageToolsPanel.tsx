// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 「图片」工具面板 —— 右侧滑出。
 *
 * 分工：像素运算在这里（离屏 canvas），落盘在主进程（image-tools.ts）。
 * 为什么像素运算放渲染层：
 *   · Chromium 的 canvas 自带 brightness/contrast/saturate/grayscale/sepia/blur；
 *   · WebP **编码**只有 canvas.toDataURL('image/webp') 能做 ——
 *     nativeImage 只有 toPNG / toJPEG，没有 toWebP；
 *   · 锐化 / 浮雕 / 噪点这类卷积用 getImageData 循环几行就够，
 *     不必为它引一个 sharp。
 *
 * 打开图片时主进程会把临时 PDF 的路径当普通文档发过来，
 * 面板按这个路径向主进程要「原图是谁」，于是标签页与面板显示的都是
 * 真实文件名（IMG_2026.jpg），而不是缓存名（IMG_2026-3f9a1c0d.pdf）。
 *
 * 状态发布：把 originalName / isImage / imageMetaById 写进 zustand store，
 * 这样 `window.__store.getState()`（test-hooks 模式）也能读到，
 * 其它面板不必再各自去问主进程。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useViewer } from '../store'
import '../styles/image-tools.css'

/* ============================================================
 * 与主进程的桥（env.d.ts 不在本次可改范围，这里就地声明）
 * ============================================================ */

type OutputFormat = 'png' | 'jpg' | 'webp' | 'bmp'

interface ImageMeta {
  sourcePath: string
  originalName: string
  isImage: true
  format: string
  formatLabel: string
  width: number
  height: number
  bytes: number
  mtimeMs?: number
  /** 仅「当前打开的是图片」时存在 */
  tempPath?: string
  openedAt?: number
}

interface ImageReadResult {
  ok: boolean
  dataUrl?: string
  converted?: boolean
  meta?: ImageMeta
  error?: string
}

interface ImageMetaResult {
  ok: boolean
  meta?: ImageMeta | null
  error?: string
}

interface ImageSaveResult {
  ok: boolean
  path?: string
  dir?: string
  backup?: string
  bytes?: number
  canceled?: boolean
  error?: string
}

interface ImageSavePayload {
  sourcePath: string
  bytes?: Uint8Array
  rgba?: { bytes: Uint8Array; width: number; height: number }
  format: OutputFormat
  mode: 'dialog' | 'overwrite' | 'directory'
  fileName?: string
  directory?: string
}

interface ImageBridge {
  read: (filePath: string) => Promise<ImageReadResult>
  meta: (filePath: string) => Promise<ImageMetaResult>
  pick: (options?: { multi?: boolean; title?: string }) => Promise<{ ok: boolean; canceled?: boolean; files: string[]; error?: string }>
  pickFolder: () => Promise<{ ok: boolean; canceled?: boolean; directory?: string; error?: string }>
  save: (payload: ImageSavePayload) => Promise<ImageSaveResult>
}

function imageBridge(): ImageBridge {
  const api = (window.pdfApp as unknown as { image?: ImageBridge }).image
  if (!api) throw new Error('图片工具桥未就绪：preload 里缺少 image 分组')
  return api
}

/* ============================================================
 * 尺寸 / 名字 / 编码小工具
 * ============================================================ */

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function replaceExt(name: string, format: OutputFormat): string {
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  return `${base}.${format}`
}

function formatName(format: OutputFormat): string {
  return format === 'jpg' ? 'JPEG' : format.toUpperCase()
}

/** 编码结果；BMP 交给主进程拼头（渲染层只给 RGBA） */
interface EncodedImage {
  bytes: Uint8Array
  rgba?: { bytes: Uint8Array; width: number; height: number }
}

function dataUrlToBytes(url: string): Uint8Array {
  const comma = url.indexOf(',')
  if (comma < 0) throw new Error('编码结果不是合法的 data URL')
  const binary = atob(url.slice(comma + 1))
  const out = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index)
  return out
}

function encodeCanvas(canvas: HTMLCanvasElement, format: OutputFormat, quality: number): EncodedImage {
  if (format === 'bmp') {
    const data = context2d(canvas).getImageData(0, 0, canvas.width, canvas.height)
    return { bytes: new Uint8Array(0), rgba: { bytes: new Uint8Array(data.data), width: canvas.width, height: canvas.height } }
  }
  const mime = format === 'png' ? 'image/png' : format === 'jpg' ? 'image/jpeg' : 'image/webp'
  const q = format === 'png' ? undefined : Math.min(1, Math.max(0.1, quality / 100))
  const url = canvas.toDataURL(mime, q)
  if (format === 'webp' && !url.startsWith('data:image/webp')) {
    throw new Error('当前环境不支持 WebP 编码（canvas.toDataURL 回落成 PNG 了）')
  }
  return { bytes: dataUrlToBytes(url) }
}

/* ============================================================
 * 离屏 canvas
 * ============================================================ */

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  return canvas
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('无法创建离屏画布（canvas 2d 上下文不可用）')
  return ctx
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolvePromise, reject) => {
    const img = new Image()
    img.onload = () => resolvePromise(img)
    img.onerror = () => reject(new Error('图片无法解码：格式不支持或文件已损坏'))
    img.src = url
  })
}

/** 把透明背景合成到白色（JPEG / BMP 没有 alpha 通道） */
function flattenToWhite(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const out = makeCanvas(canvas.width, canvas.height)
  const ctx = context2d(out)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, out.width, out.height)
  ctx.drawImage(canvas, 0, 0)
  return out
}

/** 3×3 卷积（锐化 / 浮雕用） */
function convolve(canvas: HTMLCanvasElement, kernel: number[], divisor: number, offset: number): void {
  const ctx = context2d(canvas)
  const { width, height } = canvas
  const source = ctx.getImageData(0, 0, width, height)
  const input = source.data
  const output = new Uint8ClampedArray(input.length)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      for (let ky = -1; ky <= 1; ky += 1) {
        for (let kx = -1; kx <= 1; kx += 1) {
          const px = Math.min(width - 1, Math.max(0, x + kx))
          const py = Math.min(height - 1, Math.max(0, y + ky))
          const index = (py * width + px) * 4
          const weight = kernel[(ky + 1) * 3 + (kx + 1)]
          r += input[index] * weight
          g += input[index + 1] * weight
          b += input[index + 2] * weight
        }
      }
      const index = (y * width + x) * 4
      output[index] = r / divisor + offset
      output[index + 1] = g / divisor + offset
      output[index + 2] = b / divisor + offset
      output[index + 3] = input[index + 3]
    }
  }

  const next = new ImageData(output, width, height)
  ctx.putImageData(next, 0, 0)
}

/** 噪点：每个像素叠一个 ±amount 的随机偏移 */
function addNoise(canvas: HTMLCanvasElement, amount: number): void {
  const ctx = context2d(canvas)
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const data = image.data
  const range = Math.max(1, Math.round(amount))
  for (let index = 0; index < data.length; index += 4) {
    const delta = Math.round((Math.random() * 2 - 1) * range)
    data[index] = data[index] + delta
    data[index + 1] = data[index + 1] + delta
    data[index + 2] = data[index + 2] + delta
  }
  ctx.putImageData(image, 0, 0)
}

/* ============================================================
 * 编辑状态
 * ============================================================ */

interface Snapshot {
  url: string
  width: number
  height: number
}

interface BatchItem {
  file: string
  ok: boolean
  error?: string
  outPath?: string
  bytes?: number
}

/** 调色滑块（-100 ~ 100）；预览与烘焙用同一套映射 */
interface Adjust {
  brightness: number
  contrast: number
  saturation: number
  sharpen: number
}

const DEFAULT_ADJUST: Adjust = { brightness: 0, contrast: 0, saturation: 0, sharpen: 0 }

function adjustFilter(adjust: Adjust): string {
  const parts: string[] = []
  if (adjust.brightness !== 0) parts.push(`brightness(${(100 + adjust.brightness) / 100})`)
  if (adjust.contrast !== 0) parts.push(`contrast(${(100 + adjust.contrast) / 100})`)
  if (adjust.saturation !== 0) parts.push(`saturate(${(100 + adjust.saturation) / 100})`)
  return parts.join(' ') || 'none'
}

/** 把 #RRGGBB 定成 CSS 变量以外的简单比较用常量 */
const FILTER_LABEL: Record<string, string> = {
  none: '原色',
  gray: '灰度',
  sepia: '复古',
  blur: '模糊',
  emboss: '浮雕',
  noise: '噪点'
}

/* ============================================================
 * 组件
 * ============================================================ */

export function ImageToolsPanel(): JSX.Element {
  const filePath = useViewer((state) => state.filePath)

  /*
   * 2026-10-28（需求清单 B5）：入口从上栏来。
   *
   * 以前这里是面板自己的 useState，配合右侧一个常驻的悬浮圆按钮
   * （.image-tools-toggle）—— 那个按钮悬在阅读区右下角，盖住正文，
   * 还被用户点名说「不要单独悬浮按钮」。现在开关状态放 store，
   * 上栏「工具」选项卡里的「图片」按钮 setShowImageTools(true) 打开，
   * 面板本身变成可拖动的浮层（见下面的 image-float）。
   */
  const open = useViewer((state) => state.showImageTools)
  const setOpen = useViewer((state) => state.setShowImageTools)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  /** 面板当前操作的图片（不一定是阅读器里打开的那张） */
  const [meta, setMeta] = useState<ImageMeta | null>(null)
  const [originalUrl, setOriginalUrl] = useState('')
  const [workingUrl, setWorkingUrl] = useState('')
  const [dims, setDims] = useState({ width: 0, height: 0 })
  const [dirty, setDirty] = useState(false)
  const [history, setHistory] = useState<Snapshot[]>([])

  /** 调色 / 滤镜 */
  const [adjust, setAdjust] = useState<Adjust>(DEFAULT_ADJUST)
  const [filter, setFilter] = useState('none')

  /** 裁剪 / 缩放输入 */
  const [crop, setCrop] = useState({ x: 0, y: 0, width: 0, height: 0 })
  const [resize, setResize] = useState({ width: 0, height: 0, keepRatio: true })

  /** 导出 */
  const [outFormat, setOutFormat] = useState<OutputFormat>('png')
  const [quality, setQuality] = useState(90)
  const [maxSide, setMaxSide] = useState(0)
  const [exported, setExported] = useState('')

  /** 批量 */
  const [batchFiles, setBatchFiles] = useState<string[]>([])
  const [batchFormat, setBatchFormat] = useState<OutputFormat>('jpg')
  const [batchQuality, setBatchQuality] = useState(80)
  const [batchMaxSide, setBatchMaxSide] = useState(1920)
  const [batchDir, setBatchDir] = useState('')
  const [batchItems, setBatchItems] = useState<BatchItem[]>([])
  const [batchProgress, setBatchProgress] = useState('')

  const workingRef = useRef({ url: '', width: 0, height: 0 })
  workingRef.current = { url: workingUrl, width: dims.width, height: dims.height }

  /** 面板挂在 App 上时可能比 store 的首次渲染更早，这里只写、不读 */
  const publish = useCallback((next: ImageMeta | null, tempPath: string) => {
    try {
      const setState = useViewer.setState as unknown as (partial: Record<string, unknown>) => void
      setState({
        originalName: next?.originalName ?? '',
        isImage: Boolean(next),
        imageMetaById: next
          ? {
              [tempPath || next.sourcePath]: {
                sourcePath: next.sourcePath,
                originalName: next.originalName,
                tempPath: tempPath || '',
                isImage: true,
                format: next.format,
                formatLabel: next.formatLabel,
                width: next.width,
                height: next.height,
                bytes: next.bytes
              }
            }
          : {}
      })
    } catch {
      /* store 结构变化时不影响面板本身 */
    }
  }, [])

  const resetEditing = useCallback((read: ImageReadResult) => {
    if (!read.meta || !read.dataUrl) return
    setMeta(read.meta)
    setOriginalUrl(read.dataUrl)
    setWorkingUrl(read.dataUrl)
    setDims({ width: read.meta.width, height: read.meta.height })
    setCrop({ x: 0, y: 0, width: read.meta.width, height: read.meta.height })
    setResize({ width: read.meta.width, height: read.meta.height, keepRatio: true })
    setAdjust(DEFAULT_ADJUST)
    setFilter('none')
    setDirty(false)
    setHistory([])
    setExported('')
  }, [])

  /** 直接读一张图进面板（批量选择 / 手动选图都走这里） */
  const loadFile = useCallback(
    async (path: string, tempPath: string) => {
      setBusy(true)
      setError('')
      setNotice('')
      try {
        const result = await imageBridge().read(path)
        if (!result.ok) throw new Error(result.error ?? '读取图片失败')
        resetEditing(result)
        if (result.converted) setNotice('这张图的格式浏览器不直接认，已转成 PNG 显示')
        publish(result.meta ?? null, tempPath)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    },
    [publish, resetEditing]
  )

  /* ---- 当前文档是图片时，自动把它装进面板 ---- */
  useEffect(() => {
    let cancelled = false
    async function follow() {
      if (!filePath) {
        if (!cancelled) {
          setMeta(null)
          setOriginalUrl('')
          setWorkingUrl('')
          setDims({ width: 0, height: 0 })
          setDirty(false)
          setHistory([])
          publish(null, '')
        }
        return
      }
      try {
        const result = await imageBridge().meta(filePath)
        if (cancelled) return
        const info = result.ok ? result.meta : null
        if (!info) {
          publish(null, '')
          setMeta(null)
          setOriginalUrl('')
          setWorkingUrl('')
          setDims({ width: 0, height: 0 })
          return
        }
        if (info.sourcePath === meta?.sourcePath && info.tempPath) {
          /* 同一张图切回来：保留面板里的编辑状态，不重来 */
          publish(info, info.tempPath ?? '')
          return
        }
        await loadFile(info.sourcePath, info.tempPath ?? '')
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    void follow()
    return () => {
      cancelled = true
    }
    // meta 故意不进依赖：只在切换文档时重新跟随
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, loadFile, publish])

  /* ---- Esc 关闭 ---- */
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  /* ---- 编辑提交 ---- */

  const commitCanvas = useCallback(
    (canvas: HTMLCanvasElement, note?: string) => {
      const url = canvas.toDataURL('image/png')
      setHistory((list) => [...list.slice(-19), workingRef.current])
      setWorkingUrl(url)
      setDims({ width: canvas.width, height: canvas.height })
      setDirty(true)
      setNotice(note ?? '')
      setExported('')
    },
    []
  )

  const runTransform = useCallback(
    async (work: (img: HTMLImageElement) => HTMLCanvasElement, note?: string) => {
      const current = workingRef.current
      if (!current.url || busy) return
      setBusy(true)
      setError('')
      try {
        const img = await loadImage(current.url)
        commitCanvas(work(img), note)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    },
    [busy, commitCanvas]
  )

  const rotate = useCallback(
    (degrees: 90 | 180 | 270) =>
      runTransform((img) => {
        const rad = (degrees * Math.PI) / 180
        const swap = degrees === 90 || degrees === 270
        const canvas = makeCanvas(swap ? img.naturalHeight : img.naturalWidth, swap ? img.naturalWidth : img.naturalHeight)
        const ctx = context2d(canvas)
        ctx.translate(canvas.width / 2, canvas.height / 2)
        ctx.rotate(rad)
        ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2)
        return canvas
      }, `已旋转 ${degrees}°`),
    [runTransform]
  )

  const flip = useCallback(
    (axis: 'h' | 'v') =>
      runTransform((img) => {
        const canvas = makeCanvas(img.naturalWidth, img.naturalHeight)
        const ctx = context2d(canvas)
        ctx.translate(axis === 'h' ? canvas.width : 0, axis === 'v' ? canvas.height : 0)
        ctx.scale(axis === 'h' ? -1 : 1, axis === 'v' ? -1 : 1)
        ctx.drawImage(img, 0, 0)
        return canvas
      }, axis === 'h' ? '已水平翻转' : '已垂直翻转'),
    [runTransform]
  )

  const applyCrop = useCallback(() => {
    const values = { x: Math.round(crop.x), y: Math.round(crop.y), width: Math.round(crop.width), height: Math.round(crop.height) }
    if (values.width <= 0 || values.height <= 0) {
      setError('裁剪宽高必须大于 0')
      return
    }
    if (values.x < 0 || values.y < 0) {
      setError('裁剪起点不能是负数')
      return
    }
    if (values.x + values.width > dims.width || values.y + values.height > dims.height) {
      setError(`裁剪区域超出图片范围（当前 ${dims.width}×${dims.height}）`)
      return
    }
    void runTransform((img) => {
      const canvas = makeCanvas(values.width, values.height)
      const ctx = context2d(canvas)
      ctx.drawImage(img, values.x, values.y, values.width, values.height, 0, 0, values.width, values.height)
      return canvas
    }, `已裁剪为 ${values.width}×${values.height}`)
  }, [crop, dims, runTransform])

  const applyResize = useCallback(() => {
    const width = Math.round(resize.width)
    const height = Math.round(resize.height)
    if (width <= 0 || height <= 0) {
      setError('缩放后的宽高必须大于 0')
      return
    }
    if (width > 20000 || height > 20000) {
      setError('缩放尺寸过大（单边上限 20000 像素）')
      return
    }
    void runTransform((img) => {
      const canvas = makeCanvas(width, height)
      const ctx = context2d(canvas)
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, 0, 0, width, height)
      return canvas
    }, `已缩放到 ${width}×${height}`)
  }, [resize, runTransform])

  /** 调色 + 滤镜一次性烘焙（都在同一个 canvas 上按顺序做） */
  const applyAdjust = useCallback(async () => {
    const current = workingRef.current
    if (!current.url || busy) return
    setBusy(true)
    setError('')
    try {
      const img = await loadImage(current.url)
      const canvas = makeCanvas(img.naturalWidth, img.naturalHeight)
      const ctx = context2d(canvas)
      const css: string[] = []
      if (adjust.brightness !== 0) css.push(`brightness(${(100 + adjust.brightness) / 100})`)
      if (adjust.contrast !== 0) css.push(`contrast(${(100 + adjust.contrast) / 100})`)
      if (adjust.saturation !== 0) css.push(`saturate(${(100 + adjust.saturation) / 100})`)
      ctx.filter = css.length > 0 ? css.join(' ') : 'none'
      ctx.drawImage(img, 0, 0)
      ctx.filter = 'none'

      if (adjust.sharpen > 0) {
        const amount = adjust.sharpen / 100
        convolve(canvas, [0, -amount, 0, -amount, 1 + 4 * amount, -amount, 0, -amount, 0], 1, 0)
      }

      commitCanvas(canvas, '已应用调色')
      setAdjust(DEFAULT_ADJUST)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [adjust, busy, commitCanvas])

  const applyFilter = useCallback(
    (name: string) => {
      setFilter(name)
      if (name === 'none') {
        if (originalUrl && dirty) {
          setWorkingUrl(originalUrl)
          setDims(meta ? { width: meta.width, height: meta.height } : dims)
          setDirty(false)
          setHistory([])
          setNotice('已还原到原图')
        }
        return
      }
      void runTransform(
        (img) => {
          const canvas = makeCanvas(img.naturalWidth, img.naturalHeight)
          const ctx = context2d(canvas)
          if (name === 'gray') ctx.filter = 'grayscale(1)'
          else if (name === 'sepia') ctx.filter = 'sepia(0.85)'
          else if (name === 'blur') ctx.filter = 'blur(2px)'
          ctx.drawImage(img, 0, 0)
          ctx.filter = 'none'
          if (name === 'emboss') convolve(canvas, [-2, -1, 0, -1, 1, 1, 0, 1, 2], 1, 0)
          if (name === 'noise') addNoise(canvas, 26)
          return canvas
        },
        `已应用「${FILTER_LABEL[name] ?? name}」滤镜`
      )
    },
    [dirty, dims, meta, originalUrl, runTransform]
  )

  const undo = useCallback(() => {
    setHistory((list) => {
      if (list.length === 0) return list
      const last = list[list.length - 1]
      setWorkingUrl(last.url)
      setDims({ width: last.width, height: last.height })
      if (list.length === 1) setDirty(false)
      return list.slice(0, -1)
    })
  }, [])

  const resetAll = useCallback(() => {
    if (!originalUrl || !meta) return
    setWorkingUrl(originalUrl)
    setDims({ width: meta.width, height: meta.height })
    setDirty(false)
    setHistory([])
    setAdjust(DEFAULT_ADJUST)
    setFilter('none')
    setNotice('已还原到原图')
    setExported('')
  }, [meta, originalUrl])

  /* ---- 导出 ---- */

  const buildExportCanvas = useCallback(async (): Promise<HTMLCanvasElement> => {
    const current = workingRef.current
    if (!current.url) throw new Error('还没有可导出的图片')
    const img = await loadImage(current.url)
    let width = img.naturalWidth
    let height = img.naturalHeight
    if (maxSide > 0) {
      const scale = Math.min(1, maxSide / Math.max(width, height))
      width = Math.max(1, Math.round(width * scale))
      height = Math.max(1, Math.round(height * scale))
    }
    let canvas = makeCanvas(width, height)
    const ctx = context2d(canvas)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, width, height)
    if (outFormat === 'jpg' || outFormat === 'bmp') canvas = flattenToWhite(canvas)
    return canvas
  }, [maxSide, outFormat])

  const exportImage = useCallback(
    async (mode: 'dialog' | 'overwrite') => {
      if (!meta || busy) return
      if (mode === 'overwrite' && !dirty) {
        setError('还没有任何修改，覆盖原图没有意义')
        return
      }
      setBusy(true)
      setError('')
      setNotice('')
      try {
        const canvas = await buildExportCanvas()
        const encoded = encodeCanvas(canvas, outFormat, quality)
        const saved = await imageBridge().save({
          sourcePath: meta.sourcePath,
          bytes: encoded.bytes,
          rgba: encoded.rgba,
          format: outFormat,
          mode,
          fileName: mode === 'dialog' ? replaceExt(meta.originalName, outFormat) : undefined
        })
        if (!saved.ok) {
          if (saved.canceled) setNotice('已取消')
          else setError(saved.error ?? '导出失败')
          return
        }
        const bak = saved.backup ? `；原文件已备份到 ${saved.backup}` : ''
        setNotice(`已保存 ${formatName(outFormat)}：${saved.path}（${formatBytes(saved.bytes ?? 0)}）${bak}`)
        setExported(saved.path ?? '')
        if (mode === 'overwrite') {
          /* 覆盖后原图变了，重新读一遍，面板与新文件对齐 */
          await loadFile(meta.sourcePath, meta.tempPath ?? '')
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    },
    [buildExportCanvas, busy, dirty, loadFile, meta, outFormat, quality]
  )

  const quickConvert = useCallback(
    async (format: OutputFormat) => {
      setOutFormat(format)
      if (!meta || busy) return
      setBusy(true)
      setError('')
      try {
        const canvas = await buildExportCanvas()
        const target = format === 'png' ? canvas : flattenToWhite(canvas)
        const encoded = encodeCanvas(target, format, quality)
        const saved = await imageBridge().save({
          sourcePath: meta.sourcePath,
          bytes: encoded.bytes,
          rgba: encoded.rgba,
          format,
          mode: 'dialog',
          fileName: replaceExt(meta.originalName, format)
        })
        if (!saved.ok) {
          if (saved.canceled) setNotice('已取消')
          else setError(saved.error ?? '转换失败')
          return
        }
        setNotice(`已转换并保存：${saved.path}`)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    },
    [buildExportCanvas, busy, meta, quality]
  )

  /* ---- 批量 ---- */

  const pickBatchFiles = useCallback(async () => {
    try {
      const picked = await imageBridge().pick({ multi: true, title: '选择要批量转换的图片' })
      if (!picked.ok) {
        if (!picked.canceled) setError(picked.error ?? '选择图片失败')
        return
      }
      setBatchFiles(picked.files)
      setBatchItems([])
      setBatchProgress(`已选择 ${picked.files.length} 个文件`)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  const pickBatchFolder = useCallback(async () => {
    try {
      const picked = await imageBridge().pickFolder()
      if (!picked.ok || !picked.directory) return
      setBatchDir(picked.directory)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  const runBatch = useCallback(async () => {
    if (batchFiles.length === 0) {
      setError('先选择要批量处理的图片')
      return
    }
    if (!batchDir) {
      /* 批量一律写进指定文件夹：既不会覆盖原图，也不会把文件丢在下拉里说不清的地方 */
      setError('先选一个输出文件夹')
      return
    }
    setBusy(true)
    setError('')
    setNotice('')
    const results: BatchItem[] = []
    for (const [index, file] of batchFiles.entries()) {
      setBatchProgress(`处理中 ${index + 1}/${batchFiles.length}…`)
      try {
        const read = await imageBridge().read(file)
        if (!read.ok || !read.meta || !read.dataUrl) throw new Error(read.error ?? '读取失败')
        const img = await loadImage(read.dataUrl)
        let width = img.naturalWidth
        let height = img.naturalHeight
        if (batchMaxSide > 0) {
          const scale = Math.min(1, batchMaxSide / Math.max(width, height))
          width = Math.max(1, Math.round(width * scale))
          height = Math.max(1, Math.round(height * scale))
        }
        let canvas = makeCanvas(width, height)
        const ctx = context2d(canvas)
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(img, 0, 0, width, height)
        if (batchFormat === 'jpg' || batchFormat === 'bmp') canvas = flattenToWhite(canvas)
        const encoded = encodeCanvas(canvas, batchFormat, batchQuality)
        const saved = await imageBridge().save({
          sourcePath: read.meta.sourcePath,
          bytes: encoded.bytes,
          rgba: encoded.rgba,
          format: batchFormat,
          mode: 'directory',
          directory: batchDir,
          fileName: replaceExt(read.meta.originalName, batchFormat)
        })
        if (!saved.ok) throw new Error(saved.error ?? '保存失败')
        results.push({ file, ok: true, outPath: saved.path, bytes: saved.bytes })
      } catch (cause) {
        results.push({ file, ok: false, error: cause instanceof Error ? cause.message : String(cause) })
      }
      setBatchItems([...results])
    }
    const failed = results.filter((item) => !item.ok).length
    setBatchProgress(
      failed === 0
        ? `完成：${results.length} 个文件全部成功`
        : `完成：成功 ${results.length - failed} 个，失败 ${failed} 个`
    )
    setBusy(false)
  }, [batchDir, batchFiles, batchFormat, batchMaxSide, batchQuality])

  /* ---- 派生显示 ---- */

  const previewFilter = useMemo(() => adjustFilter(adjust), [adjust])
  const info = useMemo(() => {
    if (!meta) return ''
    const size = dims.width && dims.height ? `${dims.width}×${dims.height}` : `${meta.width}×${meta.height}`
    const changed = dirty ? '（已修改）' : ''
    return `${meta.originalName} · ${meta.formatLabel || formatName(meta.format as OutputFormat)} · ${size} · ${formatBytes(meta.bytes)}${changed}`
  }, [dims, dirty, meta])

  const canEdit = Boolean(workingUrl) && !busy

  /*
   * 浮层拖动：按住标题栏拖。
   *
   * 用 window 上的 pointermove/pointerup 而不是 setPointerCapture：
   * 标题栏里有按钮（关闭），捕获会把点击也吞掉，拖小手一抖就点不到关闭。
   * 边界只做粗保护（不让标题栏拖出屏幕外），不追求像素级贴合。
   */
  const [floatPos, setFloatPos] = useState<{ x: number; y: number } | null>(null)

  const onFloatDown = (event: {
    currentTarget: EventTarget
    clientX: number
    clientY: number
  }): void => {
    const head = event.currentTarget as HTMLElement
    if (!head) return
    const panel = head.closest('.image-float') as HTMLElement | null
    if (!panel) return
    const rect = panel.getBoundingClientRect()
    const grab = { dx: event.clientX - rect.left, dy: event.clientY - rect.top }
    const move = (e: PointerEvent): void => {
      setFloatPos({
        x: Math.max(8, Math.min(window.innerWidth - 160, e.clientX - grab.dx)),
        y: Math.max(36, Math.min(window.innerHeight - 80, e.clientY - grab.dy))
      })
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /* ---- 渲染 ---- */

  return (
    <>
      {open ? (
        <div className="image-float-wrap">
          {/*
            可拖动浮层，不再是「右侧常驻按钮 + 全屏遮罩抽屉」：
              · 遮罩留着会在阅读时挡住正文，且点一下就把面板关了；
              · 浮动面板不挡视线，拖到顺手的位置继续读。
            位置只在本次打开期间记着（关掉重开会回到默认右上角）。
          */}
          <div
            className="sb-settings-panel image-panel image-float"
            role="dialog"
            aria-modal="false"
            aria-label="图片工具"
            tabIndex={-1}
            style={floatPos ? { left: floatPos.x, top: floatPos.y, right: 'auto', bottom: 'auto' } : undefined}
          >
            <header className="sb-settings-head image-float__head" onPointerDown={onFloatDown}>
              <div className="sb-settings-head-text">
                <h2 className="sb-settings-title">图片工具</h2>
                <p className="sb-settings-subtitle">裁剪 · 调色 · 滤镜 · 格式转换 · 批量压缩</p>
              </div>
              <button className="sb-icon-btn" type="button" aria-label="关闭" onClick={() => setOpen(false)}>
                ×
              </button>
            </header>

            <div className="sb-settings-body image-panel-body">
              <section className="sb-card image-current">
                <div className="image-current-head">
                  <strong>{meta ? meta.originalName : '未载入图片'}</strong>
                  <div className="image-current-actions">
                    <button
                      type="button"
                      className="sb-btn"
                      data-tb-id="image-pick"
                      disabled={busy}
                      onClick={async () => {
                        try {
                          const picked = await imageBridge().pick({ title: '选择一张图片' })
                          if (picked.ok && picked.files[0]) await loadFile(picked.files[0], '')
                        } catch (cause) {
                          setError(cause instanceof Error ? cause.message : String(cause))
                        }
                      }}
                    >
                      选择图片…
                    </button>
                    <button
                      type="button"
                      className="sb-btn"
                      data-tb-id="image-open-in-reader"
                      disabled={!meta || busy}
                      onClick={async () => {
                        if (!meta) return
                        try {
                          const result = await window.pdfApp.open.path(meta.sourcePath)
                          if (!result.ok) setError(result.error ?? '打开失败')
                        } catch (cause) {
                          setError(cause instanceof Error ? cause.message : String(cause))
                        }
                      }}
                    >
                      在阅读器中打开
                    </button>
                  </div>
                </div>
                <p className="tools-note">{info || '打开一张图片，或点「选择图片」后开始编辑。'}</p>

                {workingUrl ? (
                  <div className="image-preview">
                    <img
                      src={workingUrl}
                      alt={meta?.originalName ?? '图片预览'}
                      style={{ filter: previewFilter }}
                      draggable={false}
                    />
                  </div>
                ) : null}

                <div className="image-row">
                  <button
                    type="button"
                    className="sb-btn"
                    data-tb-id="image-undo"
                    disabled={history.length === 0 || busy}
                    onClick={undo}
                  >
                    撤销
                  </button>
                  <button
                    type="button"
                    className="sb-btn"
                    data-tb-id="image-reset"
                    disabled={!dirty || busy}
                    onClick={resetAll}
                  >
                    还原
                  </button>
                  <span className="tools-note">{busy ? '处理中…' : filter !== 'none' ? `滤镜：${FILTER_LABEL[filter]}` : ''}</span>
                </div>
              </section>

              {error ? <p className="image-msg is-error">{error}</p> : null}
              {notice ? <p className="image-msg is-ok">{notice}</p> : null}

              <section className="sb-card">
                <h3 className="tools-title">基础编辑</h3>
                <div className="image-row">
                  <button type="button" className="sb-btn" data-tb-id="image-rotate-90" disabled={!canEdit} onClick={() => rotate(90)}>
                    旋转 90°
                  </button>
                  <button type="button" className="sb-btn" data-tb-id="image-rotate-180" disabled={!canEdit} onClick={() => rotate(180)}>
                    180°
                  </button>
                  <button type="button" className="sb-btn" data-tb-id="image-rotate-270" disabled={!canEdit} onClick={() => rotate(270)}>
                    270°
                  </button>
                </div>
                <div className="image-row">
                  <button type="button" className="sb-btn" data-tb-id="image-flip-h" disabled={!canEdit} onClick={() => flip('h')}>
                    水平翻转
                  </button>
                  <button type="button" className="sb-btn" data-tb-id="image-flip-v" disabled={!canEdit} onClick={() => flip('v')}>
                    垂直翻转
                  </button>
                </div>

                <h3 className="tools-title">裁剪（像素）</h3>
                <div className="image-grid">
                  <label>
                    左 X
                    <input
                      type="number"
                      className="image-input"
                      data-tb-id="image-crop-x"
                      value={crop.x}
                      min={0}
                      onChange={(event) => setCrop({ ...crop, x: Number(event.target.value) })}
                    />
                  </label>
                  <label>
                    上 Y
                    <input
                      type="number"
                      className="image-input"
                      data-tb-id="image-crop-y"
                      value={crop.y}
                      min={0}
                      onChange={(event) => setCrop({ ...crop, y: Number(event.target.value) })}
                    />
                  </label>
                  <label>
                    宽
                    <input
                      type="number"
                      className="image-input"
                      data-tb-id="image-crop-width"
                      value={crop.width}
                      min={1}
                      onChange={(event) => setCrop({ ...crop, width: Number(event.target.value) })}
                    />
                  </label>
                  <label>
                    高
                    <input
                      type="number"
                      className="image-input"
                      data-tb-id="image-crop-height"
                      value={crop.height}
                      min={1}
                      onChange={(event) => setCrop({ ...crop, height: Number(event.target.value) })}
                    />
                  </label>
                </div>
                <div className="image-row">
                  <button type="button" className="sb-btn" data-tb-id="image-crop" disabled={!canEdit} onClick={applyCrop}>
                    按数值裁剪
                  </button>
                </div>

                <h3 className="tools-title">缩放（像素）</h3>
                <div className="image-grid">
                  <label>
                    宽
                    <input
                      type="number"
                      className="image-input"
                      data-tb-id="image-resize-width"
                      value={resize.width}
                      min={1}
                      onChange={(event) => {
                        const width = Number(event.target.value)
                        const ratio = dims.width > 0 ? dims.height / dims.width : 0
                        setResize({ ...resize, width, height: resize.keepRatio && ratio > 0 ? Math.round(width * ratio) : resize.height })
                      }}
                    />
                  </label>
                  <label>
                    高
                    <input
                      type="number"
                      className="image-input"
                      data-tb-id="image-resize-height"
                      value={resize.height}
                      min={1}
                      onChange={(event) => {
                        const height = Number(event.target.value)
                        const ratio = dims.height > 0 ? dims.width / dims.height : 0
                        setResize({ ...resize, height, width: resize.keepRatio && ratio > 0 ? Math.round(height * ratio) : resize.width })
                      }}
                    />
                  </label>
                  <label className="image-check">
                    <input
                      type="checkbox"
                      checked={resize.keepRatio}
                      onChange={(event) => setResize({ ...resize, keepRatio: event.target.checked })}
                    />
                    保持比例
                  </label>
                </div>
                <div className="image-row">
                  <button type="button" className="sb-btn" data-tb-id="image-resize" disabled={!canEdit} onClick={applyResize}>
                    应用缩放
                  </button>
                </div>
              </section>

              <section className="sb-card">
                <h3 className="tools-title">调色</h3>
                <label className="image-slider">
                  亮度
                  <input
                    type="range"
                    data-tb-id="image-adj-brightness"
                    min={-100}
                    max={100}
                    value={adjust.brightness}
                    onChange={(event) => setAdjust({ ...adjust, brightness: Number(event.target.value) })}
                  />
                  <span>{adjust.brightness}</span>
                </label>
                <label className="image-slider">
                  对比度
                  <input
                    type="range"
                    data-tb-id="image-adj-contrast"
                    min={-100}
                    max={100}
                    value={adjust.contrast}
                    onChange={(event) => setAdjust({ ...adjust, contrast: Number(event.target.value) })}
                  />
                  <span>{adjust.contrast}</span>
                </label>
                <label className="image-slider">
                  饱和度
                  <input
                    type="range"
                    data-tb-id="image-adj-saturation"
                    min={-100}
                    max={100}
                    value={adjust.saturation}
                    onChange={(event) => setAdjust({ ...adjust, saturation: Number(event.target.value) })}
                  />
                  <span>{adjust.saturation}</span>
                </label>
                <label className="image-slider">
                  锐化
                  <input
                    type="range"
                    data-tb-id="image-adj-sharpen"
                    min={0}
                    max={100}
                    value={adjust.sharpen}
                    onChange={(event) => setAdjust({ ...adjust, sharpen: Number(event.target.value) })}
                  />
                  <span>{adjust.sharpen}</span>
                </label>
                <div className="image-row">
                  <button
                    type="button"
                    className="sb-btn"
                    data-tb-id="image-adj-apply"
                    disabled={!canEdit || (adjust.brightness === 0 && adjust.contrast === 0 && adjust.saturation === 0 && adjust.sharpen === 0)}
                    onClick={applyAdjust}
                  >
                    应用调色
                  </button>
                </div>

                <h3 className="tools-title">滤镜</h3>
                <div className="image-row image-row-wrap">
                  <button type="button" className="sb-btn" data-tb-id="image-filter-gray" disabled={!canEdit} onClick={() => applyFilter('gray')}>
                    灰度
                  </button>
                  <button type="button" className="sb-btn" data-tb-id="image-filter-sepia" disabled={!canEdit} onClick={() => applyFilter('sepia')}>
                    复古
                  </button>
                  <button type="button" className="sb-btn" data-tb-id="image-filter-blur" disabled={!canEdit} onClick={() => applyFilter('blur')}>
                    模糊
                  </button>
                  <button type="button" className="sb-btn" data-tb-id="image-filter-emboss" disabled={!canEdit} onClick={() => applyFilter('emboss')}>
                    浮雕
                  </button>
                  <button type="button" className="sb-btn" data-tb-id="image-filter-noise" disabled={!canEdit} onClick={() => applyFilter('noise')}>
                    噪点
                  </button>
                  <button type="button" className="sb-btn" data-tb-id="image-filter-none" disabled={!canEdit} onClick={() => applyFilter('none')}>
                    无滤镜
                  </button>
                </div>
              </section>

              <section className="sb-card">
                <h3 className="tools-title">转换 / 导出</h3>
                <div className="image-grid">
                  <label>
                    格式
                    <select
                      className="image-input"
                      data-tb-id="image-format"
                      value={outFormat}
                      onChange={(event) => setOutFormat(event.target.value as OutputFormat)}
                    >
                      <option value="png">PNG</option>
                      <option value="jpg">JPG</option>
                      <option value="webp">WebP</option>
                      <option value="bmp">BMP</option>
                    </select>
                  </label>
                  <label>
                    质量 {outFormat === 'png' || outFormat === 'bmp' ? '（不适用）' : quality}
                    <input
                      type="range"
                      data-tb-id="image-quality"
                      min={10}
                      max={100}
                      value={quality}
                      disabled={outFormat === 'png' || outFormat === 'bmp'}
                      onChange={(event) => setQuality(Number(event.target.value))}
                    />
                  </label>
                  <label>
                    最长边（0 = 原尺寸）
                    <input
                      type="number"
                      className="image-input"
                      data-tb-id="image-max-side"
                      min={0}
                      value={maxSide}
                      onChange={(event) => setMaxSide(Math.max(0, Number(event.target.value)))}
                    />
                  </label>
                </div>
                <div className="image-row">
                  <button
                    type="button"
                    className="sb-btn"
                    data-tb-id="image-convert-png"
                    disabled={!canEdit}
                    onClick={() => void quickConvert('png')}
                  >
                    转为 PNG…
                  </button>
                  <button
                    type="button"
                    className="sb-btn"
                    data-tb-id="image-export"
                    disabled={!canEdit}
                    onClick={() => void exportImage('dialog')}
                  >
                    另存为…
                  </button>
                  <button
                    type="button"
                    className="sb-btn image-danger"
                    data-tb-id="image-export-overwrite"
                    disabled={!canEdit || !dirty}
                    onClick={() => void exportImage('overwrite')}
                  >
                    覆盖原图（先备份）
                  </button>
                </div>
                <p className="tools-hint">
                  覆盖会先把原文件备份成 <code>&lt;同名&gt;.bak</code>，再写入新内容；备份已存在时不会覆盖备份。
                  {exported ? ` 上次保存：${exported}` : ''}
                </p>
              </section>

              <section className="sb-card">
                <h3 className="tools-title">批量转换 / 压缩</h3>
                <p className="tools-note">可多选，逐个转换；输出到同一目录时同名文件会自动加后缀，不覆盖。</p>
                <div className="image-row image-row-wrap">
                  <button type="button" className="sb-btn" data-tb-id="image-batch-pick" disabled={busy} onClick={() => void pickBatchFiles()}>
                    多选图片…
                  </button>
                  <button type="button" className="sb-btn" data-tb-id="image-batch-folder" disabled={busy} onClick={() => void pickBatchFolder()}>
                    输出目录…
                  </button>
                  <span className="tools-note">{batchDir || '（默认输出到各自所在目录）'}</span>
                </div>
                <div className="image-grid">
                  <label>
                    格式
                    <select
                      className="image-input"
                      data-tb-id="image-batch-format"
                      value={batchFormat}
                      onChange={(event) => setBatchFormat(event.target.value as OutputFormat)}
                    >
                      <option value="png">PNG</option>
                      <option value="jpg">JPG</option>
                      <option value="webp">WebP</option>
                      <option value="bmp">BMP</option>
                    </select>
                  </label>
                  <label>
                    质量 {batchQuality}
                    <input
                      type="range"
                      data-tb-id="image-batch-quality"
                      min={10}
                      max={100}
                      value={batchQuality}
                      disabled={batchFormat === 'png' || batchFormat === 'bmp'}
                      onChange={(event) => setBatchQuality(Number(event.target.value))}
                    />
                  </label>
                  <label>
                    最长边（0 = 原尺寸）
                    <input
                      type="number"
                      className="image-input"
                      data-tb-id="image-batch-max-side"
                      min={0}
                      value={batchMaxSide}
                      onChange={(event) => setBatchMaxSide(Math.max(0, Number(event.target.value)))}
                    />
                  </label>
                </div>
                <div className="image-row">
                  <button
                    type="button"
                    className="sb-btn"
                    data-tb-id="image-batch-run"
                    disabled={busy || batchFiles.length === 0}
                    onClick={() => void runBatch()}
                  >
                    开始批量处理（{batchFiles.length}）
                  </button>
                  <span className="tools-note">{batchProgress}</span>
                </div>
                {batchItems.length > 0 ? (
                  <ul className="image-batch-list">
                    {batchItems.map((item) => (
                      <li key={item.file} className={item.ok ? 'is-ok' : 'is-error'}>
                        <span className="image-batch-name">{item.file.split(/[\\/]/).pop()}</span>
                        <span className="image-batch-detail">
                          {item.ok ? `${formatBytes(item.bytes ?? 0)} → ${item.outPath ?? ''}` : item.error}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>

              <p className="tools-hint">
                支持 PNG / JPEG / WebP / BMP / GIF；ICO 视平台而定；TIFF 内置解码器不支持，会明确报错而不是白屏。
                所有处理只读写本地文件。
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
