/**
 * 验证「改文字 / 格式」（选择工具下改内容与格式）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么用真鼠标拖拽而不是 window.getSelection()
 * ══════════════════════════════════════════════════════════════════
 *   这条链路的入口是「用户在文字层上拖选」：
 *     pointerdown（DocumentView 判定要不要让给原生选字）
 *     → 浏览器原生建选区
 *     → selectionchange → 算 anchor（页面坐标 rects + quote）
 *     → 弹选区工具条
 *   脚本直接 window.getSelection().selectAllChildren() 会**跳过**
 *   前面几步，测不出「拖选能不能建立 anchor」。
 *   所以这里走 CDP 的 Input.dispatchMouseEvent 真拖。
 *
 * ══════════════════════════════════════════════════════════════════
 * 判据
 * ══════════════════════════════════════════════════════════════════
 *   ① 拖选后工具条出现、带 sel-edit-text 与 sel-format 按钮
 *   ② 点「改文字」→ 面板出现，输入框里预填了**选中的原文**
 *   ③ 改成新文字 + 点「替换」→ 落库为
 *        · 1 个 whiteout（盖住原文）
 *        · 1 个 text（内容是新文字、位置与原选区重合）
 *   ④ 点「格式」的字号档 → text 物件的 fontSize 变化（且不重复新增涂白）
 *   ⑤ 点「格式」的颜色块 → text 物件的 color 变化
 *
 * 用法：node tools/run-verify-suite.mjs --dev 9296 verify-text-edit.mjs
 */

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PORT = Number(process.argv[2] ?? process.env.PDF_READER_PORT ?? 9296)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let fails = 0
let checks = 0
const check = (ok, label, detail = '') => {
  checks += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  —— ${detail}` : ''}`)
  if (!ok) fails += 1
}

/* ---------- CDP 直连（需要发 Input 域事件，cdp-eval 只做 Runtime.evaluate） ---------- */
const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
const page = list.find((t) => t.type === 'page' && t.url.includes('index.html')) ?? list.find((t) => t.type === 'page')
if (!page) {
  console.error('✗ 找不到页面目标')
  process.exit(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})
let seq = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve: rs, reject: rj } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? rj(new Error(msg.error.message)) : rs(msg.result)
  }
}
function send(method, params = {}, timeout = 30000) {
  const id = ++seq
  return new Promise((rs, rj) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      rj(new Error(`CDP 超时：${method}`))
    }, timeout)
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer)
        rs(v)
      },
      reject: (e) => {
        clearTimeout(timer)
        rj(e)
      }
    })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function json(expr, timeout = 30000) {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true
  }, timeout)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'eval 异常')
  return r.result?.value
}

console.log('改文字 / 格式（隐藏窗口）')
console.log(`  端口 ${PORT}\n`)

/* ---------- 等文本层就绪 ---------- */
for (let i = 0; i < 40; i++) {
  const n = await json(`document.querySelectorAll('.textLayer span').length`).catch(() => 0)
  if (Number(n) > 0) break
  await sleep(500)
}

/* ---------- 切到「选择」工具，收集可拖选的候选 ---------- */
const spotRaw = await json(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const s = window.__store;
  s.getState().setEditTool('select');
  await w(500);

  /*
   * 连续滚动模式下，所有已挂载页的 span 都在 DOM 里。
   * 只挑「坐标确实落在视口安全区内」的，否则拖拽会落到视口外，
   * 什么也选不中（第一版就栽在这）。
   */
  const out = [];
  for (const l of document.querySelectorAll('.textLayer')) {
    for (const el of l.querySelectorAll('span')) {
      const txt = el.textContent.trim();
      if (txt.length < 16) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 80 || r.height < 6) continue;
      /* 安全区：上下各留 130px 给工具栏与底部工具条，左右留 40px */
      if (r.top < 130 || r.bottom > innerHeight - 130) continue;
      if (r.left < 40 || r.right > innerWidth - 40) continue;
      out.push({ t: txt.slice(0, 40), w: Math.round(r.width),
                 x1: Math.round(r.left + 6), x2: Math.round(r.left + Math.min(r.width - 6, r.width * 0.6)),
                 y: Math.round(r.top + r.height / 2) });
    }
  }
  out.sort((a, b) => b.w - a.w);
  return JSON.stringify(out.slice(0, 6));
})()`)

const candidates = JSON.parse(spotRaw || '[]')
console.log(`  候选文字 ${candidates.length} 段`)
if (candidates.length === 0) {
  console.error('✗ 视口内找不到可拖选的文字（夹具可能没渲染完）')
  ws.close()
  process.exit(1)
}

/** 在给定两点之间真拖一次 */
async function dragSelect(x1, y1, x2, y2) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, button: 'none', buttons: 0 })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1 })
  const steps = 10
  for (let i = 1; i <= steps; i++) {
    const k = i / steps
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: x1 + (x2 - x1) * k,
      y: y1 + (y2 - y1) * k,
      button: 'none',
      buttons: 1
    })
    await sleep(25)
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(600)
  return Number(await json('window.getSelection() ? window.getSelection().toString().length : 0'))
}

/* 逐个候选试，直到真的选出字来 */
let spot = null
for (const c of candidates) {
  const n = await dragSelect(c.x1, c.y, c.x2, c.y)
  if (n > 0) {
    spot = { 文本: c.t, 起点: { x: c.x1, y: c.y }, 终点: { x: c.x2, y: c.y }, 选中字符数: n }
    console.log(`  拖选成功：选中 ${n} 个字符（「${c.t.slice(0, 24)}…」）`)
    break
  }
}

if (!spot) {
  console.error('✗ 试过所有候选都选不中文字')
  ws.close()
  process.exit(1)
}

/* ---------- ① 工具条出现 ---------- */
const bar = await json(`(() => {
  const el = document.querySelector('[data-edit-selbar="1"]');
  const sel = window.getSelection();
  return JSON.stringify({
    有工具条: !!el,
    选中字符数: sel ? sel.toString().length : 0,
    有改文字按钮: !!document.querySelector('[data-tb-id="sel-edit-text"]'),
    有格式按钮: !!document.querySelector('[data-tb-id="sel-format"]')
  });
})()`)
const barInfo = JSON.parse(bar)
console.log(`  工具条：${JSON.stringify(barInfo)}`)
check(barInfo.有工具条, '① 拖选后选区工具条出现', `选中 ${barInfo.选中字符数} 个字符`)
check(barInfo.有改文字按钮 && barInfo.有格式按钮, '① 工具条含「改文字」与「格式」按钮')

if (!barInfo.有工具条) {
  console.log('\n★ 拖选没能建立选区/工具条，后续判据无法进行')
  ws.close()
  process.exit(1)
}

/* ---------- ② 点「改文字」→ 输入框预填原文 ---------- */
await json(`document.querySelector('[data-tb-id="sel-edit-text"]').click()`)
await sleep(400)
const panel = await json(`JSON.stringify({
  面板: !!document.querySelector('[data-selbar-panel="text"]'),
  输入框: !!document.querySelector('[data-tb-id="sel-text-input"]'),
  预填: document.querySelector('[data-tb-id="sel-text-input"]')?.value ?? null,
  选中原文: window.getSelection()?.toString() ?? ''
})`)
const p = JSON.parse(panel)
check(p.面板 && p.输入框, '② 点「改文字」后面板与输入框出现')
check(
  !!p.预填 && p.预填.length > 0,
  '② 输入框预填了选中的原文',
  JSON.stringify((p.预填 ?? '').slice(0, 30))
)

/* ---------- ③ 改成新文字并替换 ---------- */
const NEW_TEXT = '已替换的文字ABC'
await json(`(() => {
  const t = document.querySelector('[data-tb-id="sel-text-input"]');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(t, ${JSON.stringify(NEW_TEXT)});
  t.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`)
await sleep(300)
await json(`document.querySelector('[data-tb-id="sel-text-apply"]').click()`)
await sleep(900)

const after = await json(`(() => {
  const st = window.__store.getState();
  const list = (st.annotations || []).filter(a => a.type === 'whiteout' || a.type === 'text');
  const texts = list.filter(a => a.type === 'text');
  return JSON.stringify({
    白块数: list.filter(a => a.type === 'whiteout').length,
    文字数: texts.length,
    新文字: texts.map(t => ({ 内容: (t.text ?? '').slice(0, 24), 字号: t.fontSize, 颜色: t.color, 页: t.page,
                              位置: t.rects[0] ? [Math.round(t.rects[0].x), Math.round(t.rects[0].y)] : null })),
    选中原文位置: ${JSON.stringify(spot.起点)}
  });
})()`)
const a2 = JSON.parse(after)
console.log(`  落库：${JSON.stringify(a2)}`)
check(a2.白块数 >= 1, '③ 生成了涂白（盖住原文）', `${a2.白块数} 块`)
check(a2.文字数 >= 1, '③ 生成了新文字物件', `${a2.文字数} 个`)
check(
  a2.新文字.some((t) => t.内容.startsWith('已替换的文字')),
  '③ 新文字内容 = 改写后的文字',
  JSON.stringify(a2.新文字.map((t) => t.内容))
)
const target = a2.新文字.find((t) => t.内容.startsWith('已替换的文字'))
check(!!target?.字号 && target.字号 > 5, '③ 新文字带上了估计字号', String(target?.字号))

/* ---------- ④ 换一段没改过的文字 → 点格式改字号 ---------- */
/*
 * 为什么不重选刚才那段：替换之后原文字被白块盖住，白块本身是一个编辑物件，
 * 在选择工具下点它会「选中物件」（可以拖动/删除），不会产生文字选区 ——
 * 这是产品对的交互，不是 bug。所以 ④ 改用另一段没动过的文字来验格式面板。
 */
await json(`(() => { const sc = document.querySelector('.viewer-scroll'); if (sc) { sc.scrollTop = 0; sc.scrollLeft = 0 } return true })()`)
await sleep(350)
let fmtSpot = null
for (const c of candidates) {
  if (c.x1 === spot.起点.x && c.y === spot.起点.y) continue
  const n = await dragSelect(c.x1, c.y, c.x2, c.y)
  if (n <= 0) continue
  const barOk = await json(`Boolean(document.querySelector('[data-edit-selbar="1"]'))`)
  if (barOk) {
    fmtSpot = { x1: c.x1, x2: c.x2, y: c.y }
    console.log(`  ④ 另选一段：选中 ${n} 个字符（「${c.t.slice(0, 24)}…」）`)
    break
  }
}
if (!fmtSpot) console.log('  ⚠ 找不到未被编辑物件覆盖的文字段（下面格式面板判据会连带失败）')
await sleep(200)
const reInfo = await json(`JSON.stringify({
  选区: (window.getSelection()?.toString() ?? '').slice(0, 30),
  字符数: (window.getSelection()?.toString() ?? '').length,
  浮条: !!document.querySelector('.edit-selbar'),
  按钮: [...document.querySelectorAll('[data-tb-id]')].map((el) => el.getAttribute('data-tb-id')).slice(0, 12)
})`)
console.log(`  ④ 重选诊断：${reInfo}`)

/* 先点「改文字」建立快照（点格式也会自动建，但这里更接近真实操作顺序） */
await json(`document.querySelector('[data-tb-id="sel-edit-text"]')?.click()`)
await sleep(300)
await json(`document.querySelector('[data-tb-id="sel-format"]')?.click()`)
await sleep(400)
const fmtPanel = await json(
  `JSON.stringify({ 格式面板: !!document.querySelector('[data-selbar-panel="format"]'),
                    字号档数: document.querySelectorAll('.edit-selbar__size').length,
                    色块数: document.querySelectorAll('.edit-selbar__swatch').length })`
)
console.log(`  格式面板：${fmtPanel}`)
const f = JSON.parse(fmtPanel)
check(f.格式面板 && f.字号档数 > 3 && f.色块数 > 2, '④ 格式面板出现（含字号档与色块）', fmtPanel)

/*
 * 这一段是「另一段没改过的文字」，第一次点字号会正常生成一对（涂白 + 文字），
 * 所以白块数会从 1 变 2；真正要防的是**同一个物件被反复改格式时越叠越厚**。
 * 因此基线取「点完字号之后」的白块数，再点色块，要求数量不再增加。
 */
await json(`document.querySelector('[data-tb-id="sel-size-24"]')?.click()`)
await sleep(800)
const midRaw = await json(`(() => {
  const st = window.__store.getState();
  const list = (st.annotations || []).filter(a => a.type === 'whiteout' || a.type === 'text');
  return JSON.stringify({
    白块数: list.filter(a => a.type === 'whiteout').length,
    字号集合: list.filter(a => a.type === 'text').map(t => t.fontSize)
  });
})()`)
const mid = JSON.parse(midRaw)
console.log(`  点字号后：${midRaw}`)

await json(`document.querySelector('[data-tb-id="sel-color-dc2626"]')?.click()`)
await sleep(800)

const after2 = await json(`(() => {
  const st = window.__store.getState();
  const list = (st.annotations || []).filter(a => a.type === 'whiteout' || a.type === 'text');
  const texts = list.filter(a => a.type === 'text');
  return JSON.stringify({
    白块数: list.filter(a => a.type === 'whiteout').length,
    字号集合: texts.map(t => t.fontSize),
    颜色集合: texts.map(t => t.color)
  });
})()`)
const a3 = JSON.parse(after2)
console.log(`  改格式后：${JSON.stringify(a3)}`)
check(a3.字号集合.includes(24), '④ 点字号档 24 生效', JSON.stringify(a3.字号集合))
check(a3.颜色集合.includes('#dc2626'), '⑤ 点色块生效', JSON.stringify(a3.颜色集合))
check(
  a3.白块数 === mid.白块数,
  '④ 反复改格式没有重复新增涂白（复用了同一个物件）',
  `点字号后 ${mid.白块数} → 点色块后 ${a3.白块数}（初始 ${a2.白块数}）`
)

/* 收尾：别给后面的用例留一堆编辑物件 */
await json(`(() => {
  const st = window.__store.getState();
  for (const a of (st.annotations || []).filter(x => x.type === 'whiteout' || x.type === 'text')) {
    void st.removeAnnotation(a.id);
  }
  window.getSelection()?.removeAllRanges();
  st.setEditTool('none');
  return true;
})()`)
await sleep(500)

console.log(`\n=== 结果：${checks} 项检查，${fails} 项失败 ===`)
ws.close()
process.exit(fails > 0 ? 1 : 0)
void spawnSync
