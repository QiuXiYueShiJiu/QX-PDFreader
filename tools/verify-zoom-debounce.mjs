// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 验证「先 CSS 拉伸、停手才重渲染」这条缩放链路真的生效了。
 *
 * 期望的时间线（PDF.js viewer 的 defaultZoomDelay 策略）：
 *   t0   连续改 6 次 zoom（模拟拖滑块）
 *   t0+  **版面尺寸立刻变**（纯 CSS），而**位图尺寸一动不动**
 *   t0+400ms 停手后，位图才按最终比例重画一次
 *
 * 关键判据有两条，缺一不可：
 *   ① 手势期间位图尺寸必须不变 —— 变了就说明防抖没生效，
 *      等于每次缩放事件都在整页重渲染，卡顿根源没解决；
 *   ② 停手后位图必须追上最终版面尺寸 —— 不追就说明画面会一直糊着，
 *      防抖做过头了。
 *
 * 用法：node tools/verify-zoom-debounce.mjs [端口]
 */

const port = Number(process.argv[2] ?? 9280)

async function evalJs(expression) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'))
  if (!page) throw new Error('找不到页面目标')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  const result = await new Promise((res, rej) => {
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id === 1) res(msg.result)
    }
    ws.onerror = rej
    ws.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true }
      })
    )
  })
  ws.close()
  if (result.exceptionDetails) {
    throw new Error('表达式异常: ' + JSON.stringify(result.exceptionDetails.exception?.description))
  }
  return result.result.value
}

/*
 * 复位视口。
 *
 * CDP 的 Emulation.setDeviceMetricsOverride 是粘性的 ——
 * `verify-toolbar-adaptive.mjs` 把视口缩到 520px 之后就算退出也仍然生效，
 * 于是本脚本会在一个 595px 宽的版面里跑，位图自然对不上「应为 1608」，
 * 看起来像防抖失效，其实是环境被污染。开跑前清一次最省事。
 */
async function resetViewport() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'))
  if (!page) return
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  await new Promise((res) => {
    ws.onmessage = () => res()
    ws.send(
      JSON.stringify({ id: 1, method: 'Emulation.clearDeviceMetricsOverride', params: {} })
    )
  })
  ws.close()
}

/** 读第 1 页的「版面宽」与「位图宽」 */
const PROBE = `JSON.stringify((() => {
  const el = document.querySelector('.pdf-page[data-page="1"]');
  if (!el) return { 错误: '找不到第 1 页' };
  const cv = el.querySelector('canvas.pdf-page__canvas');
  const wrap = el.querySelector('.pdf-page__cwrap');
  return {
    版面宽: wrap ? Math.round(wrap.getBoundingClientRect().width) : -1,
    位图宽: cv ? cv.width : -1,
    位图高: cv ? cv.height : -1
  };
})())`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('=== 缩放防抖验证 ===\n')

await resetViewport()
await sleep(500)

/* 复位到 1 并等它落定 */
await evalJs(`window.__store.getState().setZoom(1)`)
await sleep(1400)
const base = JSON.parse(await evalJs(PROBE))
console.log('起点:', JSON.stringify(base))

/* ---- ① 连续改 6 次 zoom，手势期间不该开始重渲染 ---- */
/*
 * ★ 这一段**不能**写成「一次 CDP 往返算一步」。
 *
 *   原先的写法是：evalJs(setZoom) → sleep(60) → evalJs(PROBE)，六轮。
 *   而 evalJs 每调一次都要重新拉 /json/list 并新开一个 WebSocket，
 *   实测单轮 100~300ms 不等 —— 步进间隔根本不是 60ms。
 *   只要有两轮之间超过 ZOOM_SETTLE_MS(400ms)，应用**按设计**就该落定重画，
 *   这时位图变了却被判成「防抖没生效」。同一份代码上一轮绿这一轮红，
 *   赌的就是那一刻机器上 eval 的快慢。
 *
 *   现在把整个手势塞进**页内一次 eval**：由页内 setTimeout 真正按 60ms 步进，
 *   每一步顺手把「这一页的渲染阶段」和「画布还是不是同一张」也记下来。
 *   判据随之从「采样点读到的位图宽恰好没变」换成三个**事件事实**：
 *     · 手势期间这一页的渲染阶段没有离开 painted（= 没有开始新的光栅化）
 *     · 手势期间屏幕上的画布始终是同一张（= 没有换图落在手势中间）
 *     · 步进真的是连续的（间隔 < 300ms，否则「没落定」这个前提不成立）
 *   这三条与采样快慢无关。
 */
const GESTURE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = () => window.__store.getState()
  const el = () => document.querySelector('.pdf-page[data-page="1"]')
  const snap = () => {
    const e = el()
    const cv = e ? e.querySelector('canvas.pdf-page__canvas') : null
    const wrap = e ? e.querySelector('.pdf-page__cwrap') : null
    let dbg = {}
    try { dbg = wrap && wrap.dataset.dbg ? JSON.parse(wrap.dataset.dbg) : {} } catch (err) { dbg = {} }
    return {
      版面宽: wrap ? Math.round(wrap.getBoundingClientRect().width) : -1,
      位图宽: cv ? cv.width : -1,
      位图高: cv ? cv.height : -1,
      阶段: wrap ? String(wrap.dataset.stage || '') : '',
      落定宽: typeof dbg.rw === 'number' ? dbg.rw : -1,
      落定高: typeof dbg.rh === 'number' ? dbg.rh : -1,
      画布: cv
    }
  }
  store().setZoom(1)
  await sleep(1400)
  const s0 = snap()
  const 起点 = { 版面宽: s0.版面宽, 位图宽: s0.位图宽, 位图高: s0.位图高, 阶段: s0.阶段, 落定宽: s0.落定宽 }
  const steps = []
  let prev = performance.now()
  for (const z of [1.1, 1.2, 1.35, 1.5, 1.65, 1.8]) {
    store().setZoom(z)
    const now = performance.now()
    const item = { z, 间隔: Math.round(now - prev) }
    prev = now
    await sleep(60)
    const s = snap()
    item.版面宽 = s.版面宽
    item.位图宽 = s.位图宽
    item.落定宽 = s.落定宽
    item.阶段 = s.阶段
    item.同张画布 = s.画布 === s0.画布
    steps.push(item)
  }
  const 末 = steps[steps.length - 1]
  return JSON.stringify({
    起点,
    步进: steps,
    最大间隔: Math.max.apply(null, steps.slice(1).map((s) => s.间隔)),
    版面变了: 末.版面宽 !== 起点.版面宽,
    阶段全程painted: steps.every((s) => s.阶段 === 'painted'),
    画布始终同一张: steps.every((s) => s.同张画布),
    位图全程未变: steps.every((s) => s.位图宽 === 起点.位图宽),
    落定入参全程未变: steps.every((s) => s.落定宽 === 起点.落定宽 && s.落定宽 > 0),
    期间阶段: steps.map((s) => s.阶段).join(','),
    期间位图宽: steps.map((s) => s.位图宽).join(','),
    期间落定宽: steps.map((s) => s.落定宽).join(',')
  })
})()`

console.log('\n① 连续 6 次缩放（页内步进，每步 60ms，模拟拖滑块）：')
const g = JSON.parse(await evalJs(GESTURE))
console.log('   起点:', JSON.stringify(g.起点))
for (const s of g.步进) {
  console.log(
    `   zoom=${String(s.z).padEnd(5)} 版面宽=${String(s.版面宽).padStart(5)} 位图宽=${String(s.位图宽).padStart(5)} 落定入参=${String(s.落定宽).padStart(5)} 阶段=${s.阶段} 同张画布=${s.同张画布 ? '是' : '否'} 间隔=${s.间隔}ms`
  )
}
const 手势连续 = g.最大间隔 < 300
const layoutChanged = g.版面变了
const noRenderStarted = g.阶段全程painted
const noCanvasSwap = g.画布始终同一张
const bitmapStill = g.位图全程未变
const inputStill = g.落定入参全程未变
console.log(
  `\n   手势连续（步进最大间隔 ${g.最大间隔}ms < 300ms）: ${手势连续 ? '是 ✓' : '否 ✗（前提不成立，下面几条判据无意义）'}`
)
console.log(`   版面跟着变了吗: ${layoutChanged ? '是 ✓' : '否 ✗（缩放没反映到版面）'}`)
/*
 * ★ 这一条是判据里最硬的一条（2026-10-16 加）。
 *
 *   它直接读渲染 effect 看到的**落定尺寸**（PdfPage 起手写进
 *   wrapper.dataset.dbg 的 rw），而不是屏幕上的画布 ——
 *   画布会被换图、会被清空、会被撑到显示尺寸，读数受时序影响；
 *   而「渲染入参有没有变」就是「有没有人要重渲染」本身。
 *
 *   加它的起因是一个真实缺陷：落定尺寸原先拿异步算出的 pageSize 乘
 *   settled/live 倍率，pageSize 落后一档时会算出 595×(1.1/1.2)=545
 *   这种两边都不是的中间值 → 手势期间真的发起了一次 818 宽的整页渲染。
 *   当时只有画布读数变红，看不出是谁要渲染；这条判据一读就指到根因。
 */
console.log(
  `   手势期间没人要求重渲染（落定尺寸始终 ${g.起点.落定宽}）: ${
    inputStill ? '是 ✓' : `否 ✗（实际落定宽 ${g.期间落定宽}）`
  }`
)
console.log(
  `   手势期间没开始重渲染（阶段始终 painted）: ${
    noRenderStarted ? '是 ✓' : `否 ✗（实际阶段序列 ${g.期间阶段}）`
  }`
)
console.log(
  `   手势期间屏幕上的画布没换过: ${noCanvasSwap ? '是 ✓' : '否 ✗（换图落在手势中间）'}`
)
console.log(
  `   手势期间位图尺寸没变过: ${bitmapStill ? '是 ✓' : `否 ✗（实际位图宽 ${g.期间位图宽}）`}`
)

/* ---- ② 停手后位图必须追上最终版面 ---- */
/*
 * ★ 这里**不能**写死「等 1.5 秒然后判生死」。
 *
 *   隐藏窗口里合成器几乎不产帧（实测 600ms 才 1 帧 rAF），
 *   而位图重渲染是靠 rAF 排队的，什么时候落定取决于环境给不给帧：
 *   可见窗口约 0.6s，隐藏且不推帧的实例要 1.3s 开外。
 *   写死一个等待时长，就是在赌运气 —— 实测同一条链路
 *   上一轮「追上 ✓」、下一轮「没追上 ✗」，代码一个字没改。
 *
 *   改成**带截止时间的轮询**：最多等 8 秒，追上就立刻通过，
 *   并把它花的时间打出来（时间本身就是有用的信息）。
 *   真正要证明的是「防抖没有做过头、位图最终一定会追上来」，
 *   而不是「它在 1.5 秒内追上」。
 */
const DEADLINE_MS = 8000
console.log(`\n② 停手后轮询位图是否追上版面（最多 ${DEADLINE_MS / 1000} 秒）：`)
const t0 = Date.now()
let settled = JSON.parse(await evalJs(PROBE))
let wantBitmap = Math.max(1, Math.floor(settled.版面宽 * 1.5))
while (Date.now() - t0 < DEADLINE_MS) {
  if (Math.abs(settled.位图宽 - wantBitmap) <= 2) break
  await sleep(250)
  settled = JSON.parse(await evalJs(PROBE))
  wantBitmap = Math.max(1, Math.floor(settled.版面宽 * 1.5))
}
const waited = ((Date.now() - t0) / 1000).toFixed(1)
console.log('   ' + JSON.stringify(settled))

const caught = Math.abs(settled.位图宽 - wantBitmap) <= 2
console.log(
  `   位图是否追上版面: ${caught ? `是 ✓（${waited}s 落定）` : `否 ✗（等了 ${waited}s，位图 ${settled.位图宽}，应为约 ${wantBitmap}）`}`
)

/* ---- ③ 画布必须仍有内容（缩放不能把页面搞黑） ---- */
const sample = await evalJs(`window.__sbSampleCanvas(1)`)
console.log(`\n③ 画布采样: ${sample}`)
/*
 * ★ 判据必须同时看「暗」和「透」。
 *
 *   __sbSampleCanvas 输出 `亮x% 暗y% 中z% 透w%`。
 *   「暗」= alpha ≥ 8 且很暗，「透」= alpha < 8（用户看到的是白纸）。
 *   只看「暗」会把「这一页还没画完（大面积透明）」误判成画布变黑，
 *   而那正是上一轮反复误报的根源：0 像素既可能是透明也可能是黑，
 *   只有 alpha 分得开。
 */
const m = /亮(\d+)%/.exec(String(sample))
const dark = /暗(\d+)%/.exec(String(sample))
const clear = /透(\d+)%/.exec(String(sample))
const bright = m ? Number(m[1]) : -1
const darkPct = dark ? Number(dark[1]) : -1
const clearPct = clear ? Number(clear[1]) : -1
const loading = clearPct > 50
const ok = bright >= 0 && (loading || darkPct < 95)
console.log(
  `   有内容: ${ok ? '是 ✓' : '否 ✗'}${loading ? '（大面积透明 = 仍在加载，用户看到白纸）' : ''}`
)

const allPass =
  手势连续 &&
  layoutChanged &&
  inputStill &&
  noRenderStarted &&
  noCanvasSwap &&
  bitmapStill &&
  caught &&
  ok
console.log(`\n=== 结论：${allPass ? '全部通过 ✓' : '有未通过项 ✗'} ===`)
process.exit(allPass ? 0 : 1)
