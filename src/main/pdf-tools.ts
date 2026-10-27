// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * PDF 工具箱的主进程实现。
 *
 * 提供：合并 / 拆分 / 加水印 / 压缩 / 加密 / 解密 /
 *       PDF↔图片 / Office→PDF。
 *
 * ── 为什么这些操作都放主进程 ────────────────────────────────
 *   渲染层开着 contextIsolation，拿不到 fs，也不能拉起外部程序；
 *   而这些操作的本质都是「读文件 → 改 → 写文件」，天然属于主进程。
 *   渲染层只负责两件它擅长的事：用 pdf.js 把页面画成图（压缩、转图片），
 *   以及用 canvas 把中文水印画成 PNG（见 renderer/src/pdf-tools.ts）。
 *
 * ── 为什么用 @cantoo/pdf-lib 而不是 pdf-lib ──────────────────
 *   上游 pdf-lib 1.17 完全不支持加密（issue #243/#917/#1680 至今未合入）。
 *   @cantoo/pdf-lib 是它的维护分支，API 兼容，另外提供：
 *     · `PDFDocument.load(bytes, { password })` —— 带密码解密
 *     · `pdfDoc.encrypt({ userPassword, ownerPassword, permissions })`
 *   因此「加保护 / 去保护」不需要引入 qpdf、mupdf 之类的原生依赖。
 *
 * ── 解密为什么是「重建文档」而不是原地去 /Encrypt ─────────────
 *   实测：把带密码的文档 load 进来再 save，/Encrypt 字典仍然在，
 *   保存出来的文件依旧要密码（加密在序列化层是绑定的，库没有公开的
 *   removeEncryption）。所以「移除保护」= 把每一页 copyPages 到一个全新
 *   文档再保存 —— 内容流在加载时已解密，新文档天然是明文。
 *   代价：书签、表单域、部分元数据不随页面复制（页内容完整保留）。
 */

import { app, dialog, ipcMain, nativeImage, BrowserWindow } from 'electron'
import { PDFDocument, degrees } from '@cantoo/pdf-lib'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'
import type {
  CompressPayload,
  DecryptPayload,
  EncryptPayload,
  ImagesToPdfPayload,
  MergePayload,
  OfficeConverterInfo,
  OfficeToPdfPayload,
  SaveImagesPayload,
  SplitPayload,
  ToolResult,
  WatermarkPayload
} from '@shared/pdf-tools'

/* ============================================================
 * 小工具
 * ============================================================ */

/** 给用户看的错误文案：把异常统一成一句中文 */
export function friendly(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (/password|encrypted|decrypt/i.test(raw) && /incorrect|wrong|password/i.test(raw)) {
    return '密码不正确，或文档使用了不支持的加密方式'
  }
  if (/encrypted/i.test(raw)) return '文档已加密，请先在「加密 / 解密」里移除保护'
  return raw
}

/** 读 PDF 字节 */
export function readBytes(filePath: string): Uint8Array {
  return new Uint8Array(readFileSync(filePath))
}

/** 校验是一个存在的 PDF 文件 */
export function assertPdf(filePath: string): string {
  const abs = resolve(filePath)
  if (!existsSync(abs)) throw new Error(`文件不存在：${abs}`)
  if (extname(abs).toLowerCase() !== '.pdf') throw new Error(`不是 PDF 文件：${basename(abs)}`)
  if (statSync(abs).size === 0) throw new Error(`文件是空的：${basename(abs)}`)
  return abs
}

/**
 * 打开一个 PDF。
 *
 * 返回的 `doc` 保证是**可安全修改并保存**的文档：
 *   · 明文文档：原样返回（load 的结果）；
 *   · 加密文档 + 给了密码：重建一份明文文档（见文件头说明）；
 *   · 加密文档 + 没给密码：抛错，提示先去解密。
 *
 * `encrypted` 告诉调用方「这份文件原来是不是加密的」，用于结果提示。
 */
export async function openPdf(
  filePath: string,
  password?: string
): Promise<{ doc: PDFDocument; encrypted: boolean; pages: number }> {
  const bytes = readBytes(filePath)

  /* 先探一下是不是加密的：ignoreEncryption 下 isEncrypted 才是准的 */
  const probe = await PDFDocument.load(bytes, { ignoreEncryption: true })
  if (!probe.isEncrypted) {
    return { doc: probe, encrypted: false, pages: probe.getPageCount() }
  }

  if (!password) {
    throw new Error('文档已加密，请先在「加密 / 解密」里移除保护，或输入密码')
  }

  /* 带密码重新加载 → 解密到内存，再整篇复制到新文档，得到明文 */
  const decrypted = await PDFDocument.load(bytes, { password })
  const rebuilt = await PDFDocument.create()
  const pages = await rebuilt.copyPages(decrypted, decrypted.getPageIndices())
  for (const page of pages) rebuilt.addPage(page)
  copyMetadata(decrypted, rebuilt)
  return { doc: rebuilt, encrypted: true, pages: rebuilt.getPageCount() }
}

/** 把能安全复制的元数据搬过去（copyPages 不带这些） */
export function copyMetadata(from: PDFDocument, to: PDFDocument): void {
  const read = (fn: () => string): string => {
    try {
      return fn()
    } catch {
      return ''
    }
  }
  const title = read(() => from.getTitle() ?? '')
  const author = read(() => from.getAuthor() ?? '')
  const subject = read(() => from.getSubject() ?? '')
  const keywords = read(() => from.getKeywords() ?? '')
  const creator = read(() => from.getCreator() ?? '')
  const producer = read(() => from.getProducer() ?? '')
  if (title) to.setTitle(title)
  if (author) to.setAuthor(author)
  if (subject) to.setSubject(subject)
  if (keywords) to.setKeywords(keywords.split(/[,，;；]\s*/).filter(Boolean))
  if (creator) to.setCreator(creator)
  if (producer) to.setProducer(producer)
}

/** 确保输出目录存在 */
export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 弹「另存为」，返回目标路径；取消返回 null */
export async function askSavePath(
  win: BrowserWindow | null,
  title: string,
  defaultPath: string,
  ext: string
): Promise<string | null> {
  /* 过滤器名按扩展名给，保存框里才不会把 .docx 显示成「图片」 */
  const filterName: Record<string, string> = {
    pdf: 'PDF 文档',
    png: 'PNG 图片',
    jpg: 'JPEG 图片',
    jpeg: 'JPEG 图片',
    docx: 'Word 文档',
    xlsx: 'Excel 表格',
    txt: '文本文件',
    html: '网页文件',
    htm: '网页文件'
  }
  const result = await dialog.showSaveDialog(win ?? undefined!, {
    title,
    defaultPath,
    filters: [{ name: filterName[ext.toLowerCase()] ?? `${ext.toUpperCase()} 文件`, extensions: [ext] }]
  })
  if (result.canceled || !result.filePath) return null
  return result.filePath
}

/** 目标路径与源文件相同 → 拒绝（避免把原稿写坏） */
export function assertNotSame(target: string, source: string): void {
  if (resolve(target) === resolve(source)) {
    throw new Error('不能覆盖原文件，请换一个文件名')
  }
}

/* ============================================================
 * 合并
 * ============================================================ */

async function mergePdfs(win: BrowserWindow | null, payload: MergePayload): Promise<ToolResult> {
  let inputs = (payload.inputs ?? []).map((p) => resolve(p)).filter((p) => existsSync(p))
  if (inputs.length === 0) {
    const picked = await dialog.showOpenDialog(win ?? undefined!, {
      title: '选择要合并的 PDF（可多选，按选择顺序合并）',
      filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
      properties: ['openFile', 'multiSelections']
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true }
    inputs = picked.filePaths
  }
  if (inputs.length < 2) return { ok: false, error: '合并至少需要两个 PDF 文件' }

  let target = payload.targetPath ? resolve(payload.targetPath) : ''
  if (!target) {
    const picked = await askSavePath(
      win,
      '合并结果另存为',
      join(dirname(inputs[0]), '合并结果.pdf'),
      'pdf'
    )
    if (!picked) return { ok: false, canceled: true }
    target = picked
  }
  for (const input of inputs) assertNotSame(target, input)

  const out = await PDFDocument.create()
  let totalPages = 0
  for (const input of inputs) {
    const abs = assertPdf(input)
    const { doc } = await openPdf(abs)
    const pages = await out.copyPages(doc, doc.getPageIndices())
    for (const page of pages) out.addPage(page)
    totalPages += pages.length
  }

  await writeFile(target, await out.save())
  return {
    ok: true,
    path: target,
    info: { 合并文件数: inputs.length, 总页数: totalPages }
  }
}

/* ============================================================
 * 拆分
 * ============================================================ */

/**
 * 解析页码范围："1-3,5,8-10" → [[1,3],[5,5],[8,10]]
 *
 * 校验全部范围落在 1..max 内，有任何一段非法就整体报错
 * （部分成功对用户最难受：拿到一半文件却不知道少了哪几页）。
 */
function parseRanges(text: string, max: number): Array<{ from: number; to: number; label: string }> {
  const groups: Array<{ from: number; to: number; label: string }> = []
  const parts = text
    .split(/[,，;；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.length === 0) throw new Error('请填写页码范围，例如 1-3,5,8-10')

  for (const part of parts) {
    const match = /^(\d+)(?:\s*[-–~]\s*(\d+))?$/.exec(part)
    if (!match) throw new Error(`页码格式不正确：${part}（应形如 3 或 1-5）`)
    const from = Number(match[1])
    const to = match[2] ? Number(match[2]) : from
    if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error(`页码不合法：${part}`)
    if (from < 1 || to < from) throw new Error(`页码范围不合法：${part}`)
    if (to > max) throw new Error(`超出文档页数（共 ${max} 页）：${part}`)
    groups.push({ from, to, label: from === to ? `${from}` : `${from}-${to}` })
  }
  return groups
}

async function splitPdf(win: BrowserWindow | null, payload: SplitPayload): Promise<ToolResult> {
  let source = payload.sourcePath ? resolve(payload.sourcePath) : ''
  if (!source) {
    const picked = await dialog.showOpenDialog(win ?? undefined!, {
      title: '选择要拆分的 PDF',
      filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
      properties: ['openFile']
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true }
    source = picked.filePaths[0]
  }
  source = assertPdf(source)

  let outputDir = payload.outputDir ? resolve(payload.outputDir) : ''
  if (!outputDir) {
    const picked = await dialog.showOpenDialog(win ?? undefined!, {
      title: '选择拆分结果的保存文件夹',
      defaultPath: dirname(source),
      properties: ['openDirectory', 'createDirectory']
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true }
    outputDir = picked.filePaths[0]
  }
  ensureDir(outputDir)

  const { doc, pages } = await openPdf(source)
  const base = basename(source, extname(source))
  const written: string[] = []

  if (payload.mode === 'each') {
    for (let i = 0; i < pages; i += 1) {
      const out = await PDFDocument.create()
      const [page] = await out.copyPages(doc, [i])
      out.addPage(page)
      const target = join(outputDir, `${base}_第${i + 1}页.pdf`)
      await writeFile(target, await out.save())
      written.push(target)
    }
    return { ok: true, paths: written, info: { 拆分页数: pages, 输出目录: outputDir } }
  }

  const groups = parseRanges(payload.ranges ?? '', pages)
  for (const group of groups) {
    const out = await PDFDocument.create()
    const indices: number[] = []
    for (let i = group.from; i <= group.to; i += 1) indices.push(i - 1)
    const copied = await out.copyPages(doc, indices)
    for (const page of copied) out.addPage(page)
    const target = join(outputDir, `${base}_${group.label}.pdf`)
    await writeFile(target, await out.save())
    written.push(target)
  }
  return {
    ok: true,
    paths: written,
    info: { 提取段数: written.length, 输出目录: outputDir }
  }
}

/* ============================================================
 * 水印
 * ============================================================ */

/**
 * 把旋转后的矩形摆到指定中心点。
 *
 * pdf-lib 的 drawImage 以图片左下角为原点施加 translate → rotate → scale，
 * 所以「图心落在 (cx, cy)」需要反解：
 *   x = cx - (w/2·cosθ - h/2·sinθ)
 *   y = cy - (w/2·sinθ + h/2·cosθ)
 * 不这么算的话，旋转后的水印会整体偏出去半个对角线。
 */
function rotatedOrigin(cx: number, cy: number, w: number, h: number, deg: number): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  return {
    x: cx - (w / 2) * cos + (h / 2) * sin,
    y: cy - (w / 2) * sin - (h / 2) * cos
  }
}

async function addWatermark(
  win: BrowserWindow | null,
  payload: WatermarkPayload
): Promise<ToolResult> {
  let source = payload.sourcePath ? resolve(payload.sourcePath) : ''
  if (!source) {
    const picked = await dialog.showOpenDialog(win ?? undefined!, {
      title: '选择要加水印的 PDF',
      filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
      properties: ['openFile']
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true }
    source = picked.filePaths[0]
  }
  source = assertPdf(source)

  if (!payload.image || !payload.image.data) {
    return { ok: false, error: '水印图片为空，请检查水印文字' }
  }

  let target = payload.targetPath ? resolve(payload.targetPath) : ''
  if (!target) {
    const base = basename(source, extname(source))
    const picked = await askSavePath(win, '带水印的 PDF 另存为', join(dirname(source), `${base}-水印.pdf`), 'pdf')
    if (!picked) return { ok: false, canceled: true }
    target = picked
  }
  assertNotSame(target, source)

  const { doc } = await openPdf(source)
  const pngBytes = payload.image.data instanceof Uint8Array
    ? payload.image.data
    : new Uint8Array(payload.image.data)
  const image = await doc.embedPng(pngBytes)

  const opacity = Math.min(1, Math.max(0.03, Number(payload.opacity) || 0.18))
  const rotation = Math.min(180, Math.max(-180, Number(payload.rotation) || 0))
  const mode = payload.position === 'tile' ? 'tile' : 'center'

  let stampCount = 0
  for (const page of doc.getPages()) {
    const { width: pw, height: ph } = page.getSize()
    const ratio = payload.image.width > 0 ? payload.image.height / payload.image.width : 0.3

    if (mode === 'center') {
      /* 居中：占页宽 62%，高度按图片比例；太长就按页高再收一次 */
      let w = pw * 0.62
      let h = w * ratio
      const maxH = ph * 0.62
      if (h > maxH) {
        h = maxH
        w = h / ratio
      }
      const origin = rotatedOrigin(pw / 2, ph / 2, w, h, rotation)
      page.drawImage(image, {
        x: origin.x,
        y: origin.y,
        width: w,
        height: h,
        opacity,
        rotate: degrees(rotation)
      })
      stampCount += 1
      continue
    }

    /* 平铺：列数按页宽估算（每块约 1/3 页宽），行数同理，再按间距铺满 */
    const w = pw * 0.28
    const h = Math.max(8, w * ratio)
    const gap = Math.max(24, Number(payload.gap) || Math.max(w, h) * 0.6)
    const stepX = w + gap
    const stepY = h + gap
    const cols = Math.max(1, Math.ceil(pw / stepX))
    const rows = Math.max(1, Math.ceil(ph / stepY))
    const offsetX = (pw - (cols - 1) * stepX) / 2
    const offsetY = (ph - (rows - 1) * stepY) / 2

    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const cx = offsetX + c * stepX
        const cy = offsetY + r * stepY
        const origin = rotatedOrigin(cx, cy, w, h, rotation)
        page.drawImage(image, {
          x: origin.x,
          y: origin.y,
          width: w,
          height: h,
          opacity,
          rotate: degrees(rotation)
        })
        stampCount += 1
      }
    }
  }

  await writeFile(target, await doc.save())
  return { ok: true, path: target, info: { 加盖页数: doc.getPageCount(), 水印块数: stampCount } }
}

/* ============================================================
 * 加密 / 解密
 * ============================================================ */

async function encryptPdf(win: BrowserWindow | null, payload: EncryptPayload): Promise<ToolResult> {
  let source = payload.sourcePath ? resolve(payload.sourcePath) : ''
  if (!source) {
    const picked = await dialog.showOpenDialog(win ?? undefined!, {
      title: '选择要加密的 PDF',
      filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
      properties: ['openFile']
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true }
    source = picked.filePaths[0]
  }
  source = assertPdf(source)

  const userPassword = String(payload.userPassword ?? '')
  if (userPassword.length < 4) return { ok: false, error: '打开密码至少 4 位' }

  let target = payload.targetPath ? resolve(payload.targetPath) : ''
  if (!target) {
    const base = basename(source, extname(source))
    const picked = await askSavePath(win, '加密后的 PDF 另存为', join(dirname(source), `${base}-已加密.pdf`), 'pdf')
    if (!picked) return { ok: false, canceled: true }
    target = picked
  }
  assertNotSame(target, source)

  /* 已加密的文件不能叠加加密（否则要先解再加密，属于「改密码」场景） */
  const probe = await PDFDocument.load(readBytes(source), { ignoreEncryption: true })
  if (probe.isEncrypted) {
    return { ok: false, error: '该文档已经有保护，请先「移除保护」再重新设置密码' }
  }

  const ownerPassword = String(payload.ownerPassword ?? '') || userPassword
  const allow = payload.permissions ?? {}
  probe.encrypt({
    userPassword,
    ownerPassword,
    permissions: {
      printing: allow.printing ?? true,
      copying: allow.copying ?? true,
      modifying: allow.modifying ?? true,
      annotating: true,
      fillingForms: true,
      contentAccessibility: true,
      documentAssembly: false
    }
  })
  await writeFile(target, await probe.save())
  return { ok: true, path: target, info: { 加密方式: 'AES-256 (R6)', 页数: probe.getPageCount() } }
}

async function decryptPdf(win: BrowserWindow | null, payload: DecryptPayload): Promise<ToolResult> {
  let source = payload.sourcePath ? resolve(payload.sourcePath) : ''
  if (!source) {
    const picked = await dialog.showOpenDialog(win ?? undefined!, {
      title: '选择要去保护的 PDF',
      filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
      properties: ['openFile']
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true }
    source = picked.filePaths[0]
  }
  source = assertPdf(source)

  const password = String(payload.password ?? '')
  const probe = await PDFDocument.load(readBytes(source), { ignoreEncryption: true })
  if (!probe.isEncrypted) return { ok: false, error: '该文档没有设置密码，无需移除保护' }

  let target = payload.targetPath ? resolve(payload.targetPath) : ''
  if (!target) {
    const base = basename(source, extname(source))
    const picked = await askSavePath(win, '去保护后的 PDF 另存为', join(dirname(source), `${base}-已解密.pdf`), 'pdf')
    if (!picked) return { ok: false, canceled: true }
    target = picked
  }
  assertNotSame(target, source)

  /* openPdf 里完成「带密码加载 + 复制到新文档」这一步 */
  const { doc, pages } = await openPdf(source, password)
  await writeFile(target, await doc.save())
  return { ok: true, path: target, info: { 页数: pages, 说明: '已移除打开密码与权限限制' } }
}

/* ============================================================
 * 压缩（渲染层光栅化 → 主进程重排）
 * ============================================================ */

async function compressPdf(win: BrowserWindow | null, payload: CompressPayload): Promise<ToolResult> {
  let source = payload.sourcePath ? resolve(payload.sourcePath) : ''
  if (!source) {
    const picked = await dialog.showOpenDialog(win ?? undefined!, {
      title: '选择要压缩的 PDF',
      filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
      properties: ['openFile']
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true }
    source = picked.filePaths[0]
  }
  source = assertPdf(source)

  const pages = Array.isArray(payload.pages) ? payload.pages : []
  if (pages.length === 0) return { ok: false, error: '没有可写入的页面（渲染失败？）' }

  let target = payload.targetPath ? resolve(payload.targetPath) : ''
  if (!target) {
    const base = basename(source, extname(source))
    const picked = await askSavePath(win, '压缩后的 PDF 另存为', join(dirname(source), `${base}-压缩.pdf`), 'pdf')
    if (!picked) return { ok: false, canceled: true }
    target = picked
  }
  assertNotSame(target, source)

  const out = await PDFDocument.create()
  pages.sort((a, b) => a.page - b.page)
  for (const item of pages) {
    const w = Number(item.width) > 0 ? Number(item.width) : 595.28
    const h = Number(item.height) > 0 ? Number(item.height) : 841.89
    const bytes = item.data instanceof Uint8Array ? item.data : new Uint8Array(item.data)
    if (bytes.byteLength === 0) continue
    const image = item.mime === 'image/png' ? await out.embedPng(bytes) : await out.embedJpg(bytes)
    const page = out.addPage([w, h])
    page.drawImage(image, { x: 0, y: 0, width: w, height: h })
  }

  await writeFile(target, await out.save())
  const before = statSync(source).size
  const after = statSync(target).size
  const savedPct = Math.round((1 - after / before) * 100)
  return {
    ok: true,
    path: target,
    info: {
      原大小: before,
      新大小: after,
      /*
       * 以文字/矢量为主的文档（例如 Word 直接导出的 PDF）重排成位图后
       * 反而更大，这个时候报「压缩率 -130%」会让人困惑，直说体积增加多少。
       */
      体积变化: savedPct >= 0 ? `减小 ${savedPct}%` : `增加 ${-savedPct}%`,
      页数: pages.length
    }
  }
}

/* ============================================================
 * PDF ↔ 图片
 *  · PDF → 图片：渲染层渲染，主进程落盘（saveImages）
 *  · 图片 → PDF：主进程读图拼页（imagesToPdf）
 * ============================================================ */

async function saveImages(win: BrowserWindow | null, payload: SaveImagesPayload): Promise<ToolResult> {
  const images = Array.isArray(payload.images) ? payload.images : []
  if (images.length === 0) return { ok: false, error: '没有可保存的图片' }

  const bytesOf = (image: SaveImagesPayload['images'][number]): Uint8Array =>
    image.data instanceof Uint8Array ? image.data : new Uint8Array(image.data)

  if (payload.singleFile) {
    let target = payload.targetPath ? resolve(payload.targetPath) : ''
    if (!target) {
      const ext = images[0].mime === 'image/png' ? 'png' : 'jpg'
      const picked = await askSavePath(
        win,
        '保存长图',
        join(app.getPath('documents'), `长图.${ext}`),
        ext
      )
      if (!picked) return { ok: false, canceled: true }
      target = picked
    }
    await writeFile(target, bytesOf(images[0]))
    return { ok: true, path: target, info: { 文件数: 1 } }
  }

  let outputDir = payload.outputDir ? resolve(payload.outputDir) : ''
  if (!outputDir) {
    const picked = await dialog.showOpenDialog(win ?? undefined!, {
      title: '选择图片保存文件夹',
      properties: ['openDirectory', 'createDirectory']
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true }
    outputDir = picked.filePaths[0]
  }
  ensureDir(outputDir)

  const written: string[] = []
  const base = (payload.baseName ?? '页面').replace(/[\\/:*?"<>|]/g, '_')
  for (const image of images) {
    const target = join(outputDir, image.name || `${base}.png`)
    await writeFile(target, bytesOf(image))
    written.push(target)
  }
  return { ok: true, paths: written, info: { 文件数: written.length, 输出目录: outputDir } }
}

/** 把任意图片文件读成 pdf-lib 能嵌入的字节（非 PNG/JPG 先经 Chromium 解码转 PNG） */

async function imagesToPdf(win: BrowserWindow | null, payload: ImagesToPdfPayload): Promise<ToolResult> {
  let files = (payload.files ?? []).map((p) => resolve(p)).filter((p) => existsSync(p))
  if (files.length === 0) {
    const picked = await dialog.showOpenDialog(win ?? undefined!, {
      title: '选择要合成 PDF 的图片（可多选，按选择顺序成页）',
      filters: [
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: ['openFile', 'multiSelections']
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true }
    files = picked.filePaths
  }

  let target = payload.targetPath ? resolve(payload.targetPath) : ''
  if (!target) {
    const picked = await askSavePath(
      win,
      '合成后的 PDF 另存为',
      join(dirname(files[0]), `${basename(files[0], extname(files[0]))}-合成.pdf`),
      'pdf'
    )
    if (!picked) return { ok: false, canceled: true }
    target = picked
  }

  const mode = payload.pageSize === 'a4' || payload.pageSize === 'a4-landscape' ? payload.pageSize : 'fit'
  const A4 = { w: 595.28, h: 841.89 }
  const pageBox = mode === 'a4' ? A4 : mode === 'a4-landscape' ? { w: A4.h, h: A4.w } : null

  const doc = await PDFDocument.create()
  for (const file of files) {
    /* 每张图单独嵌入：embedPng 返回的对象绑定文档上下文，不能跨页复用错误 */
    const ext = extname(file).toLowerCase()
    const bytes = readBytes(file)
    let image
    if (ext === '.png') image = await doc.embedPng(bytes)
    else if (ext === '.jpg' || ext === '.jpeg') image = await doc.embedJpg(bytes)
    else {
      const img = nativeImage.createFromPath(file)
      if (img.isEmpty()) throw new Error(`无法识别的图片格式：${basename(file)}`)
      image = await doc.embedPng(img.toPNG())
    }

    const { width: iw, height: ih } = image.size()
    if (pageBox) {
      const page = doc.addPage([pageBox.w, pageBox.h])
      const margin = 24
      const scale = Math.min((pageBox.w - margin * 2) / iw, (pageBox.h - margin * 2) / ih)
      const w = iw * scale
      const h = ih * scale
      page.drawImage(image, {
        x: (pageBox.w - w) / 2,
        y: (pageBox.h - h) / 2,
        width: w,
        height: h
      })
    } else {
      const page = doc.addPage([iw, ih])
      page.drawImage(image, { x: 0, y: 0, width: iw, height: ih })
    }
  }

  await writeFile(target, await doc.save())
  return { ok: true, path: target, info: { 图片数: files.length, 页数: doc.getPageCount() } }
}

/* ============================================================
 * Office → PDF
 *
 * 转换链（按「用户机器上最可能存在」的顺序）：
 *   ① LibreOffice（soffice）—— 免费、无界面、兼容性最好；
 *   ② Microsoft Office 的 COM 自动化 —— 装了 Office 的机器效果最完美；
 *   ③ WPS Office 的 COM（KWPS / KET / KWPP）—— 国内机器常见。
 * 三选一成功后立刻返回；前一条失败就试下一条，最后仍失败则给出可操作的提示。
 *
 * ★ COM 一律走「写一个临时 .ps1 再 execFile 调用」：
 *   不经过 shell 拼字符串，文件路径里的空格/引号/中文都不需要转义，
 *   也就不存在通过文件名注入命令的通道。
 * ============================================================ */

interface Converter {
  kind: string
  label: string
  /** 该转换器能处理哪些扩展名 */
  extensions: string[]
}

/** 在 PATH 里找一个可执行名（只用 existsSync，不额外 spawn 进程） */
function inPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue
    const full = join(dir, name)
    try {
      if (existsSync(full)) return full
    } catch {
      /* 忽略 */
    }
  }
  return null
}

/** PATH 与常见安装目录里找 soffice */
function findSoffice(): string | null {
  /*
   * Linux 上 soffice 通常在 PATH 里（或 /opt/libreoffice*/program）；
   * 先按 PATH 找，再退到几个固定位置 —— 打包机与 UOS 上名字都是 soffice。
   */
  if (process.platform !== 'win32') {
    const fromPath = ['soffice', '/usr/bin/soffice', '/usr/lib/libreoffice/program/soffice',
      '/snap/bin/libreoffice', '/opt/libreoffice/program/soffice']
    for (const candidate of fromPath) {
      try {
        if (candidate.includes('/') ? existsSync(candidate) : Boolean(inPath(candidate))) return candidate
      } catch {
        /* 忽略非法路径 */
      }
    }
    return null
  }

  const candidates = [
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'LibreOffice', 'program', 'soffice.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'LibreOffice', 'program', 'soffice.exe')
  ]
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      /* 路径非法就跳过 */
    }
  }
  return null
}

/** 探测可用的 Office 转换器（结果缓存，避免每次点按钮都查一遍注册表级的 COM） */
let converterCache: Converter[] | null = null

function availableConverters(): Converter[] {
  if (converterCache) return converterCache
  const list: Converter[] = []
  const officeExt = ['doc', 'docx', 'rtf', 'txt', 'odt']

  if (findSoffice()) {
    list.push({
      kind: 'libreoffice',
      label: 'LibreOffice',
      extensions: ['doc', 'docx', 'rtf', 'txt', 'odt', 'xls', 'xlsx', 'csv', 'ods', 'ppt', 'pptx', 'odp']
    })
  }

  /*
   * COM 的可用性无法在「不发 COM 请求」的前提下确认（注册表键名随版本变化），
   * 因此这里按「Windows 上大概率有」列出来，真正失败时由 convert 的错误提示兜底。
   * 两个 COM 提供方都列上，按 Office 优先于 WPS。
   */
  if (process.platform === 'win32') {
    list.push(
      { kind: 'word', label: 'Microsoft Word', extensions: officeExt },
      { kind: 'excel', label: 'Microsoft Excel', extensions: ['xls', 'xlsx', 'csv'] },
      { kind: 'powerpoint', label: 'Microsoft PowerPoint', extensions: ['ppt', 'pptx'] },
      { kind: 'wps', label: 'WPS Office', extensions: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'rtf', 'csv'] }
    )
  }

  converterCache = list
  return list
}

/** 按扩展名挑出可能能转的转换器（顺序即优先级） */
function convertersFor(ext: string): Converter[] {
  return availableConverters().filter((c) => c.extensions.includes(ext.replace(/^\./, '').toLowerCase()))
}

/** execFile 的 Promise 包装（带超时） */
function run(
  file: string,
  args: string[],
  timeout: number
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile(file, args, { timeout, windowsHide: true }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: number }).code === 'number' ? (error as { code?: number }).code! : error ? 1 : 0
      resolvePromise({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

/**
 * 通过 COM 把一份 Office 文档转成 PDF。
 *
 * kind: word / excel / powerpoint / wps（wps 按后缀自动挑组件）
 * 返回错误文本（成功时为空串），便于上层决定是否换下一个转换器。
 */
async function convertWithCom(kind: string, input: string, output: string): Promise<string> {
  const ext = extname(input).toLowerCase()

  let progId: string
  let method: 'word' | 'excel' | 'ppt'
  if (kind === 'wps') {
    if (['.xls', '.xlsx', '.csv'].includes(ext)) {
      progId = 'KET.Application'
      method = 'excel'
    } else if (['.ppt', '.pptx'].includes(ext)) {
      progId = 'KWPP.Application'
      method = 'ppt'
    } else {
      progId = 'KWPS.Application'
      method = 'word'
    }
  } else if (kind === 'excel') {
    progId = 'Excel.Application'
    method = 'excel'
  } else if (kind === 'powerpoint') {
    progId = 'PowerPoint.Application'
    method = 'ppt'
  } else {
    progId = 'Word.Application'
    method = 'word'
  }

  /*
   * 脚本本身保持纯 ASCII，路径全部通过参数传入。
   * 三个组件的导出 API 不同：
   *   Word    → Document.ExportAsFixedFormat(路径, 17)     17 = wdExportFormatPDF
   *   Excel   → Workbook.ExportAsFixedFormat(0, 路径)       0  = xlTypePDF
   *   PPT     → Presentation.SaveAs(路径, 32)              32 = ppSaveAsPDF
   */
  const script = `param([string]$InPath, [string]$OutPath, [string]$Method, [string]$ProgId)
$ErrorActionPreference = 'Stop'
$app = $null
$doc = $null
try {
  $app = New-Object -ComObject $ProgId
  if ($Method -eq 'word') {
    $app.Visible = $false
    try { $app.DisplayAlerts = 0 } catch {}
    $doc = $app.Documents.Open($InPath, $false, $true)
    $doc.ExportAsFixedFormat($OutPath, 17)
    $doc.Close(0)
  } elseif ($Method -eq 'excel') {
    $app.Visible = $false
    $app.DisplayAlerts = $false
    $doc = $app.Workbooks.Open($InPath, 0, $true)
    $doc.ExportAsFixedFormat(0, $OutPath)
    $doc.Close($false)
  } else {
    $doc = $app.Presentations.Open($InPath, $true, $false, $false)
    $doc.SaveAs($OutPath, 32)
    $doc.Close()
  }
  Write-Output 'OK'
} catch {
  Write-Error $_.Exception.Message
  exit 1
} finally {
  if ($doc) { try { $doc.Close(0) } catch {} }
  if ($app) { try { $app.Quit() } catch {} }
}`

  const scriptPath = join(tmpdir(), `qxpdf-office-${process.pid}-${Date.now()}.ps1`)
  writeFileSync(scriptPath, script, 'utf8')
  try {
    const result = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-InPath',
        input,
        '-OutPath',
        output,
        '-Method',
        method,
        '-ProgId',
        progId
      ],
      180_000
    )
    if (result.code !== 0) {
      return (result.stderr || result.stdout || 'COM 转换失败').trim().split(/\r?\n/).slice(-3).join(' ')
    }
    if (!existsSync(output) || statSync(output).size === 0) return '转换结束但没有生成 PDF 文件'
    return ''
  } finally {
    try {
      unlinkSync(scriptPath)
    } catch {
      /* 忽略清理失败 */
    }
  }
}

/** LibreOffice 转换 */
async function convertWithSoffice(soffice: string, input: string, output: string): Promise<string> {
  const outDir = dirname(output)
  const result = await run(
    soffice,
    ['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', outDir, input],
    180_000
  )

  /*
   * ★ soffice 永远按「输入文件的主名」输出（<outdir>/<输入基名>.pdf），
   *   不认我们指定的目标文件名。单文件 + 自定义路径时两者会不一致，
   *   直接判 existsSync(output) 会把一次**成功**的转换当成失败。
   *   因此找不到目标就按它的命名规则再找一次，找到就改名到目标。
   */
  if (!existsSync(output)) {
    const produced = join(outDir, `${basename(input, extname(input))}.pdf`)
    if (existsSync(produced)) {
      try {
        renameSync(produced, output)
      } catch {
        /* 改名失败（跨盘/占用）时保留产物，当作成功 */
        return ''
      }
    }
  }

  if (!existsSync(output) || statSync(output).size === 0) {
    const detail = (result.stderr || result.stdout || '').trim().split(/\r?\n/).slice(-2).join(' ')
    return detail || 'LibreOffice 没有生成 PDF'
  }
  return ''
}

async function officeToPdf(win: BrowserWindow | null, payload: OfficeToPdfPayload): Promise<ToolResult> {
  let inputs = (payload.inputs ?? []).map((p) => resolve(p)).filter((p) => existsSync(p))
  if (inputs.length === 0) {
    const picked = await dialog.showOpenDialog(win ?? undefined!, {
      title: '选择要转换为 PDF 的 Office 文档（可多选）',
      filters: [
        { name: 'Office 文档', extensions: ['doc', 'docx', 'rtf', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'odt', 'ods', 'odp'] },
        { name: 'Word 文档', extensions: ['doc', 'docx', 'rtf'] },
        { name: 'Excel 表格', extensions: ['xls', 'xlsx', 'csv'] },
        { name: 'PowerPoint 演示', extensions: ['ppt', 'pptx'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: ['openFile', 'multiSelections']
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true }
    inputs = picked.filePaths
  }

  const soffice = findSoffice()
  const written: string[] = []
  const failed: string[] = []
  let usedConverter = ''

  for (const input of inputs) {
    const ext = extname(input).toLowerCase()
    const target =
      inputs.length === 1 && payload.targetPath
        ? resolve(payload.targetPath)
        : join(dirname(input), `${basename(input, extname(input))}.pdf`)

    const errors: string[] = []
    const chain = convertersFor(ext)

    if (soffice && chain.some((c) => c.kind === 'libreoffice')) {
      const err = await convertWithSoffice(soffice, input, target)
      if (!err) {
        usedConverter = usedConverter || 'LibreOffice'
        written.push(target)
        continue
      }
      errors.push(`LibreOffice：${err}`)
    }

    for (const converter of chain.filter((c) => c.kind !== 'libreoffice')) {
      const err = await convertWithCom(converter.kind, input, target)
      if (!err) {
        usedConverter = usedConverter || converter.label
        written.push(target)
        break
      }
      errors.push(`${converter.label}：${err}`)
    }

    if (!written.includes(target)) {
      failed.push(`${basename(input)}（${errors.join('；')}）`)
    }
  }

  if (written.length === 0) {
    return {
      ok: false,
      error:
        '没有转换成功。Office 文档转 PDF 需要本机装有 Microsoft Office、WPS 或 LibreOffice 之一。\n' +
        (failed.length ? failed.join('\n') : '')
    }
  }

  const result: ToolResult = {
    ok: true,
    paths: written,
    info: { 成功: written.length, 转换方式: usedConverter || '未知' }
  }
  if (failed.length > 0) {
    result.info = { ...result.info, 失败: failed.length }
    result.error = `有 ${failed.length} 个文件没转成功：${failed.join('；')}`
  }
  return result
}

/* ============================================================
 * IPC 注册
 * ============================================================ */

/** 统一包住「校验 + 异常 → ToolResult」的样板代码 */
function wrap<T>(fn: (payload: T) => Promise<ToolResult>) {
  return async (_event: unknown, payload: T): Promise<ToolResult> => {
    try {
      return await fn(payload ?? ({} as T))
    } catch (error) {
      console.error('[pdf-tools] 失败：', error)
      return { ok: false, error: friendly(error) }
    }
  }
}

export function registerPdfToolsIpc(getWindow: () => BrowserWindow | null): void {
  const win = (): BrowserWindow | null => {
    const w = getWindow()
    return w && !w.isDestroyed() ? w : null
  }

  ipcMain.handle('tools:merge', wrap<MergePayload>((p) => mergePdfs(win(), p)))
  ipcMain.handle('tools:split', wrap<SplitPayload>((p) => splitPdf(win(), p)))
  ipcMain.handle('tools:watermark', wrap<WatermarkPayload>((p) => addWatermark(win(), p)))
  ipcMain.handle('tools:compress', wrap<CompressPayload>((p) => compressPdf(win(), p)))
  ipcMain.handle('tools:encrypt', wrap<EncryptPayload>((p) => encryptPdf(win(), p)))
  ipcMain.handle('tools:decrypt', wrap<DecryptPayload>((p) => decryptPdf(win(), p)))
  ipcMain.handle('tools:save-images', wrap<SaveImagesPayload>((p) => saveImages(win(), p)))
  ipcMain.handle('tools:images-to-pdf', wrap<ImagesToPdfPayload>((p) => imagesToPdf(win(), p)))
  ipcMain.handle('tools:office-to-pdf', wrap<OfficeToPdfPayload>((p) => officeToPdf(win(), p)))

  /* ---------- 选择器（面板上「选择文件」按钮用，返回路径给界面预览） ---------- */

  ipcMain.handle('tools:pick-pdfs', async (): Promise<string[]> => {
    const picked = await dialog.showOpenDialog(win() ?? undefined!, {
      title: '选择 PDF 文件（可多选）',
      filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
      properties: ['openFile', 'multiSelections']
    })
    return picked.canceled ? [] : picked.filePaths
  })

  ipcMain.handle('tools:pick-images', async (): Promise<string[]> => {
    const picked = await dialog.showOpenDialog(win() ?? undefined!, {
      title: '选择图片（可多选）',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
      properties: ['openFile', 'multiSelections']
    })
    return picked.canceled ? [] : picked.filePaths
  })

  ipcMain.handle('tools:pick-office', async (): Promise<string[]> => {
    const picked = await dialog.showOpenDialog(win() ?? undefined!, {
      title: '选择 Office 文档（可多选）',
      filters: [
        { name: 'Office 文档', extensions: ['doc', 'docx', 'rtf', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'odt', 'ods', 'odp'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: ['openFile', 'multiSelections']
    })
    return picked.canceled ? [] : picked.filePaths
  })

  ipcMain.handle('tools:pick-folder', async (): Promise<string | null> => {
    const picked = await dialog.showOpenDialog(win() ?? undefined!, {
      title: '选择输出文件夹',
      properties: ['openDirectory', 'createDirectory']
    })
    return picked.canceled || picked.filePaths.length === 0 ? null : picked.filePaths[0]
  })

  /** 转换方式说明（界面上告诉用户「你这台机器上可以用什么转 Office」） */
  ipcMain.handle('tools:converter-info', (): OfficeConverterInfo[] => {
    const list = availableConverters().map((c) => ({
      kind: c.kind,
      label: c.label,
      extensions: c.extensions
    }))
    if (list.length === 0) return [{ kind: 'none', label: '未检测到可用转换器', extensions: [] }]
    return list
  })
}
