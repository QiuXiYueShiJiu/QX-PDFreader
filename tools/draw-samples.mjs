// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 画几条不同颜色/粗细的笔迹，用于目视检查渲染效果。
 *
 * 与 verify-drawbar.mjs 的分工：
 *   那个脚本验证「逻辑是否正确」（计数、状态、命中），
 *   这个脚本只负责「画得对不对」，产出可以直接看的画面。
 *
 * 用法：node tools/draw-samples.mjs [端口]
 */

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
function send(method, params = {}) {
  const id = ++nextId
  return new Promise((resolve) => {
    const onMsg = (event) => {
      const m = JSON.parse(String(event.data))
      if (m.id !== id) return
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

/* 开启手绘 */
await evaluate(`(() => {
  const btns = Array.from(document.querySelectorAll('.rail-btn'));
  const pen = btns.find(b => b.textContent.includes('批注'));
  if (pen && !pen.classList.contains('is-active')) pen.click();
})()`)
await sleep(600)

const box = JSON.parse(
  await evaluate(`(() => {
    const p = document.querySelector('.pdf-page');
    const r = p.getBoundingClientRect();
    return JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) });
  })()`)
)

/** 选颜色（0-5）与粗细（0-3） */
async function pick(colorIdx, widthIdx) {
  await evaluate(`(() => {
    const c = document.querySelectorAll('.drawbar__color')[${colorIdx}];
    const w = document.querySelectorAll('.drawbar__width')[${widthIdx}];
    if (c) c.click();
    if (w) w.click();
  })()`)
  await sleep(250)
}

/** 画一条横向波浪线 */
async function stroke(yRatio, lengthRatio, waveAmp) {
  const sx = box.left + Math.round(box.width * 0.12)
  const sy = box.top + Math.round(box.height * yRatio)
  const len = Math.round(box.width * lengthRatio)

  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: sx, y: sy, button: 'left', clickCount: 1, pointerType: 'mouse'
  })
  const steps = 60
  for (let i = 1; i <= steps; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: sx + Math.round((len * i) / steps),
      y: sy + Math.round(Math.sin((i / steps) * Math.PI * 2.5) * waveAmp),
      button: 'left',
      buttons: 1,
      pointerType: 'mouse'
    })
  }
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: sx + len, y: sy, button: 'left', clickCount: 1, pointerType: 'mouse'
  })
  await sleep(400)
}

/* 红细 · 蓝中 · 绿粗 · 橙特粗，四条线直观对比 */
await pick(0, 0)
await stroke(0.16, 0.7, 10)

await pick(1, 1)
await stroke(0.26, 0.7, 14)

await pick(2, 2)
await stroke(0.36, 0.7, 18)

await pick(3, 3)
await stroke(0.46, 0.7, 22)

/* 画一个红色圈选（教学最常用的动作） */
await pick(0, 2)
{
  const cx = box.left + box.width * 0.5
  const cy = box.top + box.height * 0.62
  const rx = box.width * 0.24
  const ry = box.height * 0.045

  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: Math.round(cx + rx), y: Math.round(cy), button: 'left', clickCount: 1, pointerType: 'mouse'
  })
  for (let i = 1; i <= 70; i++) {
    const a = (i / 70) * Math.PI * 2
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(cx + Math.cos(a) * rx),
      y: Math.round(cy + Math.sin(a) * ry),
      button: 'left',
      buttons: 1,
      pointerType: 'mouse'
    })
  }
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: Math.round(cx + rx), y: Math.round(cy), button: 'left', clickCount: 1, pointerType: 'mouse'
  })
  await sleep(600)
}

const result = await evaluate(`JSON.stringify({
  笔迹折线数: document.querySelectorAll('.stroke-layer polyline').length,
  批注卡片数: document.querySelectorAll('.annotations-card').length
})`)
console.log('绘制完成:', result)

/* 退出橡皮，保留手绘，方便截图时工具条可见 */
ws.close()
