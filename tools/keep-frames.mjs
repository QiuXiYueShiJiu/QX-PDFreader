// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 让**隐藏窗口**里的帧跑起来（给验证套件当背景进程用）。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────
 *   用户的硬约束是「全程不能更改前台」，所以验证只能在 `--hidden` 实例上跑。
 *   但从未 show() 过的窗口，Chromium 的合成器几乎不产帧：
 *   实测隐藏实例里 **600ms 只跑到 1 帧 rAF**（开了 screencast 是 38 帧）。
 *   而 pdf.js 的渲染任务（InternalRenderTask）是**靠 rAF 排帧**的，
 *   于是缩放停手后的位图重渲染会被拖到 1 秒开外 ——
 *   `verify-zoom-debounce.mjs` 因此时通时不通（等 1.5s 撞上运气）。
 *   这是测量环境的失真，不是用户会遇到的 bug：用户的窗口是可见的，
 *   帧率正常，实测同一条链路 0.6s 就落定。
 *
 *   修法不是「把等待时间调大」，而是**让隐藏实例也像可见窗口一样有帧**：
 *   CDP 的 Page.startScreencast 会强制合成器持续产帧。
 *   本进程就干这一件事，挂在套件旁边当背景进程，套件结束时被杀掉。
 *
 * 用法：node tools/keep-frames.mjs <端口>
 *       （一直跑到被杀；stdout 打点节流信息，便于确认真的在产帧）
 */

const PORT = Number(process.argv[2] ?? 9290)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function target() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  return list.find((t) => t.type === 'page' && t.url.includes('index.html')) ?? null
}

let t = null
for (let i = 0; i < 40 && !t; i++) {
  try {
    t = await target()
  } catch {
    /* 还没起来，接着等 */
  }
  if (!t) await sleep(500)
}
if (!t) {
  console.error(`✗ 端口 ${PORT} 上没有页面目标`)
  process.exit(2)
}

const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})

let id = 0
let frames = 0
let lastReport = Date.now()

ws.onmessage = (ev) => {
  try {
    const msg = JSON.parse(ev.data)
    if (msg.method === 'Page.screencastFrame') {
      frames++
      // 必须回 ack，否则 Chromium 发够一定数量就停
      ws.send(JSON.stringify({ id: ++id, method: 'Page.screencastFrameAck', params: { sessionId: msg.params.sessionId } }))
    }
  } catch {
    /* 忽略非 JSON */
  }
}

const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const myId = ++id
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id !== myId) return
      ws.removeEventListener('message', onMsg)
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id: myId, method, params }))
    setTimeout(() => rej(new Error(method + ' 超时')), 15000)
  })

await send('Page.enable')
/*
 * 帧尺寸压到 160x160 / jpeg q20：
 * 我们只要「合成器在产帧」这件事，不需要看得清的图，
 * 越小越不干扰被测应用的性能表现。
 */
await send('Page.startScreencast', { format: 'jpeg', quality: 20, maxWidth: 160, maxHeight: 160, everyNthFrame: 1 })

console.log(`✓ 已开启持续产帧（端口 ${PORT}）`)

/* 心跳：每 10 秒报一次产帧速率，顺带证明进程还活着 */
for (;;) {
  await sleep(10000)
  const dt = (Date.now() - lastReport) / 1000
  console.log(`  产帧 ${(frames / dt).toFixed(1)} fps`)
  frames = 0
  lastReport = Date.now()
}
