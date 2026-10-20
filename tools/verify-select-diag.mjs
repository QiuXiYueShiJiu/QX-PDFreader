/**
 * 诊断：「选择」工具下拖选文字为什么选不中。
 *
 * 查四件事：
 *   ① 命中点上的元素链（是否真的落在字符 span 上）
 *   ② 该点的**有效 user-select**（可能是某个祖先设了 none）
 *   ③ editTool 与 viewer-scroll 的 class
 *   ④ 用脚本直接建选区能否成功（区分「浏览器不让选」与「事件被吃」）
 *
 * 用法：node tools/run-verify-suite.mjs --dev 9327 verify-select-diag.mjs
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PORT = Number(process.argv[2] ?? 9327)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

const info = await json(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const s = window.__store;
  out0 = null;
  s.getState().setEditTool('select');
  await w(500);

  const scroll = document.querySelector('.viewer-scroll');
  const res = { editTool: s.getState().editTool, scrollClass: scroll.className };

  /* 找候选（与用例同口径） */
  const cands = [];
  for (const l of document.querySelectorAll('.textLayer')) {
    for (const el of l.querySelectorAll('span')) {
      const txt = el.textContent.trim();
      if (txt.length < 16) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 80 || r.height < 6) continue;
      if (r.top < 130 || r.bottom > innerHeight - 130) continue;
      if (r.left < 40 || r.right > innerWidth - 40) continue;
      cands.push({ txt: txt.slice(0,24), x: Math.round(r.left + 6), y: Math.round(r.top + r.height/2), w: Math.round(r.width) });
    }
  }
  res.候选数 = cands.length;
  res.前3个 = cands.slice(0, 3);
  if (cands.length === 0) return JSON.stringify(res, null, 1);

  const c = cands[0];
  res.探测点 = { x: c.x, y: c.y };

  /* ① 命中链 */
  const chain = [];
  let el = document.elementFromPoint(c.x, c.y);
  res.命中元素 = el ? (el.tagName + '.' + (el.getAttribute('class') || '')) : null;
  while (el && chain.length < 8) {
    const cs = getComputedStyle(el);
    chain.push({
      标签: el.tagName,
      类: (el.getAttribute('class') || '').slice(0, 40),
      userSelect: cs.userSelect,
      webkitUserSelect: cs.webkitUserSelect,
      pointerEvents: cs.pointerEvents
    });
    el = el.parentElement;
  }
  res.祖先链 = chain;

  /* ② 直接建选区（绕过事件）能否成功 */
  const span = document.elementFromPoint(c.x, c.y)?.closest?.('.textLayer span') || null;
  res.命中span = !!span;
  if (span) {
    const rng = document.createRange();
    rng.selectNodeContents(span);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(rng);
    await w(200);
    res.脚本选区字符数 = sel.toString().length;
    res.脚本选区后工具条 = !!document.querySelector('[data-edit-selbar="1"]');
    sel.removeAllRanges();
  }

  s.getState().setEditTool('none');
  return JSON.stringify(res, null, 1);
})()`)

console.log(info)
ws.close()
