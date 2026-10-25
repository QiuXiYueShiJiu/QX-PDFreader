// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 探针：**隐藏窗口**里到底跑不跑帧（rAF）、不跑帧时缩放后的位图还能不能追上。
 *
 * ── 为什么要写它 ─────────────────────────────────────────────
 *   verify-zoom-debounce.mjs 在隐藏实例上时通时不通：
 *   同一条链路，上一轮 `位图是否追上版面: 是 ✓`，这一轮变成
 *   `否 ✗（位图 892，应为约 1608）`。代码在两轮之间没动过。
 *
 *   用户硬约束是「全程不能更改前台」，所以验证只能用 --hidden 跑；
 *   如果隐藏窗口里 Chromium 不给 rAF，那么 pdf.js 的渲染任务
 *   （InternalRenderTask 用 rAF 排帧）就永远排不上，
 *   位图自然停在旧尺寸 —— 这属于**测量环境的失真**，
 *   不是用户会遇到的 bug（用户窗口是可见的）。
 *
 *   本探针把这件事一次问清楚，并试出「怎么在隐藏窗口里把帧推动起来」
 *   （CDP 的 Page.startScreencast 是常用手段：它让合成器持续产帧）。
 *
 * 用法：node tools/probe-hidden-frames.mjs [端口]
 */

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PORT = Number(process.argv[2] ?? 9299)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function target() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  return list.find((t) => t.type === 'page' && t.url.includes('index.html')) ?? null
}

/** 开一个长连接，既能 evaluate 也能发任意 CDP 命令 */
async function connect() {
  const t = await target()
  if (!t) throw new Error('找不到页面目标')
  const ws = new WebSocket(t.webSocketDebuggerUrl)
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
    new Promise((res, rej) => {
      const myId = ++id
      pending.set(myId, (msg) => (msg.error ? rej(new Error(method + ': ' + JSON.stringify(msg.error))) : res(msg.result)))
      ws.send(JSON.stringify({ id: myId, method, params }))
      setTimeout(() => {
        if (pending.has(myId)) {
          pending.delete(myId)
          rej(new Error(method + ' 超时'))
        }
      }, 15000)
    })
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('表达式异常: ' + r.exceptionDetails.exception?.description)
    return r.result.value
  }
  return { ws, send, evaluate }
}

const PROBE = `JSON.stringify((() => {
  const el = document.querySelector('.pdf-page[data-page="1"]');
  const cv = el && el.querySelector('canvas.pdf-page__canvas');
  const wrap = el && el.querySelector('.pdf-page__cwrap');
  return {
    版面宽: wrap ? Math.round(wrap.getBoundingClientRect().width) : -1,
    位图宽: cv ? cv.width : -1
  };
})())`

if (!(await target())) {
  console.error(`✗ 端口 ${PORT} 上没有页面目标，先用 run-verify-suite 起一个隐藏实例`)
  process.exit(2)
}

const { send, evaluate } = await connect()

console.log('=== 隐藏窗口的帧与缩放落定探针 ===\n')

/* ---------- ① 页面可见性 ---------- */
console.log('① 可见性')
console.log(
  '   ' +
    (await evaluate(
      `JSON.stringify({ visibilityState: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus(), innerWidth, innerHeight })`
    ))
)

/* ---------- ② rAF 到底跑不跑 ---------- */
console.log('\n② rAF（600ms 内数帧）')
const rafProbe = await evaluate(`
  new Promise((res) => {
    let frames = 0;
    const t0 = performance.now();
    const tick = () => { frames++; if (performance.now() - t0 < 600) requestAnimationFrame(tick); else res(JSON.stringify({ frames, ms: Math.round(performance.now() - t0) })); };
    requestAnimationFrame(tick);
    setTimeout(() => res(JSON.stringify({ frames, ms: Math.round(performance.now() - t0), 说明: '超时兜底' })), 900);
  })
`)
console.log('   ' + rafProbe)

/* ---------- ③ 不开 screencast 时，缩放后位图追不追 ---------- */
async function catchUp(label, seconds) {
  console.log(`\n③ ${label}`)
  await evaluate(`window.__store.getState().setZoom(1)`)
  await sleep(1500)
  console.log('   起点 ' + (await evaluate(PROBE)))
  await evaluate(`window.__store.getState().setZoom(1.8)`)
  const t0 = Date.now()
  let last = null
  const seen = []
  while ((Date.now() - t0) / 1000 < seconds) {
    await sleep(250)
    const s = JSON.parse(await evaluate(PROBE))
    seen.push(`${((Date.now() - t0) / 1000).toFixed(1)}s 版面${s.版面宽} 位图${s.位图宽}`)
    last = s
  }
  console.log('   ' + seen.join('\n   '))
  const want = Math.floor(last.版面宽 * 1.5)
  console.log(`   → 位图 ${last.位图宽}，应为约 ${want}　${Math.abs(last.位图宽 - want) <= 2 ? '追上 ✓' : '没追上 ✗'}`)
  return Math.abs(last.位图宽 - want) <= 2
}

const plain = await catchUp('不开 screencast，直接缩放', 3)

/* ---------- ④ 开 screencast 后重试 ---------- */
console.log('\n④ 开 Page.startScreencast（强制合成器产帧）')
await send('Page.enable')
await send('Page.startScreencast', { format: 'jpeg', quality: 20, maxWidth: 200, maxHeight: 200, everyNthFrame: 1 })

const afterScreencast = await catchUp('开着 screencast，再缩放一次', 3)

/* ---------- ⑤ 再验一次 rAF ---------- */
console.log('\n⑤ screencast 期间的 rAF（600ms 内数帧）')
console.log(
  '   ' +
    (await evaluate(`
  new Promise((res) => {
    let frames = 0;
    const t0 = performance.now();
    const tick = () => { frames++; if (performance.now() - t0 < 600) requestAnimationFrame(tick); else res(JSON.stringify({ frames, ms: Math.round(performance.now() - t0) })); };
    requestAnimationFrame(tick);
    setTimeout(() => res(JSON.stringify({ frames, ms: Math.round(performance.now() - t0), 说明: '超时兜底' })), 900);
  })
`))
)

try {
  await send('Page.stopScreencast')
} catch {
  /* 已经停了就算了 */
}

console.log(
  `\n=== 结论 ===\n  隐藏窗口不开 screencast：${plain ? '能追上' : '追不上'}\n  隐藏窗口开 screencast：${afterScreencast ? '能追上' : '追不上'}`
)
process.exit(0)
