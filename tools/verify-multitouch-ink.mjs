// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 多指绘画 / 掌心擦除 回归验证（对应用户 2026-10-16 报的 bug）。
 *
 * 用户原话（要点）：单指绘画过程中若切换成多指，批注渲染就出问题
 * —— 手指在屏幕上时：第二根手指一按下去就开始画、两根手指之间
 * 拉出一条横跨的折线、单指抬起后整笔提前结束、第二条笔迹不落库。
 *
 * 根因（已修）：移动/抬起监听挂在 window 上却不按 pointerId 过滤，
 * 于是第二根手指的坐标被追加进第一根手指的点数组；第二根手指抬起
 * 时又把第一笔结算掉（并清空共享的点数组）。
 *
 * 这个脚本把修复后的行为钉成判据：
 *   ① 双指并写 → 两条独立笔迹，各自 bbox 只覆盖自己的轨迹（不出横跨折线）
 *   ② 中途抬起一指 → 另一指的点一个不少（不被提前结算）
 *   ③ 五指点下去 → 只认 4 笔（用户定的上限），第 5 根不影响别人
 *   ④ 笔 + 手指同时写 → 两条都落库（按 pointerId 隔离，不按类型）
 *   ⑤ 掌心（大触点）在绘画模式下 → 不画线，改成大面积擦除
 *   ⑥ 橡皮模式下两指同时擦 → 两条笔迹都被切断
 *   ⑦ 掌心阈值可在真机现场标定（__sbSetPalmThreshold），且触点尺寸有记录
 *
 * 用法：node tools/verify-multitouch-ink.mjs [端口]
 * 由 tools/run-verify-suite.mjs 在已启动的实例上调用（不改前台、不弹窗）。
 */

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PORT = process.argv[2] ?? '9228'

function cdp(expr) {
  const r = spawnSync('node', [join(root, 'scripts', 'cdp-eval.mjs'), PORT, expr], {
    cwd: root,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60000
  })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 从 cdp() 的多行输出里抠出 JSON（脚本里的诊断都是 JSON.stringify(…, null, 1)） */
function parseObj(text) {
  const s = String(text)
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    return JSON.parse(s.slice(a, b + 1))
  } catch {
    return null
  }
}

function parseArr(text) {
  const s = String(text)
  const a = s.indexOf('[')
  const b = s.lastIndexOf(']')
  if (a < 0 || b <= a) return null
  try {
    return JSON.parse(s.slice(a, b + 1))
  } catch {
    return null
  }
}

const fails = []
function check(ok, label, extra) {
  console.log(`${ok ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`)
  if (!ok) fails.push(label)
}

/* ============================================================
 * 浏览器侧的公共片段：合成指针事件工厂 + 读取全部笔迹摘要
 * ============================================================ */

/**
 * mk(t, id, kind, x, y, size) 造一个指针事件。
 * size 同时写进 width/height —— 掌心判定看的就是触点长边。
 */
const MK = `
  const mk = (t, id, kind, x, y, size) => new PointerEvent(t, {
    bubbles: true, cancelable: true, composed: true,
    pointerId: id, pointerType: kind, isPrimary: true,
    clientX: x, clientY: y, button: 0,
    buttons: t === 'pointerup' ? 0 : 1,
    pressure: t === 'pointerup' ? 0 : 0.5,
    width: size, height: size
  });
  const page = document.querySelector('.pdf-page[data-page="1"]');
`

/** 把当前所有笔迹批注摘要成一张表（点数 / bbox / 颜色 / 粗细） */
const STROKES = `
  const strokes = window.__store.getState().annotations
    .filter((a) => typeof a.quote === 'string' && a.quote.startsWith('[笔迹]'))
    .map((a) => {
      const st = JSON.parse(a.quote.slice(4));
      const xs = st.d.map((p) => p[0]);
      const ys = st.d.map((p) => p[1]);
      return {
        n: st.d.length,
        w: st.w,
        color: a.color,
        page: a.page,
        x0: Math.round(Math.min.apply(null, xs)),
        x1: Math.round(Math.max.apply(null, xs)),
        y0: Math.round(Math.min.apply(null, ys)),
        y1: Math.round(Math.max.apply(null, ys)),
        dy: Math.round(Math.max.apply(null, ys) - Math.min.apply(null, ys)),
        dx: Math.round(Math.max.apply(null, xs) - Math.min.apply(null, xs))
      };
    });
`

async function resetScene(mode) {
  cdp(`(() => {
    window.__sbDebugDraw = true;
    window.__sbDrawTrace = [];
    const s = window.__store.getState();
    s.setDrawMode(${mode === 'draw'});
    s.setEraserMode(${mode === 'erase'});
    s.setPage(1);
    s.setZoom('fit-width');
    const v = document.querySelector('.viewer-scroll');
    if (v) v.scrollTop = 0;
    return 'ok';
  })()`)
  await sleep(900)
}

/** 清空批注，最多试 3 次（清空是异步落库的） */
async function clearInk() {
  for (let i = 0; i < 3; i++) {
    const left = cdp(`(() => {
      ${STROKES}
      return String(strokes.length);
    })()`)
    if (/^0$/.test(left.split('\n').pop().trim())) return true
    cdp(`(() => { void window.__store.getState().clearAnnotations(); return 'clearing' })()`)
    await sleep(900)
  }
  const left = cdp(`(() => { ${STROKES} return String(strokes.length); })()`)
  return /^0$/.test(left.split('\n').pop().trim())
}

async function readStrokes() {
  const raw = cdp(`(() => {
    ${STROKES}
    return JSON.stringify(strokes, null, 1);
  })()`)
  const arr = parseArr(raw)
  return Array.isArray(arr) ? arr : []
}

/* ============================================================
 * ① 准备：复位 + 量第 1 页底图矩形
 * ============================================================ */
console.log('① 准备环境（复位缩放/页码/模式，清空批注）…')
await resetScene('draw')

const rectRaw = cdp(`(() => {
  const el = document.querySelector('.pdf-page[data-page="1"]');
  if (!el) return 'null';
  const cv = el.querySelector('canvas.pdf-page__canvas');
  if (!cv) return 'null';
  const r = cv.getBoundingClientRect();
  return JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
})()`)
const rect = parseObj(rectRaw)
if (!rect || rect.w <= 0) {
  console.error('✗ 第 1 页底图量不到，终止（', rectRaw, '）')
  process.exit(1)
}
console.log(`   第 1 页底图：${rect.w}x${rect.h} @ (${rect.left}, ${rect.top})`)

const X0 = rect.left + 60
const STEP = 5
const MOVES = 20
const Y = [rect.top + 120, rect.top + 220, rect.top + 320, rect.top + 420, rect.top + 520]
/** 一条水平线在页面坐标里的纵向跨度应远小于相邻两条线的人为间距（100 CSS px） */
const DY_MAX = 50

/* ============================================================
 * ② 双指并写：两条独立笔迹，不互相串点
 * ============================================================ */
console.log('\n② 双指并写（正是用户报的场景）…')
if (!(await clearInk())) {
  console.error('✗ 批注清不掉，测试前提不成立')
  process.exit(1)
}
const parallelRaw = cdp(`(() => {
  ${MK}
  const pts = [[11, ${Y[0]}], [12, ${Y[1]}]];
  for (const p of pts) page.dispatchEvent(mk('pointerdown', p[0], 'touch', ${X0}, p[1], 10));
  const parallel = (window.__sbDraftSessions || new Map()).size;
  for (let i = 1; i <= ${MOVES}; i++) {
    for (const p of pts) page.dispatchEvent(mk('pointermove', p[0], 'touch', ${X0} + i * ${STEP}, p[1], 10));
  }
  const during = (window.__sbDraftSessions || new Map()).size;
  return JSON.stringify({ parallel, during, after: -1 });
})()`)
const par = parseObj(parallelRaw)
/*
 * ★ 每一笔都要有**自己的**预览画布。
 *   中途停一下先看 DOM：共用一张画布的话，两根手指的笔迹
 *   会在预览层互相覆盖，用户看到的就是「画着画着线跳来跳去」。
 */
await sleep(300)
const previewRaw = cdp(`(() => {
  const n = document.querySelectorAll('.ink-preview').length;
  const sizes = Array.prototype.map.call(document.querySelectorAll('.ink-preview'), (c) => c.width + 'x' + c.height);
  return JSON.stringify({ n, sizes });
})()`)
const previewDuring = parseObj(previewRaw)
const closeRaw = cdp(`(() => {
  ${MK}
  const pts = [[11, ${Y[0]}], [12, ${Y[1]}]];
  for (const p of pts) page.dispatchEvent(mk('pointerup', p[0], 'touch', ${X0} + ${MOVES * STEP}, p[1], 10));
  return JSON.stringify({ parallel: -1, during: -1, after: (window.__sbDraftSessions || new Map()).size });
})()`)
const closed = parseObj(closeRaw)
await sleep(400)
const previewAfterRaw = cdp(`(() => String(document.querySelectorAll('.ink-preview').length))()`)
const previewAfter = Number(previewAfterRaw.split('\n').pop().trim())
await sleep(900)
const two = await readStrokes()
console.log(`   并行会话数：下笔后 ${par?.parallel} / 书写中 ${par?.during} / 收笔后 ${closed?.after}`)
console.log(`   预览画布数：书写中 ${previewDuring?.n} ${JSON.stringify(previewDuring?.sizes)} → 收笔后 ${previewAfter}`)
console.log(`   落库笔迹：${JSON.stringify(two)}`)
check(two.length === 2, '双指并写落库 2 条笔迹', `实际 ${two.length}`)
check(par?.parallel === 2 && par?.during === 2, '两笔同时存在（两个独立会话）', `parallel=${par?.parallel} during=${par?.during}`)
check(
  previewDuring?.n === 2 && previewAfter === 0,
  '每一笔都有自己的预览画布（书写中 2 张，收笔后清空）',
  `书写中 ${previewDuring?.n} / 收笔后 ${previewAfter}`
)
check(closed?.after === 0, '两指抬起后会话全部结束', `after=${closed?.after}`)
check(
  two.length === 2 && two.every((s) => s.n >= MOVES),
  `每条笔迹点数 ≥ ${MOVES}（没有丢点）`,
  two.map((s) => s.n).join(' / ')
)
/*
 * ★ 核心判据：修复前两根手指的点会被并进同一条笔迹，
 *   那条笔迹的 bbox 会横跨两条线的间距（100 CSS px）。
 *   页面坐标 = CSS 像素 / 实时缩放，所以页面坐标下的跨度只会更大。
 */
check(
  two.length === 2 && two.every((s) => s.dy <= DY_MAX),
  `每条笔迹只覆盖自己那条线（纵向跨度 ≤ ${DY_MAX} 页面单位）`,
  two.map((s) => `dy=${s.dy}`).join(' / ')
)
check(
  two.length === 2 && Math.abs(two[0].y0 - two[1].y0) > 20,
  '两条笔迹分属不同轨迹（纵向位置不同）',
  two.map((s) => `y0=${s.y0}`).join(' / ')
)

/* ============================================================
 * ③ 中途抬起一指：另一指的点不能少、不能被提前结算
 * ============================================================ */
console.log('\n③ 一指中途抬起（另一指继续写）…')
if (!(await clearInk())) {
  console.error('✗ 批注清不掉，测试前提不成立')
  process.exit(1)
}
const midRaw = cdp(`(() => {
  ${MK}
  page.dispatchEvent(mk('pointerdown', 21, 'touch', ${X0}, ${Y[0]}, 10));
  page.dispatchEvent(mk('pointerdown', 22, 'touch', ${X0}, ${Y[1]}, 10));
  const HALF = Math.floor(${MOVES} / 2);
  for (let i = 1; i <= HALF; i++) {
    page.dispatchEvent(mk('pointermove', 21, 'touch', ${X0} + i * ${STEP}, ${Y[0]}, 10));
    page.dispatchEvent(mk('pointermove', 22, 'touch', ${X0} + i * ${STEP}, ${Y[1]}, 10));
  }
  // 21 号提前抬指
  page.dispatchEvent(mk('pointerup', 21, 'touch', ${X0} + HALF * ${STEP}, ${Y[0]}, 10));
  const after21Up = (window.__sbDraftSessions || new Map()).size;
  // 22 号继续写完整条
  for (let i = HALF + 1; i <= ${MOVES}; i++) {
    page.dispatchEvent(mk('pointermove', 22, 'touch', ${X0} + i * ${STEP}, ${Y[1]}, 10));
  }
  page.dispatchEvent(mk('pointerup', 22, 'touch', ${X0} + ${MOVES * STEP}, ${Y[1]}, 10));
  return JSON.stringify({ after21Up, after: (window.__sbDraftSessions || new Map()).size });
})()`)
const mid = parseObj(midRaw)
await sleep(900)
const midStrokes = await readStrokes()
console.log(`   21 号抬指后仍有会话：${mid?.after21Up}（应为 1）；全部收笔后：${mid?.after}`)
console.log(`   落库笔迹：${JSON.stringify(midStrokes)}`)
check(mid?.after21Up === 1, '一指抬起后另一指仍在书写（会话未被误清）', `实际 ${mid?.after21Up}`)
check(midStrokes.length === 2, '两条笔迹都落库（早抬的那条也落库）', `实际 ${midStrokes.length}`)
check(
  midStrokes.length === 2 && midStrokes.some((s) => s.n >= MOVES),
  `继续书写的那条点数 ≥ ${MOVES}（抬指后仍继续收点）`,
  midStrokes.map((s) => s.n).join(' / ')
)

/* ============================================================
 * ④ 五指同时写：只认 4 笔（上限），第 5 根不影响别人
 * ============================================================ */
console.log('\n④ 五指同时写（上限 4）…')
if (!(await clearInk())) {
  console.error('✗ 批注清不掉，测试前提不成立')
  process.exit(1)
}
const fiveRaw = cdp(`(() => {
  ${MK}
  const ids = [31, 32, 33, 34, 35];
  const ys = ${JSON.stringify(Y)};
  for (let k = 0; k < ids.length; k++) page.dispatchEvent(mk('pointerdown', ids[k], 'touch', ${X0}, ys[k], 10));
  const parallel = (window.__sbDraftSessions || new Map()).size;
  for (let i = 1; i <= ${MOVES}; i++) {
    for (let k = 0; k < ids.length; k++) page.dispatchEvent(mk('pointermove', ids[k], 'touch', ${X0} + i * ${STEP}, ys[k], 10));
  }
  for (let k = 0; k < ids.length; k++) page.dispatchEvent(mk('pointerup', ids[k], 'touch', ${X0} + ${MOVES * STEP}, ys[k], 10));
  return JSON.stringify({ parallel, after: (window.__sbDraftSessions || new Map()).size });
})()`)
const five = parseObj(fiveRaw)
await sleep(900)
const capStrokes = await readStrokes()
console.log(`   并行会话数：${five?.parallel}（上限 4）；落库 ${capStrokes.length} 条`)
console.log(`   笔迹摘要：${JSON.stringify(capStrokes.map((s) => ({ n: s.n, y0: s.y0, dy: s.dy })))}`)
check(five?.parallel === 4, '并行会话上限为 4（第 5 根手指被忽略）', `实际 ${five?.parallel}`)
check(capStrokes.length === 4, '落库 4 条笔迹', `实际 ${capStrokes.length}`)
check(
  capStrokes.every((s) => s.dy <= DY_MAX),
  '四条笔迹互不串点（每条只覆盖自己那条线）',
  capStrokes.map((s) => `dy=${s.dy}`).join(' / ')
)

/* ============================================================
 * ⑤ 笔 + 手指同时写：两种 pointerType 各自独立
 * ============================================================ */
console.log('\n⑤ 触屏笔与手指同时写…')
if (!(await clearInk())) {
  console.error('✗ 批注清不掉，测试前提不成立')
  process.exit(1)
}
const mixRaw = cdp(`(() => {
  ${MK}
  page.dispatchEvent(mk('pointerdown', 41, 'pen', ${X0}, ${Y[0]}, 1));
  page.dispatchEvent(mk('pointerdown', 42, 'touch', ${X0}, ${Y[1]}, 10));
  for (let i = 1; i <= ${MOVES}; i++) {
    page.dispatchEvent(mk('pointermove', 41, 'pen', ${X0} + i * ${STEP}, ${Y[0]}, 1));
    page.dispatchEvent(mk('pointermove', 42, 'touch', ${X0} + i * ${STEP}, ${Y[1]}, 10));
  }
  page.dispatchEvent(mk('pointerup', 41, 'pen', ${X0} + ${MOVES * STEP}, ${Y[0]}, 1));
  page.dispatchEvent(mk('pointerup', 42, 'touch', ${X0} + ${MOVES * STEP}, ${Y[1]}, 10));
  return JSON.stringify({ parallel: (window.__sbDraftSessions || new Map()).size });
})()`)
console.log(`   并行会话数：${parseObj(mixRaw)?.parallel}`)
await sleep(900)
const mixStrokes = await readStrokes()
console.log(`   落库笔迹：${JSON.stringify(mixStrokes.map((s) => ({ n: s.n, y0: s.y0, dy: s.dy })))}`)
check(mixStrokes.length === 2, '笔与手指各落一条笔迹', `实际 ${mixStrokes.length}`)
check(
  mixStrokes.length === 2 && mixStrokes.every((s) => s.dy <= DY_MAX && s.n >= MOVES),
  '两条笔迹各自完整且互不串点',
  mixStrokes.map((s) => `n=${s.n},dy=${s.dy}`).join(' / ')
)

/* ============================================================
 * ⑥ 掌心：大触点在绘画模式下 = 大面积擦除，而不是画一道粗线
 * ============================================================ */
console.log('\n⑥ 掌心擦除（绘画模式下手掌搭在屏上）…')
/*
 * 先把画布清空，再只画一条作为被擦对象 ——
 * 否则上一节留下的笔迹会一起被数进来，「擦掉了多少」就没法对账。
 */
if (!(await clearInk())) {
  console.error('✗ 批注清不掉，测试前提不成立')
  process.exit(1)
}
cdp(`(() => {
  ${MK}
  page.dispatchEvent(mk('pointerdown', 51, 'pen', ${X0}, ${Y[2]}, 1));
  for (let i = 1; i <= ${MOVES}; i++) page.dispatchEvent(mk('pointermove', 51, 'pen', ${X0} + i * ${STEP}, ${Y[2]}, 1));
  page.dispatchEvent(mk('pointerup', 51, 'pen', ${X0} + ${MOVES * STEP}, ${Y[2]}, 1));
  return 'ok';
})()`)
await sleep(900)
const beforePalm = await readStrokes()
const palmRaw = cdp(`(() => {
  ${MK}
  const before = (window.__sbDraftSessions || new Map()).size;
  page.dispatchEvent(mk('pointerdown', 61, 'touch', ${X0 + 40}, ${Y[2]}, 120));
  const during = (window.__sbDraftSessions || new Map()).size;
  for (let i = 1; i <= 6; i++) page.dispatchEvent(mk('pointermove', 61, 'touch', ${X0 + 40} + i * ${STEP}, ${Y[2]}, 120));
  page.dispatchEvent(mk('pointerup', 61, 'touch', ${X0 + 70}, ${Y[2]}, 120));
  return JSON.stringify({ before, during, after: (window.__sbDraftSessions || new Map()).size });
})()`)
console.log(`   会话数（掌心不该起笔）：下笔前 ${parseObj(palmRaw)?.before} / 按下后 ${parseObj(palmRaw)?.during}`)
await sleep(1100)
const afterPalm = await readStrokes()
const pointsBefore = beforePalm.reduce((a, s) => a + s.n, 0)
const pointsAfter = afterPalm.reduce((a, s) => a + s.n, 0)
/*
 * 只对账**被擦的那条线**：总量下降可能只是因为别处正好少了一段，
 * 盯住目标线才说明掌心擦对了地方。
 *
 * ★ 参考纵坐标要取**笔迹存下来的页面坐标**（beforePalm[0].y0），
 *   不能拿派发时的 CSS 坐标去减 rect.top —— 笔迹点存的是页面坐标，
 *   两者差一个实时缩放倍率（实测 ~1.76），窗口一开小就完全对不上。
 */
const hitLineY = beforePalm[0]?.y0 ?? 0
const nearBefore = beforePalm.filter((s) => Math.abs(s.y0 - hitLineY) < 30)
const nearAfter = afterPalm.filter((s) => Math.abs(s.y0 - hitLineY) < 30)
const hitBefore = nearBefore.reduce((a, s) => a + s.n, 0)
const hitAfter = nearAfter.reduce((a, s) => a + s.n, 0)
console.log(`   擦除前 ${beforePalm.length} 条 / ${pointsBefore} 点 → 擦除后 ${afterPalm.length} 条 / ${pointsAfter} 点`)
console.log(`   被擦那条线（y0≈${hitLineY}）：${hitBefore} 点 → ${hitAfter} 点（${nearBefore.length} 段 → ${nearAfter.length} 段）`)
check(beforePalm.length === 1, '前置：先有一条完整笔迹可擦', `实际 ${beforePalm.length}`)
check(parseObj(palmRaw)?.during === 0, '掌心不产生绘画会话（不画粗线）', `during=${parseObj(palmRaw)?.during}`)
check(
  hitBefore > 0 && hitAfter < hitBefore,
  '掌心擦掉的是它盖住的那条笔迹',
  `${hitBefore} → ${hitAfter} 点`
)
check(pointsAfter < pointsBefore, '掌心真的擦掉了笔迹（总点数下降）', `${pointsBefore} → ${pointsAfter}`)

/* ============================================================
 * ⑦ 多指同时擦（橡皮模式）
 * ============================================================ */
console.log('\n⑦ 橡皮模式下两指同时擦…')
await resetScene('erase')
if (!(await clearInk())) {
  console.error('✗ 批注清不掉，测试前提不成立')
  process.exit(1)
}
/*
 * 先在两条水平线上各画一条笔迹：
 * 擦除必须在绘画模式下画，画完再切回橡皮模式（切模式会清空作图状态）。
 */
await resetScene('draw')
cdp(`(() => {
  ${MK}
  const ys = [${Y[0]}, ${Y[1]}];
  const ids = [71, 72];
  for (let k = 0; k < 2; k++) {
    page.dispatchEvent(mk('pointerdown', ids[k], 'pen', ${X0}, ys[k], 1));
    for (let i = 1; i <= ${MOVES}; i++) page.dispatchEvent(mk('pointermove', ids[k], 'pen', ${X0} + i * ${STEP}, ys[k], 1));
    page.dispatchEvent(mk('pointerup', ids[k], 'pen', ${X0} + ${MOVES * STEP}, ys[k], 1));
  }
  return 'ok';
})()`)
await sleep(900)
const twoStrokes = await readStrokes()
await resetScene('erase')
const eraseRaw = cdp(`(() => {
  ${MK}
  const ys = [${Y[0]}, ${Y[1]}];
  const ids = [81, 82];
  for (let k = 0; k < 2; k++) page.dispatchEvent(mk('pointerdown', ids[k], 'touch', ${X0 + 50}, ys[k], 12));
  const parallel = (window.__sbDraftSessions || new Map()).size;
  for (let i = 1; i <= 8; i++) {
    for (let k = 0; k < 2; k++) page.dispatchEvent(mk('pointermove', ids[k], 'touch', ${X0 + 50} + i * 4, ys[k], 12));
  }
  for (let k = 0; k < 2; k++) page.dispatchEvent(mk('pointerup', ids[k], 'touch', ${X0 + 82}, ys[k], 12));
  return JSON.stringify({ parallel });
})()`)
console.log(`   绘画会话数（擦除不该产生绘画会话）：${parseObj(eraseRaw)?.parallel}`)
await sleep(1400)
const erased = await readStrokes()
console.log(`   擦除前 ${twoStrokes.length} 条 / 每条约 ${twoStrokes[0]?.n} 点`)
console.log(`   擦除后 ${erased.length} 条：${JSON.stringify(erased.map((s) => ({ n: s.n, y0: s.y0, x0: s.x0, x1: s.x1 })))}`)
check(twoStrokes.length === 2, '前置：两条笔迹都已落库', `实际 ${twoStrokes.length}`)
check(parseObj(eraseRaw)?.parallel === 0, '橡皮模式的手指不产生绘画会话', `parallel=${parseObj(eraseRaw)?.parallel}`)
check(erased.length > twoStrokes.length, '两指同时擦：两条笔迹都被切断（条数变多）', `${twoStrokes.length} → ${erased.length}`)
check(
  erased.reduce((a, s) => a + s.n, 0) < twoStrokes.reduce((a, s) => a + s.n, 0),
  '擦除使总点数下降',
  `${twoStrokes.reduce((a, s) => a + s.n, 0)} → ${erased.reduce((a, s) => a + s.n, 0)}`
)
/*
 * 两指分别擦的是两条不同的线：两条线的碎片都应该各自留下
 * 「左边一段 + 右边一段」，即擦除点两侧都有碎片。
 *
 * ★ 参考纵坐标同样取笔迹自己的页面坐标（并按 y 排序），
 *   不拿派发用的 CSS 坐标换算 —— 差一个实时缩放倍率就对不上了。
 *   纵向窗口取 30 页面单位：相邻两条测试线只隔 100 CSS 像素，
 *   窗口开大了会把另一条线的碎片也算进来（那这项判据就没牙了）。
 */
const refLines = [...twoStrokes].sort((a, b) => a.y0 - b.y0)
const byLine = refLines.map((orig) => erased.filter((s) => Math.abs(s.y0 - orig.y0) < 30))
check(
  byLine.every((group) => group.length >= 2),
  '两条线各自被切断成 ≥ 2 段（两指各擦各的）',
  byLine.map((g, i) => `线${i + 1}: ${g.length} 段`).join(' / ')
)
/*
 * 「切断」而不是「擦掉一头」：两端的碎片都还在，只少了中间一段。
 * 只看段数会被「擦掉半条线」蒙过去（那也只剩 1 段），
 * 所以要同时要求最左与最右都还留着。
 */
check(
  byLine.every((group, i) => {
    if (!refLines[i] || group.length < 2) return false
    const left = Math.min(...group.map((s) => s.x0))
    const right = Math.max(...group.map((s) => s.x1))
    return left <= refLines[i].x0 + 2 && right >= refLines[i].x1 - 2
  }),
  '每条线只被切掉中间一段（左右两端碎片都还在）',
  byLine
    .map((g, i) => {
      if (!g.length) return `线${i + 1}: 无碎片`
      return `线${i + 1}: 原 ${refLines[i]?.x0}..${refLines[i]?.x1} → ${Math.min(...g.map((s) => s.x0))}..${Math.max(...g.map((s) => s.x1))}`
    })
    .join(' / ')
)

/* ============================================================
 * ⑧ 掌心阈值可现场标定 + 触点尺寸有记录
 * ============================================================ */
console.log('\n⑧ 掌心阈值标定与触点记录…')
await resetScene('draw')
if (!(await clearInk())) {
  console.error('✗ 批注清不掉，测试前提不成立')
  process.exit(1)
}
const calRaw = cdp(`(() => {
  ${MK}
  window.__sbSetPalmThreshold(200);
  const th = window.__sbPalmThreshold;
  // 120px 的触点：阈值 200 时不该判掌心 → 应该画出线来
  page.dispatchEvent(mk('pointerdown', 91, 'touch', ${X0}, ${Y[0]}, 120));
  for (let i = 1; i <= ${MOVES}; i++) page.dispatchEvent(mk('pointermove', 91, 'touch', ${X0} + i * ${STEP}, ${Y[0]}, 120));
  page.dispatchEvent(mk('pointerup', 91, 'touch', ${X0} + ${MOVES * STEP}, ${Y[0]}, 120));
  // 250px 的触点：超过阈值 → 判掌心，不该画出线
  page.dispatchEvent(mk('pointerdown', 92, 'touch', ${X0}, ${Y[1]}, 250));
  for (let i = 1; i <= 6; i++) page.dispatchEvent(mk('pointermove', 92, 'touch', ${X0} + i * ${STEP}, ${Y[1]}, 250));
  page.dispatchEvent(mk('pointerup', 92, 'touch', ${X0 + 30}, ${Y[1]}, 250));
  window.__sbSetPalmThreshold(44);
  const contacts = (window.__sbTouchContacts || []).slice(-8).map((c) => c.size);
  return JSON.stringify({ threshold: th, restored: window.__sbPalmThreshold, contacts }, null, 1);
})()`)
console.log(calRaw.split('\n').slice(0, 12).join('\n'))
const cal = parseObj(calRaw)
await sleep(1000)
const calStrokes = await readStrokes()
console.log(`   落库笔迹：${JSON.stringify(calStrokes.map((s) => ({ n: s.n, y0: s.y0 })))}`)
check(cal?.threshold === 200, '标定钩子 __sbSetPalmThreshold 生效', `读到 ${cal?.threshold}`)
check(cal?.restored === 44, '阈值可恢复默认（44）', `读到 ${cal?.restored}`)
check(
  Array.isArray(cal?.contacts) && cal.contacts.filter((s) => s === 120).length >= 1 && cal.contacts.filter((s) => s === 250).length >= 1,
  '触点尺寸写入 __sbTouchContacts（真机标定看得到）',
  JSON.stringify(cal?.contacts)
)
check(
  calStrokes.length === 1 && Math.abs(calStrokes[0].y0 - (Y[0] - rect.top)) < 100,
  '阈值内的粗触点当手指（画线），超过阈值的当掌心（不画线）',
  `落库 ${calStrokes.length} 条，y0=${calStrokes[0]?.y0}（期望 ≈ ${Y[0] - rect.top}）`
)

/* ============================================================
 * 收尾
 * ============================================================ */
cdp(`(() => {
  const s = window.__store.getState();
  s.setDrawMode(false);
  s.setEraserMode(false);
  void s.clearAnnotations();
  return 'ok';
})()`)
await sleep(600)

if (fails.length) {
  console.error(`\n=== 结果：未通过 ✗（${fails.length} 项）===\n  - ` + fails.join('\n  - '))
  process.exit(1)
}
console.log('\n=== 结果：全部通过 ✓（多指并写 / 中途抬指 / 上限 4 / 笔指共存 / 掌心擦除 / 多指擦除 / 阈值标定）===')
process.exit(0)
