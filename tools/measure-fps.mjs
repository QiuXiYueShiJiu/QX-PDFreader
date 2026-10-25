/**
 * 量滚动帧率：隐藏实例 + CDP。
 *
 * 关键点（不这么做就永远是 1 fps）：
 *   · Electron 隐藏/遮挡的窗口会被 Chromium 降频，rAF 基本不跑；
 *   · 所以先 `Emulation.setFocusEmulationEnabled(true)`，再开
 *     `Page.startScreencast` 逼合成器持续出帧，之后 rAF 才有意义。
 *
 * 用法：node tools/measure-fps.mjs <port> [theme]
 * 判据：≥50 顺畅 / 40~50 可用 / <40 卡顿
 */
const PORT = Number(process.argv[2] ?? 9999)
const THEME = process.argv[3] ?? ''
const MS = Number(process.argv[4] ?? 3000)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!target) {
  console.error('找不到调试目标')
  process.exit(1)
}
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})
let seq = 0
const pending = new Map()
let screencastFrames = 0
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.method === 'Page.screencastFrame') {
    screencastFrames += 1
    ws.send(JSON.stringify({ id: ++seq, method: 'Page.screencastFrameAck', params: { sessionId: msg.params.sessionId } }))
    return
  }
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result ?? msg.error)
    pending.delete(msg.id)
  }
})
const send = (method, params = {}) =>
  new Promise((ok) => {
    const id = ++seq
    pending.set(id, ok)
    ws.send(JSON.stringify({ id, method, params }))
  })
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return r?.result?.value ?? r?.exceptionDetails?.text
}
const evJson = async (body) => {
  const raw = await ev(`JSON.stringify((() => { ${body} })())`)
  try {
    return JSON.parse(raw)
  } catch {
    return { __err: String(raw).slice(-300) }
  }
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setFocusEmulationEnabled', { enabled: true })
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Page.startScreencast', { format: 'jpeg', quality: 20, maxWidth: 480, maxHeight: 300, everyNthFrame: 1 })
await sleep(400)

const ready = await evJson(`
  const s = window.__store?.getState?.()
  return { pages: s?.pageCount ?? 0, theme: s?.settings?.theme ?? '' }
`)
if (!ready.pages) {
  console.error('渲染层没就绪：', JSON.stringify(ready))
  process.exit(1)
}

if (THEME && THEME !== ready.theme) {
  await ev(`window.__store.getState().patchSettings({ theme: '${THEME}' })`)
  await sleep(700)
}

await ev(`
  window.__fps = { frames: 0, started: 0, done: false, elapsed: 0 }
  window.__fps.start = (ms) => {
    const s = window.__fps
    s.frames = 0; s.done = false; s.started = performance.now(); s.elapsed = 0
    requestAnimationFrame(function loop(){ if (!s.done) { s.frames += 1; requestAnimationFrame(loop) } })
    setTimeout(() => { s.done = true; s.elapsed = performance.now() - s.started }, ms)
  }
  window.__fps.read = () => {
    const s = window.__fps
    const secs = Math.max(0.001, (s.elapsed || (performance.now() - s.started)) / 1000)
    return { frames: s.frames, seconds: Number(secs.toFixed(2)), fps: Number((s.frames / secs).toFixed(1)) }
  }
  'ok'
`)

const before = screencastFrames
await ev(`
  const el = document.querySelector('.viewer-scroll')
  el.scrollTop = 0
  window.__fps.start(${MS})
  let dir = 1
  const id = setInterval(() => {
    el.scrollTop += 26 * dir
    if (el.scrollTop <= 0) dir = 1
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) dir = -1
  }, 16)
  setTimeout(() => clearInterval(id), ${MS})
  'ok'
`)
await sleep(MS + 500)
const res = await evJson('return window.__fps.read()')
const castFrames = screencastFrames - before
await send('Page.stopScreencast')
ws.close()

if (res.__err) {
  console.error('读取失败：', res.__err)
  process.exit(1)
}
const verdict = res.fps >= 50 ? '顺畅' : res.fps >= 40 ? '可用' : '卡顿'
console.log(`主题 ${ready.theme}｜${res.seconds}s / ${res.frames} 帧 / 合成器 ${castFrames} 帧`)
console.log(`→ ${res.fps} fps（${verdict}）`)
