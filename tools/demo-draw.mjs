// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 演示绘制：画出一组能体现功能特点的批注。
 *
 * 为什么不用 ui = 点按钮的方式：
 *   DrawToolbar 的按钮点击依赖 React 事件与 CSS 过渡，
 *   在自动化里容易因时序问题漏点。这里直接改 store 状态
 *   （颜色 / 粗细），再用 CDP 派发真实指针事件绘制 ——
 *   绘制链路仍然走完整的生产代码，只是省掉了点按钮那一步。
 *
 * 用法：node tools/demo-draw.mjs [端口]
 */

const port = process.argv[2] ?? '9224'

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
function send(method, params = {}, timeoutMs = 8000) {
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
  if (r?.exceptionDetails) {
    console.error('★ 异常:', r.exceptionDetails.exception?.description?.slice(0, 200))
  }
  const v = r.result?.value
  return typeof v === 'string' ? v : JSON.stringify(v)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------- ① 开启手绘模式 ---------- */
await evaluate(`(() => {
  const btns = Array.from(document.querySelectorAll('.rail-btn'));
  const pen = btns.find(b => b.textContent.includes('批注'));
  if (pen && !pen.classList.contains('is-active')) pen.click();
})()`)
await sleep(800)

/* ---------- ② 取页面矩形 ---------- */
const box = JSON.parse(
  await evaluate(`(() => {
    const p = document.querySelector('.pdf-page');
    const r = p.getBoundingClientRect();
    return JSON.stringify({ left: r.left, top: r.top, width: r.width, height: r.height });
  })()`)
)

const sx = (r) => box.left + box.width * r
const sy = (r) => box.top + box.height * r

/** 鼠标路径绘制（真实指针事件，走完整生产链路） */
async function stroke(path, steps = 36) {
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: Math.round(path[0].x),
    y: Math.round(path[0].y),
    button: 'left',
    clickCount: 1,
    pointerType: 'mouse'
  })

  // 在相邻控制点之间插值，模拟连续笔迹
  for (let seg = 0; seg < path.length - 1; seg++) {
    const a = path[seg]
    const b = path[seg + 1]
    for (let i = 1; i <= steps; i++) {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(a.x + ((b.x - a.x) * i) / steps),
        y: Math.round(a.y + ((b.y - a.y) * i) / steps),
        button: 'left',
        buttons: 1,
        pointerType: 'mouse'
      })
    }
  }

  const last = path[path.length - 1]
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: Math.round(last.x),
    y: Math.round(last.y),
    button: 'left',
    clickCount: 1,
    pointerType: 'mouse'
  })
  await sleep(350)
}

/** 画椭圆圈（教学最常用的动作） */
async function circle(cx, cy, rx, ry, steps = 52) {
  const pts = []
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2
    pts.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry })
  }
  await stroke(pts, 1)
}

/**
 * 设置画笔。
 *
 * 直接改 React 内部状态不方便，这里点对应的色块与档位 ——
 * 它们的点击是标准按钮，比拖滑块可靠得多。
 */
async function setPen(colorIdx, widthIdx) {
  await evaluate(`(() => {
    const c = document.querySelectorAll('.drawbar__color')[${colorIdx}];
    const w = document.querySelectorAll('.drawbar__width')[${widthIdx}];
    if (c) c.click();
    if (w) w.click();
  })()`)
  await sleep(300)
}

/* ---------- ③ 画四组示例 ---------- */
console.log('绘制中…')

// ① 红色粗圈：圈住一段文字（最典型的教学标注）
await setPen(0, 2)
await circle(sx(0.34), sy(0.22), box.width * 0.26, box.height * 0.032)

// ② 蓝色波浪下划线：划重点
await setPen(1, 1)
await stroke(
  [
    { x: sx(0.12), y: sy(0.4) },
    { x: sx(0.46), y: sy(0.405) },
    { x: sx(0.8), y: sy(0.4) }
  ].map((p, i) => ({ x: p.x, y: p.y + (i % 2 === 0 ? 0 : 5) }))
)

// ③ 绿色勾：表示正确
await setPen(2, 2)
await stroke([
  { x: sx(0.13), y: sy(0.62) },
  { x: sx(0.17), y: sy(0.66) },
  { x: sx(0.24), y: sy(0.56) }
])

// ④ 橙色箭头：指向重点
await setPen(3, 1)
await stroke([
  { x: sx(0.62), y: sy(0.72) },
  { x: sx(0.78), y: sy(0.72) }
])

/* ---------- ④ 出结果 ---------- */
const result = await evaluate(`JSON.stringify({
  笔迹折线数: document.querySelectorAll('.stroke-layer polyline').length,
  批注卡片数: document.querySelectorAll('.annotations-card').length,
  工具条可见: !!document.querySelector('.drawbar')
})`)
console.log('绘制完成:', result)

ws.close()
