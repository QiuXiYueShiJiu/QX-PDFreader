// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 通过 CDP 截取页面画面并输出渲染层状态。
 *
 * 为什么用 CDP 截图而不是系统截屏：
 *   系统截屏受窗口层级、最小化、遮挡影响，验证「页面本身渲染成什么样」时
 *   CDP 的 Page.captureScreenshot 最直接、最可靠。
 *   需要验证「窗口是否真的显示在屏幕上」时再用系统截屏。
 *
 * 用法：node scripts/cdp-shot.mjs <端口> <输出png> [面板URL关键字]
 */

import { writeFileSync } from 'node:fs'

const [port = '9223', outPath = 'test-results/cdp-shot.png', filter = ''] = process.argv.slice(2)

const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
const pages = list.filter((t) => t.type === 'page')
const target = filter ? pages.find((t) => decodeURIComponent(t.url).includes(filter)) : pages[0]

if (!target) {
  console.error('未找到页面目标。现有：')
  for (const p of pages) console.error('  ' + decodeURIComponent(p.url))
  process.exit(1)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res)
  ws.addEventListener('error', () => rej(new Error('CDP 连接失败')))
})

let nextId = 0
/** 发一条 CDP 命令并等结果 */
function send(method, params = {}) {
  const id = ++nextId
  return new Promise((resolve) => {
    const onMsg = (event) => {
      const msg = JSON.parse(String(event.data))
      if (msg.id !== id) return
      ws.removeEventListener('message', onMsg)
      resolve(msg.result)
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

// 采集渲染层状态
const state = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    url: location.href,
    hasApi: typeof window.pdfApp,
    rootChildren: document.getElementById('root')?.children.length ?? -1,
    theme: document.documentElement.dataset.theme,
    title: document.querySelector('.titlebar__subtitle')?.textContent ?? null,
    pages: document.querySelectorAll('.pdf-page').length,
    canvas: document.querySelectorAll('.pdf-page__canvas').length,
    size: innerWidth + 'x' + innerHeight
  })`,
  returnByValue: true
})

console.log('页面状态:')
console.log('  ' + (state?.result?.value ?? JSON.stringify(state)))

// 截图
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })

if (!shot?.data) {
  console.error('截图失败:', JSON.stringify(shot))
  process.exit(1)
}

const buf = Buffer.from(shot.data, 'base64')
writeFileSync(outPath, buf)
console.log(`截图已保存: ${outPath} (${Math.round(buf.length / 1024)} KB)`)

ws.close()
