// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 目视验证：绘制中 vs 绘制后，笔迹位置是否一致。
 *
 * 分两张截图：
 *   A. 按住不放时（预览层在渲染）
 *   B. 松手之后（成品墨迹层在渲染）
 * 对比两者的笔迹位置 —— 如果一致，说明「画完跳走」已修复。
 *
 * 用法：node tools/capture-draw-phases.mjs [端口]
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outDir = join(root, 'test-results', 'draw-phases')
mkdirSync(outDir, { recursive: true })

const port = process.argv[2] ?? '9223'

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
function send(method, params = {}, timeoutMs = 15000) {
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

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r?.exceptionDetails) return `★异常 ${r.exceptionDetails.exception?.description?.slice(0, 200)}`
  const v = r.result?.value
  return typeof v === 'string' ? v : JSON.stringify(v)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = (name) =>
  spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', join(root, 'tools', 'crop-shot.ps1'), '-Out', join(outDir, name)],
    { windowsHide: true, encoding: 'utf8' }
  )

console.log('=== 绘制中 / 绘制后 对比 ===\n')

/* 进入绘画模式 */
await evaluate(`(() => {
  const b = Array.from(document.querySelectorAll('.rail-btn')).find(x => x.textContent.includes('批注'));
  if (b && !b.classList.contains('is-active')) b.click();
})()`)
await sleep(900)

const box = JSON.parse(
  await evaluate(`(() => {
    const c = document.querySelector('.pdf-page__canvas');
    const r = c.getBoundingClientRect();
    return JSON.stringify({ left: r.left, top: r.top, width: r.width, height: r.height });
  })()`)
)

/* 在页面偏上位置画一条明显的红线 */
const y = Math.round(box.top + box.height * 0.28)
const x0 = Math.round(box.left + box.width * 0.25)
const x1 = Math.round(box.left + box.width * 0.7)

console.log(`  线: y=${y}, x ${x0} → ${x1}`)

await send('Input.dispatchMouseEvent', {
  type: 'mousePressed', x: x0, y, button: 'left', clickCount: 1, pointerType: 'mouse'
})
for (let i = 1; i <= 30; i++) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(x0 + ((x1 - x0) * i) / 30),
    y: y + Math.round(Math.sin(i / 4) * 10),
    button: 'left',
    buttons: 1,
    pointerType: 'mouse'
  })
}

/* A. 按住不放 —— 截图（此时是预览层在画） */
console.log('\n  [A] 按住不放，截图…')
console.log('     预览画布存在:', await evaluate(`!!document.querySelector('.ink-preview')`))
shot('A-绘制中.png')

/* 松手 */
await send('Input.dispatchMouseEvent', {
  type: 'mouseReleased', x: x1, y, button: 'left', clickCount: 1, pointerType: 'mouse'
})
await sleep(1500)

/* B. 松手之后 —— 截图（此时是成品墨迹层在画） */
console.log('  [B] 松手之后，截图…')
console.log('     成品墨迹层存在:', await evaluate(`!!document.querySelector('.ink-canvas')`))
shot('B-绘制后.png')

console.log('\n=== 完成 ===')
console.log('  对比 test-results/draw-phases/ 下两张图，笔迹应落在同一位置。')

ws.close()
