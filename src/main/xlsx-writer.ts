// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 极简 .xlsx 生成器（把纯文本按行/列写成 Excel 表格）。
 *
 * 与 docx-writer 同一思路：自己拼最小 OOXML，用 MIT 的 fflate 打包，
 * 不引入任何带 copyleft 的第三方表格库（项目许可证闸门要求零 copyleft）。
 *
 * ── 最小 xlsx 结构 ────────────────────────────────────────────
 *   zip 根
 *     ├─ [Content_Types].xml
 *     ├─ _rels/.rels
 *     ├─ xl/workbook.xml
 *     ├─ xl/_rels/workbook.xml.rels
 *     └─ xl/worksheets/sheet1.xml
 *
 * 单元格全部用 inlineStr（内联字符串），不建 sharedStrings：
 * 实现简单、打开速度对几千行以内的内容没有可感知差异。
 */

import { strToU8, zipSync } from 'fflate'

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** 列号（0 起）→ Excel 列名（A、B…AA） */
function columnName(index: number): string {
  let name = ''
  let n = index
  while (n >= 0) {
    name = String.fromCharCode(65 + (n % 26)) + name
    n = Math.floor(n / 26) - 1
  }
  return name
}

/**
 * 把一行文本拆成若干单元格。
 *
 * 规则：Tab 或「两个及以上连续空格」视为列分隔（从 PDF 提取的文字里，
 * 列间距通常就是多个连续空格）。否则整行放进第一列。
 */
export function splitRow(line: string): string[] {
  const parts = line.split(/\t| {2,}/).map((cell) => cell.trim())
  return parts.length > 0 ? parts : ['']
}

interface CellSpec {
  text: string
  /** 纯数字（含负号/小数点）时写成数值单元格，Excel 里可直接参与计算 */
  numeric: boolean
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`

/**
 * 由「每页文本」生成 .xlsx 字节。
 *
 * 行为约定：
 *   · 每行文本按 splitRow 拆列；
 *   · 页与页之间插入一行 `===== 第 N 页 =====`（方便对照原文页码）；
 *   · 首行如果全是短文本，作为表头不动（不做额外推断）。
 *   · 渲染层若给了对齐好的 `rows`（按文字 x 坐标聚列），直接用它，
 *     不再按空格猜列 —— 这是「列对齐」的可靠做法。
 */
export function buildXlsx(
  pages: Array<{ page: number; text?: string; rows?: string[][] }>,
  title = '导出表格'
): Uint8Array {
  const rows: CellSpec[][] = []

  pages.forEach((page) => {
    /*
     * 每页都插一行页码分隔：单页文档也能一眼看出「这是第几页导出的」，
     * 与 .docx / .txt 的页标记保持一致。
     */
    rows.push([{ text: `===== 第 ${page.page} 页 =====`, numeric: false }])

    if (Array.isArray(page.rows) && page.rows.length > 0) {
      for (const cells of page.rows) {
        rows.push(
          (cells.length > 0 ? cells : ['']).map((cell) => ({
            text: String(cell ?? ''),
            numeric: /^-?\d+(\.\d+)?$/.test(String(cell ?? '').trim())
          }))
        )
      }
      return
    }

    const lines = (page.text ?? '').replace(/\r/g, '').split('\n')
    for (const line of lines) {
      rows.push(
        splitRow(line).map((cell) => ({ text: cell, numeric: /^-?\d+(\.\d+)?$/.test(cell) }))
      )
    }
  })

  const sheetRows = rows
    .map((cells, rowIndex) => {
      const r = rowIndex + 1
      if (cells.length === 0) return `<row r="${r}"/>`
      const cellXml = cells
        .map((cell, colIndex) => {
          const ref = `${columnName(colIndex)}${r}`
          if (cell.numeric) {
            return `<c r="${ref}" t="n"><v>${escapeXml(cell.text)}</v></c>`
          }
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell.text)}</t></is></c>`
        })
        .join('')
      return `<row r="${r}">${cellXml}</row>`
    })
    .join('\n')

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
${sheetRows}
</sheetData>
</worksheet>`

  const coreXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${escapeXml(title)}</dc:title>
<dc:creator>秋夕-PDF阅读器</dc:creator>
</cp:coreProperties>`

  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(ROOT_RELS),
    'docProps/core.xml': strToU8(coreXml),
    'xl/workbook.xml': strToU8(workbookXml),
    'xl/_rels/workbook.xml.rels': strToU8(WORKBOOK_RELS),
    'xl/worksheets/sheet1.xml': strToU8(sheetXml)
  }

  return zipSync(files, { level: 6 })
}
