// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 用 CDP 截取页面截图。
 *
 * 为什么自己写而不是复用 scripts/cdp-shot.mjs：
 *   那个脚本在整屏 PDF 上会卡住（Page.captureScreenshot 对大画布超时），
 *   这里显式指定 captureBeyondViewport: false 并加超时，
 *   只截可视区域，稳定且够用。
 *
 * 用法：node tools/shot.mjs [端口] [输出路径]
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const port = process.argv[2] ?? '9223'
const out = resolve(root, process.argv[3] ?? 'test-results/shot.png')
mkdirSync(dirname(out), { recursive: true })

const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
const page = list.find((t) => t.type === 'page')
if (!page) {
  console.error('★ 没有页面目标')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res)
  ws.addEventListener('error', () => rej(new Error('连接失败')))
})

let nextId = 0
function send(method, params = {}, timeoutMs = 20000) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} 超时`)), timeoutMs)
    const onMsg = (event) => {
      const m = JSON.parse(String(event.data))
      if (m.id !== id) return
      clearTimeout(timer)
      ws.removeEventListener('message', onMsg)
      resolve(m.result)
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

try {
  // 只截可视区域，避免整页渲染超时
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    fromSurface: true
  })

  if (!shot?.data) {
    console.error('★ 没有拿到截图数据')
    process.exit(1)
  }

  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log(`saved: ${out}`)
} catch (error) {
  console.error('截图失败:', error instanceof Error ? error.message : error)
  process.exit(1)
} finally {
  ws.close()
}
