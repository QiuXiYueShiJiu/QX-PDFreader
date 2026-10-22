// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 极简 .docx 生成器（只做「把纯文本按页写进 Word」这一件事）。
 *
 * ── 为什么不用 docx 包 ────────────────────────────────────────
 *   `docx` 很好用，但它依赖 jszip，而 jszip 的许可是
 *   `MIT OR GPL-3.0-or-later` —— 本项目的交付闸门要求「零 copyleft」，
 *   引入它会直接触发红线（实测 check-licenses 判不通过）。
 *   这里用 MIT 的 fflate 自己打一个最小 OOXML 包，依赖干净，
 *   体积也只有几 KB。
 *
 * ── docx 的最小合法结构 ──────────────────────────────────────
 *   zip 根
 *     ├─ [Content_Types].xml          声明各部件类型
 *     ├─ _rels/.rels                  指向主文档
 *     └─ word/document.xml            正文（w:body 里一串 w:p）
 *   Word、WPS、LibreOffice 都能打开。
 */

import { strToU8, zipSync } from 'fflate'

/** XML 文本转义（& < > " 和换行由段落负责） */
function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`

/** 一段普通文字 */
function paragraph(text: string): string {
  if (text === '') return '<w:p/>'
  return `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`
}

/** 分页符（Acrobat 导出 Word 时按页分页，这里保持一致） */
const PAGE_BREAK = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'

/**
 * 由「每页纯文本」生成 .docx 字节。
 *
 * @param pages 文本页数组（顺序即 Word 里的顺序，页与页之间插入分页符）
 * @param title 文档标题（写入核心属性，见 docProps/core.xml）
 */
export function buildDocx(
  pages: Array<{ text: string }>,
  title = '导出文档'
): Uint8Array {
  const lines: string[] = []
  pages.forEach((page, index) => {
    const pageLines = (page.text || '').replace(/\r/g, '').split('\n')
    for (const line of pageLines) lines.push(paragraph(line))
    if (index < pages.length - 1) lines.push(PAGE_BREAK)
  })

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${lines.join('\n')}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
</w:body>
</w:document>`

  const coreXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${escapeXml(title)}</dc:title>
<dc:creator>秋夕-PDF阅读器</dc:creator>
</cp:coreProperties>`

  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(ROOT_RELS),
    'word/document.xml': strToU8(documentXml),
    'docProps/core.xml': strToU8(coreXml)
  }

  return zipSync(files, { level: 6 })
}
