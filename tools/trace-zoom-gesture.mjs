// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 逐帧追踪一次缩放防抖手势，看位图到底在第几步被重画。
 *
 * 为什么要逐步看：`verify-zoom-debounce.mjs` 只比较首尾，
 * 一旦中途发生了一次意外重画，首尾看不出来是「哪一步触发的」。
 * 这里在两次 setZoom 之间插一次高频采样，把 (zoom, 版面宽, 位图宽)
 * 三元组的变化点抓出来。
 *
 * 用法：node tools/trace-zoom-gesture.mjs [端口]
 */

const port = Number(process.argv[2] ?? 9280)

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'))
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
    const p = pending.get(msg.id)
    if (p) {
      pending.delete(msg.id)
      p(msg.result)
    }
  }
  const evalJs = async (expression) => {
    const r = await new Promise((res) => {
      const myId = ++id
      pending.set(myId, res)
      ws.send(
        JSON.stringify({
          id: myId,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true }
        })
      )
    })
    if (r.exceptionDetails) {
      throw new Error('表达式异常: ' + JSON.stringify(r.exceptionDetails.exception?.description))
    }
    return r.result.value
  }
  return { ws, evalJs }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const { ws, evalJs } = await connect()

/*
 * 在页面里装一个高频采样器，直接在渲染层记录。
 * 从 Node 侧轮询太慢（一次往返几毫秒），抓不到 400ms 内的变化。
 */
await evalJs(`
  window.__trace = [];
  window.__traceStop = false;
  (function loop() {
    if (window.__traceStop) return;
    var el = document.querySelector('.pdf-page');
    if (el) {
      var cv = el.querySelector('canvas.pdf-page__canvas');
      var wrap = el.querySelector('.pdf-page__cwrap');
      window.__trace.push({
        t: Math.round(performance.now()),
        z: String(window.__store.getState().zoom),
        layout: wrap ? Math.round(wrap.getBoundingClientRect().width) : -1,
        bmp: cv ? cv.width : -1
      });
    }
    requestAnimationFrame(loop);
  })();
  'installed'
`)

console.log('=== 逐帧追踪缩放手势 ===\n')

await evalJs(`window.__store.getState().setZoom(1)`)
await sleep(1500)
await evalJs(`window.__trace = []`)

for (const z of [1.1, 1.2, 1.35, 1.5, 1.65, 1.8]) {
  await evalJs(`window.__store.getState().setZoom(${z})`)
  await sleep(60)
}
await sleep(2000)

const trace = await evalJs(`JSON.stringify(window.__trace)`)
await evalJs(`window.__traceStop = true`)

const rows = JSON.parse(trace)
const t0 = rows[0]?.t ?? 0

/* 只打印发生变化的帧，避免几百行噪声 */
let lastBmp = -1
let lastLayout = -1
let lastZ = ''
console.log('时间(ms)  缩放   版面宽  位图宽   说明')
for (const r of rows) {
  const changed = r.bmp !== lastBmp || r.layout !== lastLayout || r.z !== lastZ
  if (!changed) continue
  const notes = []
  if (r.bmp !== lastBmp && lastBmp !== -1) notes.push('◀ 位图重画')
  if (r.z !== lastZ && lastZ !== '') notes.push('缩放变更')
  console.log(
    `${String(r.t - t0).padStart(7)}  ${r.z.padEnd(6)} ${String(r.layout).padStart(5)}  ${String(r.bmp).padStart(6)}   ${notes.join(' ')}`
  )
  lastBmp = r.bmp
  lastLayout = r.layout
  lastZ = r.z
}

const final = rows[rows.length - 1]
console.log(`\n终点: 缩放=${final.z} 版面宽=${final.layout} 位图宽=${final.bmp}`)

ws.close()
