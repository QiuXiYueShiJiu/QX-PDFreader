// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 触摸手势「误判成缩放」的回归验证（对应用户报的 bug）。
 *
 * ── 用户报的现象 ─────────────────────────────────────────────
 *   「快速滑动时页面宽度会变、适应宽度突然变成 200%」。
 *   根因在 src/renderer/src/hooks/useTouchGestures.ts：
 *   旧实现的双击判定只看两次 `touchstart` 的**落点**（相距 <30px）与间隔
 *   （<300ms），于是「连续两次快速滑动」也被当成双击 → 缩放到 200%；
 *   捏合也没有任何约束，滑动中第二根手指蹭上来就立刻改比例。
 *
 *   该文件已于 2026-10-16 重写，本脚本给这次修复上锁：
 *   把「什么才算双击/捏合」钉成可复跑的判据，同时**保住真正的双击缩放**
 *   （那是一条有用的功能，不能连它一起修没了）。
 *
 * ── 判定规则（照抄现在的实现，见 useTouchGestures.ts:34-51 / 217-259）──
 *   真轻点：按下到抬起 ≤250ms（TAP_MAX_MS）、位移 ≤10px（TAP_SLOP）、
 *           期间滚动容器位移 ≤8px（TAP_SCROLL_SLOP）、且不在惯性滑动中
 *           （距上次 scroll 事件 >250ms，SCROLL_QUIET_MS）
 *   双击  ：两次**真轻点**，抬起→落下间隔 ≤300ms（DOUBLE_TAP_MS）、
 *           落点相距 ≤30px（DOUBLE_TAP_SLOP）
 *   双击倍数：按**当前实际比例**切换 —— `current > 1.4 ? 1 : 2`
 *           （useTouchGestures.ts:252-253），所以断言必须先把状态摆到已知值，
 *           不能假定「双击一定变成 200%」。
 *   捏合  ：两指按下间隔 ≤150ms（PINCH_JOIN_MS）且不在滑动中，
 *           幅度越过 8% 死区（PINCH_DEADZONE）才真的改缩放
 *   任何一次滑动都会清掉上一拍记录（滑动与轻点拼不成双击）
 *
 * ── 检查项 ───────────────────────────────────────────────────
 *   ① 连续两次快速滑动（起点相距 10px、两次起点间隔 <300ms）→ 仍是 fit-width，
 *      且 .pdf-page 的显示宽度不变（容差 0.5px）
 *   ② 单次快速滑动 → 缩放不动
 *   ③ 真双击：把状态摆到 100%（zoom=1）后双击 → 2；再双击 → 回到 1
 *      （按当前比例切换，双向都验）【功能必须保留】
 *   ④ 需求边界：**静默后才允许**
 *      ④a 滑动后 ~180ms（还在 SCROLL_QUIET_MS=250 里）轻点一次 → 不缩放
 *      ④b 滑动后 400ms 轻点一次 → 不缩放（一次轻点不构成双击）
 *      ④c 滑动后 400ms（已静默）打**真双击** → 照常缩放（切到 200%）
 *   ⑤ 第二指晚 250ms 才按下 + 幅度 60% → 缩放不动；
 *      两指 100ms 内按下 + 越过 8% 死区 → 缩放真的变化（真捏合还有效）
 *
 * 用法：node tools/verify-touch-zoom-guard.mjs [端口]
 * 由 tools/run-verify-suite.mjs 在已启动的实例上调用（不改前台、不弹窗）。
 */

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PORT = process.argv[2] ?? '9280'

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

/**
 * 从 cdp() 的多行输出里抠出 JSON。
 * cdp-eval.mjs 对字符串原样打印、对其它类型 JSON.stringify(…, null, 2)，
 * 而页面里的诊断也会自己 JSON.stringify —— 所以按首尾括号切片最稳。
 */
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

const fails = []
let checks = 0
function check(ok, label, extra) {
  checks += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? `  —— ${extra}` : ''}`)
  if (!ok) fails.push(label)
}

/** 页面里取不到值时的兜底诊断：把原始返回截断打印，免得只看到 undefined */
function why(raw) {
  const s = String(raw).replace(/\s+/g, ' ').slice(0, 300)
  return `页面返回无法解析：${s}`
}

/* ============================================================
 * 页面侧公共片段
 * ============================================================ */

/*
 * 触摸事件工厂。
 *
 * ★ 必须真的派发到 `.viewer-scroll` 上：
 *   监听是用 addEventListener('touchstart'/'touchmove'/'touchend') 挂在
 *   那个容器上的（DocumentView.tsx:2582 → scrollRef 挂在 .viewer-scroll），
 *   派发到 document 不会触发它。
 *
 * ★ TouchEvent 的 touches/targetTouches/changedTouches 都得自己填：
 *   合成事件不会被浏览器补全，而 hook 读的正是 e.touches[0] / e.touches.length。
 *
 * ★ 用 await 的 IIFE 必须写成 `async () => {}`，否则整段脚本语法错误、
 *   cdp-eval 只会打印「表达式异常」，所有读数都会变成 undefined。
 */
const T = `
  const el = document.querySelector('.viewer-scroll');
  if (!el) throw new Error('找不到 .viewer-scroll，测试前提不成立');
  const mkTouch = (id, x, y) => new Touch({ identifier: id, target: el, clientX: x, clientY: y, pageX: x, pageY: y });
  const fire = (type, all, changed) => {
    const tt = all.map((p) => mkTouch(p.id, p.x, p.y));
    const cc = changed.map((p) => mkTouch(p.id, p.x, p.y));
    el.dispatchEvent(new TouchEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      touches: tt, targetTouches: tt, changedTouches: cc
    }));
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const readZoom = () => window.__store.getState().zoom;
`

/** 一次滑动：按下 → 位移 dx → 抬起（位移 200px 远超 TAP_SLOP=10px） */
const SWIPE = `
  const swipe = async (id, x0, y0, dx, holdMs) => {
    const start = performance.now();
    fire('touchstart', [{ id, x: x0, y: y0 }], [{ id, x: x0, y: y0 }]);
    await sleep(30);
    fire('touchmove', [{ id, x: x0 + dx, y: y0 }], [{ id, x: x0 + dx, y: y0 }]);
    await sleep(holdMs);
    fire('touchend', [], [{ id, x: x0 + dx, y: y0 }]);
    return { start: Math.round(start), end: Math.round(performance.now()), zoom: readZoom() };
  };
`

/** 一次真轻点：原地按下 → 60ms → 抬起（位移 0、时长 60ms ≤ TAP_MAX_MS） */
const TAP = `
  const tapAt = async (id, x, y) => {
    const down = performance.now();
    fire('touchstart', [{ id, x, y }], [{ id, x, y }]);
    await sleep(60);
    fire('touchend', [], [{ id, x, y }]);
    return { down: Math.round(down), up: Math.round(performance.now()), zoom: readZoom() };
  };
`

/** 当前缩放、实际比例、页码、`.pdf-page` 显示宽度 */
const READ = `
  const st = window.__store.getState();
  const pageEl = document.querySelector('.pdf-page');
  const r = pageEl ? pageEl.getBoundingClientRect() : null;
  const out = { zoom: st.zoom, actualScale: st.actualScale, page: st.page, w: r ? r.width : -1 };
`

/** 读一次渲染层状态（缩放 + 页面宽度 + 实际比例） */
function readState() {
  const raw = cdp(`(() => {
    ${READ}
    return JSON.stringify(out, null, 1);
  })()`)
  return parseObj(raw)
}

/** 复位到「适应宽度 + 第 1 页 + 滚到顶」，并等版面稳定 */
async function resetFit() {
  cdp(`(() => {
    const st = window.__store.getState();
    st.setZoom('fit-width');
    st.setPage(1);
    const v = document.querySelector('.viewer-scroll');
    if (v) { v.scrollTop = 0; v.scrollLeft = 0; }
    return 'ok';
  })()`)
  /* 缩放换档要重排 + 重渲染，等版面落定再量基准宽度 */
  await sleep(1200)
  return readState()
}

/**
 * 用测试挂钩把缩放摆到某个**已知数值档位**，等换算稳定后读数。
 *
 * 双击的目标倍数是按当前实际比例算的（>1.4 → 1，否则 → 2），
 * 所以每次双击前都得先把状态摆成确定值，断言才不是靠运气。
 */
async function setKnownZoom(value) {
  cdp(`(() => { window.__store.getState().setZoom(${value}); return 'ok'; })()`)
  await sleep(1200)
  return readState()
}

/* ============================================================
 * ① 连续两次快速滑动：这是用户报的那个场景
 * ============================================================ */
console.log('=== 触摸手势误判成缩放 回归验证 ===')
console.log(`  端口 ${PORT}\n`)

console.log('① 连续两次快速滑动（每次位移 200px、起点相距 10px、两次起点间隔 <300ms）…')
const base = await resetFit()
if (!base || base.w <= 0) {
  console.error(`✗ 量不到页面宽度（zoom=${base?.zoom} w=${base?.w}），测试前提不成立`)
  process.exit(1)
}
console.log(`   基准：zoom=${base.zoom}  页面宽度=${base.w.toFixed(1)}px  scale=${base.actualScale}`)

/*
 * 两拍滑动：每拍 touchstart → 一次 200px 的 touchmove → touchend，
 * 第二拍起点只挪 10px（<30px 的 DOUBLE_TAP_SLOP）、两次按下间隔 ~60ms
 * （<300ms 的 DOUBLE_TAP_MS）——旧实现必判双击，新实现必须无动于衷。
 */
const swipeSqRaw = cdp(`(async () => {
  ${T}
  ${SWIPE}
  const X = 400, Y = 400;
  const runs = [];
  runs.push(await swipe(11, X, Y, 200, 30));
  runs.push(await swipe(12, X + 10, Y, 200, 30));
  const r = document.querySelector('.pdf-page').getBoundingClientRect();
  return JSON.stringify({
    zoom: readZoom(),
    w: r.width,
    perSwipe: runs,
    startGap: runs[1].start - runs[0].start,
    tapSlop: 10
  }, null, 1);
})()`)
await sleep(900)
const sq = parseObj(swipeSqRaw)
const afterSq = await readState()
if (!sq) console.log(`   ${why(swipeSqRaw)}`)
console.log(`   两次按下间隔 ${sq?.startGap}ms、起点相距 ${sq?.tapSlop}px（都在旧实现的双击窗口内）`)
console.log(`   每拍滑动结束时 zoom：${JSON.stringify(sq?.perSwipe?.map((r) => r.zoom))}`)

check(
  sq && sq.startGap < 300 && sq.tapSlop < 30,
  '测试前提成立：两次滑动落在旧实现的双击窗口内（按下间隔 <300ms、起点相距 <30px）',
  `间隔 ${sq?.startGap}ms、相距 ${sq?.tapSlop}px`
)
check(
  afterSq?.zoom === 'fit-width',
  "两次快速滑动后 zoom 仍是 'fit-width'（滑动没有被当成双击）",
  `实际 ${JSON.stringify(afterSq?.zoom)}`
)
check(
  Boolean(afterSq) && Math.abs(afterSq.w - base.w) <= 0.5,
  '两次快速滑动后页面显示宽度不变（容差 0.5px）',
  `${base.w.toFixed(1)}px → ${afterSq ? afterSq.w.toFixed(1) : '?'}px`
)
check(
  Array.isArray(sq?.perSwipe) && sq.perSwipe.every((r) => r.zoom === 'fit-width'),
  '第一拍滑动结束时就已经没有缩放（不是靠第二拍才凑巧没事）',
  JSON.stringify(sq?.perSwipe?.map((r) => r.zoom))
)

/* ============================================================
 * ② 单次快速滑动
 * ============================================================ */
console.log('\n② 单次快速滑动（位移 260px）…')
const oneRaw = cdp(`(async () => {
  ${T}
  ${SWIPE}
  const r = await swipe(21, 400, 400, 260, 30);
  const rect = document.querySelector('.pdf-page').getBoundingClientRect();
  return JSON.stringify({ zoom: readZoom(), w: rect.width, hold: r.end - r.start }, null, 1);
})()`)
await sleep(700)
const afterOne = await readState()
const one = parseObj(oneRaw)
if (!one) console.log(`   ${why(oneRaw)}`)
console.log(`   滑动时长 ${one?.hold}ms、滑动结束时 zoom：${JSON.stringify(one?.zoom)}`)
check(
  afterOne?.zoom === 'fit-width',
  "单次快速滑动后 zoom 不变（仍是 'fit-width'）",
  `实际 ${JSON.stringify(afterOne?.zoom)}`
)
check(
  Boolean(afterOne) && Math.abs(afterOne.w - base.w) <= 0.5,
  '单次快速滑动后页面显示宽度不变（容差 0.5px）',
  `${base.w.toFixed(1)}px → ${afterOne ? afterOne.w.toFixed(1) : '?'}px`
)

/* ============================================================
 * ③ 真双击：功能必须保留（按当前比例在 100% / 200% 之间切换）
 * ============================================================ */
console.log('\n③ 真双击（两次真轻点，间隔 <300ms）…')
const at100 = await setKnownZoom(1)
console.log(`   先把状态摆到 100%：zoom=${JSON.stringify(at100?.zoom)}  scale=${at100?.actualScale}  页面宽度=${at100?.w?.toFixed(1)}px`)
check(
  at100?.zoom === 1,
  '测试前提成立：用测试挂钩把缩放摆到 100%（zoom === 1，实际比例 ≤1.4 → 双击该切到 2）',
  `实际 ${JSON.stringify(at100?.zoom)} scale=${at100?.actualScale}`
)

/** 在页面上连打两次真轻点（同一落点、间隔 110ms），返回读数与节奏 */
function doubleTapExpr(idA, idB) {
  return `(async () => {
  ${T}
  ${TAP}
  const X = 520, Y = 430;
  const taps = [];
  taps.push(await tapAt(${idA}, X, Y));
  await sleep(110);
  taps.push(await tapAt(${idB}, X, Y));
  const st = window.__store.getState();
  return JSON.stringify({
    zoom: st.zoom, scale: st.actualScale,
    hold: taps.map((t) => t.up - t.down),
    tapGap: taps[1].down - taps[0].up,
    tapSlop: 0
  }, null, 1);
})()`
}

const dbl1Raw = cdp(doubleTapExpr(31, 32))
await sleep(1400)
const afterDbl1 = await readState()
const dbl1 = parseObj(dbl1Raw)
if (!dbl1) console.log(`   ${why(dbl1Raw)}`)
console.log(`   第一次双击：按压 ${JSON.stringify(dbl1?.hold)}ms、抬起→落下间隔 ${dbl1?.tapGap}ms`)
check(
  dbl1 && dbl1.hold.every((h) => h <= 250) && dbl1.tapGap <= 300 && dbl1.tapSlop <= 30,
  '测试前提成立：两拍都是真轻点（按压 ≤250ms、间隔 ≤300ms、落点相同）',
  `按 ${JSON.stringify(dbl1?.hold)}ms、间隔 ${dbl1?.tapGap}ms`
)
check(
  afterDbl1?.zoom === 2,
  '真双击把缩放从 100% 切到 200%（zoom === 2）——双击缩放功能仍然有效',
  `期望 2，实际 ${JSON.stringify(afterDbl1?.zoom)}（页面内读数 ${JSON.stringify(dbl1?.zoom)}，getScale=${dbl1?.scale}）`
)
check(
  Boolean(afterDbl1) && afterDbl1.w > at100.w * 1.5,
  '真双击真的把页面显示宽度放大了（不是只改了状态）',
  `${at100?.w?.toFixed(1)}px → ${afterDbl1 ? afterDbl1.w.toFixed(1) : '?'}px`
)

const dbl2Raw = cdp(doubleTapExpr(33, 34))
await sleep(1400)
const afterDbl2 = await readState()
const dbl2 = parseObj(dbl2Raw)
if (!dbl2) console.log(`   ${why(dbl2Raw)}`)
console.log(`   第二次双击：实际比例 ${dbl2?.scale}（>1.4 → 该切回 100%），得到 zoom=${JSON.stringify(afterDbl2?.zoom)}`)
check(
  afterDbl2?.zoom === 1,
  '再双击一次切回 100%（zoom === 1）——双击是「按当前比例切换」，双向都有效',
  `期望 1，实际 ${JSON.stringify(afterDbl2?.zoom)}（页面内读数 ${JSON.stringify(dbl2?.zoom)}，getScale=${dbl2?.scale}）`
)
check(
  Boolean(afterDbl2) && Math.abs(afterDbl2.w - at100.w) <= 0.5,
  '切回 100% 后页面显示宽度回到原值（容差 0.5px）',
  `${at100?.w?.toFixed(1)}px → ${afterDbl2 ? afterDbl2.w.toFixed(1) : '?'}px`
)

/* ============================================================
 * ④ 滑动之后的轻点不会被拼成双击
 * ============================================================ */
console.log('\n④ 滑动之后紧接着的轻点不该被拼成双击…')
const late = await resetFit()

const lateTapExpr = (waitMs) => `(async () => {
  ${T}
  ${SWIPE}
  ${TAP}
  const sw = await swipe(41, 400, 400, 180, 30);
  await sleep(${waitMs});
  const tp = await tapAt(42, 400, 400);
  const rect = document.querySelector('.pdf-page').getBoundingClientRect();
  return JSON.stringify({
    zoom: readZoom(), w: rect.width,
    swipeAt: sw.start, tapAt: tp.down,
    swipeToTap: tp.down - sw.start
  }, null, 1);
})()`

/* ④a 滑动后 ~180ms 就轻点一次：这一拍在旧实现里会被拼成双击的第二拍 */
const lateARaw = cdp(lateTapExpr(120))
await sleep(900)
const afterLateA = await readState()
const lateA = parseObj(lateARaw)
if (!lateA) console.log(`   ${why(lateARaw)}`)
console.log(`   ④a 滑动起点 → 轻点 ${lateA?.swipeToTap}ms（<300ms 窗口内）`)
check(
  afterLateA?.zoom === late?.zoom,
  "④a 滑动后 180ms 内轻点一次：不缩放（滑动没被当成双击的第一拍）",
  `基准 ${JSON.stringify(late?.zoom)} → 实际 ${JSON.stringify(afterLateA?.zoom)}`
)
check(
  Boolean(afterLateA) && late && Math.abs(afterLateA.w - late.w) <= 0.5,
  '④a 该轻点不改变页面显示宽度（容差 0.5px）',
  `${late?.w?.toFixed(1)}px → ${afterLateA ? afterLateA.w.toFixed(1) : '?'}px`
)

/* ④b 滑动后等 400ms 再轻点一次：单个轻点任何时候都不该缩放 */
const lateBRaw = cdp(lateTapExpr(400))
await sleep(900)
const afterLateB = await readState()
const lateB = parseObj(lateBRaw)
if (!lateB) console.log(`   ${why(lateBRaw)}`)
console.log(`   ④b 滑动起点 → 轻点 ${lateB?.swipeToTap}ms（>400ms）`)
check(
  afterLateB?.zoom === late?.zoom,
  "④b 滑动后等 400ms 再轻点一次：不缩放（一次轻点不构成双击）",
  `基准 ${JSON.stringify(late?.zoom)} → 实际 ${JSON.stringify(afterLateB?.zoom)}`
)

/* ④c 需求边界：**静默之后才允许**
 *     滑动只是清掉上一拍记录（useTouchGestures.ts:241-245），并不禁用双击；
 *     等 SCROLL_QUIET_MS=250 过去（isScrolling() 变 false）之后，
 *     两次**真轻点**依旧构成双击（同文件 247-255）→ 必须缩放。
 *     ④a/④b 验的是「静默之前不许」，④c 验的是「静默之后允许」，
 *     两条合起来才是完整的边界，任何一边坏了这里都会红。 */
console.log('   ④c 滑动后等 400ms 再打真双击（两次真轻点）——按实现应当照常缩放…')
const at100c = await setKnownZoom(1)
const lateCRaw = cdp(`(async () => {
  ${T}
  ${SWIPE}
  ${TAP}
  const sw = await swipe(43, 400, 400, 180, 30);
  await sleep(400);
  const X = 520, Y = 430;
  const taps = [];
  taps.push(await tapAt(44, X, Y));
  await sleep(110);
  taps.push(await tapAt(45, X, Y));
  const rect = document.querySelector('.pdf-page').getBoundingClientRect();
  return JSON.stringify({
    zoom: readZoom(), w: rect.width,
    swipeToFirstTap: taps[0].down - sw.start,
    tapGap: taps[1].down - taps[0].up,
    hold: taps.map((t) => t.up - t.down)
  }, null, 1);
})()`)
await sleep(1400)
const afterLateC = await readState()
const lateC = parseObj(lateCRaw)
if (!lateC) console.log(`   ${why(lateCRaw)}`)
console.log(`   ④c 滑动起点 → 第一次轻点 ${lateC?.swipeToFirstTap}ms，两拍间隔 ${lateC?.tapGap}ms、按压 ${JSON.stringify(lateC?.hold)}ms`)
check(
  Boolean(at100c) && at100c.zoom === 1,
  '④c 测试前提成立：先摆到 100%（zoom === 1）',
  `实际 ${JSON.stringify(at100c?.zoom)}`
)
check(
  afterLateC?.zoom === 2,
  '④c 需求边界：滑动静默 400ms（>SCROLL_QUIET_MS=250）后，两次真轻点仍是双击 → 缩放切到 200%',
  `期望 2，实际 ${JSON.stringify(afterLateC?.zoom)}（页面内读数 ${JSON.stringify(lateC?.zoom)}）`
)

/* ============================================================
 * ⑤ 捏合：晚到的第二根手指不缩放，同时按下的真捏合照常缩放
 * ============================================================ */
console.log('\n⑤a 第二指晚 250ms 才按下（>PINCH_JOIN_MS=150）+ 幅度 60% → 不该缩放…')
const late2 = await resetFit()
/*
 * 两指「先后」按下后再分开 100px → 200px（100% 幅度，远超 8% 死区）。
 * 分两步派发 move，中间留出时间让可能的版面变动落定。
 */
const latePinchRaw = cdp(`(async () => {
  ${T}
  const CX = 400, CY = 400;
  const before = readZoom();
  fire('touchstart', [{ id: 51, x: CX - 50, y: CY }], [{ id: 51, x: CX - 50, y: CY }]);
  await sleep(250);
  // 第二指晚到（>PINCH_JOIN_MS=150）→ 不该被认成捏合
  fire('touchstart', [{ id: 51, x: CX - 50, y: CY }, { id: 52, x: CX + 50, y: CY }], [{ id: 52, x: CX + 50, y: CY }]);
  const joined = readZoom();
  fire('touchmove', [{ id: 51, x: CX - 80, y: CY }, { id: 52, x: CX + 80, y: CY }], [{ id: 51, x: CX - 80, y: CY }, { id: 52, x: CX + 80, y: CY }]);
  await sleep(400);
  fire('touchmove', [{ id: 51, x: CX - 130, y: CY }, { id: 52, x: CX + 130, y: CY }], [{ id: 51, x: CX - 130, y: CY }, { id: 52, x: CX + 130, y: CY }]);
  await sleep(300);
  const during = readZoom();
  fire('touchend', [{ id: 51, x: CX - 130, y: CY }], [{ id: 52, x: CX + 130, y: CY }]);
  fire('touchend', [], [{ id: 51, x: CX - 130, y: CY }]);
  const rect = document.querySelector('.pdf-page').getBoundingClientRect();
  return JSON.stringify({ before, joined, during, after: readZoom(), w: rect.width }, null, 1);
})()`)
await sleep(900)
const afterLatePinch = await readState()
const lp = parseObj(latePinchRaw)
if (!lp) console.log(`   ${why(latePinchRaw)}`)
console.log(`   zoom：按下第二指 ${JSON.stringify(lp?.joined)} → 分开到 200px 间距 ${JSON.stringify(lp?.during)} → 抬起 ${JSON.stringify(lp?.after)}`)
check(
  lp?.joined === 'fit-width' && lp?.during === 'fit-width' && afterLatePinch?.zoom === 'fit-width',
  "晚到的第二根手指不触发捏合缩放（zoom 始终 'fit-width'）",
  `joined=${JSON.stringify(lp?.joined)} during=${JSON.stringify(lp?.during)} after=${JSON.stringify(afterLatePinch?.zoom)}`
)
check(
  Boolean(afterLatePinch) && late2 && Math.abs(afterLatePinch.w - late2.w) <= 0.5,
  '晚到手指的分开动作不改变页面显示宽度（容差 0.5px）',
  `${late2?.w?.toFixed(1)}px → ${afterLatePinch ? afterLatePinch.w.toFixed(1) : '?'}px`
)

console.log('\n⑤b 两指 100ms 内按下（真捏合）+ 越过 8% 死区 → 缩放必须变化…')
const real2 = await resetFit()
const pinchRaw = cdp(`(async () => {
  ${T}
  const CX = 400, CY = 400;
  const before = readZoom();
  fire('touchstart', [{ id: 61, x: CX - 50, y: CY }], [{ id: 61, x: CX - 50, y: CY }]);
  await sleep(100);
  // 第二指 100ms 内按下（≤PINCH_JOIN_MS）→ 真捏合
  fire('touchstart', [{ id: 61, x: CX - 50, y: CY }, { id: 62, x: CX + 50, y: CY }], [{ id: 62, x: CX + 50, y: CY }]);
  const joined = readZoom();
  // 第一步：100px → 140px（+40%，越过 8% 死区）→ 这一步只「上膛」，不立刻改比例
  fire('touchmove', [{ id: 61, x: CX - 70, y: CY }, { id: 62, x: CX + 70, y: CY }], [{ id: 61, x: CX - 70, y: CY }, { id: 62, x: CX + 70, y: CY }]);
  await sleep(450);
  const armed = readZoom();
  // 第二步：140px → 176px（相对上膛点 +25.7%）→ 真的改比例
  fire('touchmove', [{ id: 61, x: CX - 88, y: CY }, { id: 62, x: CX + 88, y: CY }], [{ id: 61, x: CX - 88, y: CY }, { id: 62, x: CX + 88, y: CY }]);
  await sleep(450);
  const zoomed = readZoom();
  fire('touchend', [], [{ id: 61, x: CX - 88, y: CY }, { id: 62, x: CX + 88, y: CY }]);
  const rect = document.querySelector('.pdf-page').getBoundingClientRect();
  return JSON.stringify({ before, joined, armed, zoomed, after: readZoom(), w: rect.width }, null, 1);
})()`)
await sleep(1200)
const afterPinch = await readState()
const pr = parseObj(pinchRaw)
if (!pr) console.log(`   ${why(pinchRaw)}`)
console.log(`   zoom：基准 ${JSON.stringify(pr?.before)} → 双指按下 ${JSON.stringify(pr?.joined)} → 越过死区 ${JSON.stringify(pr?.armed)} → 继续撑开 ${JSON.stringify(pr?.zoomed)}`)
check(
  pr?.armed === 'fit-width',
  '捏合越过 8% 死区只是「上膛」，不立刻跳比例',
  `armed=${JSON.stringify(pr?.armed)}`
)
check(
  typeof pr?.zoomed === 'number' && pr.zoomed > 1.08,
  '真捏合（100ms 内两指按下 + 越过死区后继续撑开）真的把缩放改大了',
  `zoomed=${JSON.stringify(pr?.zoomed)}`
)
check(
  Boolean(afterPinch) && afterPinch.w > real2.w * 1.05,
  '真捏合真的改变了页面显示宽度',
  `${real2?.w?.toFixed(1)}px → ${afterPinch ? afterPinch.w.toFixed(1) : '?'}px`
)

/* ============================================================
 * 收尾：把缩放复位，别把状态留给下一个脚本
 * ============================================================ */
cdp(`(() => { window.__store.getState().setZoom('fit-width'); return 'ok'; })()`)
await sleep(800)

console.log(`\n=== 结果：${fails.length ? '✗ 未通过' : '✓ 全部通过'}（${checks} 项检查，失败 ${fails.length} 项）===`)
if (fails.length) {
  console.error('  - ' + fails.join('\n  - '))
  process.exit(1)
}
console.log('  ① 连续两次快速滑动不缩放 ② 单次快速滑动不缩放 ③ 真双击仍按比例切换（1↔2）')
console.log('  ④ 滑动不会被拼成双击 ⑤ 晚到手指不捏合 / 真捏合有效')
process.exit(0)
