// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 用 CDP 的 Page.captureScreenshot + clip 只截「退出确认框」那一块。
 *
 * 前面把视口从 1440 一路收到 400，两个按钮的几何都正常、也都可点中，
 * 所以问题不在布局计算上 —— 只能看**真实渲染出来的像素**。
 * 用 clip 只截弹窗，避免把整屏（含用户桌面）拍进来。
 *
 * 用法：node tools/shot-exit-dialog.mjs [端口]
 */

import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PORT = process.argv[2] ?? '9228'

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!page) throw new Error('找不到页面目标')

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})

let id = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
}
const send = (method, params = {}) =>
  new Promise((res) => {
    const myId = ++id
    pending.set(myId, res)
    ws.send(JSON.stringify({ id: myId, method, params }))
  })

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  return r.result?.result?.value
}

/* 弹窗必须是打开的 */
const state = await evaluate(`(() => {
  const dlg = document.querySelector('.exit-confirm');
  if (!dlg) return 'closed';
  const box = dlg.querySelector('.exit-confirm__box').getBoundingClientRect();
  return JSON.stringify({ x: box.left, y: box.top, w: box.width, h: box.height });
})()`)
console.log('弹窗区域:', state)

if (state === 'closed') {
  console.log('弹窗未打开，先运行 diag-exit-dialog.mjs')
  ws.close()
  process.exit(1)
}

const box = JSON.parse(state)
/*
 * 四周多留 60px。留宽一点的用意：
 *   实测发现红色「退出应用」按钮明明有正确的矩形与命中结果，
 *   但在截图里完全看不见 —— 需要确认它是「没画」还是「画到了
 *   卡片外面、被裁掉」，多留的边距就是用来区分这两种情况的。
 */
const clip = {
  x: Math.max(0, box.x - 60),
  y: Math.max(0, box.y - 60),
  width: box.w + 120,
  height: box.h + 120,
  scale: 2
}

const shot = await send('Page.captureScreenshot', {
  format: 'png',
  clip,
  captureBeyondViewport: false
})

if (!shot.result?.data) {
  console.log('截图失败:', JSON.stringify(shot).slice(0, 300))
  ws.close()
  process.exit(1)
}

const out = join(root, 'test-results', 'exit-dialog-render.png')
writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
console.log('已保存:', out)
ws.close()
