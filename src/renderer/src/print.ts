// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 打印页：把 PDF 画成一组 canvas，交给 BrowserWindow.webContents.print()。
 *
 * 为什么单开一个页面而不是在阅读器里直接打印：
 *   · 阅读器是应用 UI（工具条/侧栏/批注层），打印时这些都不能出现在纸上；
 *   · 打印需要「每页一张图、按纸页尺寸分页」的纯净 DOM，
 *     单独入口最直接，也不会被应用的主题/CSS 干扰；
 *   · 主进程用隐藏窗口加载它，渲染完成后调 print()，用完即销毁。
 *
 * 与主进程的约定：
 *   · 入参 query: ?pdf=<pdf-file:/// 编码后的地址>
 *   · 渲染完成：window.__printInfo = { pages, widthPt, heightPt } 且 window.__printReady = true
 *   · 失败：window.__printError = '原因'
 */

import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

declare global {
  interface Window {
    __printReady?: boolean
    __printInfo?: { pages: number; widthPt: number; heightPt: number }
    __printError?: string
  }
}

/** 1 PDF 点 = 25.4/72 毫米 */
const PT_TO_MM = 25.4 / 72

function fail(message: string): void {
  window.__printError = message
  const status = document.getElementById('status')
  if (status) status.textContent = `打印预览失败：${message}`
}

async function renderAll(): Promise<void> {
  const params = new URLSearchParams(window.location.search)
  const pdfUrl = params.get('pdf') ?? ''
  if (!pdfUrl) {
    fail('缺少 pdf 参数')
    return
  }

  const doc: PDFDocumentProxy = await pdfjsLib.getDocument({ url: pdfUrl, verbosity: 0 }).promise
  const container = document.getElementById('pages')
  if (!container) {
    fail('页面容器缺失')
    return
  }

  /*
   * 页码筛选：主进程把 "1-3,5" 解析成逗号列表传进来；
   * 这里是最终防线 —— 越界/重复的页码丢掉，空列表则打印全部。
   */
  const pageParam = params.get('pages') ?? ''
  const wanted = pageParam
    .split(',')
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value) && value >= 1 && value <= doc.numPages)
  const selected = wanted.length > 0
    ? Array.from(new Set(wanted)).sort((a, b) => a - b)
    : Array.from({ length: doc.numPages }, (_, index) => index + 1)

  const first = await doc.getPage(selected[0])
  const firstView = first.getViewport({ scale: 1 })

  /* 先把第一页尺寸写进 @page：纸张大小与页面一致，打印不缩放 */
  const style = document.createElement('style')
  style.textContent = `@page { size: ${firstView.width * PT_TO_MM}mm ${firstView.height * PT_TO_MM}mm; margin: 0; }`
  document.head.appendChild(style)

  for (const pageNumber of selected) {
    const page = await doc.getPage(pageNumber)
    const base = page.getViewport({ scale: 1 })

    /*
     * 2 倍像素渲染：150% 缩放的屏幕上打印出来也足够清晰，
     * 同时不至于让几十页的文档把内存撑爆。
     */
    const viewport = page.getViewport({ scale: 2 })

    const wrapper = document.createElement('div')
    wrapper.className = 'print-page'
    wrapper.style.width = `${base.width * PT_TO_MM}mm`
    wrapper.style.height = `${base.height * PT_TO_MM}mm`

    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(viewport.width))
    canvas.height = Math.max(1, Math.round(viewport.height))

    const ctx = canvas.getContext('2d')
    if (!ctx) {
      fail('无法创建打印画布')
      return
    }
    /* 纸张是白的：先铺白底，避免透明区域打印成黑色 */
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    const task = page.render({ canvasContext: ctx, viewport })
    await (task as unknown as { promise: Promise<void> }).promise

    wrapper.appendChild(canvas)
    container.appendChild(wrapper)
    page.cleanup()
  }

  window.__printInfo = {
    pages: selected.length,
    widthPt: firstView.width,
    heightPt: firstView.height
  }
  window.__printReady = true
  const status = document.getElementById('status')
  if (status) status.textContent = ''
}

renderAll().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error))
})
