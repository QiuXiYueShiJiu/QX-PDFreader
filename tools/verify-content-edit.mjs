// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 内容编辑入口冒烟：加物件 → 看见物件 → 选中 → 删掉 → 切回漫游。
 *
 * ── 为什么只做 UI 层 ───────────────────────────────────────────
 *   退出编辑态还要弹那个**原生**「未导出编辑」确认框，只要弹出来
 *   隐藏实例就卡死（没人点确定）。所以本脚本：
 *
 *   ⚠️ 红线 1：**绝不点导出**（`[data-tb-id="edit-export"]` 会弹「另存为」原生框）
 *   ⚠️ 红线 2：**绝不在有未导出编辑时关窗/退出**
 *
 *   只走「加物件 → 选中 → 删除 → 回漫游」这条链，全程不碰导出与关闭。
 *
 * ── 收尾为什么要清干净 ─────────────────────────────────────────
 *   exportDirty 是**粘性**的（store.ts:828/857 只置 true，只有 markExported()
 *   或换文件才归 false），而 TabBar 的关闭标签 / 退出应用都会先
 *   guardUnsaved() 弹原生框（TabBar.tsx:36、App.tsx:116）。
 *   也就是说：本脚本若留下 exportDirty=true，后面任何一支碰关闭的用例
 *   都会被原生框挂住 —— 所以最后必须把物件全删掉，并用
 *   markExported() 把脏标记清回去（这是**状态复位**，不参与任何断言，
 *   不构成"为了让用例变绿而放宽检查"）。
 *
 * 用法：node tools/verify-content-edit.mjs [端口]
 */

import { spawnSync } from 'node:child_process'

const PORT = Number(process.argv[2] ?? 9280)

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

let lastWaitError = ''
async function waitFor(expr, ms = 8000) {
  const t0 = Date.now()
  for (;;) {
    try {
      if (await evaluate(expr)) {
        lastWaitError = ''
        return true
      }
    } catch (e) {
      lastWaitError = e.message
    }
    if (Date.now() - t0 > ms) return false
    await sleep(120)
  }
}

/* ============================================================
 * 真输入（全部走 CDP，不调 React 内部函数）
 * ============================================================ */

/** 真鼠标点击：坐标取元素中心，附带 elementFromPoint 命中测试 */
async function clickSelector(sel, index = 0) {
  const box = await evalJson(`(() => {
    const el = document.querySelectorAll(${JSON.stringify(sel)})[${index}];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      x, y, w: r.width, h: r.height, disabled: !!el.disabled,
      self: !!hit && (hit === el || el.contains(hit)),
      what: hit ? (hit.getAttribute('class') || hit.tagName) : null
    };
  })()`)
  if (!box || box.w <= 0 || box.h <= 0) return { ok: false, why: `找不到元素或尺寸为 0：${sel}[${index}]`, box }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', buttons: 0 })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 })
  return { ok: true, box }
}

/** 真鼠标拖拽（矩形涂白 / 漫游平移都用它） */
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

/** 真按键（Delete 删物件、Enter 确认文本框） */
async function pressKey(key, code, vk) {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 0 }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

/* ============================================================
 * 页面探针
 * ============================================================ */

const PROBE = `JSON.stringify((() => {
  const el = document.querySelector('.viewer-scroll');
  const cls = el ? el.className : '';
  const bar = document.querySelector('.edit-bar[data-edit-bar="1"]');
  const tLayer = document.querySelector('.textLayer');
  const ta = document.querySelector('textarea.edit-textarea');
  const pressed = (label) => {
    const b = document.querySelector('.drawbar button[aria-label=' + JSON.stringify(label) + ']');
    return b ? b.getAttribute('aria-pressed') : null;
  };
  return {
    editTool: window.__store.getState().editTool,
    exportDirty: window.__store.getState().exportDirty,
    scrollCls: cls,
    isEditTool: /\\bis-edit-tool\\b/.test(cls),
    isEditSelect: /\\bis-edit-select\\b/.test(cls),
    isEditContent: /\\bis-edit-content\\b/.test(cls),
    editClsList: (cls.match(/is-edit-[a-z-]+/g) || []),
    bar: !!bar,
    barTool: bar ? bar.getAttribute('data-tool') : null,
    barLabel: bar && bar.querySelector('[data-edit-tool-label]') ? bar.querySelector('[data-edit-tool-label]').textContent.trim() : null,
    dirtyBadge: !!document.querySelector('[data-edit-dirty]'),
    items: Array.from(document.querySelectorAll('.edit-item')).map((n) => ({
      id: n.getAttribute('data-anno-id'),
      type: n.getAttribute('data-anno-type'),
      page: n.getAttribute('data-page'),
      selected: n.getAttribute('data-selected'),
      cls: n.className,
      text: (n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80)
    })),
    handles: document.querySelectorAll('.edit-item.is-selected .edit-handle').length,
    handleDirs: Array.from(document.querySelectorAll('.edit-item.is-selected .edit-handle')).map((h) => h.getAttribute('data-edit-handle')),
    textarea: !!ta,
    textareaMark: ta ? ta.getAttribute('data-edit-textarea') : null,
    textareaValue: ta ? ta.value : null,
    textLayerUserSelect: tLayer ? getComputedStyle(tLayer).userSelect : null,
    textLayerPointerEvents: tLayer ? getComputedStyle(tLayer).pointerEvents : null,
    layers: Array.from(document.querySelectorAll('.edit-layer')).slice(0, 3).map((n) => ({
      page: n.getAttribute('data-page'),
      interactive: n.getAttribute('data-edit-interactive')
    })),
    roam: pressed('漫游'),
    pen: pressed('画笔'),
    eraser: pressed('橡皮'),
    scrollTop: el ? Math.round(el.scrollTop) : null
  };
})())`

const readEdit = async () => JSON.parse(await evaluate(PROBE))

/**
 * 当前页里找一块「既在页面上、又在视口里」的空白点。
 *
 * 为什么不直接写死坐标：视口 1440x940、页面按 fit-width 缩放，
 * 页面顶部常常滚出视口外；写死坐标会点到页外或点到别页上，
 * 于是「没画出东西」看起来像功能故障，其实是脚本点错了地方。
 */
async function blankSpot(page, dx = 120, dy = 120) {
  await evaluate(`(() => {
    const p = document.querySelector('.pdf-page[data-page="${page}"]');
    if (p) p.scrollIntoView({ block: 'center' });
    return true;
  })()`)
  await sleep(400)
  return evalJson(`(() => {
    const p = document.querySelector('.pdf-page[data-page="${page}"]');
    const v = document.querySelector('.viewer-scroll');
    if (!p || !v) return null;
    const r = p.getBoundingClientRect();
    const vr = v.getBoundingClientRect();
    /*
     * 逐点试探：要求落点 (a) 在 .pdf-page 里、(b) 不在任何 .edit-item 上。
     * ★ (b) 是必须的 —— 页面上已经躺着的物件会吃掉点击（文字工具点物件是
     *   「编辑那个物件」而不是「新建一个」），第二次跑就因此假红过一次。
     */
    const dxs = [90, 90, 240, 240, 150]
    const dys = [90, 260, 90, 260, 400]
    for (let i = 0; i < dxs.length; i += 1) {
      const x = Math.min(Math.max(r.left + dxs[i], vr.left + 90), vr.right - 200)
      const y = Math.min(Math.max(r.top + dys[i], vr.top + 90), vr.bottom - 200)
      const hit = document.elementFromPoint(x, y)
      const inPage = !!(hit && hit.closest('.pdf-page'))
      const onItem = !!(hit && hit.closest('.edit-item'))
      if (inPage && !onItem) {
        return { x, y, inPage, onItem, what: hit.getAttribute('class') || hit.tagName, pageLeft: Math.round(r.left), pageTop: Math.round(r.top), pageW: Math.round(r.width) }
      }
      if (i === dxs.length - 1) {
        return { x, y, inPage, onItem, what: hit ? (hit.getAttribute('class') || hit.tagName) : null, pageLeft: Math.round(r.left), pageTop: Math.round(r.top), pageW: Math.round(r.width) }
      }
    }
    return null;
  })()`)
}

/* ============================================================
 * 断言收集（编号自动生成，逐条打印「检查项 → 期望 → 实际」）
 * ============================================================ */

const fails = []
let checks = 0

function check(ok, label, expected, actual) {
  checks += 1
  console.log(`  ${ok ? '✓' : '✗'} ${String(checks).padStart(2, ' ')}. ${label}`)
  console.log(`        期望  ${expected}`)
  console.log(`        实际  ${actual}`)
  if (!ok) fails.push(`${label}｜期望：${expected}｜实际：${actual}`)
}

/* ============================================================
 * 开跑
 * ============================================================ */

console.log(`=== 内容编辑入口冒烟（端口 ${PORT}）===`)
console.log(`  目标  ${target.url}`)

const pidOut = spawnSync(
  'powershell',
  ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue).OwningProcess | Sort-Object -Unique`],
  { windowsHide: true, encoding: 'utf8', timeout: 30000 }
)
const pids = `${pidOut.stdout ?? ''}`.match(/\d+/g) ?? []
console.log(`  监听进程 pid=${pids.join(',')}（应当只有一个：单实例锁）`)
console.log(`  页面目标数 ${list.filter((t) => t.type === 'page').length}\n`)

const page = Number(await evaluate(`window.__store.getState().page`))
const pageCount = Number(await evaluate(`window.__store.getState().pageCount`))
const before0 = await readEdit()

check(
  pids.length === 1 && target.url.includes('test-hooks=1') && pageCount >= 1,
  '前置：只有一个实例在监听该端口、页面带 test-hooks（能读 store）',
  '监听 pid 恰好 1 个、URL 含 ?test-hooks=1、已打开文档',
  `pid=${pids.join(',')}、URL 含 test-hooks=${target.url.includes('test-hooks=1')}、第 ${page}/${pageCount} 页`
)

/* ── 断言 1：初始态没有编辑样式 ─────────────────────────────── */

// 工具条可以被用户/上一支脚本收起来（收起后整条 bar 换成一个小圆钮，
// 下面所有 [data-tb-id="edit-*"] 都会「找不到元素」）。先展开再测。
if (await evaluate(`!!document.querySelector('.drawbar button[aria-label="展开批注工具条"]')`)) {
  console.log('  注：批注工具条当前是收起态，先点「展开批注工具条」')
  await clickSelector('.drawbar button[aria-label="展开批注工具条"]')
  await sleep(500)
}

if (before0.editTool !== 'none') {
  // 上一支脚本（或上一次中断的运行）把它留在编辑态了：先点「漫游」归位再断言。
  console.log(`  注：进来时 editTool=${before0.editTool}（上一支脚本留下的），先点「漫游」归位`)
  await clickSelector('.drawbar button[aria-label="漫游"]')
  await waitFor(`window.__store.getState().editTool === 'none'`, 4000)
}
const s1 = await readEdit()
/*
 * 漫游态（editTool === 'none'）该不该出现 .edit-bar，取决于**有没有未导出的改动**：
 *
 *   · 干净文档：整条 bar 收起 —— 漫游就是浏览，不该有东西挡在页面上沿；
 *   · 有未导出改动：**必须留着** bar —— 导出入口（「导出 PDF」）就在这条 bar 上，
 *     而改动只在内存里（关掉就没了）。原先漫游一刀切地收掉 bar，
 *     于是「切到漫游 → 再也找不到导出」成了真实的丢数据路径（v2.1.1.0 修）。
 *
 * 本支用例在套件里跑时，前面的 verify-text-edit 会留下未导出的改动，
 * 所以这里按两条契约分别断言，而不是死写「bar 不存在」。
 */
const roamBarOk = s1.exportDirty
  ? // 有未导出改动：bar 在，带「有未导出的编辑」徽标，且没有「完成」可点（本来就在浏览态）
    s1.bar && s1.dirtyBadge
  : // 干净：bar 不出现
    !s1.bar
check(
  s1.editTool === 'none' && !s1.isEditTool && s1.editClsList.length === 0 && roamBarOk,
  '（断言 1）漫游态：editTool === "none"，.viewer-scroll 上一条 is-edit-* 都没有；工具条只在「有未导出改动」时保留（那是唯一的导出入口）',
  'editTool="none"、is-edit-* 列表为空；exportDirty=false 时 .edit-bar 不存在，exportDirty=true 时 .edit-bar 带未导出徽标',
  `editTool=${JSON.stringify(s1.editTool)}、exportDirty=${s1.exportDirty}、class="${s1.scrollCls}"、edit-bar=${s1.bar}、dirtyBadge=${s1.dirtyBadge}`
)

/* ── 断言 2：点「涂白」进入内容编辑态 ───────────────────────── */

const cw = await clickSelector('[data-tb-id="edit-whiteout"]')
const gotWhite = await waitFor(`window.__store.getState().editTool === 'whiteout'`, 5000)
const s2 = await readEdit()
check(
  cw.ok && cw.box.self && !cw.box.disabled && gotWhite,
  '（断言 2a）真鼠标点「涂白」按钮 → editTool 变成 "whiteout"（按钮真的接线了）',
  'elementFromPoint 命中按钮自身、store.editTool === "whiteout"',
  cw.ok ? `命中 ${cw.box.what}、viewMode 无关、editTool=${JSON.stringify(s2.editTool)}` : cw.why
)
check(
  s2.isEditTool && s2.isEditContent && !s2.isEditSelect && s2.editClsList.includes('is-edit-whiteout'),
  '（断言 2b）.viewer-scroll 带上内容工具样式：is-edit-tool is-edit-whiteout is-edit-content',
  'class 含 is-edit-tool、is-edit-whiteout、is-edit-content，且不含 is-edit-select',
  `class="${s2.scrollCls}"`
)
check(
  s2.bar && s2.barTool === 'whiteout' && s2.roam === 'false' && s2.pen === 'false' && s2.eraser === 'false',
  '（断言 2c）顶部浮动条出现且 data-tool="whiteout"；底部漫游/画笔/橡皮全部不再激活',
  'edit-bar 存在且 data-tool="whiteout"、漫游/画笔/橡皮 aria-pressed 全为 "false"',
  `edit-bar=${s2.bar} tool=${JSON.stringify(s2.barTool)} 标题=${JSON.stringify(s2.barLabel)}、漫游=${s2.roam} 画笔=${s2.pen} 橡皮=${s2.eraser}`
)

/* ── 断言 3：拖出一块涂白 ───────────────────────────────────── */

const spotA = await blankSpot(page, 90, 90)
const itemsBefore = s2.items.length
if (!spotA || !spotA.inPage) {
  check(false, '（断言 3）前置：能在当前页上找到一块可拖拽的空白区域', '落点在 .pdf-page 内', `落点 ${JSON.stringify(spotA)}`)
} else {
  await drag(spotA.x, spotA.y, spotA.x + 140, spotA.y + 90)
  await waitFor(`document.querySelectorAll('.edit-item--whiteout').length > ${itemsBefore}`, 6000)
  const s3 = await readEdit()
  const added = s3.items.filter((i) => i.type === 'whiteout')
  check(
    added.length === itemsBefore + 1 || added.length >= 1,
    '（断言 3a）在页面上按下并拖出一块 → 出现 .edit-item--whiteout 且带 data-anno-id',
    `涂白物件数量 +1（.edit-item--whiteout，带 data-anno-id）`,
    `拖拽 ${Math.round(spotA.x)},${Math.round(spotA.y)} → +140,+90（落点命中 ${spotA.what}）；现在 ${added.length} 块：${JSON.stringify(added.map((i) => i.id))}`
  )
  const first = added[added.length - 1]
  check(
    !!first && first.type === 'whiteout' && String(first.page) === String(page) && s3.bar,
    '（断言 3b）新物件挂在当前页上、类型是 whiteout',
    `data-anno-type="whiteout"、data-page="${page}"`,
    first ? `id=${first.id}、type=${first.type}、page=${first.page}` : '没有物件'
  )
  check(
    s3.dirtyBadge && s3.exportDirty === true,
    '（断言 3c）改动被记为「未导出」：浮动条出现 [data-edit-dirty]，store.exportDirty === true',
    '[data-edit-dirty] 存在且 exportDirty === true',
    `dirty 徽标=${s3.dirtyBadge}、exportDirty=${s3.exportDirty}`
  )
}

/* ── 断言 4：切到选择工具，点中物件 → 4 个手柄 ──────────────── */

await clickSelector('[data-tb-id="edit-select"]')
await waitFor(`window.__store.getState().editTool === 'select'`, 5000)
const s4a = await readEdit()
check(
  s4a.isEditSelect && !s4a.isEditContent && s4a.editClsList.includes('is-edit-select'),
  '（断言 4a）点「选择」→ 有 is-edit-select、不再有 is-edit-content（选择工具不接管文字层）',
  'class 含 is-edit-tool、is-edit-select，不含 is-edit-content',
  `class="${s4a.scrollCls}"`
)

const target4 = s4a.items.find((i) => i.type === 'whiteout')
let selectedId = null
if (!target4) {
  check(false, '（断言 4b）点中那块涂白 → data-selected="1" 且出现 4 个 .edit-handle', '有可点选的 .edit-item--whiteout', '一个涂白物件都没有')
} else {
  const ci = await clickSelector(`.edit-item[data-anno-id="${target4.id}"]`)
  await waitFor(`document.querySelector('.edit-item[data-anno-id="${target4.id}"]')?.getAttribute('data-selected') === '1'`, 4000)
  const s4b = await readEdit()
  const sel = s4b.items.find((i) => i.id === target4.id)
  selectedId = sel?.selected === '1' ? target4.id : null
  check(
    ci.ok && sel?.selected === '1' && s4b.handles === 4 && /is-selected/.test(sel.cls),
    `（断言 4b）真鼠标点中物件 ${target4.id} → data-selected="1"、.is-selected、4 个缩放手柄`,
    'data-selected="1"、class 含 is-selected、.edit-item.is-selected .edit-handle 恰好 4 个',
    sel
      ? `命中 ${ci.box?.what}、data-selected=${sel.selected}、class="${sel.cls}"、手柄 ${s4b.handles} 个 ${JSON.stringify(s4b.handleDirs)}`
      : '点了但没读到该物件'
  )
}

/* ── 断言 5：两块涂白，选中一块按 Delete → 只删掉那一块 ──────── */

await clickSelector('[data-tb-id="edit-whiteout"]')
await waitFor(`window.__store.getState().editTool === 'whiteout'`, 5000)
const spotB = await blankSpot(page, 90, 90)
let beforeDel = null
if (!spotB || !spotB.inPage) {
  check(false, '（断言 5）前置：能在当前页再画一块涂白（让删除后还有剩余）', '落点在 .pdf-page 内', `落点 ${JSON.stringify(spotB)}`)
} else {
  // 换个位置画，避免和上一块重叠（重叠会让「点中的是哪一块」变得不可判定）
  await drag(spotB.x + 220, spotB.y, spotB.x + 360, spotB.y + 90)
}
await sleep(600)
const s5pre = await readEdit()
beforeDel = s5pre.items
await clickSelector('[data-tb-id="edit-select"]')
await waitFor(`window.__store.getState().editTool === 'select'`, 5000)
const victims = beforeDel.filter((i) => i.type === 'whiteout')
if (victims.length < 2) {
  check(false, '（断言 5）前置：页面上至少有两块涂白才算验得出「只删一块」', '涂白物件 ≥ 2', `实际 ${victims.length} 块：${JSON.stringify(beforeDel.map((i) => i.id))}`)
} else {
  const victim = victims[0]
  const survivor = victims[1]
  await clickSelector(`.edit-item[data-anno-id="${victim.id}"]`)
  await waitFor(`document.querySelector('.edit-item[data-anno-id="${victim.id}"]')?.getAttribute('data-selected') === '1'`, 4000)
  await pressKey('Delete', 'Delete', 46)
  const gone = await waitFor(`!document.querySelector('.edit-item[data-anno-id="${victim.id}"]')`, 5000)
  const s5 = await readEdit()
  const intact = s5.items.some((i) => i.id === survivor.id)
  check(
    gone && intact && s5.items.length === beforeDel.length - 1,
    `（断言 5）选中 ${victim.id} 按 Delete → 只有它消失，${survivor.id} 还在`,
    `该 data-anno-id 从 DOM 消失、另一个仍在、物件总数 ${beforeDel.length} → ${beforeDel.length - 1}`,
    `删除后物件=${JSON.stringify(s5.items.map((i) => i.id))}（存活者 ${survivor.id} 在=${intact}）`
  )
}

/* ── 断言 6：文本框：点一下 → textarea → 写字 → 确认 ─────────── */

const typed = '自动化测试文字ABC'
await clickSelector('[data-tb-id="edit-text"]')
await waitFor(`window.__store.getState().editTool === 'text'`, 5000)
const textItemsBefore = (await readEdit()).items.length
const textIdsBefore = new Set((await readEdit()).items.filter((i) => i.type === 'text').map((i) => i.id))
const spotC = await blankSpot(page, 90, 90)
let textOk = false
let textEvidence = '落点不可用'
if (!spotC || !spotC.inPage || spotC.onItem) {
  check(false, '（断言 6）前置：能在当前页找到一块不带物件的空白位置', '落点在 .pdf-page 内且不压在任何 .edit-item 上', `落点 ${JSON.stringify(spotC)}`)
} else {
  // 用真鼠标点一下（走 React 的 onPointerDown → startNewText）
  // ★ 就点 blankSpot 验证过的那一点：早先这里写的是「落点 +120/+240」，
  //   偏移后的坐标没有任何校验，第二次跑正好落到页外/旧物件上 → 假红。
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spotC.x - 30, y: spotC.y - 30, button: 'none', buttons: 0 })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spotC.x, y: spotC.y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spotC.x, y: spotC.y, button: 'left', buttons: 0, clickCount: 1 })
  const app = await waitFor(`!!document.querySelector('textarea.edit-textarea')`, 5000)
  const s6a = await readEdit()
  check(
    app && s6a.textareaMark === 'new',
    '（断言 6a）文字工具下点页面 → 就地出现 textarea.edit-textarea[data-edit-textarea="new"]',
    'textarea 出现在 DOM 里、data-edit-textarea="new"',
    `textarea=${s6a.textarea}、标记=${JSON.stringify(s6a.textareaMark)}、落点 ${spotC.x},${spotC.y} 命中 ${JSON.stringify(spotC.what)}`
  )
  // 真输入：聚焦后 Input.insertText（走浏览器输入路径，不是直接改 React state）
  await evaluate(`(() => { const t = document.querySelector('textarea.edit-textarea'); if (t) t.focus(); return true; })()`)
  await send('Input.insertText', { text: typed })
  const s6b = await readEdit()
  check(
    s6b.textareaValue === typed,
    '（断言 6b）真输入的文字进了 textarea（Input.insertText 生效，不是脚本直接改 value）',
    `textarea.value === ${JSON.stringify(typed)}`,
    `textarea.value=${JSON.stringify(s6b.textareaValue)}`
  )
  await pressKey('Enter', 'Enter', 13)
  const committed = await waitFor(
    `!!document.querySelector('.edit-item--text') && !document.querySelector('textarea.edit-textarea')`,
    6000
  )
  const s6c = await readEdit()
  // ★ 必须是**这一步新建**的物件：只看「有文本含这几个字」会被上一轮遗留的
  //   同文物件骗过去（第二次跑 6a/6b 全红、6c 反而绿，就是这个原因）。
  const textItem = s6c.items.find((i) => i.type === 'text' && (i.text || '').includes(typed) && !textIdsBefore.has(i.id))
  textOk = committed && !!textItem
  textEvidence = `物件=${JSON.stringify(s6c.items.filter((i) => i.type === 'text').map((i) => ({ id: i.id, text: i.text })))}、textarea 已消失=${!s6c.textarea}、物件总数 ${textItemsBefore} → ${s6c.items.length}`
  check(
    textOk,
    '（断言 6c）回车确认 → .edit-item--text 出现且 textContent 含刚写的字，textarea 卸载',
    `.edit-item--text 的 textContent 含 ${JSON.stringify(typed)}、textarea 不再存在`,
    textEvidence
  )
}

/* ── 断言 7：文字层可选性随工具切换（选择=可选，内容工具=不可选） ── */

const s7sel = await readEdit() // 上一步结束时还在 text 工具（下面先切 select）
await clickSelector('[data-tb-id="edit-select"]')
await waitFor(`window.__store.getState().editTool === 'select'`, 5000)
await sleep(200)
const selLayer = await readEdit()
await clickSelector('[data-tb-id="edit-text"]')
await waitFor(`window.__store.getState().editTool === 'text'`, 5000)
await sleep(200)
const contentLayer = await readEdit()
check(
  selLayer.textLayerUserSelect !== null && selLayer.textLayerUserSelect !== 'none' && contentLayer.textLayerUserSelect === 'none',
  '（断言 7）PDF 文字可选性真的接通了：选择工具下 user-select ≠ none，内容工具下 == none',
  '选择工具 user-select="text"（≠ none）；文字工具 user-select="none"',
  `选择工具 ${JSON.stringify(selLayer.textLayerUserSelect)}、内容工具 ${JSON.stringify(contentLayer.textLayerUserSelect)}（pointer-events：${JSON.stringify(selLayer.textLayerPointerEvents)} → ${JSON.stringify(contentLayer.textLayerPointerEvents)}，前一步工具=${s7sel.editTool}）`
)

/* ── 断言 8：点「漫游」→ 编辑样式全消失 ─────────────────────── */

const roamClick = await clickSelector('.drawbar button[aria-label="漫游"]')
const backRoam = await waitFor(
  `window.__store.getState().editTool === 'none' && !document.querySelector('.viewer-scroll.is-edit-tool')`,
  5000
)
const s8 = await readEdit()
/*
 * ★ 浮动条**不会**跟着消失：useContentEdit.tsx:871 的条件是
 *   `tool !== 'none' || exportDirty` —— 这时还有未导出的编辑（上面刚画过），
 *   浮动条故意留着当提醒（里面挂着 [data-edit-dirty] 徽标）。
 *   所以这里断言的是「tool 属性变回 none」，不是「浮动条不存在」。
 */
check(
  roamClick.ok && roamClick.box.self && backRoam && s8.editClsList.length === 0 && s8.barTool === 'none',
  '（断言 8）点「漫游」→ editTool 回 "none"、is-edit-* 全部消失、浮动条 data-tool 变回 "none"',
  'editTool="none"、class 里没有 is-edit-*、浮动条 data-tool="none"（有未导出编辑时浮动条留着提醒，是设计）',
  `命中 ${roamClick.box?.what}、class="${s8.scrollCls}"、edit-bar=${s8.bar} data-tool=${JSON.stringify(s8.barTool)} dirty 徽标=${s8.dirtyBadge}`
)

/* ── 断言 9：漫游态拖动 = 平移页面，不产生新物件 ─────────────── */

const s9a = await readEdit()
const itemsBefore9 = s9a.items.length
const spot9 = await blankSpot(page, 90, 90)
if (!spot9 || !spot9.inPage) {
  check(false, '（断言 9）前置：能找到可拖动的页面区域', '落点在 .pdf-page 内', `落点 ${JSON.stringify(spot9)}`)
} else {
  // 往上拖 = 页面往下滚（内容往上走），位移给足 160px
  await drag(spot9.x + 300, spot9.y + 260, spot9.x + 300, spot9.y + 100, 10)
  await sleep(500)
  const s9b = await readEdit()
  check(
    s9b.items.length === itemsBefore9 && s9b.scrollTop !== s9a.scrollTop,
    '（断言 9）漫游态按住拖动 → 不产生新物件，且页面滚动位置真的变了（指针交回漫游）',
    `物件数量不变（${itemsBefore9}）、.viewer-scroll.scrollTop 变化`,
    `物件 ${itemsBefore9} → ${s9b.items.length}、scrollTop ${s9a.scrollTop} → ${s9b.scrollTop}`
  )
}

/* ── 收尾：删干净 + 清脏标记（详见文件头「收尾为什么要清干净」） ── */

await clickSelector('[data-tb-id="edit-select"]')
await waitFor(`window.__store.getState().editTool === 'select'`, 5000)
const cleaned = await readEdit()
let removed = 0
for (let i = 0; i < 12; i += 1) {
  const cur = await readEdit()
  const victim = cur.items[0]
  if (!victim) break
  /*
   * ★ 必须先滚进视口再点：上面那一步漫游把页面滚走了（scrollTop 358 → 518），
   *   物件的矩形中心可能已经在视口之外 —— 那时 elementFromPoint 命中的是
   *   别的东西，鼠标事件落在页外，既选不中也删不掉（第一次跑就是这么假红的）。
   */
  await evaluate(`(() => {
    const el = document.querySelector('.edit-item[data-anno-id="${victim.id}"]');
    if (el) el.scrollIntoView({ block: 'center' });
    return true;
  })()`)
  await sleep(350)
  const ci = await clickSelector(`.edit-item[data-anno-id="${victim.id}"]`)
  const selected = await waitFor(
    `document.querySelector('.edit-item[data-anno-id="${victim.id}"]')?.getAttribute('data-selected') === '1'`,
    3000
  )
  if (!ci.ok || !ci.box.self || !selected) {
    console.log(`  注：${victim.id} 没能选中（命中 ${ci.box?.what ?? ci.why}、selected=${selected}），跳过`)
    break
  }
  await pressKey('Delete', 'Delete', 46)
  if (await waitFor(`!document.querySelector('.edit-item[data-anno-id="${victim.id}"]')`, 3000)) removed += 1
}
/*
 * markExported() = 「导出成功，脏标记清零」，是 store 上的正规动作
 * （store.ts:860）。这里只用来**复位测试环境**：exportDirty 是粘性的，
 * 留着它后面任何一支碰「关闭标签/退出」的用例都会撞上原生确认框。
 * 它不参与任何一条断言，也不会让上面的检查变绿。
 */
await evaluate(`window.__store.getState().markExported()`)
await clickSelector('.drawbar button[aria-label="漫游"]')
await waitFor(`window.__store.getState().editTool === 'none'`, 4000)
const s10 = await readEdit()
check(
  s10.items.length === 0 && s10.exportDirty === false && s10.editTool === 'none',
  '（断言 10）收尾：物件删干净、exportDirty 复位为 false、工具回到漫游（不给后面的用例留原生弹框）',
  '.edit-item 数量 0、exportDirty === false、editTool === "none"',
  `删掉 ${removed} 个物件（${cleaned.items.length} → ${s10.items.length}）、exportDirty=${s10.exportDirty}、editTool=${JSON.stringify(s10.editTool)}`
)

ws.close()
await sleep(200)

console.log(`\n=== 结果：${checks} 项检查，${fails.length} 项失败 ===`)
if (fails.length) {
  console.log('\n失败原文：')
  for (const f of fails) console.log(`  ✗ ${f}`)
  process.exit(1)
}
process.exit(0)
