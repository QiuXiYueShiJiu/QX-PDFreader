/**
 * 诊断：点「改文字」后为什么面板没出现。
 *
 * 用法：node tools/run-verify-suite.mjs --dev 9337 verify-panel-diag.mjs
 */

import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.argv[2] ?? 9337)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
void here

const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
const page = list.find((t) => t.type === 'page' && t.url.includes('index.html')) ?? list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})
let seq = 0
const pending = new Map()
const errors = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text)
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
    errors.push((m.params.args ?? []).map((a) => a.value ?? a.description).join(' '))
  }
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
await send('Runtime.enable')
const json = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) {
    return `EXC: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`
  }
  return r.result?.value
}

for (let i = 0; i < 40; i++) {
  const n = await json(`document.querySelectorAll('.textLayer span').length`).catch(() => 0)
  if (Number(n) > 0) break
  await sleep(500)
}

/* 用兜底路径建选区：直接点 + 拖（走 pointer 事件） */
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
      out.push({ t: t.slice(0,24), x1: Math.round(r.left+6), x2: Math.round(r.left+Math.min(r.width-6, r.width*0.6)),
                 y: Math.round(r.top + r.height/2) });
    }
  }
  return JSON.stringify(out.slice(0,2));
})()`)
const cands = JSON.parse(spot)
const c = cands[0]
console.log(`候选：${JSON.stringify(c)}`)

/* 真拖（走 pointer 事件，触发兜底选字） */
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
await sleep(800)

console.log(`拖选后：${await json(`JSON.stringify({
  选区: window.getSelection() ? window.getSelection().toString().slice(0,30) : null,
  工具条: !!document.querySelector('[data-edit-selbar="1"]'),
  panel属性: document.querySelector('[data-edit-selbar="1"]')?.getAttribute('data-panel'),
  按钮数: document.querySelectorAll('[data-tb-id^="sel-"]').length
})`)}`)

/* 点「改文字」 */
console.log(`点击前按钮存在：${await json(`!!document.querySelector('[data-tb-id="sel-edit-text"]')`)}`)
console.log(`点击结果：${await json(`(() => {
  const b = document.querySelector('[data-tb-id="sel-edit-text"]');
  if (!b) return 'no button';
  b.click();
  return 'clicked';
})()`)}`)
await sleep(600)

console.log(`点击后：${await json(`JSON.stringify({
  panel属性: document.querySelector('[data-edit-selbar="1"]')?.getAttribute('data-panel') ?? '(无工具条)',
  有text面板: !!document.querySelector('[data-selbar-panel="text"]'),
  有输入框: !!document.querySelector('[data-tb-id="sel-text-input"]'),
  输入框值: document.querySelector('[data-tb-id="sel-text-input"]')?.value ?? null,
  选区: window.getSelection() ? window.getSelection().toString().slice(0,20) : null,
  工具条项: [...document.querySelectorAll('[data-tb-id^="sel-"]')].map(x => x.getAttribute('data-tb-id'))
}, null, 1)`)}`)

if (errors.length) console.log(`\n渲染层报错：\n  ${errors.slice(0, 4).join('\n  ')}`)
ws.close()
