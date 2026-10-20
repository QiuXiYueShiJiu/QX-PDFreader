// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 验证本轮其余改动（数据层 + DOM）。
 *
 * 覆盖：
 *   ① 批注默认粗细应减半（4 → 2）
 *   ② 缩放宽高应连续（zoomIn 多次后应停在中间值，而不是跳档）
 *   ③ 连续缩放滑块是否存在且量程正确
 *   ④ 橡皮大小范围是否是 3~48（连续可调）
 *   ⑤ 橡皮光标元素是否存在
 *   ⑥ 撤销/重做按钮是否随栈深启用
 *
 * 用法：node tools/verify-round2.mjs [端口]
 */

const port = process.argv[2] ?? '9225'

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
function send(method, params = {}, timeoutMs = 20000) {
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
  if (r?.exceptionDetails) return `★异常 ${r.exceptionDetails.exception?.description?.slice(0, 260)}`
  const v = r.result?.value
  return typeof v === 'string' ? v : JSON.stringify(v)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await sleep(1200)

console.log('=== 本轮改动验证 ===\n')

/* ① 默认粗细 */
console.log('① 批注默认粗细:', await evaluate(`window.__store.getState().drawWidth`))

/* ④ 橡皮大小范围 */
console.log('④-set 橡皮大小:')
console.log('   设 1  → 应被夹到 3 :', await evaluate(`(() => { const s=window.__store; s.getState().setEraserSize(1); return s.getState().eraserSize })()`))
console.log('   设 99 → 应被夹到 48:', await evaluate(`(() => { const s=window.__store; s.getState().setEraserSize(99); return s.getState().eraserSize })()`))
console.log('   设 27 → 应为 27     :', await evaluate(`(() => { const s=window.__store; s.getState().setEraserSize(27); return s.getState().eraserSize })()`))

/* ② 缩放连续性：连按 5 次放大，看是否停在档位之间 */
console.log('\n② 缩放连续性:')
const zoomSeq = await evaluate(`(() => {
  const s = window.__store;
  s.getState().setZoom(1);
  const out = [];
  for (let i = 0; i < 5; i++) { s.getState().zoomIn(); out.push(s.getState().zoom); }
  return JSON.stringify(out);
})()`)
console.log('   连按 5 次放大:', zoomSeq)

const zoomSeqOut = await evaluate(`(() => {
  const s = window.__store;
  s.getState().setZoom(1);
  const out = [];
  for (let i = 0; i < 5; i++) { s.getState().zoomOut(); out.push(s.getState().zoom); }
  return JSON.stringify(out);
})()`)
console.log('   连按 5 次缩小:', zoomSeqOut)

/* ③ 连续缩放滑块 */
console.log('\n③ 右栏缩放滑块:')
console.log(
  '  ',
  await evaluate(`(() => {
    const el = document.querySelector('.rail__zoom-slider');
    if (!el) return '★ 未找到';
    return JSON.stringify({ min: el.min, max: el.max, step: el.step, value: el.value, 可禁用: el.disabled === false });
  })()`)
)

/* ⑤ 橡皮光标：进入橡皮模式后应出现 */
console.log('\n⑤ 橡皮光标:')
console.log(
  '   进入橡皮模式前:',
  await evaluate(`document.querySelectorAll('.eraser-cursor').length`)
)
await evaluate(`(() => { const s=window.__store; s.getState().setDrawMode(true); s.getState().setEraserMode(true); })()`)
await sleep(600)
console.log(
  '   进入橡皮模式后:',
  await evaluate(`(() => {
    const el = document.querySelector('.eraser-cursor');
    if (!el) return '★ 未出现';
    const cs = getComputedStyle(el);
    return JSON.stringify({ 数量: document.querySelectorAll('.eraser-cursor').length, 定位: cs.position, 圆角: cs.borderRadius, 指针事件: cs.pointerEvents });
  })()`)
)

/* ⑥ 撤销/重做按钮 */
console.log('\n⑥ 撤销/重做按钮:')
console.log(
  '  ',
  await evaluate(`(() => {
    const btns = Array.from(document.querySelectorAll('.rail-btn'));
    const u = btns.find(b => b.textContent.trim() === '撤销');
    const r = btns.find(b => b.textContent.trim() === '重做');
    return JSON.stringify({
      撤销按钮存在: !!u,
      重做按钮存在: !!r,
      撤销禁用_栈空时: u ? u.disabled : null,
      重做禁用_栈空时: r ? r.disabled : null
    });
  })()`)
)

/* 有历史后按钮应启用 */
await evaluate(`(() => {
  const s = window.__store;
  s.setState({ annotations: [], history: [], future: [] });
  const pts = [];
  for (let i = 0; i <= 20; i++) pts.push({ x: 100 + i*10, y: 300, t: i*10, p: 0.5 });
  s.setState({ annotations: [{ id:'x1', page:1, type:'note', rects:[], color:'#e5484d',
    quote: window.__inkTest.encodeStroke(pts, 2), note:'', at: Date.now() }] });
})()`)
await sleep(300)
await evaluate(`window.__store.getState().eraseAt(1, 200, 300, 30)`)
await sleep(400)
console.log(
  '   擦一下后:',
  await evaluate(`(() => {
    const btns = Array.from(document.querySelectorAll('.rail-btn'));
    const u = btns.find(b => b.textContent.trim() === '撤销');
    const r = btns.find(b => b.textContent.trim() === '重做');
    return JSON.stringify({
      栈深: window.__store.getState().history.length,
      撤销禁用: u ? u.disabled : null,
      撤销提示: u ? u.title : null,
      重做禁用: r ? r.disabled : null
    });
  })()`)
)

/* 复位 */
await evaluate(`(() => { const s=window.__store; s.setState({ annotations: [], history: [], future: [] }); s.getState().setEraserMode(false); s.getState().setDrawMode(false); s.getState().setZoom('fit-width'); })()`)

console.log('\n=== 判定 ===')
console.log('  ① 应为 2')
console.log('  ② 序列应是连续小数（如 1.15 / 1.3225 …），不是 1.25 / 1.5 这种跳档')
console.log('  ④ 应依次为 3 / 48 / 27')
console.log('  ⑤ 进入橡皮模式后应出现 1 个 .eraser-cursor，position=fixed，pointer-events=none')
console.log('  ⑥ 栈空时两个按钮都禁用；擦一下后撤销启用且 title 显示可撤步数')

ws.close()
