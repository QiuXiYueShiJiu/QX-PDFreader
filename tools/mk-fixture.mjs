/**
 * 生成**功能全覆盖**的测试夹具 PDF（v2：改用 pdf-lib）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么从「手写 PDF 语法」改成 pdf-lib（一段踩坑记录，别再走回头路）
 * ══════════════════════════════════════════════════════════════════
 *   第一版是手写对象表 + 自己拼 xref，理由是「不让夹具的生成依赖被测库」。
 *   结果连续踩了三个坑，每个的症状都出现在**别的地方**，排查成本极高：
 *
 *     ① 大纲根对象号错位：`/Outlines` 指向了最后一页的 Page 对象，
 *        pdf.js 渲染第 1 页报 `Illegal character: 41`。
 *     ② 内嵌位图被 latin1 转换破坏：deflate 后的二进制被当字符串
 *        走了一遍 `Buffer.from(s,'latin1')`，内容与长度都不对。
 *     ③ 内容流 `/Length` 与「stream 之后那个 EOL 算不算」的口径不一致，
 *        21 个流全部差 1 字节，pdf.js 的 xref 校验报
 *        `Bad (uncompressed) XRef entry`。
 *
 *   pdf-lib 本来就是本项目的运行时依赖（导出功能在用），把这三个坑
 *   一次性交给它，生成代码还短了一半。
 *   代价：夹具生成依赖一个第三方库 —— 但它已在 dependencies 里，不是新增。
 *
 * ══════════════════════════════════════════════════════════════════
 * 夹具覆盖了什么（每一项都对应一类用例）
 * ══════════════════════════════════════════════════════════════════
 *   翻页 / 页码      20 页
 *   缩放 / 适配      8 种页面尺寸（含 1191×842 超宽、400×1200 超长）
 *   旋转             第 10 页 90°、第 11 页 270°
 *   目录 / 书签      6 条
 *   文本选择 / 复制  多页满幅可提取英文（含长单词与各种标点）
 *   图片             第 5 页内嵌 240×160 RGB 位图
 *   矢量图形         第 6、15 页：矩形 / 圆 / 折线 / 虚线
 *   涂白 / 文本框    第 7 页近乎空白、第 8 页只有页眉页脚
 *   字号阶梯         第 17 页 6~36pt
 *
 * 用法：
 *   node tools/mk-fixture.mjs                    # 写到 tests/fixture/fixture.pdf
 *   node tools/mk-fixture.mjs <输出路径>
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { dirname, resolve } from 'node:path'
import { PDFDocument, PDFString, StandardFonts, rgb } from 'pdf-lib'
import { fixturePath } from '../scripts/packaging-paths.mjs'

const DEFAULT_OUT = fixturePath()
const argv = process.argv.slice(2)
const outPath = resolve(argv.find((a) => !a.startsWith('--')) ?? DEFAULT_OUT)

/* ============================================================
 * 内容素材
 * ============================================================ */

const PARA = [
  'The quick brown fox jumps over the lazy dog. 0123456789 !@#$%^&*()_+-=[]{};:,.<>/?',
  'Portable Document Format preserves the exact layout of a document, independent of the',
  'software, hardware, or operating system used to create or view it. Each page is described',
  'by a content stream that draws text, vector graphics and raster images onto a canvas',
  'whose origin sits at the lower-left corner and whose unit is one seventy-second of an inch.',
  'This fixture intentionally mixes long unbroken tokens such as',
  'Antidisestablishmentarianism Pneumonoultramicroscopicsilicovolcanoconiosis with ordinary',
  'prose, so that selection, highlight, copy and the greedy line wrapping used by the export',
  'pipeline all get something non-trivial to chew on. Numbers 1234567890 and punctuation',
  'marks (parentheses) [brackets] {braces} quotes apostrophes back-slashes must survive',
  'the round trip through text extraction without being mangled or dropped silently.'
]

const A4 = [595.28, 841.89]
const LETTER = [612, 792]
const A5 = [419.53, 595.28]
const LANDSCAPE = [841.89, 595.28]
const WIDE = [1190.55, 841.89]
const TINY = [283.46, 425.2]
const SQUARE = [600, 600]
const TALL = [400, 1200]

const PLAN = [
  { size: A4, kind: 'cover', title: 'Cover / title page' },
  { size: A4, kind: 'text', title: 'Dense text (selection)' },
  { size: A4, kind: 'text', title: 'Dense text (continuation)' },
  { size: LETTER, kind: 'text', title: 'US Letter, dense text' },
  { size: A4, kind: 'image', title: 'Embedded RGB raster image' },
  { size: A4, kind: 'vector', title: 'Vector shapes (rect / circle / lines)' },
  { size: A4, kind: 'blank', title: 'Almost blank (whiteout target)' },
  { size: A4, kind: 'margins', title: 'Header + footer only (text box target)' },
  { size: LANDSCAPE, kind: 'text', title: 'Landscape A4' },
  { size: A4, kind: 'text', title: 'Rotate 90 degrees', rotate: 90 },
  { size: A4, kind: 'text', title: 'Rotate 270 degrees', rotate: 270 },
  { size: A5, kind: 'text', title: 'A5 (small page)' },
  { size: TINY, kind: 'text', title: 'A6 (fits on screen)' },
  { size: WIDE, kind: 'zoomgrid', title: 'Double-width (zoom target)' },
  { size: SQUARE, kind: 'vector', title: 'Square page, vector art' },
  { size: TALL, kind: 'longtext', title: 'Very tall page (scroll target)' },
  { size: A4, kind: 'fonts', title: 'Font size ladder 6..36' },
  { size: A4, kind: 'text', title: 'Dense text (again)' },
  { size: A4, kind: 'blank', title: 'Almost blank (blend target)' },
  { size: A4, kind: 'end', title: 'End of document' }
]

/* ============================================================
 * 内嵌位图：自己编一张 PNG（pdf-lib 只接受 PNG/JPG）
 * ============================================================ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/**
 * 造一张 RGB 位图并编成 PNG。
 *
 * 图案：左侧色带 + 中间棋盘 + 右下同心圆。
 * 棋盘与同心圆对**缩放插值**最敏感 —— 缩放后若有摩尔纹/锯齿异常，
 * 放大这张图就看得出来；纯色块看不出问题。
 */
function makePng(width = 240, height = 160) {
  const raw = Buffer.alloc(height * (1 + width * 3))
  let p = 0
  for (let y = 0; y < height; y++) {
    raw[p++] = 0 // 每行 filter=0
    for (let x = 0; x < width; x++) {
      let r
      let g
      let b
      const dist = Math.hypot(x - 170, y - 118)
      if (dist < 42) {
        const t = 1 - dist / 42
        r = Math.round(20 + 215 * t)
        g = Math.round(120 + 100 * t)
        b = Math.round(240 - 120 * t)
      } else if (x < 80) {
        r = Math.round((x / 80) * 255)
        g = 60
        b = Math.round(255 - (x / 80) * 200)
      } else {
        const checker = (Math.floor(x / 16) + Math.floor(y / 16)) % 2 === 0
        r = checker ? 235 : 45
        g = checker ? 235 : 90
        b = checker ? 200 : 45
      }
      raw[p++] = r
      raw[p++] = g
      raw[p++] = b
    }
  }

  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body), 0)
    return Buffer.concat([len, body, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* ============================================================
 * 组装
 * ============================================================ */

const doc = await PDFDocument.create()
doc.setTitle('QiuXi PDF Reader - Test Fixture')
doc.setAuthor('QiuXi Yue Shi Jiu')
doc.setSubject('Feature coverage fixture: text, images, vectors, rotation, page sizes')
doc.setKeywords(['fixture', 'test', 'pdf', 'text', 'image', 'vector', 'rotation', 'zoom'])
doc.setCreator('tools/mk-fixture.mjs')
doc.setProducer('QiuXi PDF Reader test tooling')
doc.setCreationDate(new Date('2026-10-16T22:00:00+08:00'))

const F1 = await doc.embedFont(StandardFonts.Helvetica)
const F2 = await doc.embedFont(StandardFonts.HelveticaBold)
const F3 = await doc.embedFont(StandardFonts.HelveticaOblique)

const png = makePng(240, 160)
const IMG = await doc.embedPng(png)

const INK = rgb(0.12, 0.12, 0.14)
const MUTED = rgb(0.45, 0.45, 0.5)
const BRAND = rgb(0.22, 0.35, 0.55)
const WHITE = rgb(1, 1, 1)

function chrome(page, w, h, no, total, title) {
  page.drawRectangle({ x: 0, y: h - 34, width: w, height: 34, color: BRAND })
  page.drawText('QiuXi PDF Reader - Test Fixture', { x: 24, y: h - 23, size: 12, font: F2, color: WHITE })
  page.drawText(`Page ${no} / ${total}`, { x: w - 110, y: h - 23, size: 12, font: F2, color: WHITE })
  page.drawText(title, { x: 24, y: 24, size: 10, font: F1, color: MUTED })
  page.drawText(`${Math.round(w)} x ${Math.round(h)} pt`, { x: w - 130, y: 24, size: 10, font: F1, color: MUTED })
  page.drawLine({ start: { x: 24, y: 38 }, end: { x: w - 24, y: 38 }, thickness: 0.6, color: rgb(0.7, 0.7, 0.7) })
}

function paragraph(page, x, yTop, rows, size = 10.5, leading = 15) {
  for (let r = 0; r < rows; r++) {
    page.drawText(PARA[r % PARA.length], { x, y: yTop - r * leading, size, font: F1, color: INK })
  }
}

const pages = []
for (const [index, spec] of PLAN.entries()) {
  const [w, h] = spec.size
  const page = doc.addPage([w, h])
  if (spec.rotate) page.setRotation({ type: 'degrees', angle: spec.rotate })
  pages.push(page)
  const no = index + 1

  switch (spec.kind) {
    case 'cover': {
      page.drawRectangle({ x: 0, y: h - 240, width: w, height: 240, color: BRAND })
      page.drawText('QiuXi PDF Reader', { x: 48, y: h - 110, size: 34, font: F2, color: WHITE })
      page.drawText('Test fixture - all features', { x: 48, y: h - 152, size: 18, font: F1, color: rgb(0.85, 0.9, 1) })
      page.drawText(`Generated ${new Date().toISOString().slice(0, 10)}`, {
        x: 48,
        y: h - 182,
        size: 11,
        font: F1,
        color: rgb(0.75, 0.82, 0.95)
      })
      page.drawText('Contents', { x: 48, y: h - 300, size: 20, font: F2, color: rgb(0.15, 0.2, 0.3) })
      page.drawLine({
        start: { x: 48, y: h - 320 },
        end: { x: w - 48, y: h - 320 },
        thickness: 1,
        color: rgb(0.6, 0.65, 0.7)
      })
      const toc = [
        'Text-heavy pages .......... pages 2-4, 9, 12, 13, 18',
        'Embedded raster image ..... page 5',
        'Vector shapes ............. pages 6, 15',
        'Almost blank pages ........ pages 7, 19',
        'Header/footer only ........ page 8',
        'Rotated pages ............. pages 10, 11',
        'Oversized / tiny / tall ... pages 13, 14, 16',
        'Font size ladder .......... page 17'
      ]
      toc.forEach((t, i) => {
        page.drawText(t, { x: 48, y: h - 340 - i * 26, size: 12.5, font: F1, color: rgb(0.2, 0.22, 0.26) })
      })
      page.drawText('This document is machine generated; every element exists on purpose.', {
        x: 48,
        y: 70,
        size: 10,
        font: F3,
        color: MUTED
      })
      break
    }
    case 'text':
      paragraph(page, 48, h - 70, 34)
      page.drawLine({
        start: { x: 48, y: 96 },
        end: { x: w - 48, y: 96 },
        thickness: 0.8,
        color: rgb(0.75, 0.75, 0.75),
        dashArray: [4, 3]
      })
      page.drawText('Selectable text above - try drag-select, highlight and copy.', {
        x: 48,
        y: 74,
        size: 10,
        font: F3,
        color: MUTED
      })
      break
    case 'longtext':
      paragraph(page, 36, h - 70, 74, 10, 14)
      break
    case 'image':
      page.drawText('Raster image below: 240 x 160 RGB, PNG embedded.', {
        x: 48,
        y: h - 70,
        size: 13,
        font: F2,
        color: rgb(0.15, 0.2, 0.3)
      })
      page.drawImage(IMG, { x: 48, y: h - 420, width: 360, height: 240 })
      page.drawRectangle({
        x: 48,
        y: h - 420,
        width: 360,
        height: 240,
        borderColor: rgb(0.3, 0.35, 0.45),
        borderWidth: 1.2
      })
      page.drawText('Left: colour ramp. Middle: checkerboard. Right: radial gradient.', {
        x: 48,
        y: h - 450,
        size: 11,
        font: F1,
        color: INK
      })
      page.drawText('Zoom past 200% - the checkerboard reveals any interpolation artefact.', {
        x: 48,
        y: h - 468,
        size: 11,
        font: F1,
        color: INK
      })
      paragraph(page, 48, h - 510, 10, 10, 14)
      break
    case 'vector':
      page.drawRectangle({
        x: 60,
        y: h - 200,
        width: 180,
        height: 110,
        color: rgb(0.9, 0.75, 0.55),
        borderColor: rgb(0.4, 0.3, 0.15),
        borderWidth: 1.5
      })
      page.drawText('filled rect', { x: 60, y: h - 216, size: 10, font: F1, color: rgb(0.35, 0.3, 0.25) })
      page.drawRectangle({ x: 280, y: h - 200, width: 180, height: 110, borderColor: rgb(0.2, 0.45, 0.7), borderWidth: 2.5 })
      page.drawText('stroked rect', { x: 280, y: h - 216, size: 10, font: F1, color: rgb(0.2, 0.35, 0.55) })
      page.drawCircle({
        x: 140,
        y: h - 340,
        size: 62,
        color: rgb(0.7, 0.85, 0.8),
        borderColor: rgb(0.15, 0.4, 0.3),
        borderWidth: 1.5
      })
      page.drawCircle({ x: 360, y: h - 340, size: 62, borderColor: rgb(0.7, 0.3, 0.35), borderWidth: 2 })
      page.drawLine({ start: { x: 60, y: h - 450 }, end: { x: w - 60, y: h - 450 }, thickness: 1, color: rgb(0.2, 0.2, 0.2) })
      page.drawLine({
        start: { x: 60, y: h - 470 },
        end: { x: w - 60, y: h - 470 },
        thickness: 2,
        color: rgb(0.6, 0.2, 0.2),
        dashArray: [6, 4]
      })
      page.drawLine({ start: { x: 60, y: h - 500 }, end: { x: w - 60, y: h - 540 }, thickness: 3, color: rgb(0.2, 0.5, 0.3) })
      paragraph(page, 60, h - 590, 8, 10, 14)
      break
    case 'blank':
      page.drawText('This page is intentionally almost blank.', {
        x: 48,
        y: h - 70,
        size: 12,
        font: F1,
        color: rgb(0.55, 0.55, 0.6)
      })
      page.drawText('Use it as the target of whiteout / rectangle / ellipse tests.', {
        x: 48,
        y: h - 92,
        size: 11,
        font: F3,
        color: rgb(0.6, 0.6, 0.65)
      })
      break
    case 'margins':
      paragraph(page, 48, h - 70, 3)
      page.drawText('Body intentionally left empty from here down.', {
        x: 48,
        y: h / 2,
        size: 11,
        font: F3,
        color: rgb(0.6, 0.6, 0.65)
      })
      break
    case 'zoomgrid': {
      const cols = 4
      const rows = 3
      const cw = (w - 96) / cols
      const ch = (h - 220) / rows
      for (let r = 0; r < rows; r++) {
        for (let cc = 0; cc < cols; cc++) {
          const x = 48 + cc * cw
          const y = h - 150 - (r + 1) * ch
          const tint = 0.86 - (r * cols + cc) * 0.045
          page.drawRectangle({
            x: x + 4,
            y: y + 4,
            width: cw - 8,
            height: ch - 8,
            color: rgb(tint, tint + 0.04, tint + 0.1),
            borderColor: rgb(0.35, 0.4, 0.5),
            borderWidth: 1
          })
          page.drawText(`cell ${r * cols + cc + 1}`, {
            x: x + 16,
            y: y + ch - 26,
            size: 11,
            font: F2,
            color: rgb(0.25, 0.3, 0.4)
          })
          page.drawText(`${Math.round(cw)}x${Math.round(ch)}`, {
            x: x + 16,
            y: y + ch - 44,
            size: 9,
            font: F1,
            color: rgb(0.4, 0.45, 0.55)
          })
        }
      }
      page.drawText('Double-width page - zoom to 200%+ and the grid should stay crisp.', {
        x: 48,
        y: 74,
        size: 11,
        font: F3,
        color: MUTED
      })
      break
    }
    case 'fonts': {
      const sizes = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36]
      let y = h - 80
      for (const s of sizes) {
        page.drawText(`${String(s).padStart(2)} pt  The quick brown fox 0123456789`, { x: 48, y, size: s, font: F1, color: INK })
        y -= s + 10
      }
      page.drawText('Smallest 6pt, largest 36pt - check text layer scaling.', {
        x: 48,
        y: 60,
        size: 10,
        font: F3,
        color: MUTED
      })
      break
    }
    case 'end':
      page.drawText('End of document', { x: 48, y: h - 120, size: 26, font: F2, color: rgb(0.15, 0.2, 0.3) })
      page.drawText(`${PLAN.length} pages, 8 page geometries, 2 rotations, 1 raster image.`, {
        x: 48,
        y: h - 156,
        size: 12,
        font: F1,
        color: INK
      })
      paragraph(page, 48, h - 200, 12)
      page.drawRectangle({
        x: 48,
        y: 90,
        width: w - 96,
        height: 46,
        color: rgb(0.95, 0.93, 0.85),
        borderColor: rgb(0.7, 0.65, 0.5),
        borderWidth: 1
      })
      page.drawText('If you can read this line, the fixture rendered fully.', {
        x: 60,
        y: 108,
        size: 12,
        font: F2,
        color: rgb(0.35, 0.32, 0.2)
      })
      break
    default:
      paragraph(page, 48, h - 70, 20)
  }

  chrome(page, w, h, no, PLAN.length, spec.title)
}

/* ---------- 目录（书签）---------- */
const outline = [
  ['Cover', 1],
  ['Text pages', 2],
  ['Raster image page', 5],
  ['Vector shapes', 6],
  ['Rotated pages', 10],
  ['End of document', PLAN.length]
]
const ctx = doc.context
const refs = []
for (const [title, pageNo] of outline) {
  /*
   * ★ Title 必须用 `PDFString.of()` 包一层。
   *   直接给普通 JS 字符串时 pdf-lib 会把它当**已编码的 PDF 语法片段**处理，
   *   结果是空字符串 —— 书签条数对、标题全是空的，肉眼看不出来，
   *   只有读到 outline 才发现（实测：6 条书签标题全空）。
   */
  const ref = ctx.register(
    ctx.obj({ Title: PDFString.of(title), Dest: [pages[pageNo - 1].ref, PDFString.of('Fit')] })
  )
  refs.push(ref)
}
for (let i = 0; i < refs.length; i++) {
  const obj = ctx.lookup(refs[i])
  if (i > 0) obj.set(ctx.obj('Prev'), refs[i - 1])
  if (i < refs.length - 1) obj.set(ctx.obj('Next'), refs[i + 1])
}
const rootRef = ctx.register(ctx.obj({ Type: 'Outlines', First: refs[0], Last: refs[refs.length - 1], Count: refs.length }))
for (const r of refs) ctx.lookup(r).set(ctx.obj('Parent'), rootRef)
doc.catalog.set(ctx.obj('Outlines'), rootRef)
doc.catalog.set(ctx.obj('PageMode'), ctx.obj('UseOutlines'))

/* ---------- 写盘 ---------- */
const bytes = await doc.save()
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, bytes)

console.log(`wrote ${outPath}`)
console.log(`  size    = ${(bytes.length / 1024).toFixed(1)} KB`)
console.log(`  pages   = ${doc.getPageCount()}`)
console.log(`  outline = ${refs.length} entries`)
console.log(`  image   = 240x160 RGB (PNG ${(png.length / 1024).toFixed(1)} KB)`)
