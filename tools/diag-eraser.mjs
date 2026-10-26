// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 橡皮链路诊断：在页面上插桩，看事件走到哪一步断了。
 *
 * 做法：给 store 的 eraseAt 包一层记录调用参数，
 * 再派发真实鼠标事件，最后读回「有没有被调用、参数是多少」。
 * 这能一步区分三种可能：
 *   · 根本没调用 → 事件/模式的问题
 *   · 调用了但坐标离谱 → 换算的问题
 *   · 调用了坐标也对但没切段 → 判定/半径的问题
 *
 * 用法：node tools/diag-eraser.mjs [端口]
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

console.log('=== 橡皮链路诊断 ===\n')

/* ① 插桩：包住 eraseAt，并记录 pointerdown 是否到达容器 */
await evaluate(`(() => {
  const s = window.__store;
  window.__log = { eraseCalls: [], pointerDowns: [] };
  if (!window.__origErase) {
    window.__origErase = s.getState().eraseAt;
  }
  s.setState({
    eraseAt: async (page, x, y, radius) => {
      window.__log.eraseCalls.push({ page, x: Math.round(x*10)/10, y: Math.round(y*10)/10, radius: Math.round(radius*10)/10 });
      return window.__origErase(page, x, y, radius);
    }
  });
  // 监听容器上的 pointerdown（捕获阶段，确保能收到）
  const host = document.querySelector('.viewer-scroll');
  if (host && !host.__probed) {
    host.__probed = true;
    host.addEventListener('pointerdown', (e) => {
      window.__log.pointerDowns.push({
        x: Math.round(e.clientX), y: Math.round(e.clientY),
        button: e.button,
        target: (e.target.className && String(e.target.className).slice(0, 40)) || e.target.tagName
      });
    }, true);
  }
  return 'instrumented';
})()`)

/* ② 造笔迹并进入橡皮模式 */
await evaluate(`(() => {
  const s = window.__store;
  s.setState({ annotations: [], history: [], future: [] });
  s.getState().setDrawMode(true);
  s.setState({ drawColor: '#e5484d', drawWidth: 3 });
  const pts = [];
  for (let i = 0; i <= 60; i++) pts.push({ x: 80 + i * 7, y: 400, t: i * 16, p: 0.5 });
  s.setState({ annotations: [{ id:'diag', page:1, type:'note', rects:[], color:'#e5484d',
    quote: window.__inkTest.encodeStroke(pts, 3), note:'', at: Date.now() }] });
  s.getState().setEraserMode(true);
})()`)
await sleep(1200)

console.log('状态:', await evaluate(`JSON.stringify({
  drawMode: window.__store.getState().drawMode,
  eraserMode: window.__store.getState().eraserMode,
  笔迹数: window.__store.getState().annotations.length,
  eraserSize: window.__store.getState().eraserSize,
  缩放: Math.round(window.__store.getState().actualScale*100)
})`))

/* ③ 算出笔迹在屏幕上的**真实**位置：直接从墨迹位图反查 */
const realPos = await evaluate(`(() => {
  const pg = document.querySelector('.pdf-page');
  const base = pg.querySelector('.pdf-page__canvas');
  const ink = pg.querySelector('.ink-canvas');
  if (!ink) return JSON.stringify({ ok:false, reason:'无墨迹层' });
  const br = base.getBoundingClientRect();
  const W = ink.width, H = ink.height;
  const ctx = ink.getContext('2d');
  const kx = br.width / W, ky = br.height / H;
  // 全图找非透明像素的包围盒（分块扫）
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
  if (maxX < 0) return JSON.stringify({ ok:false, reason:'墨迹层尚无像素' });
  return JSON.stringify({
    ok: true,
    屏幕包围盒: {
      左: Math.round(br.left + minX*kx), 右: Math.round(br.left + maxX*kx),
      上: Math.round(br.top + minY*ky), 下: Math.round(br.top + maxY*ky)
    },
    中点: {
      x: Math.round(br.left + ((minX+maxX)/2)*kx),
      y: Math.round(br.top + ((minY+maxY)/2)*ky)
    },
    墨迹层屏幕: Math.round(br.left)+','+Math.round(br.top)+' '+Math.round(br.width)+'x'+Math.round(br.height)
  });
})()`)

console.log('\n笔迹真实位置:', realPos)

const rp = JSON.parse(realPos)
if (!rp.ok) {
  console.log('★ 无法定位笔迹:', rp.reason)
  ws.close()
  process.exit(1)
}

/* ④ 在笔迹中点派发真实点击 */
const cx = rp.中点.x
const cy = rp.中点.y
console.log(`\n派发点击于 (${cx}, ${cy})`)

await send('Input.dispatchMouseEvent', {
  type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1, pointerType: 'mouse'
})
await sleep(120)
await send('Input.dispatchMouseEvent', {
  type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1, pointerType: 'mouse'
})
await sleep(1000)

console.log('\n诊断日志:', await evaluate(`JSON.stringify(window.__log, null, 1)`))
console.log('\n擦后段数:', await evaluate(`window.__store.getState().annotations.length`))

console.log('\n=== 判读 ===')
console.log('  pointerDowns 为空      → 事件没到容器（CSS pointer-events 或元素被盖住）')
console.log('  pointerDowns 有、eraseCalls 为空 → onPointerDown 里提前 return 了（模式判断）')
console.log('  eraseCalls 有但坐标离谱 → 坐标换算问题')
console.log('  eraseCalls 坐标正确但段数没变 → 半径/判定问题')

/* 拆掉插桩 */
await evaluate(`(() => {
  const s = window.__store;
  if (window.__origErase) s.setState({ eraseAt: window.__origErase });
  s.setState({ annotations: [], history: [], future: [] });
  s.getState().setEraserMode(false);
  s.getState().setDrawMode(false);
})()`)

ws.close()
