// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 验证笔迹渲染质量（轮廓填充法）。
 *
 * 检查点：
 *   ① 画出后墨迹层确有像素（轮廓没画歪/没画空）
 *   ② 沿笔画中心线采样，宽度应**连续变化**而不是阶跃
 *      （逐段描边时相邻段宽度是常数，采样会看到台阶）
 *   ③ 直线段上宽度应处处一致（没有珠子感）
 *
 * 采样方式：在墨迹位图上，沿笔画法线方向数非透明像素的个数 = 该处宽度。
 *
 * 用法：node tools/verify-stroke-quality.mjs [端口]
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
function send(method, params = {}, timeoutMs = 30000) {
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
  if (r?.exceptionDetails) return `★异常 ${r.exceptionDetails.exception?.description?.slice(0, 300)}`
  const v = r.result?.value
  return typeof v === 'string' ? v : JSON.stringify(v)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await sleep(1200)

console.log('=== 笔迹渲染质量验证 ===\n')

/* 造一条水平直线（理想情况下各处宽度应完全一致） */
await evaluate(`(() => {
  const s = window.__store;
  s.setState({ annotations: [], history: [], future: [] });
  s.getState().setEraserMode(false);
  s.getState().setDrawMode(true);
  // 固定成一支中等粗细的笔，且不带压感（p=0 → 走速度推算）
  s.setState({ drawColor: '#e5484d', drawWidth: 4 });
  const pts = [];
  for (let i = 0; i <= 60; i++) pts.push({ x: 80 + i * 6, y: 300, t: i * 16, p: 0 });
  s.setState({ annotations: [{ id:'q1', page:1, type:'note', rects:[], color:'#e5484d',
    quote: window.__inkTest.encodeStroke(pts, 4), note:'', at: Date.now() }] });
})()`)
await sleep(1500)

/* 沿直线采样：在每个 x 处数竖直方向的非透明像素个数 */
const profile = await evaluate(`(() => {
  const ink = document.querySelector('.ink-canvas');
  if (!ink) return JSON.stringify({ ok:false, reason:'无墨迹层' });
  const W = ink.width, H = ink.height;
  const ctx = ink.getContext('2d');

  /*
   * 页面坐标 → 位图坐标：
   * 位图 = 原始尺寸 × dpr × 超采样，笔迹点存的是原始尺寸坐标，
   * 因此系数 = W / baseWidth。baseWidth 从页面盒与 pdf 画布关系推不出，
   * 改用「页面 CSS 宽 / 实际 scale」—— 这里直接用已知的线在 y=300、
   * 采样时扫整列找非透明像素，避免依赖坐标换算。
   */
  const samples = [];
  // 沿线扫若干列（列位置按位图宽度的比例取，保证落在线上）
  for (let k = 10; k <= 50; k += 5) {
    const px = Math.floor(W * (k / 100));
    let count = 0;
    for (let y = 0; y < H; y++) {
      const a = ctx.getImageData(px, y, 1, 1).data[3];
      if (a > 20) count++;
    }
    samples.push(count);
  }
  return JSON.stringify({ ok:true, 位图: W+'x'+H, 各列像素数: samples });
})()`)

console.log('① 直线各处宽度采样:', profile)

/* 曲线：确认轮廓在转角处不破 */
await evaluate(`(() => {
  const s = window.__store;
  const pts = [];
  for (let i = 0; i <= 80; i++) {
    const t = i / 80;
    pts.push({ x: 120 + t * 320, y: 500 + Math.sin(t * Math.PI * 2) * 60, t: i * 16, p: 0.5 });
  }
  s.setState({ annotations: [{ id:'q2', page:1, type:'note', rects:[], color:'#2f7cf6',
    quote: window.__inkTest.encodeStroke(pts, 6), note:'', at: Date.now() }] });
})()`)
await sleep(1500)

const curveCheck = await evaluate(`(() => {
  const ink = document.querySelector('.ink-canvas');
  const W = ink.width, H = ink.height;
  const ctx = ink.getContext('2d');
  // 统计整层的非透明像素总数（分块扫，避免一次 getImageData 过大）
  let total = 0;
  const step = 512;
  for (let y = 0; y < H; y += step) {
    const h = Math.min(step, H - y);
    const d = ctx.getImageData(0, y, W, h).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 20) total++;
  }
  return JSON.stringify({ 曲线笔迹非透明像素: total });
})()`)

console.log('② 曲线笔迹:', curveCheck)

/* 复位 */
await evaluate(`(() => { const s=window.__store; s.setState({ annotations: [], history: [], future: [] }); s.getState().setDrawMode(false); })()`)

console.log('\n=== 判定 ===')
console.log('  ① 「各列像素数」应基本相等（直线各处宽度一致）——')
console.log('     若出现明显的台阶式跳变（如 12,12,24,24,36），说明仍是逐段描边、有珠子感')
console.log('  ② 曲线非透明像素应远大于 0（轮廓未破、没画空）')

ws.close()
