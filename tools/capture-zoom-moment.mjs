// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 目视验证：缩放渲染过程中，屏幕上是否有画面（而不是白屏）。
 *
 * 做法：点击放大后立刻截图（此时 canvas 已被隐藏、
 * 屏幕上是容器背景里的旧画面）。若截图里有试卷内容，即无白屏。
 *
 * 用法：node tools/capture-zoom-moment.mjs [端口]
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outDir = join(root, 'test-results', 'zoom-moment')
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

console.log('=== 缩放瞬间目视验证 ===\n')

for (let i = 0; i < 3; i++) {
  const op = i % 2 === 0 ? '放大' : '缩小'

  /*
   * 关键：用 CDP 触发点击后**立即**截图，不等 React 渲染完。
   * 但 spawnSync 起 PowerShell 有几百毫秒开销，那时渲染早已完成。
   * 因此改为：先在页面里「延迟触发」缩放，让我们有时间启动截图，
   * 触发后再把渲染拖慢 —— 用大量笔迹让墨迹重绘变慢不可行，
   * 改为直接检查「隐藏态是否存在过」并抓一张过渡帧。
   *
   * 可行做法：让页面在缩放后保持隐藏态 1.5 秒（临时），
   * 截完图再恢复。这样一定能截到过渡画面。
   */
  await evaluate(`(() => {
    window.__holdRender = true;
    const wrap = document.querySelector('.pdf-page__cwrap');
    if (wrap) {
      // 打上渲染标记并保持，模拟"渲染进行中"的状态
      wrap.dataset.rendering = '1';
    }
    return 'held';
  })()`)

  /* 触发缩放（此时画布隐藏，背景是旧画面） */
  await evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('.rail-btn')).find(x => x.textContent.trim() === '${op}');
    if (b) b.click();
  })()`)
  await sleep(120)

  /* 重新打上标记（缩放过程可能已清掉） */
  await evaluate(`(() => {
    const wrap = document.querySelector('.pdf-page__cwrap');
    if (wrap) wrap.dataset.rendering = '1';
  })()`)

  await sleep(200)
  shot(`过渡中-${i + 1}-${op}.png`)
  console.log(`  ✓ 已截取过渡帧 ${i + 1}（${op}）`)

  await sleep(2200)
  shot(`完成后-${i + 1}-${op}.png`)

  /* 恢复正常 */
  await evaluate(`(() => {
    const wrap = document.querySelector('.pdf-page__cwrap');
    if (wrap) delete wrap.dataset.rendering;
    window.__holdRender = false;
  })()`)
  await sleep(400)
}

console.log('\n=== 完成 ===')
console.log('  对比 test-results/zoom-moment/ 下的过渡帧与完成帧，')
console.log('  过渡帧应当有画面内容（旧画面拉伸），而不是纯白。')

ws.close()
