// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 「图片」工具箱的主进程一半 —— 只做文件与安全相关的事。
 *
 * 分工（这是刻意的）：
 *   · 渲染层（ImageToolsPanel.tsx）负责**像素运算**：旋转/翻转/裁剪/缩放、
 *     调色、滤镜、以及 PNG / JPEG / WebP 编码 —— 用离屏 canvas 做，
 *     Chromium 自带全套实现，既不引第三方库，也不受 nativeImage 没有
 *     滤镜 API 的限制；
 *   · 主进程负责**磁盘与安全**：读原始字节、校验路径、校验目标目录可写、
 *     覆盖前备份、原子写入、真正落盘。
 *
 * 为什么不让主进程算像素：nativeImage 只能 resize / crop / toJPEG / toPNG，
 * 没有 brightness/contrast/sharpen，也**不能编码 WebP**；这些在渲染进程
 * 的 canvas 上都是现成的。
 *
 * 安全约定（和 preload 的注释呼应）：
 *   · 只接受本地文件路径，`http(s)://` / `data:` 之类一律拒绝；
 *   · 一切写入前先 `assertWritableDir`（真实写一个探针文件再删掉 ——
 *     Windows 上 accessSync(W_OK) 对只读目录并不可靠）；
 *   · 覆盖已有文件前先备份 `<同名>.bak`（已存在则不覆盖，保住最初的原件）；
 *   · 先写同目录临时文件再改名，避免写一半被中断留下半个文件；
 *   · 失败一律返回 `{ ok:false, error }`，绝不静默。
 */

import { constants } from 'node:fs'
import {
  accessSync,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import type { Stats } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { decodeImage, getImageMeta, IMAGE_DIALOG_EXTS } from './image-decode'
import type { ImageOpenMeta } from './image-decode'
import { friendly } from './pdf-tools'

/* ============================================================
 * 类型（就地定义：不碰 src/shared/**）
 * ============================================================ */

export type ImageOutputFormat = 'png' | 'jpg' | 'webp' | 'bmp'

export type ImageSaveMode = 'dialog' | 'overwrite' | 'directory'

/** 渲染层 → 主进程的保存请求 */
export interface ImageSaveRequest {
  /** 原图绝对路径（决定默认文件名与「覆盖」的目标） */
  sourcePath: string
  /** 已编码好的图片字节；BMP 可以不传，改传 rgba */
  bytes?: Uint8Array | ArrayBuffer | number[]
  /** 原始 RGBA 像素（canvas.getImageData 的结果），仅 BMP 用 */
  rgba?: {
    bytes: Uint8Array | ArrayBuffer | number[]
    width: number
    height: number
  }
  format: ImageOutputFormat
  mode: ImageSaveMode
  /** 另存为的默认文件名（不含路径） */
  fileName?: string
  /** mode='directory' 时的输出目录 */
  directory?: string
  /** mode='dialog' 时的显式目标路径（自动化用；正常交互不传） */
  targetPath?: string
}

export interface ImageSaveResult {
  ok: boolean
  path?: string
  dir?: string
  backup?: string
  bytes?: number
  canceled?: boolean
  error?: string
}

/** 面板展示 + 编辑所需的信息 */
export interface ImageFileMeta {
  sourcePath: string
  originalName: string
  isImage: true
  /** 规范扩展名，如 '.jpg' */
  format: string
  formatLabel: string
  width: number
  height: number
  bytes: number
  mtimeMs: number
}

export interface ImageReadResult {
  ok: boolean
  /** 可直接喂给 <img> / canvas 的 data URL */
  dataUrl?: string
  /** true 表示原格式浏览器不认（tiff / ico），已转成 PNG */
  converted?: boolean
  meta?: ImageFileMeta
  error?: string
}

export interface ImagePickResult {
  ok: boolean
  canceled?: boolean
  files: string[]
  error?: string
}

export interface ImagePickFolderResult {
  ok: boolean
  canceled?: boolean
  directory?: string
  error?: string
}

/* ============================================================
 * 常量与校验
 * ============================================================ */

/** 保存时单张图片的字节上限（RGBA 会被 BMP 放大，所以比读取上限宽松） */
const MAX_SAVE_BYTES = 400 * 1024 * 1024

const OUTPUT_FORMATS: readonly ImageOutputFormat[] = ['png', 'jpg', 'webp', 'bmp']

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff'
}

const FORMAT_LABEL: Record<ImageOutputFormat, string> = {
  png: 'PNG 图片',
  jpg: 'JPEG 图片',
  webp: 'WebP 图片',
  bmp: 'BMP 图片'
}

/** 拒绝 URL / data URL 之类的「非本地」输入 */
function assertLocalPath(input: string): string {
  const raw = String(input ?? '').trim()
  if (!raw) throw new Error('没有给出文件路径')
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^data:/i.test(raw)) {
    throw new Error(`只支持本地文件，不接受网络地址：${raw.slice(0, 80)}`)
  }
  const abs = resolve(raw)
  if (!isAbsolute(abs)) throw new Error(`无法解析为绝对路径：${raw}`)
  return abs
}

function toBuffer(input: Uint8Array | ArrayBuffer | number[] | undefined): Buffer {
  if (input instanceof Uint8Array) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  }
  if (input instanceof ArrayBuffer) return Buffer.from(input)
  if (Array.isArray(input)) return Buffer.from(input)
  throw new Error('没有收到图片数据（bytes 为空）')
}

function formatExt(format: ImageOutputFormat): string {
  return `.${format}`
}

/** 目标路径没有正确扩展名时补上（用户在「另存为」里把扩展名删了很常见） */
function ensureExt(target: string, format: ImageOutputFormat): string {
  const ext = extname(target).toLowerCase()
  if (ext === formatExt(format) || (format === 'jpg' && ext === '.jpeg')) return target
  return `${target}${formatExt(format)}`
}

function defaultFileName(sourcePath: string, format: ImageOutputFormat): string {
  const base = basename(sourcePath, extname(sourcePath)) || 'image'
  return `${base}${formatExt(format)}`
}

/* ============================================================
 * 写盘：可写校验 / 备份 / 原子写
 * ============================================================ */

/**
 * 目标目录必须存在、是目录、且**真的**能写。
 *
 * 为什么写探针文件：Windows 上目录的「只读」属性和 ACL 是两回事，
 * `accessSync(dir, W_OK)` 经常对实际写不进去的目录返回成功；
 * 真写一个随机名的小文件再删掉，是唯一可靠的探测。
 */
export function assertWritableDir(dir: string): void {
  const abs = resolve(dir)
  let st: Stats
  try {
    st = statSync(abs)
  } catch {
    throw new Error(`目标目录不存在：${abs}`)
  }
  if (!st.isDirectory()) throw new Error(`目标不是文件夹：${abs}`)

  try {
    accessSync(abs, constants.W_OK)
  } catch {
    throw new Error(`目标目录不可写：${abs}`)
  }

  const probe = join(abs, `.dsh-write-probe-${process.pid}-${Date.now().toString(36)}.tmp`)
  try {
    writeFileSync(probe, 'ok', { flag: 'wx' })
  } catch {
    throw new Error(`目标目录不可写（写入测试失败）：${abs}`)
  } finally {
    try {
      rmSync(probe, { force: true })
    } catch {
      /* 探针删不掉不影响主流程 */
    }
  }
}

/**
 * 覆盖前备份到 `<同名>.bak`（如 `IMG_2026.jpg.bak`）。
 *
 * 已存在就**不再覆盖**：用户可能已经导出过好几次，这个 .bak 是最初的原件，
 * 拿后来改过的版本去覆盖它等于把唯一的底稿弄丢。
 */
export function backupFile(target: string): string {
  const bak = `${target}.bak`
  if (existsSync(bak)) return bak
  copyFileSync(target, bak)
  return bak
}

/** 原子写：同目录临时文件 → rename；rename 因目标已存在失败时退回复制 */
export function writeFileAtomic(target: string, data: Buffer): void {
  const tmp = `${target}.${process.pid.toString(36)}${Date.now().toString(36)}.tmp`
  try {
    writeFileSync(tmp, data)
    try {
      renameSync(tmp, target)
    } catch {
      copyFileSync(tmp, target)
      rmSync(tmp, { force: true })
    }
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw error
  }
}

/** 目录模式下不覆盖已有文件，改用 `名字-2.png` 这类后缀 */
function avoidClobber(target: string): string {
  if (!existsSync(target)) return target
  const dir = dirname(target)
  const ext = extname(target)
  const base = basename(target, ext)
  for (let index = 2; index <= 999; index += 1) {
    const next = join(dir, `${base}-${index}${ext}`)
    if (!existsSync(next)) return next
  }
  throw new Error(`同名文件太多，无法为它生成新文件名：${basename(target)}`)
}

/* ============================================================
 * BMP 编码（渲染层只给 RGBA，格式头由主进程拼）
 * ============================================================ */

/**
 * RGBA → 24 位 BMP（BITMAPINFOHEADER，自下而上，行按 4 字节对齐）。
 *
 * 24 位没有 alpha 通道，这里按**白底**合成 —— 导出透明 PNG 到 BMP 时
 * 透明区域变成白色而不是黑色（黑色几乎总是错的那个）。
 */
export function encodeBmp(rgba: Uint8Array, width: number, height: number): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`BMP 编码失败：尺寸非法（${width} × ${height}）`)
  }
  if (rgba.length < width * height * 4) {
    throw new Error(`BMP 编码失败：像素数据不足（需要 ${width * height * 4} 字节，实际 ${rgba.length}）`)
  }

  const rowSize = Math.ceil((width * 3) / 4) * 4
  const pixelBytes = rowSize * height
  const fileHeaderSize = 14
  const infoHeaderSize = 40
  const out = Buffer.alloc(fileHeaderSize + infoHeaderSize + pixelBytes)

  out.write('BM', 0, 'ascii')
  out.writeUInt32LE(out.length, 2)
  out.writeUInt32LE(fileHeaderSize + infoHeaderSize, 10)
  out.writeUInt32LE(infoHeaderSize, 14)
  out.writeInt32LE(width, 18)
  out.writeInt32LE(height, 22) /* 正数 = 行序自下而上 */
  out.writeUInt16LE(1, 26)
  out.writeUInt16LE(24, 28)
  out.writeUInt32LE(0, 30) /* BI_RGB，无压缩 */
  out.writeUInt32LE(pixelBytes, 34)
  out.writeInt32LE(2835, 38) /* 72 DPI */
  out.writeInt32LE(2835, 42)

  for (let y = 0; y < height; y += 1) {
    const srcRow = (height - 1 - y) * width * 4
    const dstRow = fileHeaderSize + infoHeaderSize + y * rowSize
    for (let x = 0; x < width; x += 1) {
      const s = srcRow + x * 4
      const d = dstRow + x * 3
      const alpha = rgba[s + 3] / 255
      out[d] = Math.round(rgba[s + 2] * alpha + 255 * (1 - alpha))
      out[d + 1] = Math.round(rgba[s + 1] * alpha + 255 * (1 - alpha))
      out[d + 2] = Math.round(rgba[s] * alpha + 255 * (1 - alpha))
    }
  }

  return new Uint8Array(out)
}

/* ============================================================
 * 保存（核心，可脱离 Electron 直接测）
 * ============================================================ */

function normalizeSaveRequest(payload: unknown): ImageSaveRequest {
  const raw = (payload ?? {}) as Partial<ImageSaveRequest>
  const format = String(raw.format ?? '').toLowerCase() as ImageOutputFormat
  if (!OUTPUT_FORMATS.includes(format)) {
    throw new Error(`不支持的导出格式：${String(raw.format ?? '(空)')}（只支持 png / jpg / webp / bmp）`)
  }
  const mode = String(raw.mode ?? 'dialog') as ImageSaveMode
  if (!['dialog', 'overwrite', 'directory'].includes(mode)) {
    throw new Error(`不支持的保存方式：${mode}`)
  }
  return {
    sourcePath: assertLocalPath(String(raw.sourcePath ?? '')),
    bytes: raw.bytes,
    rgba: raw.rgba,
    format,
    mode,
    fileName: raw.fileName ? basename(String(raw.fileName)) : undefined,
    directory: raw.directory ? resolve(String(raw.directory)) : undefined,
    targetPath: raw.targetPath ? resolve(String(raw.targetPath)) : undefined
  }
}

/** 把请求编码后的字节写进已确定的目标路径 */
function writeImage(request: ImageSaveRequest, target: string): ImageSaveResult {
  const data = request.rgba
    ? Buffer.from(
        encodeBmp(
          new Uint8Array(toBuffer(request.rgba.bytes)),
          Number(request.rgba.width),
          Number(request.rgba.height)
        )
      )
    : toBuffer(request.bytes)

  if (data.length === 0) throw new Error('没有可写入的图片数据（编码结果为空）')
  if (data.length > MAX_SAVE_BYTES) {
    throw new Error(`图片数据过大（${(data.length / 1024 / 1024).toFixed(1)} MB），已拒绝写入`)
  }

  const dir = dirname(target)
  assertWritableDir(dir)

  if (existsSync(target)) {
    const st = statSync(target)
    if (st.isDirectory()) throw new Error(`目标是一个文件夹，不能当文件写：${target}`)
  }

  const backup = existsSync(target) ? backupFile(target) : undefined

  try {
    writeFileAtomic(target, data)
  } catch (error) {
    throw new Error(`写入失败：${target}（${friendly(error)}）`)
  }

  const written = statSync(target).size
  if (written !== data.length) {
    throw new Error(`写入不完整：${basename(target)} 期望 ${data.length} 字节，实际 ${written} 字节`)
  }

  return { ok: true, path: target, dir, backup, bytes: written }
}

/**
 * 保存入口：先决定目标路径（可能弹「另存为」），再落盘。
 *
 * 三种模式：
 *   · dialog    —— 弹系统另存为；给了 targetPath 就不弹（自动化用）；
 *   · overwrite —— 覆盖原图，覆盖前备份 `<原图>.bak`；
 *   · directory —— 写进指定目录（批量用），同名时自动加 `-2` 后缀，绝不覆盖。
 */
export async function saveImage(
  win: BrowserWindow | null,
  payload: unknown
): Promise<ImageSaveResult> {
  const request = normalizeSaveRequest(payload)

  if (request.mode === 'dialog') {
    let target = request.targetPath ?? ''
    if (!target) {
      const picked = await showSaveDialog(
        win,
        '导出图片',
        join(dirname(request.sourcePath), request.fileName ?? defaultFileName(request.sourcePath, request.format)),
        request.format
      )
      if (!picked) return { ok: false, canceled: true, error: undefined }
      target = picked
    }
    return writeImage(request, ensureExt(target, request.format))
  }

  if (request.mode === 'overwrite') {
    const target = request.sourcePath
    if (!existsSync(target)) throw new Error(`原图不存在，无法覆盖：${target}`)
    return writeImage(request, target)
  }

  const dir = request.directory ?? dirname(request.sourcePath)
  assertWritableDir(dir)
  const name = ensureExt(request.fileName ?? defaultFileName(request.sourcePath, request.format), request.format)
  const target = avoidClobber(join(dir, basename(name)))
  return writeImage(request, target)
}

async function showSaveDialog(
  win: BrowserWindow | null,
  title: string,
  defaultPath: string,
  format: ImageOutputFormat
): Promise<string | null> {
  const options = {
    title,
    defaultPath,
    filters: [{ name: FORMAT_LABEL[format], extensions: [format === 'jpg' ? 'jpg' : format] }]
  }
  const result =
    win && !win.isDestroyed()
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return null
  return result.filePath
}

/* ============================================================
 * 读取（给面板做预览 / 编辑用）
 * ============================================================ */

function metaOf(decoded: ReturnType<typeof decodeImage>): ImageFileMeta {
  return {
    sourcePath: decoded.sourcePath,
    originalName: decoded.originalName,
    isImage: true,
    format: decoded.ext,
    formatLabel: decoded.format.label,
    width: decoded.width,
    height: decoded.height,
    bytes: decoded.bytes,
    mtimeMs: decoded.mtimeMs
  }
}

/**
 * 读一张图片给渲染层。
 *
 * 常规格式直接返回**原始字节**的 data URL：不重编码，画质与 EXIF 方向
 * 都交给 Chromium 自己处理，也省一次编解码。
 * TIFF / ICO 这类浏览器不认的原格式，走 nativeImage 解一次再转 PNG，
 * 保证 <img> 一定能显示。
 */
export function readImageFile(filePath: string): ImageReadResult {
  const abs = assertLocalPath(filePath)
  const decoded = decodeImage(abs)

  if (decoded.ext === '.tif' || decoded.ext === '.ico') {
    return {
      ok: true,
      dataUrl: decoded.image.toDataURL(),
      converted: true,
      meta: metaOf(decoded)
    }
  }

  const ext = extname(abs).toLowerCase()
  const mime = MIME_BY_EXT[ext]
  if (!mime) throw new Error(`不支持的图片格式：${ext || '(无扩展名)'}`)
  const bytes = readFileSync(abs)
  return {
    ok: true,
    dataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
    converted: false,
    meta: metaOf(decoded)
  }
}

/** 按「当前打开的临时 PDF 路径」或「图片源路径」取元数据 */
export function lookupImageMeta(filePath: string): ImageOpenMeta | ImageFileMeta | null {
  const abs = assertLocalPath(filePath)
  const known = getImageMeta(abs)
  if (known) return known
  if (!existsSync(abs)) return null
  try {
    return metaOf(decodeImage(abs))
  } catch {
    return null
  }
}

/* ============================================================
 * IPC
 * ============================================================ */

function wrap<T extends object>(fn: () => Promise<T> | T): Promise<T | { ok: false; error: string }> {
  return Promise.resolve()
    .then(fn)
    .catch((error: unknown) => ({ ok: false as const, error: friendly(error) }))
}

/**
 * 注册 `img:*` 通道。
 *
 * 注意：`img:save` 是唯一会写盘的通道，所有校验都在 `saveImage` 里，
 * 这里不再重复 —— 这样自动化脚本可以绕过对话框直接驱动 `saveImage`。
 */
export function registerImageToolsIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('img:read', (_event, filePath: unknown) =>
    wrap(() => readImageFile(String(filePath ?? '')))
  )

  ipcMain.handle('img:meta', (_event, filePath: unknown) =>
    wrap(() => ({ ok: true as const, meta: lookupImageMeta(String(filePath ?? '')) }))
  )

  ipcMain.handle('img:pick', async (_event, options: unknown) => {
    const raw = (options ?? {}) as { multi?: boolean; title?: string }
    const win = getWindow()
    const dialogOptions: Electron.OpenDialogOptions = {
      title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : '选择图片',
      filters: [
        { name: '图片', extensions: [...IMAGE_DIALOG_EXTS] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: raw.multi ? ['openFile', 'multiSelections'] : ['openFile']
    }
    const picked =
      win && !win.isDestroyed()
        ? await dialog.showOpenDialog(win, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions)
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: false as const, canceled: true, files: [] as string[] }
    }
    return { ok: true as const, files: picked.filePaths }
  })

  ipcMain.handle('img:pick-folder', async () => {
    const win = getWindow()
    const dialogOptions: Electron.OpenDialogOptions = {
      title: '选择输出文件夹',
      properties: ['openDirectory', 'createDirectory']
    }
    const picked =
      win && !win.isDestroyed()
        ? await dialog.showOpenDialog(win, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions)
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: false as const, canceled: true }
    }
    return { ok: true as const, directory: picked.filePaths[0] }
  })

  ipcMain.handle('img:save', (_event, payload: unknown) =>
    wrap(() => saveImage(getWindow(), payload))
  )
}
