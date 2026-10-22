// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 批量 PDF → 图片。
 *
 * 逐份打开 PDF、用 pdf.js 渲染每一页，再交给主进程 saveImages 落盘。
 * 每份 PDF 输出到独立子文件夹（`<文件名>-图片` 或 指定根目录/<文件名>），
 * 避免多份文档的「第 1 页.png」互相覆盖。
 */

import { openPdfForTools, renderPdfPages } from './pdf-tools'

export interface BatchImageOptions {
  dpi: number
  format: 'png' | 'jpeg'
  /** 输出根目录；不填则写在源文件同目录下的「<文件名>-图片」子目录 */
  outputRoot?: string
}

export interface BatchImageOutcome {
  /** 成功写出的图片路径 */
  written: string[]
  /** 失败信息（每份一条） */
  failed: string[]
  /** 处理的 PDF 数 */
  documents: number
  /** 渲染出的图片总数 */
  images: number
}

function basename(file: string): string {
  const name = file.split(/[\\/]/).pop() ?? file
  return name.replace(/\.[^.]+$/, '')
}

function dirname(file: string): string {
  const index = Math.max(file.lastIndexOf('\\'), file.lastIndexOf('/'))
  return index > 0 ? file.slice(0, index) : '.'
}

/**
 * 批量把若干 PDF 逐页导出为图片。
 *
 * @param files 源 PDF 列表
 * @param options dpi / 格式 / 输出根目录
 * @param onProgress 每完成一份回调一次（含当前文件名）
 */
export async function batchPdfToImages(
  files: string[],
  options: BatchImageOptions,
  onProgress?: (done: number, total: number, file: string) => void
): Promise<BatchImageOutcome> {
  const outcome: BatchImageOutcome = { written: [], failed: [], documents: 0, images: 0 }
  const ext = options.format === 'png' ? 'png' : 'jpg'

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]
    const base = basename(file)
    let doc = null
    try {
      doc = await openPdfForTools(file)
      const pages = await renderPdfPages(doc, {
        dpi: Math.min(300, Math.max(72, options.dpi)),
        format: options.format,
        quality: 0.9
      })
      if (pages.length === 0) throw new Error('没有可导出的页面')

      const outputDir = options.outputRoot
        ? `${options.outputRoot}\\${base}`
        : `${dirname(file)}\\${base}-图片`

      const result = await window.pdfApp.tools.saveImages({
        singleFile: false,
        outputDir,
        baseName: base,
        images: pages.map((page) => ({
          name: `${base}-第${page.page}页.${ext}`,
          mime: page.mime,
          data: page.data
        }))
      })

      if (result.ok) {
        outcome.documents += 1
        outcome.images += pages.length
        outcome.written.push(...(result.paths ?? []))
      } else {
        outcome.failed.push(`${base}：${result.error ?? '保存失败'}`)
      }
    } catch (cause) {
      outcome.failed.push(`${base}：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      if (doc) void doc.destroy()
      onProgress?.(index + 1, files.length, file)
    }
  }

  return outcome
}
