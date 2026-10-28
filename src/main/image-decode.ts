// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 图片格式表 + 解码 + 打开元数据 —— 「图片」这条链路的唯一事实来源。
 *
 * 为什么单独一个文件：
 *   · 支持哪些格式、每种格式在本平台到底能不能解，以前散落在
 *     `src/main/index.ts` 的 IMAGE_EXTS、`pdf:pick` 的 filters、报错文案里，
 *     加一种格式要改三处，漏一处就出现「能选但打不开」；
 *   · 图片工具（`image-tools.ts`）与打开链路（`index.ts`）都要同一份判断；
 *   · 标签页/窗口标题/导出默认名要的是**原文件名**，而阅读器实际打开的是
 *     临时 PDF。两者的对应关系（`imageMetaById`）也放这里，避免 index.ts
 *     再长出一块状态。
 *
 * 解码只用 Electron 自带的 nativeImage（不引第三方图像库）：
 *   png / jpg / jpeg / webp / bmp / gif 稳定可解；
 *   ico **平台相关**（Windows 通常可以，个别文件读不出）；
 *   tif / tiff **内置解码器不支持** —— 这两种必须给出明确提示，
 *   而不是让用户对着一张白屏猜。
 */

import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import { nativeImage } from 'electron'
import type { NativeImage } from 'electron'

/* ============================================================
 * 格式表
 * ============================================================ */

export interface ImageFormatInfo {
  /** 规范扩展名（带点、小写），如 '.jpg' */
  ext: string
  /** 同一格式的其它扩展名，如 '.jpeg' / '.tiff' */
  aliases: readonly string[]
  /** 短名，给对话框与提示用 */
  label: string
  /** Electron 内置解码器在本平台能否**稳定**解码 */
  native: boolean
  /** 一句人话；native=false 时就是「为什么打不开 / 该怎么办」 */
  note: string
}

/**
 * 受支持的图片格式（顺序即对话框里的顺序）。
 *
 * 注意：`native: false` 不代表「一定打不开」，而是「不保证」。
 * 打开时仍会先真解一次，能解就照常显示（比如 Windows 上的 ico），
 * 解不出来才按这里的话术报错。
 */
export const IMAGE_FORMATS: readonly ImageFormatInfo[] = [
  {
    ext: '.png',
    aliases: [],
    label: 'PNG',
    native: true,
    note: '无损位图，支持透明'
  },
  {
    ext: '.jpg',
    aliases: ['.jpeg'],
    label: 'JPEG',
    native: true,
    note: '有损压缩位图，照片最常用'
  },
  {
    ext: '.webp',
    aliases: [],
    label: 'WebP',
    native: true,
    note: 'Google 的有损/无损格式，网页常用'
  },
  {
    ext: '.bmp',
    aliases: [],
    label: 'BMP',
    native: true,
    note: 'Windows 位图，无压缩，文件偏大'
  },
  {
    ext: '.gif',
    aliases: [],
    label: 'GIF',
    native: true,
    note: '动图只取第一帧'
  },
  {
    ext: '.ico',
    aliases: [],
    label: 'ICO',
    native: false,
    note: '图标格式，能否解码取决于平台与文件本身；读不出时请先转成 PNG'
  },
  {
    ext: '.tif',
    aliases: ['.tiff'],
    label: 'TIFF',
    native: false,
    note: '扫描件常用；内置解码器不支持 TIFF，请先转成 PNG 或 JPG'
  }
]

/** 打开链路认的全部扩展名（带点） */
export const IMAGE_OPEN_EXTS: readonly string[] = IMAGE_FORMATS.flatMap((format) => [
  format.ext,
  ...format.aliases
])

/** 文件对话框 filters 用的扩展名（不带点） */
export const IMAGE_DIALOG_EXTS: readonly string[] = IMAGE_OPEN_EXTS.map((ext) => ext.slice(1))

/** 单张图片的硬上限，防止用户误拖一个 200MB 的 PSD 改名文件把进程顶死 */
export const IMAGE_LIMITS = {
  /** 源文件字节上限 */
  maxBytes: 80 * 1024 * 1024,
  /** 像素总数上限（约 1.2 亿像素） */
  maxPixels: 120_000_000
} as const

/** 按扩展名找格式；不认识返回 null */
export function imageFormatOf(filePath: string): ImageFormatInfo | null {
  const ext = extname(filePath).toLowerCase()
  return IMAGE_FORMATS.find((format) => format.ext === ext || format.aliases.includes(ext)) ?? null
}

/** 这个路径看起来是不是一张受支持的图片（只看扩展名，不碰磁盘） */
export function isImageFile(filePath: string): boolean {
  return imageFormatOf(filePath) !== null
}

/** 扩展名 → 人类可读短名（'.jpeg' → 'JPEG'） */
export function imageExtLabel(filePath: string): string {
  return imageFormatOf(filePath)?.label ?? extname(filePath).replace('.', '').toUpperCase() ?? ''
}

/**
 * 「此格式暂不支持」的完整话术。
 *
 * 单独抽出来是因为三处要用同一套说法：打开图片、图片工具读文件、
 * 批量转换里的跳过项。文案里一定带上**下一步怎么做**，
 * 否则用户只知道打不开，不知道该拿这个文件怎么办。
 */
export function unsupportedMessage(format: ImageFormatInfo | null): string {
  if (format?.ext === '.ico') {
    return '此格式暂不支持：ICO（.ico）。当前平台的内置解码器读不出这个文件，请先用看图工具或在线转换转成 PNG / JPG 再打开。'
  }
  if (format?.ext === '.tif') {
    return '此格式暂不支持：TIFF（.tif / .tiff）。内置解码器只认 PNG / JPEG / WebP / BMP / GIF，请先用看图工具另存为 PNG 或 JPG 再打开。'
  }
  if (format) return `此格式暂不支持：${format.label}（${format.ext}）。`
  return '此格式暂不支持：未知格式'
}

/* ============================================================
 * 解码
 * ============================================================ */

export interface DecodedImage {
  /** 源图片绝对路径 */
  sourcePath: string
  /** 原文件名，如 IMG_2026.jpg */
  originalName: string
  /** 规范扩展名（'.jpeg' 归一到 '.jpg'） */
  ext: string
  format: ImageFormatInfo
  /** 解码后的位图 */
  image: NativeImage
  width: number
  height: number
  /** 源文件字节数 */
  bytes: number
  mtimeMs: number
}

/**
 * 解码一张本地图片。
 *
 * 失败一律抛中文 Error（调用方包一层「这张图片打不开：」）：
 *   · 文件不存在 / 不是文件 / 空文件；
 *   · 扩展名不认识；
 *   · 超过体积或像素上限；
 *   · 内置解码器读不出 —— 区分「格式本身不支持」与「文件损坏」，
 *     前者给替代方案，后者提示可能损坏。
 */
export function decodeImage(source: string): DecodedImage {
  const abs = resolve(source)
  if (!abs) throw new Error('图片路径为空')

  let st: Stats
  try {
    st = statSync(abs)
  } catch {
    throw new Error(`图片不存在：${abs}`)
  }
  if (!st.isFile()) throw new Error(`这不是文件：${abs}`)
  if (st.size === 0) throw new Error(`图片是空文件（0 字节）：${basename(abs)}`)

  const format = imageFormatOf(abs)
  if (!format) {
    const ext = extname(abs).toLowerCase() || '(无扩展名)'
    throw new Error(`不支持的图片格式：${ext}；支持 ${IMAGE_OPEN_EXTS.join(' / ')}`)
  }

  if (st.size > IMAGE_LIMITS.maxBytes) {
    const sizeMb = (st.size / 1024 / 1024).toFixed(1)
    const maxMb = Math.round(IMAGE_LIMITS.maxBytes / 1024 / 1024)
    throw new Error(`图片太大（${sizeMb} MB），上限 ${maxMb} MB：${basename(abs)}`)
  }

  const image = nativeImage.createFromPath(abs)
  if (image.isEmpty()) {
    throw new Error(
      format.native
        ? `无法解码这张图片：${basename(abs)}。文件可能已损坏，或扩展名与实际内容不符。`
        : unsupportedMessage(format)
    )
  }

  const size = image.getSize()
  if (!size.width || !size.height) {
    throw new Error(`图片尺寸异常（0 × 0）：${basename(abs)}`)
  }
  if (size.width * size.height > IMAGE_LIMITS.maxPixels) {
    throw new Error(`图片像素过多（${size.width} × ${size.height}），无法打开：${basename(abs)}`)
  }

  return {
    sourcePath: abs,
    originalName: basename(abs),
    ext: format.ext,
    format,
    image,
    width: size.width,
    height: size.height,
    bytes: st.size,
    mtimeMs: st.mtimeMs
  }
}

/* ============================================================
 * 临时 PDF 命名
 * ============================================================ */

/**
 * 源文件的 8 位指纹：绝对路径 + 修改时间 + 字节数。
 *
 * 8 位十六进制（32 bit）碰撞概率对「一台机器上的图片缓存」足够低，
 * 而文件名短、在标签页/最近列表里不会挤成一团。
 * 内容一变（mtime/size 变），指纹就变，旧缓存自然失效。
 */
export function imageHash8(
  source: string,
  st: { mtimeMs: number; size: number } = statSync(resolve(source))
): string {
  return createHash('sha1')
    .update(`${resolve(source)}|${st.mtimeMs}|${st.size}`)
    .digest('hex')
    .slice(0, 8)
}

/** Windows 文件名里不允许的字符统一换成下划线 */
function safeBaseName(source: string): string {
  const raw = basename(source, extname(source))
  const cleaned = raw
    .replace(/[\\/:*?"<>|]/g, '_')
    // 控制字符（0x00-0x1f）在 NTFS 里也不合法
    .replace(/[\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.slice(0, 80) || 'image'
}

/**
 * 临时 PDF 文件名：`IMG_2026-3f9a1c0d.pdf`。
 *
 * 原文件名在前 —— 这样即使用户在任务管理器/缓存目录里看到它，
 * 也能一眼认出是哪张图；hash 只负责区分「同名但内容不同」。
 */
export function tempPdfName(source: string, hash8: string = imageHash8(source)): string {
  return `${safeBaseName(source)}-${hash8}.pdf`
}

/* ============================================================
 * 打开元数据：临时 PDF ↔ 原图
 * ============================================================ */

export interface ImageOpenMeta {
  /** 原图绝对路径 */
  sourcePath: string
  /** 原文件名（标签页、最近文件、导出默认名都用它） */
  originalName: string
  /** 实际打开的临时 PDF 路径 */
  tempPath: string
  /** 渲染层据此判断「这是图片」 */
  isImage: true
  /** 规范扩展名，如 '.jpg' */
  format: string
  /** 短名，如 'JPEG' */
  formatLabel: string
  width: number
  height: number
  bytes: number
  openedAt: number
}

/**
 * 容量上限。
 *
 * 一个窗口通常只开几张图；64 条足够覆盖「开过、又切回去」的来回操作，
 * 同时保证长跑进程里这个 Map 不会无限长。
 */
const MAX_META = 64

const metaByTempPath = new Map<string, ImageOpenMeta>()

/** 记一条「临时 PDF ← 原图」映射（同一临时路径覆盖旧记录） */
export function rememberImageMeta(meta: ImageOpenMeta): void {
  const key = resolve(meta.tempPath)
  metaByTempPath.delete(key)
  metaByTempPath.set(key, meta)
  while (metaByTempPath.size > MAX_META) {
    const oldest = metaByTempPath.keys().next().value
    if (oldest === undefined) break
    metaByTempPath.delete(oldest)
  }
}

/** 按临时 PDF 路径取原图信息；不是图片（或没记录）返回 null */
export function getImageMeta(tempPath: string): ImageOpenMeta | null {
  if (!tempPath) return null
  const key = resolve(tempPath)
  const cached = metaByTempPath.get(key)
  if (cached) return cached

  /* 进程重启后内存里没有：退到旁车文件上找一次，找到就补回内存 */
  const fromDisk = readImageMetaSidecar(key)
  if (fromDisk) rememberImageMeta(fromDisk)
  return fromDisk
}

/**
 * 元数据旁车文件。
 *
 * 图片缓存（userData/image-cache）是跨进程重启保留的，而上面的 Map 只活在内存里。
 * 重启后从「最近文件」再点开一张图，如果没有旁车就会变成「有临时 PDF、没有原图信息」，
 * 标签页只好像显示 IMG_2026-ab12cd34.pdf。所以打开时顺手把 meta 写成
 * `<临时PDF>.json`，getImageMeta 找不到内存时读它。
 */
export function metaSidecarPath(tempPath: string): string {
  return `${tempPath}.json`
}

/** 写旁车；失败不影响打开（最多重启后少一条原图信息） */
export function writeImageMetaSidecar(meta: ImageOpenMeta): void {
  try {
    writeFileSync(metaSidecarPath(meta.tempPath), JSON.stringify(meta), 'utf8')
  } catch {
    /* 旁车是加速信息，不是打开图片的必要条件 */
  }
}

/** 读旁车；文件损坏 / 不是图片 / 字段缺失都当没有 */
export function readImageMetaSidecar(tempPath: string): ImageOpenMeta | null {
  try {
    const parsed = JSON.parse(readFileSync(metaSidecarPath(tempPath), 'utf8')) as Partial<ImageOpenMeta>
    if (!parsed || parsed.isImage !== true) return null
    if (!parsed.sourcePath || !parsed.originalName || !parsed.format) return null
    if (!Number.isFinite(parsed.width) || !Number.isFinite(parsed.height)) return null
    return { ...(parsed as ImageOpenMeta), tempPath }
  } catch {
    return null
  }
}
