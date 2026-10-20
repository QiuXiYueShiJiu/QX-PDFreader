// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 验证 Ctrl+滚轮的「手势窗口」是否真的生效。
 *
 * 要验的核心命题：
 *   **缩放总量取决于手势总行程，而不取决于事件频率。**
 *
 * 做法：给两种极端输入，比较最终缩放值。
 *   ① 触控板式：一次手势内派发 40 个小 delta（每次 -3，总计 -120）
 *   ② 鼠标式：  一次手势内派发 1 个大 delta（-120，会被归一化成 -10）
 *
 * ①的总行程是 120，按公式应放大 (1 + 120/100) = 2.2 倍。
 * ②的总行程是 10，应放大 (1 + 10/100) = 1.1 倍。
 * 两者**不该**相等 —— 相等就说明归一化和累加都没生效。
 *
 * 更关键的一条：同样是 40 个 -3 的事件，
 *   连续快速派发（同一手势窗口内）应只放大 2.2 倍；
 *   每个之间隔 300ms（超出 150ms 窗口）则应变成 2.2^40 ≈ 天文数字（被限幅到 6）。
 * 这条能直接证明「窗口」存在。
 *
 * 用法：node tools/verify-wheel-gesture.mjs [端口]
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
  const send = (method, params) =>
    new Promise((res) => {
      const myId = ++id
      pending.set(myId, res)
      ws.send(JSON.stringify({ id: myId, method, params }))
    })
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
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

/**
 * 在页面里派发一串 Ctrl+wheel 事件。
 *
 * 注意必须**真的派发到滚动容器上**：监听是用
 * addEventListener('wheel', …, {passive:false}) 挂在 .viewer-scroll 上的。
 * 直接对 document 派发不会冒泡到它（wheel 会冒泡，但要用 bubbles:true）。
 */
const MAKE_WHEEL = (count, delta, gapMs) => `(async () => {
  const el = document.querySelector('.viewer-scroll');
  if (!el) return '找不到滚动容器';
  for (let i = 0; i < ${count}; i++) {
    el.dispatchEvent(new WheelEvent('wheel', {
      deltaY: ${delta},
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
      clientX: 800,
      clientY: 500
    }));
    ${gapMs > 0 ? `await new Promise(r => setTimeout(r, ${gapMs}));` : ''}
  }
  return window.__store.getState().zoom;
})()`

/*
 * 重置缩放并**等它真的落到版面上**。
 *
 * 踩坑记录（2026-10-18 dev 整套）：前一支 verify-toolbar-adaptive 会把视口在
 * 1440→460px 之间来回改，最后还要清掉覆盖；此时 `actualScale`（真实渲染比例）
 * 要等下一帧量完才更新，固定 sleep(900) 偶尔仍在「actualScale 还是 0 / 旧值」时开跑。
 * 而 wheel 处理器开头的 `if (!Number.isFinite(current) || current <= 0) return`
 * 会直接吞掉整串事件 → 判据 ①「得到 1」的假红（同一份代码单跑稳稳 2.2）。
 */
const reset = async (z) => {
  await evalJs(`window.__store.getState().setZoom(${z})`)
  for (let i = 0; i < 40; i++) {
    const raw = await evalJs(
      `JSON.stringify({ zoom: window.__store.getState().zoom, actualScale: window.__store.getState().actualScale })`
    )
    const st = JSON.parse(raw)
    const settled =
      Number.isFinite(st.actualScale) && st.actualScale > 0 && Math.abs(st.actualScale - z) < 0.02
    if (settled) {
      await sleep(120) /* 再让一帧布局稳定 */
      return
    }
    await sleep(200)
  }
  console.log(`   ⚠ 缩放没在 8s 内落到 ${z}（actualScale 仍未就绪），继续但结果可能不稳`)
}
const zoomNow = () => evalJs(`window.__store.getState().zoom`)

console.log('=== Ctrl+滚轮手势窗口验证 ===\n')

/* ---- ① 触控板式：40 个 -3（总行程 120，同一手势） ---- */
await reset(1)
await evalJs(MAKE_WHEEL(40, -3, 0))
await sleep(300)
let trackpad = await zoomNow()
if (trackpad === 1) {
  /* 一次都推不动 = 事件整串被吞（actualScale 还没就绪的余波），重来一次；
     真坏了这一下也救不回来，所以只是消抖，不改判据。 */
  console.log('   （首轮手势完全没推动，等 600ms 重试一次）')
  await sleep(600)
  await reset(1)
  await evalJs(MAKE_WHEEL(40, -3, 0))
  await sleep(300)
  trackpad = await zoomNow()
}
const trackpadExpect = 1 * (1 + 120 / 100)
console.log(`① 触控板式 40×(-3)，总行程 120，同一手势`)
console.log(`   得到 ${trackpad}   期望约 ${trackpadExpect.toFixed(3)}`)
const okA = Math.abs(trackpad - trackpadExpect) < 0.06

/* ---- ② 鼠标式：1 个 -120（归一化到 -10） ---- */
await reset(1)
await evalJs(MAKE_WHEEL(1, -120, 0))
await sleep(300)
const mouse = await zoomNow()
const mouseExpect = 1 * (1 + 10 / 100)
console.log(`\n② 鼠标式 1×(-120)，归一化后行程 10`)
console.log(`   得到 ${mouse}   期望约 ${mouseExpect.toFixed(3)}`)
const okB = Math.abs(mouse - mouseExpect) < 0.02

/* ---- ③ 同样 40 个 -3，但每个间隔 300ms（跨手势） ---- */
await reset(1)
await evalJs(MAKE_WHEEL(40, -3, 300))
await sleep(300)
const slow = await zoomNow()
console.log(`\n③ 40×(-3) 但间隔 300ms（每次都超出 150ms 窗口 → 40 次独立手势）`)
console.log(`   得到 ${slow}   期望被限幅到上限 6`)
const okC = slow > 2.5

const pass = okA && okB && okC
console.log('\n--- 判据 ---')
console.log(`① 手势内累加（总量只与行程有关）: ${okA ? '✓' : '✗'}`)
console.log(`② 大 delta 被归一化（鼠标一格 ≠ 满格）: ${okB ? '✓' : '✗'}`)
console.log(`③ 超出手势窗口就重新起算: ${okC ? '✓' : '✗'}`)
console.log(`\n=== 结论：${pass ? '全部通过 ✓' : '有未通过项 ✗'} ===`)

ws.close()
process.exit(pass ? 0 : 1)
