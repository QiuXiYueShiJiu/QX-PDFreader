// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 首页缩略图渲染（资源管理器缩略图的数据源）。
 *
 * 两种使用场景：
 *   ① 正常打开 PDF 后「顺手」把首页缩略图写进缓存 → 用户在资源管理器里
 *      看到的就是自己真看过的文件，走的是快路径；
 *   ② 带 `--render-thumb` 启动（由 shell 缩略图提供器唤起）时只做这一件事，
 *      渲染完立刻退出，不建可见窗口。
 *
 * 尺寸取 512px 宽：Windows 大图标最大 256px，512 足够 200% 缩放下不糊，
 * 又不至于让缓存目录膨胀（一张约 30~80 KB）。
 */

import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const THUMB_WIDTH = 512

export async function renderThumbDataUrl(pdfPath: string, width = THUMB_WIDTH): Promise<string> {
  const task = pdfjsLib.getDocument({ url: pdfPath, verbosity: 0 })
  const doc = await task.promise
  try {
    const page = await doc.getPage(1)
    const base = page.getViewport({ scale: 1 })
    const scale = Math.max(0.05, width / base.width)
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(viewport.width))
    canvas.height = Math.max(1, Math.round(viewport.height))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('拿不到 2D 上下文')
    // 白底：PDF 本身透明，不铺白底在深色资源管理器里会糊成一团
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: ctx, viewport }).promise
    return canvas.toDataURL('image/png')
  } finally {
    await doc.destroy()
  }
}
