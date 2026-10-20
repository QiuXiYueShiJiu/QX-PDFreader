// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 检查 PDF 是否含可提取文本。
 *
 * 用途：批注依赖文本层（选区），若文档是扫描件则文本层为空，
 * 需要明确区分「文档本身没文字」与「pdf.js 提取失败」。
 *
 * 用法：node scripts/check-pdf-text.mjs "<pdf路径>" [检查页数]
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')

const filePath = process.argv[2]
const maxPages = Number(process.argv[3] ?? 3)

if (!filePath) {
  console.error('用法: node scripts/check-pdf-text.mjs "<pdf路径>" [页数]')
  process.exit(1)
}

// Node 环境没有 worker，用 legacy 构建并关闭 worker
const data = new Uint8Array(readFileSync(filePath))
const doc = await pdfjs.getDocument({
  data,
  useWorkerFetch: false,
  isEvalSupported: false,
  useSystemFonts: false
}).promise

console.log(`文件: ${filePath}`)
console.log(`页数: ${doc.numPages}`)

const pages = Math.min(maxPages, doc.numPages)
for (let i = 1; i <= pages; i++) {
  const page = await doc.getPage(i)
  const content = await page.getTextContent()
  const items = content.items
  const text = items.map((it) => ('str' in it ? it.str : '')).join('')
  console.log(
    `  第 ${i} 页：内容项 ${items.length}，字符数 ${text.length}` +
      (text.length > 0 ? `，开头「${text.slice(0, 50).replace(/\s+/g, ' ')}」` : '  ← 无文本层')
  )

  // 顺便看看有哪些内容类型（图片型 PDF 会有大量 image 操作）
  const ops = await page.getOperatorList()
  const imageOps = ops.fnArray.filter((fn) => fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject).length
  console.log(`         绘制操作 ${ops.fnArray.length} 个，其中图片 ${imageOps} 个`)
}

await doc.destroy()
