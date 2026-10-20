/**
 * 生成 **第二份** 测试夹具，专供「多标签页」用例。
 *
 * ── 为什么需要两份 ──────────────────────────────────────────
 *   `verify-tabs.mjs` 验的是「一个窗口装多个文件」。它必须打开
 *   **两个不同的路径**，否则会命中 store 的「同路径复用已有标签」逻辑，
 *   第二个文件根本开不出新标签 —— 判据会以「标签数没变」这种
 *   看起来像产品 bug 的方式失败（实测踩过：把两份都指向同一夹具）。
 *
 *   所以这里生成一份**内容不同、页数不同**的第二夹具，
 *   让它同时也能验「不同文档的页码/缩放各自暂存与恢复」。
 *
 * ── 与第一份的区别 ─────────────────────────────────────────
 *   主夹具 20 页（覆盖全部页面类型）；这一份**小巧**（5 页），
 *   因为多标签用例不需要页面多样性，只需要「是另一份文档」。
 *
 * 用法：node tools/mk-fixture-b.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const OUT = join(root, 'tests', 'fixture', 'fixture-b.pdf')

const PAGE_W = 595.28
const PAGE_H = 841.89
const PAGES = 5

const bodies = []
const add = (b) => {
  bodies.push(b)
  return bodies.length
}
const text = (s, x, y, size = 12, font = 'F1') =>
  `BT 0.12 0.12 0.14 rg /${font} ${size} Tf ${x} ${y} Td (${s.replace(/([\\()])/g, '\\$1')}) Tj ET\n`

/* 1 catalog / 2 pages 占位 */
add(null)
add(null)
const F1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
const F2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>')

const pageIds = []
for (let i = 1; i <= PAGES; i++) {
  let c = ''
  /* 明显的色带：一眼能看出「这是另一份文档」 */
  c += `0.85 0.3 0.32 rg 0 ${PAGE_H - 46} ${PAGE_W} 46 re f\n`
  c += text(`Fixture B  -  page ${i} / ${PAGES}`, 32, PAGE_H - 30, 15, 'F2')
  c += text('This is the SECOND fixture, used by the tabs test.', 32, PAGE_H - 80, 12)
  c += text('It is deliberately small and visually distinct.', 32, PAGE_H - 100, 12)
  for (let k = 0; k < 20; k++) {
    c += text(`Page ${i} line ${k + 1}: aaa bbb ccc 1234567890`, 32, PAGE_H - 140 - k * 22, 11)
  }
  c += `0.3 0.45 0.8 RG 2 w 32 120 m ${PAGE_W - 32} 120 l S\n`
  c += text('Fixture B end marker', 32, 96, 10, 'F2')

  const contentId = add(`<< /Length ${Buffer.byteLength(c)} >>\nstream\n${c}\nendstream`)
  const pageId = add(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 ${F1} 0 R /F2 ${F2} 0 R >> >> /Contents ${contentId} 0 R >>`
  )
  pageIds.push(pageId)
}

bodies[0] = '<< /Type /Catalog /Pages 2 0 R >>'
bodies[1] = `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`

let pdf = '%PDF-1.7\n'
const offsets = []
bodies.forEach((b, i) => {
  offsets.push(Buffer.byteLength(pdf, 'latin1'))
  pdf += `${i + 1} 0 obj\n${b}\nendobj\n`
})
const xref = Buffer.byteLength(pdf, 'latin1')
pdf += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`
for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`
pdf += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, Buffer.from(pdf, 'latin1'))
console.log(`wrote ${OUT}`)
console.log(`  pages = ${PAGES}   size = ${(Buffer.byteLength(pdf) / 1024).toFixed(1)} KB`)
