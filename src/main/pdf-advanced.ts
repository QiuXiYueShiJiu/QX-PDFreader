// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 「Acrobat 级」文档编辑能力的主进程实现。
 *
 * 覆盖：
 *   · 整理页面：重排 / 删除 / 旋转 / 裁剪 / 插入空白页 / 从别的 PDF 插页
 *   · 页眉页脚与页码（支持中文字体，变量 {page}{total}{date}{time}{title}）
 *   · 贝茨编号（Bates numbering）
 *   · 元数据编辑
 *   · 书签（文档目录）读写
 *   · 附件管理（添加 / 列出 / 提取）
 *   · AcroForm 表单：读取字段、填写（含中文外观）、扁平化
 *   · 电子签名（手写图片 / 图片签名 + 日期）
 *   · PDF/A 归档（1B / 2B / 3B）
 *   · 安全遮盖（渲染层涂黑成位图 → 本模块替换该页，文字层永久消失）
 *   · 导出 Word（docx）、任意二进制落盘
 *
 * ── 中文字体从哪来 ────────────────────────────────────────────
 *   pdf-lib 内置的 14 个标准字体不含 CJK，直接画中文会变成空白或抛错。
 *   这里用 @cantoo/fontkit 读取 Windows 自带字体（微软雅黑 / 黑体 / 宋体），
 *   按 PostScript 名从 .ttc 集合里选面，并以**子集嵌入**（实测一份 CJK 样本
 *   只增加 ~10KB，而不是整份字体的十几 MB）。
 *   每份文档只嵌入一次（WeakMap 缓存），多页页眉页脚不会重复占体积。
 *
 * ── 安全遮盖为什么必须「位图替换整页」────────────────────────
 *   pdf-lib 改不了内容流里的文字对象，真正删掉被遮住的文字只能重画这一页。
 *   渲染层把黑框画好、整页导出位图，本模块用这张位图页替换原页 ——
 *   原页面对象（含文字）不再存在于输出文件里，复制/搜索都拿不到，
 *   未遮盖的页保持原矢量页不受影响。
 */

import { dialog, ipcMain, BrowserWindow } from 'electron'
import {
  degrees,
  PDFArray,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  rgb,
  StandardFonts,
  type PDFFont,
  type PDFRef
} from '@cantoo/pdf-lib'
import fontkit from '@cantoo/fontkit'
import { existsSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { buildDocx } from './docx-writer'
import { buildXlsx } from './xlsx-writer'
import type {
  AttachmentInfo,
  AttachmentsPayload,
  BatesPayload,
  BatchEncrypt,
  BatchPayload,
  BookmarkItem,
  BookmarksPayload,
  ComparePdfPayload,
  ExportExcelPayload,
  ExportWordPayload,
  FormFieldInfo,
  FormsCreatePayload,
  FormsFillPayload,
  FormsQueryPayload,
  FormsQueryResult,
  HeaderFooterPayload,
  HeaderFooterSide,
  MetadataPayload,
  PagesApplyPayload,
  PdfAPayload,
  PrintInfo,
  PrintPayload,
  RedactPayload,
  SaveBinaryPayload,
  SignPayload
} from '@shared/pdf-advanced'
import type { ToolResult } from '@shared/pdf-tools'
import {
  assertNotSame,
  assertPdf,
  askSavePath,
  copyMetadata,
  ensureDir,
  friendly,
  openPdf,
  readBytes
} from './pdf-tools'

/* ============================================================
 * 中文字体
 * ============================================================ */

/** 依次尝试的系统字体（都是 Windows 10 自带） */
const FONT_CANDIDATES: Array<{ file: string; postscriptName?: string }> = [
  { file: 'C:\\Windows\\Fonts\\msyh.ttc', postscriptName: 'MicrosoftYaHei' },
  { file: 'C:\\Windows\\Fonts\\simhei.ttf' },
  { file: 'C:\\Windows\\Fonts\\simsun.ttc', postscriptName: 'SimSun' }
]

function pickFontFile(): { file: string; postscriptName?: string } | null {
  for (const candidate of FONT_CANDIDATES) {
    try {
      if (existsSync(candidate.file) && statSync(candidate.file).size > 0) return candidate
    } catch {
      /* 跳过无权限的路径 */
    }
  }
  return null
}

const fontPromiseCache = new WeakMap<PDFDocument, Promise<PDFFont>>()
const fontkitRegistered = new WeakSet<PDFDocument>()

/**
 * 取（并缓存）这份文档的中文字体。
 *
 * 失败时退回内置 Helvetica：至少 ASCII 页眉页脚还能画出来，
 * 而且不会让整个操作因为「机器上没有中文字体」直接失败。
 */
async function cjkFont(doc: PDFDocument): Promise<PDFFont> {
  const cached = fontPromiseCache.get(doc)
  if (cached) return cached

  const task = (async () => {
    const picked = pickFontFile()
    if (picked) {
      try {
        if (!fontkitRegistered.has(doc)) {
          /*
           * @cantoo/fontkit 的运行时形状与 pdf-lib 期望的 Fontkit 接口一致
           * （cantoo 文档明确支持），但两边的 TS 声明不完全相同，
           * 这里收窄成 pdf-lib 需要的类型即可，不改变运行时行为。
           */
          doc.registerFontkit(fontkit as never)
          fontkitRegistered.add(doc)
        }
        return await doc.embedFont(readBytes(picked.file), {
          postscriptName: picked.postscriptName,
          subset: true
        })
      } catch (error) {
        console.warn('[advanced] 中文字体嵌入失败，退回标准字体：', error)
      }
    }
    return doc.embedFont(StandardFonts.Helvetica)
  })()

  fontPromiseCache.set(doc, task)
  return task
}

/* ============================================================
 * 通用小工具
 * ============================================================ */

function hexColor(value: string | undefined, fallback = '#666666'): ReturnType<typeof rgb> {
  const match = /^#?([0-9a-f]{6})$/i.exec((value ?? fallback).trim())
  const hex = match ? match[1] : fallback.slice(1)
  const r = parseInt(hex.slice(0, 2), 16) / 255
  const g = parseInt(hex.slice(2, 4), 16) / 255
  const b = parseInt(hex.slice(4, 6), 16) / 255
  return rgb(r, g, b)
}

/** 取源路径：payload 里有就用，没有就弹选择框 */
async function chooseSource(
  win: BrowserWindow | null,
  given: string | undefined,
  title: string
): Promise<string> {
  if (given) return assertPdf(given)
  const picked = await dialog.showOpenDialog(win ?? undefined!, {
    title,
    filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
    properties: ['openFile']
  })
  if (picked.canceled || picked.filePaths.length === 0) throw new Canceled()
  return assertPdf(picked.filePaths[0])
}

/** 用户取消（与真正的错误区分开，结果里标 canceled） */
class Canceled extends Error {}

/** 统一选输出路径 */
async function chooseTarget(
  win: BrowserWindow | null,
  given: string | undefined,
  source: string,
  title: string,
  suffix: string
): Promise<string> {
  const base = basename(source, extname(source))
  if (given) {
    const target = resolve(given)
    assertNotSame(target, source)
    return target
  }
  const picked = await askSavePath(win, title, join(dirname(source), `${base}${suffix}.pdf`), 'pdf')
  if (!picked) throw new Canceled()
  assertNotSame(picked, source)
  return picked
}

/** 左侧对齐的文本宽度（Helvetica 等比例字体下用字体自带的度量） */
function measure(font: PDFFont, size: number, text: string): number {
  try {
    return font.widthOfTextAtSize(text, size)
  } catch {
    return text.length * size * 0.5
  }
}

/** 页眉页脚变量替换 */
function expandTokens(
  template: string | undefined,
  ctx: { page: number; total: number; title: string }
): string {
  if (!template) return ''
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return template
    .replaceAll('{page}', String(ctx.page))
    .replaceAll('{total}', String(ctx.total))
    .replaceAll('{title}', ctx.title)
    .replaceAll('{date}', `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`)
    .replaceAll('{time}', `${pad(now.getHours())}:${pad(now.getMinutes())}`)
}

/* ============================================================
 * 1. 整理页面
 * ============================================================ */

async function applyPages(win: BrowserWindow | null, payload: PagesApplyPayload): Promise<ToolResult> {
  const source = await chooseSource(win, payload.sourcePath, '选择要整理页面的 PDF')
  const entries = Array.isArray(payload.pages) ? payload.pages : []
  if (entries.length === 0) return { ok: false, error: '输出至少要保留一页' }

  const target = await chooseTarget(win, payload.targetPath, source, '整理后的 PDF 另存为', '-整理')

  /* 按源文件缓存文档，支持「从另一份 PDF 插入页面」 */
  const docs = new Map<string, PDFDocument>()
  const load = async (path: string): Promise<PDFDocument> => {
    const key = resolve(path)
    const hit = docs.get(key)
    if (hit) return hit
    const { doc } = await openPdf(assertPdf(key))
    docs.set(key, doc)
    return doc
  }

  const out = await PDFDocument.create()
  let added = 0
  for (const entry of entries) {
    const entrySource = entry.sourcePath ? resolve(entry.sourcePath) : source
    if (entry.index < 0) {
      /* 空白页 */
      const w = entry.blankSize?.width && entry.blankSize.width > 0 ? entry.blankSize.width : 595.28
      const h = entry.blankSize?.height && entry.blankSize.height > 0 ? entry.blankSize.height : 841.89
      out.addPage([w, h])
      added += 1
      continue
    }
    const doc = await load(entrySource)
    const total = doc.getPageCount()
    if (entry.index >= total) {
      throw new Error(`源文件页数不足：${basename(entrySource)} 只有 ${total} 页`)
    }
    const [page] = await out.copyPages(doc, [entry.index])
    if (typeof entry.rotation === 'number' && entry.rotation % 90 === 0) {
      page.setRotation(degrees(((entry.rotation % 360) + 360) % 360))
    }
    if (entry.crop && entry.crop.width > 0 && entry.crop.height > 0) {
      const { width, height } = page.getSize()
      const x = Math.max(0, Math.min(entry.crop.x, width - 1))
      const y = Math.max(0, Math.min(entry.crop.y, height - 1))
      const w = Math.min(entry.crop.width, width - x)
      const h = Math.min(entry.crop.height, height - y)
      page.setCropBox(x, y, w, h)
    }
    out.addPage(page)
    added += 1
  }

  const firstLoaded = await load(source)
  copyMetadata(firstLoaded, out)
  await writeFile(target, await out.save())
  return { ok: true, path: target, info: { 页数: added } }
}

/* ============================================================
 * 2. 页眉页脚 / 页码
 * ============================================================ */

function drawSide(
  page: ReturnType<PDFDocument['getPage']>,
  side: HeaderFooterSide | undefined,
  options: {
    font: PDFFont
    size: number
    color: ReturnType<typeof rgb>
    margin: number
    /** 'top' 时按上边距画，'bottom' 按下边距 */
    where: 'top' | 'bottom'
    ctx: { page: number; total: number; title: string }
  }
): number {
  if (!side) return 0
  const { width, height } = page.getSize()
  const textY = options.where === 'top' ? height - options.margin : options.margin
  let drawn = 0

  const paint = (text: string | undefined, align: 'left' | 'center' | 'right'): void => {
    const value = expandTokens(text, options.ctx).trim()
    if (!value) return
    const tw = measure(options.font, options.size, value)
    let x = options.margin
    if (align === 'center') x = Math.max(options.margin, (width - tw) / 2)
    if (align === 'right') x = Math.max(options.margin, width - options.margin - tw)
    page.drawText(value, {
      x,
      y: textY,
      size: options.size,
      font: options.font,
      color: options.color
    })
    drawn += 1
  }

  paint(side.left, 'left')
  paint(side.center, 'center')
  paint(side.right, 'right')
  return drawn
}

/**
 * 在文档上画页眉页脚（提取成独立函数，批量处理直接复用）。
 * 返回实际写了几个文本框。
 */
function drawHeaderFooterOnDoc(
  doc: PDFDocument,
  payload: Omit<HeaderFooterPayload, 'sourcePath' | 'targetPath'>,
  font: PDFFont
): number {
  const size = Math.min(36, Math.max(6, Number(payload.fontSize) || 9))
  const margin = Math.max(8, Number(payload.margin) || 24)
  const color = hexColor(payload.color)
  const startNumber = Number.isFinite(payload.startNumber) ? Number(payload.startNumber) : 1
  const title = payload.title ?? doc.getTitle?.() ?? ''
  const total = doc.getPageCount()

  let drawn = 0
  doc.getPages().forEach((page, index) => {
    if (payload.skipFirst && index === 0) return
    const ctx = { page: startNumber + index, total, title }
    drawn += drawSide(page, payload.header, { font, size, color, margin, where: 'top', ctx })
    drawn += drawSide(page, payload.footer, { font, size, color, margin, where: 'bottom', ctx })
  })
  return drawn
}

async function applyHeaderFooter(
  win: BrowserWindow | null,
  payload: HeaderFooterPayload
): Promise<ToolResult> {
  const source = await chooseSource(win, payload.sourcePath, '选择要添加页眉页脚的 PDF')
  const hasAny =
    payload.header && (payload.header.left || payload.header.center || payload.header.right)
  const hasFooter =
    payload.footer && (payload.footer.left || payload.footer.center || payload.footer.right)
  if (!hasAny && !hasFooter) return { ok: false, error: '页眉和页脚都是空的，没有可添加的内容' }

  const target = await chooseTarget(win, payload.targetPath, source, '另存为（含页眉页脚）', '-页眉页脚')
  const { doc } = await openPdf(source)
  const font = await cjkFont(doc)
  const drawn = drawHeaderFooterOnDoc(doc, payload, font)

  await writeFile(target, await doc.save())
  return { ok: true, path: target, info: { 页数: doc.getPageCount(), 文本框数: drawn } }
}

/* ============================================================
 * 3. 贝茨编号
 * ============================================================ */

/** 在文档上画贝茨编号（批量与单文件共用） */
function drawBatesOnDoc(
  doc: PDFDocument,
  payload: Omit<BatesPayload, 'sourcePath' | 'targetPath'>,
  font: PDFFont
): void {
  const size = Math.min(36, Math.max(6, Number(payload.fontSize) || 9))
  const margin = Math.max(8, Number(payload.margin) || 24)
  const digits = Math.min(12, Math.max(1, Number(payload.digits) || 6))
  const start = Number.isFinite(payload.start) ? Number(payload.start) : 1
  const prefix = payload.prefix ?? ''
  const suffix = payload.suffix ?? ''
  const position = payload.position ?? 'bottom-right'

  doc.getPages().forEach((page, index) => {
    const label = `${prefix}${String(start + index).padStart(digits, '0')}${suffix}`
    const { width, height } = page.getSize()
    const tw = measure(font, size, label)
    const bottom = position.startsWith('bottom')
    const y = bottom ? margin : height - margin
    let x = margin
    if (position.endsWith('right')) x = Math.max(margin, width - margin - tw)
    if (position.includes('center')) x = Math.max(margin, (width - tw) / 2)
    page.drawText(label, { x, y, size, font, color: rgb(0.25, 0.25, 0.25) })
  })
}

async function applyBates(win: BrowserWindow | null, payload: BatesPayload): Promise<ToolResult> {
  const source = await chooseSource(win, payload.sourcePath, '选择要添加贝茨编号的 PDF')
  const target = await chooseTarget(win, payload.targetPath, source, '另存为（含贝茨编号）', '-贝茨')

  const { doc } = await openPdf(source)
  const font = await cjkFont(doc)
  drawBatesOnDoc(doc, payload, font)

  await writeFile(target, await doc.save())
  return {
    ok: true,
    path: target,
    info: { 页数: doc.getPageCount(), 起始编号: Number.isFinite(payload.start) ? Number(payload.start) : 1 }
  }
}

/* ============================================================
 * 4. 元数据
 * ============================================================ */

async function applyMetadata(win: BrowserWindow | null, payload: MetadataPayload): Promise<ToolResult> {
  const source = await chooseSource(win, payload.sourcePath, '选择要修改属性的 PDF')
  const target = await chooseTarget(win, payload.targetPath, source, '另存为（已更新属性）', '-属性')
  const { doc } = await openPdf(source)

  const setString = (fn: (value: string) => void, value: string | undefined): void => {
    if (typeof value === 'string') fn(value)
  }
  setString((v) => doc.setTitle(v), payload.title)
  setString((v) => doc.setAuthor(v), payload.author)
  setString((v) => doc.setSubject(v), payload.subject)
  setString((v) => doc.setCreator(v), payload.creator)
  if (typeof payload.keywords === 'string') {
    const list = payload.keywords
      .split(/[,，;；]/)
      .map((s) => s.trim())
      .filter(Boolean)
    doc.setKeywords(list)
  }
  doc.setModificationDate(new Date())

  await writeFile(target, await doc.save())
  return { ok: true, path: target, info: { 页数: doc.getPageCount() } }
}

/* ============================================================
 * 5. 书签（同时支持嵌套）
 * ============================================================ */

function sanitizeBookmarkPages(items: BookmarkItem[], pageCount: number): BookmarkItem[] {
  return items
    .filter((item) => item && typeof item.title === 'string')
    .map((item) => ({
      title: item.title.trim() || '未命名书签',
      page: Math.min(Math.max(1, Math.round(item.page)), pageCount),
      children: item.children?.length
        ? sanitizeBookmarkPages(item.children, pageCount)
        : undefined
    }))
}

/**
 * 重建整棵书签树。
 *
 * pdf-lib 没有大纲对象模型，只能按 PDF 规范手工构造：
 *   Catalog /Outlines → 第一层节点（First/Last/Count/Next/Prev/Parent/Dest），
 *   子节点再各自成链。这里递归完成并返回「可见后代数」供 Count 使用。
 */
function writeBookmarkTree(doc: PDFDocument, items: BookmarkItem[]): number {
  const ctx = doc.context
  const catalog = doc.catalog

  /* 先删掉旧大纲，避免两套目录同时存在（Acrobat 会显示重复项） */
  if (catalog.has(PDFName.of('Outlines'))) catalog.delete(PDFName.of('Outlines'))
  if (items.length === 0) return 0

  const rootRef = ctx.nextRef()

  /**
   * 构造一层节点，返回该层的可见条目数（自身 + 后代）
   * 以及首尾引用，供父级链接。
   */
  const buildLevel = (
    level: BookmarkItem[],
    parentRef: PDFRef
  ): { first: PDFRef; last: PDFRef; count: number } | null => {
    if (level.length === 0) return null
    const refs = level.map(() => ctx.nextRef())
    let total = 0

    level.forEach((item, index) => {
      const dict = ctx.obj({})
      /*
       * ★ 必须用 PDFHexString.fromText 而不是 PDFString.of。
       *
       *   实测（binq 坑）：PDFString.of('第一章') 产出的是 **literal 字符串**
       *   `(第一章)` —— 不转 UTF-16BE，保存后中文变成乱码，pdf.js 读回来是
       *   ", à" 这种字节。PDF 规范要求非 ASCII 的文本字符串用 UTF-16BE
       *   （带 BOM）的十六进制字符串表示，PDFHexString.fromText 正是这么做的。
       */
      dict.set(PDFName.of('Title'), PDFHexString.fromText(item.title))
      dict.set(PDFName.of('Parent'), parentRef)

      const page = doc.getPage(Math.min(Math.max(1, item.page), doc.getPageCount()) - 1)
      const dest = PDFArray.withContext(ctx)
      dest.push(page.ref)
      dest.push(PDFName.of('Fit'))
      dict.set(PDFName.of('Dest'), dest)

      if (index > 0) dict.set(PDFName.of('Prev'), refs[index - 1])
      if (index < level.length - 1) dict.set(PDFName.of('Next'), refs[index + 1])

      let childrenCount = 0
      if (item.children && item.children.length > 0) {
        const child = buildLevel(item.children, refs[index])
        if (child) {
          dict.set(PDFName.of('First'), child.first)
          dict.set(PDFName.of('Last'), child.last)
          childrenCount = child.count
          /* 正数 Count = 默认展开；让用户一眼看到层级 */
          dict.set(PDFName.of('Count'), PDFNumber.of(childrenCount))
          total += childrenCount
        }
      }

      ctx.assign(refs[index], dict)
      total += 1
    })

    return { first: refs[0], last: refs[refs.length - 1], count: total }
  }

  const rootLevel = buildLevel(items, rootRef)
  if (!rootLevel) return 0

  const outlines = ctx.obj({})
  outlines.set(PDFName.of('Type'), PDFName.of('Outlines'))
  outlines.set(PDFName.of('First'), rootLevel.first)
  outlines.set(PDFName.of('Last'), rootLevel.last)
  outlines.set(PDFName.of('Count'), PDFNumber.of(rootLevel.count))
  ctx.assign(rootRef, outlines)
  catalog.set(PDFName.of('Outlines'), rootRef)
  return rootLevel.count
}

async function applyBookmarks(
  win: BrowserWindow | null,
  payload: BookmarksPayload
): Promise<ToolResult> {
  const source = await chooseSource(win, payload.sourcePath, '选择要编辑书签的 PDF')
  const target = await chooseTarget(win, payload.targetPath, source, '另存为（已更新书签）', '-书签')
  const { doc } = await openPdf(source)
  const items = sanitizeBookmarkPages(Array.isArray(payload.items) ? payload.items : [], doc.getPageCount())
  const count = writeBookmarkTree(doc, items)
  await writeFile(target, await doc.save())
  return { ok: true, path: target, info: { 书签数: count } }
}

/* ============================================================
 * 6. 附件
 * ============================================================ */

async function attachmentAction(
  win: BrowserWindow | null,
  payload: AttachmentsPayload
): Promise<ToolResult & { attachments?: AttachmentInfo[] }> {
  const source = await chooseSource(win, payload.sourcePath, '选择要管理附件的 PDF')

  if (payload.action === 'list') {
    const { doc } = await openPdf(source)
    const raw = doc.getAttachments() ?? {}
    const attachments: AttachmentInfo[] = Object.values(raw).map((item) => ({
      name: item.name ?? '未命名',
      size: item.data ? item.data.length : 0,
      mimeType: item.mimeType
    }))
    return { ok: true, attachments, info: { 附件数: attachments.length } }
  }

  if (payload.action === 'add') {
    let files = (payload.files ?? []).map((p) => resolve(p)).filter((p) => existsSync(p))
    if (files.length === 0) {
      const picked = await dialog.showOpenDialog(win ?? undefined!, {
        title: '选择要附加到 PDF 的文件',
        properties: ['openFile', 'multiSelections']
      })
      if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true }
      files = picked.filePaths
    }
    const target = await chooseTarget(win, payload.targetPath, source, '另存为（含附件）', '-含附件')
    const { doc } = await openPdf(source)
    for (const file of files) {
      doc.attach(readBytes(file), basename(file), { mimeType: guessMime(file) })
    }
    await writeFile(target, await doc.save())
    return { ok: true, path: target, info: { 新增附件: files.length } }
  }

  /* extract */
  const { doc } = await openPdf(source)
  const raw = doc.getAttachments() ?? {}
  const wanted = new Set((payload.names ?? []).map((n) => n.trim()).filter(Boolean))
  const entries = Object.values(raw).filter((item) => item.name && (!wanted.size || wanted.has(item.name)))
  if (entries.length === 0) return { ok: false, error: '文档里没有可导出的附件' }

  let outputDir = payload.outputDir ? resolve(payload.outputDir) : ''
  if (!outputDir) {
    const picked = await dialog.showOpenDialog(win ?? undefined!, {
      title: '选择附件导出文件夹',
      defaultPath: dirname(source),
      properties: ['openDirectory', 'createDirectory']
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true }
    outputDir = picked.filePaths[0]
  }
  ensureDir(outputDir)

  const written: string[] = []
  for (const item of entries) {
    if (!item.data) continue
    const safeName = String(item.name).replace(/[\\/:*?"<>|]/g, '_')
    const target = join(outputDir, safeName)
    await writeFile(target, item.data)
    written.push(target)
  }
  return { ok: true, paths: written, info: { 导出附件: written.length, 输出目录: outputDir } }
}

function guessMime(file: string): string {
  const ext = extname(file).toLowerCase()
  const map: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip': 'application/zip'
  }
  return map[ext] ?? 'application/octet-stream'
}

/* ============================================================
 * 7. 表单
 * ============================================================ */

/** 把 pdf-lib 的字段对象归类成界面能用的类型 */
function fieldTypeOf(field: { constructor: { name: string } }): FormFieldInfo['type'] {
  const name = field.constructor.name
  if (name.includes('TextField')) return 'text'
  if (name.includes('CheckBox')) return 'checkbox'
  if (name.includes('RadioGroup')) return 'radio'
  if (name.includes('Dropdown')) return 'dropdown'
  if (name.includes('OptionList')) return 'optionlist'
  if (name.includes('Signature')) return 'signature'
  if (name.includes('Button')) return 'button'
  return 'unknown'
}

async function formsQuery(win: BrowserWindow | null, payload: FormsQueryPayload): Promise<FormsQueryResult> {
  const source = await chooseSource(win, payload.sourcePath, '选择要填写表单的 PDF')
  const { doc } = await openPdf(source)
  const form = doc.getForm()
  const fields = form.getFields().map((field): FormFieldInfo => {
    const type = fieldTypeOf(field)
    const info: FormFieldInfo = { name: field.getName(), type, value: '' }
    try {
      const anyField = field as unknown as {
        getText?: () => string
        isChecked?: () => boolean
        getSelected?: () => string | string[]
        getOptions?: () => string[]
        isReadOnly?: () => boolean
      }
      if (type === 'text' && anyField.getText) info.value = anyField.getText() ?? ''
      else if (type === 'checkbox' && anyField.isChecked) info.value = anyField.isChecked()
      else if ((type === 'radio' || type === 'dropdown') && anyField.getSelected) {
        info.value = anyField.getSelected() ?? ''
      } else if (type === 'optionlist' && anyField.getSelected) {
        const selected = anyField.getSelected() ?? []
        info.value = Array.isArray(selected) ? selected : [selected]
      }
      if (anyField.getOptions && (type === 'dropdown' || type === 'optionlist' || type === 'radio')) {
        info.options = anyField.getOptions()
      }
      if (anyField.isReadOnly) info.readonly = anyField.isReadOnly()
    } catch (error) {
      console.warn(`[advanced] 读取字段 ${field.getName()} 失败：`, error)
    }
    return info
  })
  return { ok: true, hasForm: fields.length > 0, fields, info: { 字段数: fields.length } }
}

async function formsFill(win: BrowserWindow | null, payload: FormsFillPayload): Promise<ToolResult> {
  const source = await chooseSource(win, payload.sourcePath, '选择要填写表单的 PDF')
  const target = await chooseTarget(win, payload.targetPath, source, '另存为（已填表）', '-已填表')
  const { doc } = await openPdf(source)
  const font = await cjkFont(doc)
  const form = doc.getForm()
  const warnings: string[] = []
  let filled = 0

  for (const [name, raw] of Object.entries(payload.values ?? {})) {
    let field
    try {
      field = form.getField(name)
    } catch {
      warnings.push(`${name}：字段不存在`)
      continue
    }
    const type = fieldTypeOf(field)
    try {
      if (type === 'text') {
        const tf = field as unknown as {
          setText: (v: string) => void
          updateAppearances: (f: PDFFont) => void
        }
        tf.setText(String(raw ?? ''))
        tf.updateAppearances(font)
      } else if (type === 'checkbox') {
        const cb = field as unknown as { check: () => void; uncheck: () => void }
        if (raw === true || raw === 'true' || raw === 'on') cb.check()
        else cb.uncheck()
      } else if (type === 'radio') {
        const rg = field as unknown as { select: (v: string) => void }
        rg.select(String(raw))
      } else if (type === 'dropdown') {
        const dd = field as unknown as {
          select: (v: string) => void
          updateAppearances?: (f: PDFFont) => void
        }
        dd.select(String(raw))
        dd.updateAppearances?.(font)
      } else if (type === 'optionlist') {
        const ol = field as unknown as {
          select: (v: string | string[]) => void
          updateAppearances?: (f: PDFFont) => void
        }
        ol.select(Array.isArray(raw) ? raw : [String(raw)])
        ol.updateAppearances?.(font)
      } else {
        warnings.push(`${name}：该字段类型（${type}）暂不支持填写`)
        continue
      }
      filled += 1
    } catch (error) {
      warnings.push(`${name}：${friendly(error)}`)
    }
  }

  if (payload.flatten) {
    form.flatten()
  }

  await writeFile(target, await doc.save())
  const result: ToolResult = {
    ok: true,
    path: target,
    info: { 已填字段: filled, 扁平化: payload.flatten ? '是' : '否' }
  }
  if (warnings.length > 0) result.error = warnings.join('；')
  return result
}

/* ============================================================
 * 8. 签名
 * ============================================================ */

async function signPdf(win: BrowserWindow | null, payload: SignPayload): Promise<ToolResult> {
  const source = await chooseSource(win, payload.sourcePath, '选择要签名的 PDF')
  if (!payload.image?.data) return { ok: false, error: '签名图片为空' }
  const target = await chooseTarget(win, payload.targetPath, source, '另存为（已签名）', '-已签名')

  const { doc } = await openPdf(source)
  const pageIndex = Math.min(Math.max(1, Math.round(payload.page || 1)), doc.getPageCount()) - 1
  const page = doc.getPage(pageIndex)
  const { width: pageWidth, height: pageHeight } = page.getSize()

  const bytes = payload.image.data instanceof Uint8Array
    ? payload.image.data
    : new Uint8Array(payload.image.data)
  const image = await doc.embedPng(bytes)

  /* 位置按 PDF 用户坐标（左下角原点）传入；这里只做边界收敛 */
  const w = Math.min(Math.max(10, payload.rect.width), pageWidth)
  const h = Math.min(Math.max(10, payload.rect.height), pageHeight)
  const x = Math.min(Math.max(0, payload.rect.x), pageWidth - w)
  const y = Math.min(Math.max(0, payload.rect.y), pageHeight - h)
  page.drawImage(image, { x, y, width: w, height: h })

  if (payload.dateText && payload.dateText.trim()) {
    const font = await cjkFont(doc)
    const size = Math.max(6, Math.min(14, h * 0.16))
    page.drawText(payload.dateText.trim(), {
      x,
      y: Math.max(2, y - size - 3),
      size,
      font,
      color: rgb(0.2, 0.2, 0.2)
    })
  }

  await writeFile(target, await doc.save())
  return { ok: true, path: target, info: { 页码: pageIndex + 1 } }
}

/* ============================================================
 * 9. PDF/A
 * ============================================================ */

async function toPdfA(win: BrowserWindow | null, payload: PdfAPayload): Promise<ToolResult> {
  const source = await chooseSource(win, payload.sourcePath, '选择要归档为 PDF/A 的 PDF')
  const target = await chooseTarget(win, payload.targetPath, source, '另存为（PDF/A）', '-PDFA')
  const { doc } = await openPdf(source)
  const convert = (doc as unknown as { convertToPDFA?: (opts: { conformance: string }) => void })
    .convertToPDFA
  if (typeof convert !== 'function') return { ok: false, error: '当前 PDF 库不支持 PDF/A 转换' }
  const conformance = payload.conformance ?? '2B'
  try {
    convert.call(doc, { conformance })
  } catch (error) {
    return { ok: false, error: `PDF/A 转换失败（文档可能有未嵌入字体）：${friendly(error)}` }
  }
  await writeFile(target, await doc.save())
  return { ok: true, path: target, info: { 标准: `PDF/A-${conformance}`, 页数: doc.getPageCount() } }
}

/* ============================================================
 * 10. 安全遮盖（页面位图替换）
 * ============================================================ */

async function redact(win: BrowserWindow | null, payload: RedactPayload): Promise<ToolResult> {
  const source = await chooseSource(win, payload.sourcePath, '选择要遮盖的 PDF')
  const pages = Array.isArray(payload.pages) ? payload.pages : []
  if (pages.length === 0) return { ok: false, error: '没有需要遮盖的页面' }
  const target = await chooseTarget(win, payload.targetPath, source, '另存为（已遮盖）', '-已遮盖')

  const { doc } = await openPdf(source)
  const total = doc.getPageCount()
  const byPage = new Map<number, (typeof pages)[number]>()
  for (const item of pages) {
    const index = Math.min(Math.max(1, Math.round(item.page)), total) - 1
    byPage.set(index, item)
  }

  const out = await PDFDocument.create()
  for (let i = 0; i < total; i += 1) {
    const replacement = byPage.get(i)
    if (replacement) {
      const bytes = replacement.data instanceof Uint8Array
        ? replacement.data
        : new Uint8Array(replacement.data)
      const image = replacement.mime === 'image/png' ? await out.embedPng(bytes) : await out.embedJpg(bytes)
      const w = replacement.width > 0 ? replacement.width : 595.28
      const h = replacement.height > 0 ? replacement.height : 841.89
      const page = out.addPage([w, h])
      page.drawImage(image, { x: 0, y: 0, width: w, height: h })
    } else {
      const [page] = await out.copyPages(doc, [i])
      out.addPage(page)
    }
  }

  copyMetadata(doc, out)
  await writeFile(target, await out.save())
  return { ok: true, path: target, info: { 遮盖页数: byPage.size, 总页数: total } }
}

/* ============================================================
 * 10.5 创建表单字段（表单设计）
 * ============================================================ */

/**
 * 在页面上放置新的 AcroForm 字段。
 *
 * 与「填写表单」互补：这里是从零添加可交互域。
 * 文本域/dropdown 的 Appearance 用嵌入的中文字体生成，
 * 这样默认值与用户之后输入中文都不会变成空白方块。
 */
async function formsCreate(win: BrowserWindow | null, payload: FormsCreatePayload): Promise<ToolResult> {
  const source = await chooseSource(win, payload.sourcePath, '选择要添加表单字段的 PDF')
  const specs = Array.isArray(payload.fields) ? payload.fields : []
  if (specs.length === 0) return { ok: false, error: '没有要创建的字段' }

  const target = await chooseTarget(win, payload.targetPath, source, '另存为（含表单字段）', '-表单')
  const { doc } = await openPdf(source)
  const font = await cjkFont(doc)
  const form = doc.getForm()
  const warnings: string[] = []
  let created = 0

  for (const spec of specs) {
    const name = String(spec.name ?? '').trim()
    if (!name) {
      warnings.push('字段名为空，已跳过')
      continue
    }
    const pageIndex = Math.min(Math.max(1, Math.round(spec.page || 1)), doc.getPageCount()) - 1
    const page = doc.getPage(pageIndex)
    const { width: pageWidth, height: pageHeight } = page.getSize()
    const w = Math.min(Math.max(8, spec.rect?.width ?? 120), pageWidth)
    const h = Math.min(Math.max(8, spec.rect?.height ?? 24), pageHeight)
    const x = Math.min(Math.max(0, spec.rect?.x ?? 40), pageWidth - w)
    const y = Math.min(Math.max(0, spec.rect?.y ?? 40), pageHeight - h)
    const rect = { x, y, width: w, height: h }
    const fontSize = Math.min(72, Math.max(4, spec.fontSize ?? 12))

    try {
      if (spec.type === 'text') {
        const field = form.createTextField(name)
        field.addToPage(page, rect)
        field.setFontSize(fontSize)
        if (typeof spec.defaultValue === 'string' && spec.defaultValue !== '') {
          field.setText(spec.defaultValue)
          field.updateAppearances(font)
        }
      } else if (spec.type === 'checkbox') {
        const field = form.createCheckBox(name)
        field.addToPage(page, rect)
        if (spec.defaultValue === true) field.check()
      } else if (spec.type === 'dropdown') {
        const options = (spec.options ?? []).map((item) => String(item)).filter(Boolean)
        if (options.length === 0) throw new Error('下拉框至少需要一个选项')
        const field = form.createDropdown(name)
        field.setOptions(options)
        field.addToPage(page, rect)
        field.setFontSize(fontSize)
        if (typeof spec.defaultValue === 'string' && options.includes(spec.defaultValue)) {
          field.select(spec.defaultValue)
          field.updateAppearances(font)
        }
      } else if (spec.type === 'radio') {
        const options = (spec.options ?? []).map((item) => String(item)).filter(Boolean)
        if (options.length === 0) throw new Error('单选组至少需要一个选项')
        const field = form.createRadioGroup(name)
        /*
         * 单选组的每个选项都需要自己的矩形：
         * 这里把整块矩形横向等分，选项从左到右排列（符合常见表单布局）。
         */
        const slice = w / options.length
        options.forEach((option, index) => {
          field.addOptionToPage(option, page, {
            x: x + slice * index,
            y,
            width: Math.max(8, slice - 2),
            height: h
          })
        })
        if (typeof spec.defaultValue === 'string' && options.includes(spec.defaultValue)) {
          field.select(spec.defaultValue)
        }
      } else {
        warnings.push(`${name}：不支持的字段类型 ${String(spec.type)}`)
        continue
      }
      created += 1
    } catch (error) {
      warnings.push(`${name}：${friendly(error)}`)
    }
  }

  await writeFile(target, await doc.save())
  const result: ToolResult = {
    ok: created > 0,
    path: target,
    info: { 新建字段: created, 页数: doc.getPageCount() }
  }
  if (created === 0) {
    result.error = warnings.join('；') || '所有字段都没创建成功'
  } else if (warnings.length > 0) {
    result.error = warnings.join('；')
  }
  return result
}

/**
 * 解析页码范围 "1-3,5,8-10" → 去重升序的页码数组（1 起）。
 * 非法片段直接忽略；空/全非法返回空数组（= 全部页）。
 */
function parsePageSelection(range: string): number[] {
  const pages = new Set<number>()
  const parts = range
    .split(/[,，;；\s]+/)
    .map((part) => part.trim())
    .filter(Boolean)
  for (const part of parts) {
    const match = /^(\d+)(?:\s*[-–~]\s*(\d+))?$/.exec(part)
    if (!match) continue
    const from = Number(match[1])
    const to = match[2] ? Number(match[2]) : from
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to < from) continue
    for (let page = from; page <= to && page - from < 5000; page += 1) pages.add(page)
  }
  return Array.from(pages).sort((a, b) => a - b)
}

/* ============================================================
 * 10.6 打印
 * ============================================================ */

/**
 * 把磁盘路径转成 pdf-file:// URL（与渲染层 DocumentView 的实现一致）。
 */
function encodePdfFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  /*
   * POSIX 绝对路径要整条压成一个路径段再编码。
   *
   * 踩坑：`pdf-file:///Projects/a.pdf` 这种三段斜杠会被 Chromium 折叠成两段，
   * 首段目录变成 **host**，而 host 会被**小写化** —— `/Projects` 变成 `/projects`。
   * Windows 不区分大小写、且有盘符分支，所以从未暴露；Linux 上等于每个 PDF 都 404。
   */
  if (normalized.startsWith('/') && !/^\/[A-Za-z]:\//.test(normalized)) {
    return `pdf-file:///${encodeURIComponent(normalized)}`
  }

  const encoded = normalized
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ':'))
    .join('/')
  return `pdf-file:///${encoded}`
}

/**
 * 打印 PDF。
 *
 * 做法：开一个隐藏窗口加载 print.html（pdf.js 把每页画成 canvas），
 * 等它报告渲染完成后再调 webContents.print()。
 * 为什么不用系统 PDF 查看器：Electron 不带 PDF 插件，自己渲染是唯一可控路径。
 *
 * dryRun = 只渲染不打印，返回页数与第一页尺寸 —— 自动化用例据此判断
 * 「打印页面是否真的把每一页画出来了」（真实打印会弹系统对话框，
 * 在 CI/自动化里没法点）。
 */
async function printPdf(win: BrowserWindow | null, payload: PrintPayload): Promise<ToolResult> {
  const source = await chooseSource(win, payload.sourcePath, '选择要打印的 PDF')
  const pdfUrl = encodePdfFileUrl(source)
  const devUrl = process.env['ELECTRON_RENDERER_URL']

  const printWindow = new BrowserWindow({
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      /* 隐藏窗口默认会被降频，打印渲染需要正常速度 */
      backgroundThrottling: false
    }
  })

  const errors: string[] = []
  printWindow.webContents.on('console-message', (_event, _level, message) => {
    if (message) errors.push(message)
  })

  try {
    /*
     * 页码范围（可选）：只把选中的页交给打印窗口渲染。
     * 传 "pages=1,2,3,5" 这样的逗号列表，由 print.html 按实际页数过滤。
     */
    const selected = parsePageSelection(String(payload.pageRange ?? ''))
    const pageQuery = selected.length > 0 ? `&pages=${selected.join(',')}` : ''
    const search = `pdf=${encodeURIComponent(pdfUrl)}${pageQuery}`
    if (devUrl) {
      await printWindow.loadURL(`${devUrl}/print.html?${search}`)
    } else {
      await printWindow.loadFile(join(__dirname, '../renderer/print.html'), { search })
    }

    /* 轮询渲染完成标志（渲染几十页需要时间） */
    const started = Date.now()
    let info: PrintInfo | null = null
    while (Date.now() - started < 60_000) {
      try {
        const state = (await printWindow.webContents.executeJavaScript(
          '({ ready: !!window.__printReady, info: window.__printInfo || null, error: window.__printError || null })',
          true
        )) as { ready: boolean; info: PrintInfo | null; error: string | null }
        if (state?.error) {
          return { ok: false, error: `打印预览渲染失败：${state.error}` }
        }
        if (state?.ready && state.info && state.info.pages > 0) {
          info = state.info
          break
        }
      } catch {
        /* 页面还在加载 */
      }
      await new Promise((r) => setTimeout(r, 250))
    }

    if (!info) {
      const detail = errors.slice(-3).join(' | ')
      return { ok: false, error: `打印预览渲染失败${detail ? `：${detail}` : '（超时）'}` }
    }

    if (payload.dryRun) {
      return {
        ok: true,
        info: {
          页数: info.pages,
          页面宽: Math.round(info.widthPt),
          页面高: Math.round(info.heightPt)
        }
      }
    }

    const copies = Math.min(20, Math.max(1, Math.round(payload.copies ?? 1)))
    /* 1 点 = 352.78 微米（Electron 的 pageSize 用微米） */
    const microns = (pt: number): number => Math.round(pt * 352.78)
    const printOptions: Parameters<typeof printWindow.webContents.print>[0] = {
      silent: false,
      printBackground: true,
      copies,
      pageSize: { width: microns(info.widthPt), height: microns(info.heightPt) },
      margins: { marginType: 'none' }
    }

    const outcome = await new Promise<{ ok: boolean; reason?: string }>((resolvePrint) => {
      printWindow.webContents.print(printOptions, (success, failureReason) => {
        resolvePrint({ ok: success, reason: failureReason })
      })
    })

    if (!outcome.ok) {
      const reason = outcome.reason ?? ''
      if (reason && !/cancel/i.test(reason)) {
        return { ok: false, error: `打印失败：${reason}` }
      }
      return { ok: false, canceled: true, error: '已取消打印' }
    }

    return { ok: true, info: { 页数: info.pages, 份数: copies } }
  } finally {
    if (!printWindow.isDestroyed()) printWindow.destroy()
  }
}

/* ============================================================
 * 11. 导出 Word / 任意二进制
 * ============================================================ */

async function exportWord(win: BrowserWindow | null, payload: ExportWordPayload): Promise<ToolResult> {
  const source = payload.sourcePath ? resolve(payload.sourcePath) : ''
  if (source && !existsSync(source)) return { ok: false, error: '源文件不存在' }

  const pages = Array.isArray(payload.pages) ? payload.pages : []
  if (pages.length === 0) return { ok: false, error: '没有可写入的文本' }

  const base = source ? basename(source, extname(source)) : '导出'
  let target = payload.targetPath ? resolve(payload.targetPath) : ''
  if (!target) {
    const picked = await askSavePath(
      win,
      '导出为 Word',
      join(source ? dirname(source) : process.cwd(), `${base}.docx`),
      'docx'
    )
    if (!picked) return { ok: false, canceled: true }
    target = picked
  }

  const children = pages
    .slice()
    .sort((a, b) => a.page - b.page)
    .map((page) => ({ text: page.text || '' }))

  const buffer = buildDocx(children, base)
  await writeFile(target, buffer)
  return { ok: true, path: target, info: { 页数: pages.length, 大小: buffer.length } }
}

async function saveBinary(win: BrowserWindow | null, payload: SaveBinaryPayload): Promise<ToolResult> {
  let target = payload.targetPath ? resolve(payload.targetPath) : ''
  if (!target) {
    const picked = await askSavePath(
      win,
      '保存文件',
      join(process.cwd(), payload.defaultName),
      payload.ext
    )
    if (!picked) return { ok: false, canceled: true }
    target = picked
  }
  const bytes = payload.data instanceof Uint8Array ? payload.data : new Uint8Array(payload.data)
  await writeFile(target, bytes)
  return { ok: true, path: target, info: { 大小: bytes.length } }
}

/* ============================================================
 * 12. 导出 Excel
 * ============================================================ */

async function exportExcel(
  win: BrowserWindow | null,
  payload: ExportExcelPayload
): Promise<ToolResult> {
  const source = payload.sourcePath ? resolve(payload.sourcePath) : ''
  if (source && !existsSync(source)) return { ok: false, error: '源文件不存在' }

  const pages = Array.isArray(payload.pages) ? payload.pages : []
  if (pages.length === 0) return { ok: false, error: '没有可写入的文本' }

  const base = source ? basename(source, extname(source)) : '导出表格'
  let target = payload.targetPath ? resolve(payload.targetPath) : ''
  if (!target) {
    const picked = await askSavePath(
      win,
      '导出为 Excel',
      join(source ? dirname(source) : process.cwd(), `${base}.xlsx`),
      'xlsx'
    )
    if (!picked) return { ok: false, canceled: true }
    target = picked
  }

  const buffer = buildXlsx(
    pages.slice().sort((a, b) => a.page - b.page),
    base
  )
  await writeFile(target, buffer)
  return { ok: true, path: target, info: { 页数: pages.length, 大小: buffer.length } }
}

/* ============================================================
 * 12.5 并排对照 PDF（A/B 同页左右排列）
 * ============================================================ */

async function assembleComparePdf(
  win: BrowserWindow | null,
  payload: ComparePdfPayload
): Promise<ToolResult> {
  const pages = Array.isArray(payload.pages) ? payload.pages : []
  if (pages.length === 0) return { ok: false, error: '没有需要输出的对照页' }

  const source = payload.sourcePath ? resolve(payload.sourcePath) : ''
  const base = source ? basename(source, extname(source)) : '文档'
  let target = payload.targetPath ? resolve(payload.targetPath) : ''
  if (!target) {
    const picked = await askSavePath(
      win,
      '并排对照 PDF 另存为',
      join(source ? dirname(source) : process.cwd(), payload.defaultName ?? `${base}-对照.pdf`),
      'pdf'
    )
    if (!picked) return { ok: false, canceled: true }
    target = picked
  }

  const out = await PDFDocument.create()
  for (const page of pages) {
    const bytes = page.data instanceof Uint8Array ? page.data : new Uint8Array(page.data)
    const image = await out.embedJpg(bytes)
    const width = Number(page.width) > 0 ? Number(page.width) : 900
    const height = Number(page.height) > 0 ? Number(page.height) : 1200
    const pdfPage = out.addPage([width, height])
    pdfPage.drawImage(image, { x: 0, y: 0, width, height })
  }
  await writeFile(target, await out.save())
  return { ok: true, path: target, info: { 对照页数: pages.length } }
}

/* ============================================================
 * 13. 批量处理（页眉页脚 / 贝茨编号 / 加密）
 *
 * 水印与压缩需要渲染层光栅化/画图，由界面层循环调用单文件接口完成，
 * 不走这里；这里只做纯粹的主进程文本与加密操作。
 * ============================================================ */

function encryptDoc(doc: PDFDocument, opts: BatchEncrypt): void {
  const userPassword = String(opts?.userPassword ?? '')
  if (userPassword.length < 4) throw new Error('打开密码至少 4 位')
  const allow = opts.permissions ?? {}
  doc.encrypt({
    userPassword,
    ownerPassword: String(opts.ownerPassword ?? '') || userPassword,
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
}

const BATCH_SUFFIX: Record<BatchPayload['operation'], string> = {
  headerfooter: '-页眉页脚',
  bates: '-贝茨',
  encrypt: '-已加密',
  watermark: '-水印'
}

const BATCH_LABEL: Record<BatchPayload['operation'], string> = {
  headerfooter: '页眉页脚',
  bates: '贝茨编号',
  encrypt: '加密',
  watermark: '水印'
}

async function batchApply(win: BrowserWindow | null, payload: BatchPayload): Promise<ToolResult> {
  const operation = payload.operation
  if (!(operation in BATCH_SUFFIX)) {
    return { ok: false, error: `不支持的批量操作：${String(operation)}` }
  }
  if (operation === 'watermark') {
    return {
      ok: false,
      error: '水印批量需要渲染层参与，请使用界面里的批量水印（已自动逐份处理）'
    }
  }

  let files = (payload.files ?? []).map((file) => resolve(file)).filter((file) => existsSync(file))
  if (files.length === 0) {
    const picked = await dialog.showOpenDialog(win ?? undefined!, {
      title: '选择要批量处理的 PDF（可多选）',
      filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
      properties: ['openFile', 'multiSelections']
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true }
    files = picked.filePaths
  }

  const outputDir = payload.outputDir ? ensureDir(resolve(payload.outputDir)) : ''
  const suffix = payload.suffix || BATCH_SUFFIX[operation]
  const written: string[] = []
  const failed: string[] = []

  for (const file of files) {
    try {
      const abs = assertPdf(file)
      const { doc } = await openPdf(abs)

      if (operation === 'headerfooter') {
        const params = payload.headerFooter ?? {}
        if (!params.header && !params.footer) throw new Error('页眉页脚内容为空')
        drawHeaderFooterOnDoc(doc, params, await cjkFont(doc))
      } else if (operation === 'bates') {
        drawBatesOnDoc(doc, payload.bates ?? {}, await cjkFont(doc))
      } else {
        encryptDoc(doc, payload.encrypt ?? { userPassword: '' })
      }

      const target = join(
        outputDir || dirname(abs),
        `${basename(abs, extname(abs))}${suffix}.pdf`
      )
      assertNotSame(target, abs)
      await writeFile(target, await doc.save())
      written.push(target)
    } catch (error) {
      failed.push(`${basename(file)}：${friendly(error)}`)
    }
  }

  const result: ToolResult = {
    ok: written.length > 0,
    paths: written,
    info: {
      操作: BATCH_LABEL[operation],
      成功: written.length,
      失败: failed.length,
      输出目录: outputDir || '与源文件同目录'
    }
  }
  if (written.length === 0) {
    result.error = failed.join('；') || '全部文件处理失败'
  } else if (failed.length > 0) {
    result.error = `部分失败：${failed.join('；')}`
  }
  return result
}

/* ============================================================
 * IPC
 * ============================================================ */

function wrap<T>(fn: (payload: T) => Promise<ToolResult>) {
  return async (_event: unknown, payload: T): Promise<ToolResult> => {
    try {
      return await fn(payload ?? ({} as T))
    } catch (error) {
      if (error instanceof Canceled) return { ok: false, canceled: true }
      console.error('[advanced] 失败：', error)
      return { ok: false, error: friendly(error) }
    }
  }
}

export function registerPdfAdvancedIpc(getWindow: () => BrowserWindow | null): void {
  const win = (): BrowserWindow | null => {
    const current = getWindow()
    return current && !current.isDestroyed() ? current : null
  }

  ipcMain.handle('adv:pages', wrap<PagesApplyPayload>((p) => applyPages(win(), p)))
  ipcMain.handle('adv:header-footer', wrap<HeaderFooterPayload>((p) => applyHeaderFooter(win(), p)))
  ipcMain.handle('adv:bates', wrap<BatesPayload>((p) => applyBates(win(), p)))
  ipcMain.handle('adv:metadata', wrap<MetadataPayload>((p) => applyMetadata(win(), p)))
  ipcMain.handle('adv:bookmarks', wrap<BookmarksPayload>((p) => applyBookmarks(win(), p)))
  ipcMain.handle('adv:attachments', wrap<AttachmentsPayload>((p) => attachmentAction(win(), p)))
  ipcMain.handle('adv:forms-query', wrap<FormsQueryPayload>((p) => formsQuery(win(), p)))
  ipcMain.handle('adv:forms-fill', wrap<FormsFillPayload>((p) => formsFill(win(), p)))
  ipcMain.handle('adv:form-create', wrap<FormsCreatePayload>((p) => formsCreate(win(), p)))
  ipcMain.handle('adv:sign', wrap<SignPayload>((p) => signPdf(win(), p)))
  ipcMain.handle('adv:pdfa', wrap<PdfAPayload>((p) => toPdfA(win(), p)))
  ipcMain.handle('adv:redact', wrap<RedactPayload>((p) => redact(win(), p)))
  ipcMain.handle('adv:print', wrap<PrintPayload>((p) => printPdf(win(), p)))
  ipcMain.handle('adv:export-word', wrap<ExportWordPayload>((p) => exportWord(win(), p)))
  ipcMain.handle('adv:export-excel', wrap<ExportExcelPayload>((p) => exportExcel(win(), p)))
  ipcMain.handle('adv:compare-pdf', wrap<ComparePdfPayload>((p) => assembleComparePdf(win(), p)))
  ipcMain.handle('adv:save-binary', wrap<SaveBinaryPayload>((p) => saveBinary(win(), p)))
  ipcMain.handle('adv:batch', wrap<BatchPayload>((p) => batchApply(win(), p)))

  /** 附件等场景：选任意文件（可多选） */
  ipcMain.handle('adv:pick-files', async (): Promise<string[]> => {
    const picked = await dialog.showOpenDialog(win() ?? undefined!, {
      title: '选择文件（可多选）',
      properties: ['openFile', 'multiSelections']
    })
    return picked.canceled ? [] : picked.filePaths
  })
}
