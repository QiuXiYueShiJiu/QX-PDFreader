/**
 * 深挖：真鼠标拖拽为什么建不出选区。
 *
 * 步骤：加载后切到「选择」工具 → 取一个候选点 → 真拖 →
 *       立刻读选区、起点元素、以及拖拽期间是否收到过 pointerdown。
 *
 * 用法：node tools/run-verify-suite.mjs --dev 9334 verify-drag-diag.mjs
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.argv[2] ?? 9334)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
void here
void join
void resolve

const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
const page = list.find((t) => t.type === 'page' && t.url.includes('index.html')) ?? list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})
let seq = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const { resolve: rs, reject: rj } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? rj(new Error(m.error.message)) : rs(m.result)
  }
}
const send = (method, params = {}) => {
  const id = ++seq
  return new Promise((rs, rj) => {
    const t = setTimeout(() => rj(new Error('timeout ' + method)), 30000)
    pending.set(id, { resolve: (v) => (clearTimeout(t), rs(v)), reject: (e) => (clearTimeout(t), rj(e)) })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
const json = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result?.value
}

for (let i = 0; i < 40; i++) {
  const n = await json(`document.querySelectorAll('.textLayer span').length`).catch(() => 0)
  if (Number(n) > 0) break
  await sleep(500)
}

/* 装一个事件记录器，看拖拽期间到底发生了什么 */
await json(`(() => {
  window.__dragLog = [];
  const rec = (type) => (ev) => {
    window.__dragLog.push({
      t: type,
      target: (ev.target && ev.target.className) ? String(ev.target.className).slice(0, 30) : (ev.target && ev.target.tagName),
      defaultPrevented: ev.defaultPrevented,
      x: Math.round(ev.clientX || 0), y: Math.round(ev.clientY || 0)
    });
  };
  for (const type of ['pointerdown', 'mousedown', 'selectstart', 'pointermove', 'mouseup', 'pointerup']) {
    document.addEventListener(type, rec(type), true);
  }
  return true;
})()`)

const spot = await json(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const s = window.__store;
  s.getState().setEditTool('select');
  await w(600);
  const out = [];
  for (const l of document.querySelectorAll('.textLayer')) {
    for (const el of l.querySelectorAll('span')) {
      const t = el.textContent.trim();
      if (t.length < 16) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 80 || r.height < 6) continue;
      if (r.top < 130 || r.bottom > innerHeight - 130) continue;
      if (r.left < 40 || r.right > innerWidth - 40) continue;
      out.push({ t: t.slice(0, 20), x1: Math.round(r.left + 6), y: Math.round(r.top + r.height/2),
                 x2: Math.round(r.left + Math.min(r.width - 6, r.width * 0.6)) });
    }
  }
  return JSON.stringify({ editTool: s.getState().editTool, cands: out.slice(0, 3) });
})()`)
const info = JSON.parse(spot)
console.log(`editTool = ${info.editTool}`)
console.log(`候选 = ${JSON.stringify(info.cands)}`)

const c = info.cands[0]
if (!c) {
  console.error('没有候选')
  ws.close()
  process.exit(1)
}

/* 起点上是谁？ */
const at = await json(`(() => {
  const el = document.elementFromPoint(${c.x1}, ${c.y});
  const span = el && el.closest ? el.closest('.textLayer span') : null;
  const cs = span ? getComputedStyle(span) : null;
  return JSON.stringify({
    命中: el ? el.tagName + '.' + String(el.getAttribute('class')||'') : null,
    是span: !!span,
    spanUserSelect: cs ? cs.userSelect : null
  });
})()`)
console.log(`起点探测：${at}`)

/* 真拖 */
await json(`window.__dragLog = []`)
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x1, y: c.y, button: 'none', buttons: 0 })
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x1, y: c.y, button: 'left', buttons: 1, clickCount: 1 })
for (let i = 1; i <= 10; i++) {
  const k = i / 10
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(c.x1 + (c.x2 - c.x1) * k),
    y: c.y,
    button: 'none',
    buttons: 1
  })
  await sleep(25)
}
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x2, y: c.y, button: 'left', buttons: 0, clickCount: 1 })
await sleep(500)

const after = await json(`JSON.stringify({
  选中字符数: window.getSelection() ? window.getSelection().toString().length : -1,
  事件: (window.__dragLog || []).slice(0, 14),
  工具条: !!document.querySelector('[data-edit-selbar="1"]'),
  scrollClass: document.querySelector('.viewer-scroll').className
}, null, 1)`)
console.log(after)
ws.close()
