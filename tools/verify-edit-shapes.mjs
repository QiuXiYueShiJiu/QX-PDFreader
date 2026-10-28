// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 直线 / 箭头：端到端断言（v1.9.0 新增的两种手绘图形）。
 *
 * ── 为什么单独立一支 ──────────────────────────────────────────
 *   矩形/椭圆只要外接框对就算对，直线/箭头还多两件事：
 *   · **方向**：从右下拖到左上，画出来的必须还是那个方向
 *     （只存外接框会丢方向，四条对角线长得一模一样）；
 *   · **零厚度**：完全水平的线，外接框高度为 0，若不撑开热区，
 *     画完就点不中、也拖不动 —— 用户会以为"没画上"。
 *   这两条都不是截图能看出来的，必须读 store 里的 `line` 端点。
 *
 * ⚠️ 红线（与 verify-content-edit 一致）：
 *   · 绝不点「导出 PDF」（弹原生另存为框，隐藏实例会卡死）；
 *   · 结束前把物件删干净并 markExported()，否则 exportDirty 会粘住，
 *     后面碰关闭的用例全被原生确认框挂住。
 *
 * 用法：node tools/verify-edit-shapes.mjs [端口]
 */

const PORT = Number(process.argv[2] ?? 9290)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ============================================================
 * CDP 连接
 * ============================================================ */

async function targets() {
  try {
    return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  } catch {
    return null
  }
}

const list = await targets()
const target = list?.find((t) => t.type === 'page' && t.url.includes('index.html'))
if (!target) {
  console.error(`✗ 端口 ${PORT} 上找不到页面目标 —— 请用套件起实例：node tools/run-verify-suite.mjs --dev ${PORT}`)
  process.exit(2)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res)
  ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')))
})

let msgId = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(String(ev.data))
  const cb = m.id ? pending.get(m.id) : null
  if (cb) {
    pending.delete(m.id)
    cb(m)
  }
})

function send(method, params = {}, timeout = 20000) {
  const id = (msgId += 1)
  return new Promise((res, rej) => {
    pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)))
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        rej(new Error(`CDP 超时：${method}`))
      }
    }, timeout)
  })
}

async function evaluate(expr, timeout) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, timeout)
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text
    throw new Error(`页面异常：${String(d).split('\n')[0]}`)
  }
  return r.result?.value
}

async function evalJson(expr) {
  const s = await evaluate(`JSON.stringify(${expr})`)
  return s === undefined ? null : JSON.parse(s)
}

async function waitFor(expr, ms = 8000) {
  const t0 = Date.now()
  for (;;) {
    try {
      if (await evaluate(expr)) return true
    } catch {
      /* 页面正在重渲染时 evaluate 可能失败，下一轮再试 */
    }
    if (Date.now() - t0 > ms) return false
    await sleep(120)
  }
}

/* ============================================================
 * 断言计数
 * ============================================================ */

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${name}${detail ? ` —— ${detail}` : ''}`)
  } else {
    fail += 1
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

/* ============================================================
 * 真输入
 * ============================================================ */

async function clickSelector(sel, index = 0) {
  const box = await evalJson(`(() => {
    const el = document.querySelectorAll(${JSON.stringify(sel)})[${index}];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, disabled: !!el.disabled };
  })()`)
  if (!box || box.w <= 0 || box.h <= 0) return { ok: false, why: `找不到元素或尺寸为 0：${sel}[${index}]` }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', buttons: 0 })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 })
  return { ok: true, box }
}

async function drag(x1, y1, x2, y2, steps = 8) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, button: 'none', buttons: 0 })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1 })
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: x1 + (x2 - x1) * t,
      y: y1 + (y2 - y1) * t,
      button: 'none',
      buttons: 1
    })
    await sleep(25)
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1 })
}

async function evalJsonAsync(expr) {
  const s = await evaluate(`(async () => {
    const v = await (${expr});
    return JSON.stringify(v === undefined ? null : v);
  })()`)
  return s === undefined || s === null ? null : JSON.parse(s)
}

/**
 * 切到某个编辑工具。
 *
 * ⚠️ 不能无脑点：编辑工具按钮是「再点一次就退回浏览」的开关语义
 * （DrawToolbar 里 `setEditTool(active ? 'none' : t.id)`），
 * 已经是当前工具时再点一下会把工具关掉，后面的拖拽就画不出东西。
 */
async function ensureTool(id) {
  const now = await evaluate(`window.__store.getState().editTool`)
  if (now === id) return false
  await clickSelector(`[data-tb-id="edit-${id}"]`)
  await sleep(250)
  return true
}

const pressKey = async (key, code, vk) => {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 0 }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

/* ============================================================
 * 探针
 * ============================================================ */

const PROBE = `JSON.stringify((() => {
  const st = window.__store.getState();
  const bar = document.querySelector('.edit-bar[data-edit-bar="1"]');
  return {
    editTool: st.editTool,
    dirty: st.exportDirty,
    page: st.page,
    bar: !!bar,
    barTool: bar ? bar.getAttribute('data-tool') : null,
    shapes: st.annotations
      .filter((a) => a.type === 'line' || a.type === 'arrow' || a.type === 'rect' || a.type === 'ellipse')
      .map((a) => ({
        id: a.id,
        type: a.type,
        line: a.line ?? null,
        rect: a.rects[0] ? { x: a.rects[0].x, y: a.rects[0].y, w: a.rects[0].width, h: a.rects[0].height } : null,
        strokeWidth: a.strokeWidth ?? null,
        color: a.color,
        fill: a.fill ?? null,
        dash: a.dash ?? null
      })),
    drawn: Array.from(document.querySelectorAll('.edit-item--line, .edit-item--arrow')).map((n) => ({
      type: n.getAttribute('data-anno-type'),
      hasSvg: !!n.querySelector('svg'),
      segs: n.querySelectorAll('svg line').length,
      box: (() => { const r = n.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()
    })),
    items: st.annotations.filter((a) => a.rects && a.rects.length).length
  };
})())`

const readShape = async () => JSON.parse(await evaluate(PROBE))

/** 当前页里一块「在视口内」的空白点（与 verify-content-edit 同思路）
 *
 * 不能假设页面顶边就在视口里：前面的用例可能把缩放调大、或把文档滚到半页，
 * 于是 `页顶 + 60` 落到视口外，整支脚本会以「找不到空白点」直接抛错。
 * 这里改成用「页顶与视口顶的较大者」起算，只要视口里还有 160px 高的页面就够用。
 */
async function blankSpot(dx = 60, dy = 40) {
  const p = await evalJson(`(() => {
    const pages = Array.from(document.querySelectorAll('.pdf-page'));
    const vp = document.querySelector('.viewer-scroll');
    if (!pages.length || !vp) return null;
    const vr = vp.getBoundingClientRect();
    for (const pg of pages) {
      const r = pg.getBoundingClientRect();
      if (r.bottom < vr.top + 40 || r.top > vr.bottom - 40) continue;
      const top = Math.max(r.top, vr.top) + 40;
      const bottom = Math.min(r.bottom, vr.bottom) - 40;
      if (bottom - top < 160) continue;
      const left = Math.max(r.left, vr.left) + 40;
      const right = Math.min(r.right, vr.right) - 40;
      if (right - left < 340) continue;
      return { x: left, y: top, page: Number(pg.getAttribute('data-page') || 0) };
    }
    return null;
  })()`)
  if (!p) throw new Error('找不到可画的空白点：页面可能没渲染或视口太窄')
  return { x: p.x + dx, y: p.y + dy, page: p.page }
}

/* ============================================================
 * 开始
 * ============================================================ */

console.log(`=== 直线 / 箭头（端口 ${PORT}）===`)

/* ① 「插入」组里有两个新按钮，且都在「开始」页上 */
await clickSelector('[data-tb-id="ribbon-tab-home"]')
await sleep(400)
const buttons = await evalJson(`(() => {
  const ids = ['edit-line', 'edit-arrow'];
  return ids.map((id) => {
    const el = document.querySelector('[data-tb-id="' + id + '"]');
    const group = el ? el.closest('.ribbon__group') : null;
    const label = group ? group.querySelector('.ribbon__group-label') : null;
    return { id, found: !!el, label: el ? el.getAttribute('aria-label') : null, group: label ? label.textContent.trim() : null };
  });
})()`)
check(
  '① 功能区「插入」组有直线、箭头按钮',
  buttons.every((b) => b.found && b.group === '插入'),
  buttons.map((b) => `${b.id}=${b.found ? b.label : '缺失'}@${b.group ?? '?'}`).join(' / ')
)

/* ② 切到直线工具：编辑条出现且带线宽档位 */
await ensureTool('line')
let s = await readShape()
check('② 直线工具已激活（editTool=line）', s.editTool === 'line', `editTool=${s.editTool}`)
const strokeChips = await evalJson(
  `Array.from(document.querySelectorAll('.edit-bar [data-tb-id^="edit-strokewidth-"]')).map((n) => n.getAttribute('aria-label'))`
)
check('② 直线也用线宽档位', Array.isArray(strokeChips) && strokeChips.length >= 3, `档位=${(strokeChips ?? []).join(',')}`)

/* ③ 从右下往左上拖：方向必须反过来（这是外接框存不下的信息） */
const before = (await readShape()).items
const spotA = await blankSpot()
await drag(spotA.x + 260, spotA.y + 160, spotA.x, spotA.y, 10)
await waitFor(`window.__store.getState().annotations.filter((a) => a.type === 'line').length > 0`)
s = await readShape()
const linha = s.shapes.find((x) => x.type === 'line')
check('③ 拖出一根直线', s.items === before + 1 && Boolean(linha), `物件 ${before} → ${s.items}`)
if (linha?.line) {
  const [nx1, ny1, nx2, ny2] = linha.line
  /* 起点在右下（接近 1/1），终点在左上（接近 0/0），中间容差 0.15 */
  check(
    '③ 方向没丢：起点右下、终点左上',
    nx1 > 0.85 && ny1 > 0.85 && nx2 < 0.15 && ny2 < 0.15,
    `归一化端点=${linha.line.map((v) => v.toFixed(2)).join(',')}`
  )
  check(
    '③ 端点落在 0~1 之间',
    [...linha.line].every((v) => v >= -0.001 && v <= 1.001),
    linha.line.map((v) => v.toFixed(2)).join(',')
  )
  check('③ 线宽随 store 落库', (linha.strokeWidth ?? 0) >= 1, `strokeWidth=${linha.strokeWidth}`)
}
const drawnLine = (await readShape()).drawn.find((d) => d.type === 'line')
check(
  '③ 页面上真的画出了线段（不是空白 svg）',
  Boolean(drawnLine?.hasSvg) && (drawnLine?.segs ?? 0) >= 1,
  `svg=${drawnLine?.hasSvg} 线段=${drawnLine?.segs}`
)

/* ④ 水平线：外接框被撑到 6px，否则连自己都点不中
 *
 * 先把③那根斜线删掉再画：它就在同一块空白区上，留着的话
 * 水平线会从它身上起笔 —— 那一瞬间指针是"点在已有物件上"，
 * 触发的是选中/拖动而不是画新线，看起来就像"水平线画不出来"。 */
await evalJsonAsync(`(async () => {
  const st = window.__store.getState();
  for (const a of st.annotations.filter((x) => x.type === 'line')) await st.removeAnnotation(a.id);
  return true;
})()`)
await ensureTool('line')
const spotB = await blankSpot(40, 140)
const beforeB = (await readShape()).items
await drag(spotB.x, spotB.y, spotB.x + 300, spotB.y, 10)
await waitFor(`window.__store.getState().annotations.filter((a) => a.type === 'line').length >= 1`)
s = await readShape()
const flat = s.shapes.filter((x) => x.type === 'line').at(-1)
check('④ 水平线也画得出来', s.items === beforeB + 1, `物件 ${beforeB} → ${s.items}`)
check(
  '④ 零厚度被撑到热区（高度 ≥ 5）',
  Boolean(flat?.rect) && (flat?.rect?.h ?? 0) >= 5,
  `外接框 ${flat?.rect ? `${Math.round(flat.rect.w)}x${Math.round(flat.rect.h)}` : '无'}`
)
check(
  '④ 水平线的两端仍贴在外接框上下沿内',
  Boolean(flat?.line) && flat.line[1] >= -0.001 && flat.line[1] <= 1.001 && flat.line[3] >= -0.001 && flat.line[3] <= 1.001,
  `端点=${(flat?.line ?? []).map((v) => v.toFixed(2)).join(',')}`
)

/* ⑤ 箭头：切工具、拖一条斜线、svg 里应多出两条箭头短线（共 3 条 line） */
await evalJsonAsync(`(async () => {
  const st = window.__store.getState();
  for (const a of st.annotations.filter((x) => x.type === 'line')) await st.removeAnnotation(a.id);
  return true;
})()`)
await ensureTool('arrow')
check('⑤ 箭头工具已激活（editTool=arrow）', (await readShape()).editTool === 'arrow')
const spotC = await blankSpot(60, 40)
const beforeC = (await readShape()).items
await drag(spotC.x, spotC.y, spotC.x + 260, spotC.y + 120, 10)
await waitFor(`window.__store.getState().annotations.filter((a) => a.type === 'arrow').length > 0`)
s = await readShape()
const arrow = s.shapes.find((x) => x.type === 'arrow')
check('⑤ 拖出一个箭头', Boolean(arrow) && s.items === beforeC + 1, `物件 ${beforeC} → ${s.items}`)
const drawnArrow = s.drawn.find((d) => d.type === 'arrow')
check(
  '⑤ 箭头头部两条短线 + 主干 = 3 条 line',
  (drawnArrow?.segs ?? 0) === 3,
  `线段数=${drawnArrow?.segs}`
)

/* ⑥ 选中的物件有四个缩放手柄（直线/箭头也要能拉伸，不然等于画死） */
await clickSelector('.edit-item--arrow', 0)
await sleep(250)
const handles = await evalJson(
  `document.querySelectorAll('.edit-item.is-selected .edit-handle').length`
)
check('⑥ 选中箭头后出现 4 个缩放手柄', handles === 4, `手柄数=${handles}`)

/* ⑤b 填充 / 虚线：编辑条上的两个开关要能同时作用于「下一笔」和「选中的那一个」 */
/* 先把 ⑤ 画的箭头删掉：它占着同一块空白区，新的一笔会落进它的热区被当成「拖动旧物件」 */
await evalJsonAsync(`(async () => {
  const st = window.__store.getState();
  for (const a of st.annotations.filter((x) => x.type === 'line' || x.type === 'arrow')) {
    await st.removeAnnotation(a.id);
  }
  return true;
})()`)
await ensureTool('rect')
await sleep(250)
const hasSwitches = await evalJson(
  `({ fill: Boolean(document.querySelector('[data-tb-id="edit-fill"]')), dash: Boolean(document.querySelector('[data-tb-id="edit-dash"]')) })`
)
check(
  '⑤b 矩形工具下编辑条有「填充」「虚线」两个开关',
  hasSwitches?.fill === true && hasSwitches?.dash === true,
  JSON.stringify(hasSwitches)
)
await clickSelector('[data-tb-id="edit-fill"]')
await clickSelector('[data-tb-id="edit-dash"]')
await sleep(200)
const switchPressed = await evalJson(
  `[document.querySelector('[data-tb-id="edit-fill"]')?.getAttribute('aria-pressed'), document.querySelector('[data-tb-id="edit-dash"]')?.getAttribute('aria-pressed')]`
)
check(
  '⑤b 两个开关按下后 aria-pressed=true',
  switchPressed?.[0] === 'true' && switchPressed?.[1] === 'true',
  `填充=${switchPressed?.[0]} 虚线=${switchPressed?.[1]}`
)

const spotD = await blankSpot(60, 40)
await drag(spotD.x, spotD.y, spotD.x + 240, spotD.y + 140, 10)
await waitFor(`window.__store.getState().annotations.filter((a) => a.type === 'rect').length > 0`)
s = await readShape()
const filled = s.shapes.filter((x) => x.type === 'rect').pop()
check(
  '⑤b 新矩形带半透明填充（rgba，约 22%）',
  typeof filled?.fill === 'string' && filled.fill.startsWith('rgba(') && filled.fill.includes('0.22'),
  `fill=${filled?.fill}`
)
check('⑤b 新矩形带虚线标记', filled?.dash === true, `dash=${filled?.dash}`)
const svgLook = await evalJson(
  `(() => {
     const svg = document.querySelector('.edit-item--rect svg rect, .edit-visual--shape rect');
     if (!svg) return null;
     return { fill: svg.getAttribute('fill'), dash: svg.getAttribute('stroke-dasharray') };
   })()`
)
check(
  '⑤b 界面上真的画出了填充与虚线',
  Boolean(svgLook?.fill?.startsWith('rgba(')) && Boolean(svgLook?.dash),
  `fill=${svgLook?.fill} dasharray=${svgLook?.dash}`
)
/* 关掉开关，恢复成「只描边」，后面的用例不受影响 */
await clickSelector('[data-tb-id="edit-fill"]')
await clickSelector('[data-tb-id="edit-dash"]')
await sleep(150)

/* ⑦ 收尾：删干净 + 清脏标记 + 回漫游（红线，见文件头） */
const cleaned = await evalJsonAsync(`(async () => {
  const st = window.__store.getState();
  const ids = st.annotations
    .filter((a) => a.type === 'line' || a.type === 'arrow' || a.type === 'rect' || a.type === 'ellipse')
    .map((a) => a.id);
  for (const id of ids) await st.removeAnnotation(id);
  const left = window.__store.getState().annotations.filter((a) =>
    a.type === 'line' || a.type === 'arrow' || a.type === 'rect' || a.type === 'ellipse'
  ).length;
  if (window.__store.getState().markExported) window.__store.getState().markExported();
  window.__store.getState().setEditTool('none');
  return { left, dirty: window.__store.getState().exportDirty, tool: window.__store.getState().editTool };
})()`)
check('⑦ 收尾：图形已删、脏标记已清、回到漫游', cleaned?.left === 0 && cleaned?.dirty === false && cleaned?.tool === 'none', JSON.stringify(cleaned))

await sleep(200)
ws.close()

console.log('')
if (fail === 0) {
  console.log(`✓ 直线 / 箭头：${pass} 项全部通过`)
  process.exit(0)
}
console.log(`✗ 直线 / 箭头：${pass} 通过 / ${fail} 失败`)
process.exit(1)
