// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 插件 ↔ 应用的一个极小的回调登记处。
 *
 * 为什么单开一个文件：
 *   plugin-broker.ts 需要「把插件生成的 PDF 交给应用打开」，而打开文档的
 *   实现在 index.ts 里；index.ts 又 import 了 plugins.ts → broker。
 *   直接在 broker 里 import index 会形成循环依赖（打包后表现为 undefined）。
 *   所以用一个没有依赖的中间文件做登记：index 启动时塞进实现，broker 取用。
 */

type PdfOpenHandler = (filePath: string, title?: string) => Promise<void>

let openHandler: PdfOpenHandler | null = null

export function setPdfOpenHandler(handler: PdfOpenHandler): void {
  openHandler = handler
}

export async function openPdfFromPlugin(filePath: string, title?: string): Promise<void> {
  if (!openHandler) throw new Error('应用还没准备好打开文档')
  await openHandler(filePath, title)
}
