// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 橡皮端到端验证 v2：这次**避开工具条遮挡区**。
 *
 * ── 上一版为什么失败 ────────────────────────────────────────
 *   v1 把笔迹画在页面纵向 47% 处，而那个位置恰好被
 *   悬浮的手绘工具条盖住（实测点击目标解析成了 .drawbar）。
 *   于是「擦不了」的结论是假的 —— 实际是点在了工具条上。
 *
 *   这一版把笔迹放在页面**上部**（25%），远离底部工具条，
 *   并在点击前用 elementFromPoint 断言目标确实是页面内容，
 *   断言不通过就直接报出来，避免再次误判。
 *
 * 用法：node tools/verify-eraser-e2e.mjs [端口]
 */

const port = process.argv[2] ?? '9226'

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
function send(method, params = {}, timeoutMs = 25000) {
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

/** 造一条水平笔迹，纵向位置可指定（页面坐标比例） */
async function makeStroke(yRatio) {
  return evaluate(`(() => {
    const s = window.__store;
    s.setState({ annotations: [], history: [], future: [] });
    s.getState().setDrawMode(true);
    s.setState({ drawColor: '#e5484d', drawWidth: 4 });
    // 页面高度约 842（A4）；用比例换算成页面坐标
    const y = Math.round(842 * ${yRatio});
    const pts = [];
    for (let i = 0; i <= 60; i++) pts.push({ x: 80 + i * 7, y, t: i * 16, p: 0.5 });
    s.setState({ annotations: [{ id:'e2e2', page:1, type:'note', rects:[], color:'#e5484d',
      quote: window.__inkTest.encodeStroke(pts, 4), note:'', at: Date.now() }] });
    return y;
  })()`)
}

/** 找笔迹在屏幕上的真实位置，并断言该点确实是页面内容 */
async function locate() {
  const raw = await evaluate(`(() => {
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
    const cx = Math.round(br.left + ((minX+maxX)/2)*kx);
    const cy = Math.round(br.top + ((minY+maxY)/2)*ky);
    // 断言：这个点下面必须不是工具条
    const stack = document.elementsFromPoint(cx, cy).map(e => String(e.className || e.tagName));
    return JSON.stringify({ ok:true, cx, cy, 元素栈: stack.slice(0,3) });
  })()`)
  return JSON.parse(raw)
}

console.log('=== 橡皮端到端验证 v2（避开工具条）===\n')

for (const [label, yRatio, zoom] of [
  ['A. fit-width，笔迹在上部', 0.2, 'fit-width'],
  ['B. 300% 放大，笔迹在上部', 0.2, 3]
]) {
  await evaluate(`window.__store.getState().setZoom(${typeof zoom === 'string' ? `'${zoom}'` : zoom})`)
  await sleep(2200)
  const y = await makeStroke(yRatio)
  await evaluate(`window.__store.getState().setEraserMode(true)`)
  await sleep(900)

  const loc = await locate()
  if (!loc.ok) {
    console.log(`${label}: ★ ${loc.reason}`)
    continue
  }

  const covered = loc.元素栈.some((c) => c.includes('drawbar') || c.includes('statusbar'))
  if (covered) {
    console.log(`${label}: ★ 点击点仍被 UI 覆盖 —— ${JSON.stringify(loc.元素栈)}`)
    continue
  }

  const before = await evaluate(`window.__store.getState().annotations.length`)
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: loc.cx, y: loc.cy, button: 'left', clickCount: 1, pointerType: 'mouse'
  })
  await sleep(120)
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: loc.cx, y: loc.cy, button: 'left', clickCount: 1, pointerType: 'mouse'
  })
  await sleep(1000)

  const after = await evaluate(`(() => {
    const a = window.__store.getState().annotations;
    const ranges = a.map(x => { const p = window.__inkTest.decodeStroke(x.quote);
      const xs = p.points.map(q=>q.x); return Math.round(Math.min(...xs)) + '~' + Math.round(Math.max(...xs)); });
    return JSON.stringify({ 段数: a.length, 各段x范围: ranges });
  })()`)

  console.log(`${label}`)
  console.log(`   笔迹页面Y=${y}  点击屏幕(${loc.cx}, ${loc.cy})  命中元素=${loc.元素栈[0]}`)
  console.log(`   擦前段数=${before}  擦后=${after}`)
  console.log(`   → ${JSON.parse(after).段数 === 2 ? '✓ 橡皮生效（切成两段）' : '★ 未生效'}\n`)
}

/* 复位 */
await evaluate(`(() => {
  const s = window.__store;
  s.setState({ annotations: [], history: [], future: [] });
  s.getState().setEraserMode(false);
  s.getState().setDrawMode(false);
  s.getState().setZoom('fit-width');
})()`)

ws.close()
