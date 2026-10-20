// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 橡皮链路诊断 v2：用 window 级捕获监听，绕开元素边界问题。
 *
 * ── 为什么重写 ──────────────────────────────────────────────
 *   v1 把监听挂在 .viewer-scroll 上，结果显示「一次都没收到」。
 *   但 DOMDebugger 证实该元素上确实有 pointerdown 监听器，
 *   说明问题出在「事件没走到那个元素」而不是「没监听」。
 *   挂到 window 捕获阶段就能区分：
 *     window 收到 → 事件在更内层被拦（stopPropagation）
 *     window 也没收到 → CDP 派发的目标不对
 *
 * 用法：node tools/diag-eraser2.mjs [端口]
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
  if (r?.exceptionDetails) return `★异常 ${r.exceptionDetails.exception?.description?.slice(0, 300)}`
  const v = r.result?.value
  return typeof v === 'string' ? v : JSON.stringify(v)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('=== 橡皮链路诊断 v2 ===\n')

/* 插桩：window 捕获 + eraseAt 包装 */
await evaluate(`(() => {
  const s = window.__store;
  window.__log = { win: [], eraseCalls: [] };
  window.addEventListener('pointerdown', (e) => {
    window.__log.win.push({
      x: Math.round(e.clientX), y: Math.round(e.clientY), button: e.button,
      target: String(e.target.className || e.target.tagName).slice(0, 40)
    });
  }, true);
  if (!window.__origErase) window.__origErase = s.getState().eraseAt;
  s.setState({
    eraseAt: async (page, x, y, radius) => {
      window.__log.eraseCalls.push({ page, x: Math.round(x), y: Math.round(y), r: Math.round(radius) });
      return window.__origErase(page, x, y, radius);
    }
  });
  return 'ok';
})()`)

/* 造笔迹 + 橡皮模式 */
await evaluate(`(() => {
  const s = window.__store;
  s.setState({ annotations: [], history: [], future: [] });
  s.getState().setDrawMode(true);
  s.setState({ drawColor: '#e5484d', drawWidth: 4 });
  const pts = [];
  for (let i = 0; i <= 60; i++) pts.push({ x: 80 + i * 7, y: 400, t: i * 16, p: 0.5 });
  s.setState({ annotations: [{ id:'d2', page:1, type:'note', rects:[], color:'#e5484d',
    quote: window.__inkTest.encodeStroke(pts, 4), note:'', at: Date.now() }] });
  s.getState().setEraserMode(true);
})()`)
await sleep(1200)

/* 找笔迹真实位置 */
const rp = JSON.parse(await evaluate(`(() => {
  const pg = document.querySelector('.pdf-page');
  const base = pg.querySelector('.pdf-page__canvas');
  const ink = pg.querySelector('.ink-canvas');
  if (!ink) return JSON.stringify({ ok:false, reason:'无墨迹层' });
  const br = base.getBoundingClientRect();
  const W = ink.width, H = ink.height;
  const ctx = ink.getContext('2d');
  const kx = br.width / W, ky = br.height / H;
  let minX = W, maxX = -1, minY = H, maxY = -1;
  const step = 256;
  for (let y0 = 0; y0 < H; y0 += step) {
    const h = Math.min(step, H - y0);
    const d = ctx.getImageData(0, y0, W, h).data;
    for (let row = 0; row < h; row++) {
      for (let x = 0; x < W; x += 2) {
        if (d[(row * W + x) * 4 + 3] > 20) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          const yy = y0 + row;
          if (yy < minY) minY = yy; if (yy > maxY) maxY = yy;
        }
      }
    }
  }
  if (maxX < 0) return JSON.stringify({ ok:false, reason:'墨迹层无像素' });
  return JSON.stringify({ ok:true,
    中: { x: Math.round(br.left + ((minX+maxX)/2)*kx), y: Math.round(br.top + ((minY+maxY)/2)*ky) },
    盒: { 左: Math.round(br.left+minX*kx), 右: Math.round(br.left+maxX*kx),
          上: Math.round(br.top+minY*ky), 下: Math.round(br.top+maxY*ky) }
  });
})()`))

console.log('笔迹位置:', JSON.stringify(rp))
if (!rp.ok) { console.log('★', rp.reason); ws.close(); process.exit(1) }

const cx = rp.中.x, cy = rp.中.y

/* 先派发一个移动（顺便把橡皮光标挪过去），再点击 */
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, button: 'none', buttons: 0, pointerType: 'mouse' })
await sleep(200)
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1, pointerType: 'mouse' })
await sleep(120)
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1, pointerType: 'mouse' })
await sleep(1000)

console.log(`\n点击于 (${cx}, ${cy})`)
console.log('window 收到的 pointerdown:', await evaluate(`JSON.stringify(window.__log.win)`))
console.log('eraseAt 调用记录:', await evaluate(`JSON.stringify(window.__log.eraseCalls)`))
console.log('擦后段数:', await evaluate(`window.__store.getState().annotations.length`))

/* 再试：直接用 store 调 eraseAt，确认算法本身没问题 */
const direct = await evaluate(`(async () => {
  const s = window.__store;
  // 重置笔迹
  const pts = [];
  for (let i = 0; i <= 60; i++) pts.push({ x: 80 + i * 7, y: 400, t: i * 16, p: 0.5 });
  s.setState({ annotations: [{ id:'d3', page:1, type:'note', rects:[], color:'#e5484d',
    quote: window.__inkTest.encodeStroke(pts, 4), note:'', at: Date.now() }], history: [], future: [] });
  const ok = await window.__origErase(1, 290, 400, 20);
  return JSON.stringify({ 直调结果: ok, 段数: s.getState().annotations.length });
})()`)
console.log('\n直接调 store.eraseAt(1, 290, 400, 20):', direct)

console.log('\n=== 判读 ===')
console.log('  window 空 → CDP 派发的坐标没落在文档上（或窗口尺寸与坐标不符）')
console.log('  window 有、eraseCalls 空 → onPointerDown 里被条件挡住了')
console.log('  两者都有 → 链路通，之前测不出来是测试脚本的问题')
console.log('  直调若也不切段 → 算法在缩放后的半径换算上有问题')

/* 清理 */
await evaluate(`(() => {
  const s = window.__store;
  if (window.__origErase) s.setState({ eraseAt: window.__origErase });
  s.setState({ annotations: [], history: [], future: [] });
  s.getState().setEraserMode(false); s.getState().setDrawMode(false);
})()`)

ws.close()
