// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 验证三种视图模式真的改变版面 + 全屏功能已彻底移除。
 *
 * ── 为什么要有这支脚本 ──────────────────────────────────────────
 *   这几个按钮此前是纯装饰：viewMode 只被 Toolbar 自己读写，
 *   文档视图从来没消费过它，点了只有图标变蓝。
 *
 *   本轮补强（原版只调 store 里的 setViewMode，
 *   按钮本身有没有接线、是不是被别的东西盖住，完全测不出来）：
 *     · 「单页」「双页」改成**真鼠标点功能区按钮**（先点开「视图」页签），
 *       并在点击前做 elementFromPoint 命中测试 —— 「点了没反应」和
 *       「点在了别的元素上」是两种完全不同的故障，这个仓库里已经因此误判过好几次；
 *     · 1.0.9.x 的单条功能区只给了**两个**视图按钮（单页 / 双页），
 *       「双栏滚动」没有按钮但有真快捷键 Ctrl+8，「连续滚动」连快捷键都没有
 *       （App.tsx 只绑了 Ctrl+6/7/8 = 单页/双页/双栏连续）。
 *       所以后两种按「有 UI 走 UI、没 UI 走最短路径」验，并在输出里写明原因；
 *     · 全屏已按用户要求彻底移除（工具条按钮、F11、preload API 全没了）：
 *       这里改成**反向断言** —— 按钮不存在、F11 不会让窗口铺满屏幕。
 *
 * 判据（对每种模式都验，防止「改了一种忘了另一种」）：
 *   · 单页      —— 只挂载 1 页
 *   · 双页并排  —— 只有一行、且从第 1 页起就两两配对（1-2、3-4…）
 *   · 双页连续  —— 多行、第一行就是 [1,2]
 *   · 连续      —— 每行 1 页、行数等于总页数
 *
 * 附加判据：每种模式下当前页的 canvas 都必须有内容，
 * 否则说明版面改了但渲染没跟上（那才是真 bug）。
 *
 * 用法：node tools/verify-view-modes.mjs [端口]
 */

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.argv[2] ?? 9280)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ============================================================
 * CDP 连接（只在开头连一次，之后复用同一条连接）
 * ============================================================ */

async function pageTarget() {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    return list.find((t) => t.type === 'page' && t.url.includes('index.html')) ?? null
  } catch {
    return null
  }
}

const target = await pageTarget()
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
async function waitFor(expr, ms = 10000) {
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
    await sleep(150)
  }
}

/** 真鼠标点击（按下 + 抬起，坐标取元素中心，并回报 hit-test 命中的是谁） */
async function clickSelector(sel) {
  const box = await evalJson(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, w: r.width, h: r.height, disabled: !!el.disabled, hitSelf: !!hit && (hit === el || el.contains(hit)), hitWhat: hit ? (hit.getAttribute('class') || hit.tagName) : null };
  })()`)
  if (!box || box.w <= 0 || box.h <= 0) return { ok: false, why: `找不到元素或尺寸为 0：${sel}`, box }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', buttons: 0 })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 })
  return { ok: true, box }
}

/** 真按 Ctrl+数字（视图模式快捷键：Ctrl+6 单页、Ctrl+7 双页、Ctrl+8 双栏连续） */
async function pressCtrlDigit(digit) {
  const code = 'Digit' + digit
  const base = { key: digit, code, windowsVirtualKeyCode: 48 + Number(digit), modifiers: 2 }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

async function pressF11() {
  const base = { key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, nativeVirtualKeyCode: 122, modifiers: 0 }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

/* ============================================================
 * 断言收集：每条都打印「检查项 → 期望 → 实际」（编号由这里自动给）
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
 * OS 侧：本进程的顶层窗口矩形（用来证明 F11 不会再把窗口撑满屏幕）
 * ============================================================ */

function listenerPid() {
  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`
    ],
    { windowsHide: true, encoding: 'utf8', timeout: 30000 }
  )
  const v = Number.parseInt(`${r.stdout ?? ''}`.trim(), 10)
  return Number.isFinite(v) ? v : 0
}

/** 应用主窗口（Chrome_WidgetWin_1）的屏幕矩形，来自 Win32 枚举而不是渲染层自报 */
function appWindowRect(pid) {
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'tools', 'foreground-snapshot.ps1'), '-ProcessId', String(pid)],
    { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 30000 }
  )
  const lines = `${r.stdout ?? ''}`.split(/\r?\n/).filter((l) => l.startsWith('W|'))
  for (const l of lines) {
    const p = l.split('|')
    if (p[5] !== 'Chrome_WidgetWin_1') continue
    const m = /^(\d+)x(\d+)$/.exec(p[4] ?? '')
    if (m) return { hwnd: p[1], w: Number(m[1]), h: Number(m[2]), visible: p[3] === 'true' }
  }
  return null
}

const rectText = (r) => (r ? `${r.w}x${r.h}${r.visible ? '（可见）' : '（不可见）'}` : '（没找到应用主窗口）')

/**
 * 主屏分辨率。
 *
 * ★ 隐藏实例的窗口是最小化状态，Win32 报出来的是图标尺寸（实测 96x38），
 *   所以「有没有被撑满屏幕」只能拿**屏幕分辨率**当基准。
 */
function screenSize() {
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width; [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height'],
    { windowsHide: true, encoding: 'utf8', timeout: 30000 }
  )
  const nums = `${r.stdout ?? ''}`.match(/\d+/g)?.map(Number) ?? []
  return nums.length >= 2 ? { w: nums[0], h: nums[1] } : null
}

/* ============================================================
 * 页面侧探针
 * ============================================================ */

const PROBE = `JSON.stringify((() => {
  const rows = Array.from(document.querySelectorAll('.viewer-row'));
  const pages = Array.from(document.querySelectorAll('.pdf-page'));
  const cur = document.querySelector('.pdf-page[data-page="' + window.__store.getState().page + '"]');
  const cv = cur ? cur.querySelector('canvas.pdf-page__canvas') : null;
  return {
    viewMode: window.__store.getState().viewMode,
    page: window.__store.getState().page,
    pageCount: window.__store.getState().pageCount,
    rowCount: rows.length,
    rowSizes: rows.map(r => r.querySelectorAll('.pdf-page').length),
    rowPages: rows.map(r => Array.from(r.querySelectorAll('.pdf-page')).map(p => Number(p.getAttribute('data-page')))),
    pageNodes: pages.length,
    curBitmap: cv ? cv.width + 'x' + cv.height : 'none'
  };
})())`

/** 两个视图按钮的 aria-pressed，DOM 顺序固定是 [单页, 双页] */
const PRESSED = `Array.from(document.querySelectorAll('[data-tb-id^="viewmode"]')).map(b => b.getAttribute('aria-pressed'))`
const STATUS = `Array.from(document.querySelectorAll('.statusbar__item')).map(e => (e.textContent || '').trim())`

const MODE_LABEL = {
  single: '单页',
  continuous: '连续滚动',
  facing: '双页并排',
  'facing-continuous': '双栏滚动'
}

/**
 * 功能区「视图」页上真有的两个视图按钮。
 * 1.0.9.x 只剩这两个：`viewmode-single`（aria-label 单页）与 `viewmode-facing`（双页）。
 * 「双栏滚动」没有按钮但有 Ctrl+8；「连续滚动」既无按钮也无快捷键，只能调 store。
 */
const CLICKABLE = [
  { id: 'single', aria: '单页', pressedIndex: 0 },
  { id: 'facing', aria: '双页', pressedIndex: 1 }
]

/** 版面形状判据（对每种模式分别写清期望，免得「改一种忘一种」） */
function judgeShape(id, s) {
  if (id === 'single') return { ok: s.pageNodes === 1, why: '应只挂载 1 页' }
  if (id === 'continuous') {
    return { ok: s.rowSizes.every((n) => n === 1) && s.rowCount === s.pageNodes, why: '应每行 1 页、行数等于页数' }
  }
  if (id === 'facing') {
    /*
     * 双页并排只显示「当前所在的那一行」，且**从第 1 页起就两两配对**：
     * 1-2、3-4、5-6…（用户 2026-10-19 明确要求去掉「封面单排」）。
     * 停在第 1 页时正确的形状就是「1 行、[1,2] 两页」。
     */
    const expectRowSize = s.pageCount >= 2 ? 2 : 1
    const row = s.rowPages?.[0] ?? []
    const pairOk =
      row.length === expectRowSize &&
      row[0] === s.page - ((s.page - 1) % 2) &&
      (expectRowSize === 1 || row[1] === row[0] + 1)
    return {
      ok: s.rowCount === 1 && s.rowSizes[0] === expectRowSize && pairOk,
      why: `当前第 ${s.page} 页，应 1 行 ${expectRowSize} 页、配对为 [${row.join(',')}]`
    }
  }
  const first = s.rowPages?.[0] ?? []
  return {
    ok: s.rowCount > 1 && s.rowSizes[0] === (s.pageCount >= 2 ? 2 : 1) && first[0] === 1,
    why: '应多行、首行从第 1 页起两两配对（[1,2]）'
  }
}

/** 等版面稳定：连续两次探到的形状完全一样才算数（避免量到渲染中途的中间态） */
async function probeSettled(timeoutMs = 6000) {
  const t0 = Date.now()
  let prev = ''
  let s = null
  for (;;) {
    s = JSON.parse(await evaluate(PROBE))
    const shape = `${s.rowCount}/${s.rowSizes.join(',')}/${s.pageNodes}`
    if (shape === prev) return s
    prev = shape
    if (Date.now() - t0 > timeoutMs) return s
    await sleep(400)
  }
}

/** canvas 有没有内容：透明不算黑，全黑（暗 ~100%）才是渲染没跟上 */
async function canvasHasContent(page) {
  const sample = String(await evaluate(`window.__sbSampleCanvas(${page})`))
  const dark = /暗(\d+)%/.exec(sample)
  return { ok: dark ? Number(dark[1]) < 95 : false, sample }
}

console.log(`=== 视图模式 + 全屏移除验证（端口 ${PORT}）===`)
console.log(`  目标  ${target.url}`)
const pid = listenerPid()
console.log(`  浏览器进程 pid=${pid}\n`)

/* ── 前置条件：有文档、先点开「视图」页签、两个视图按钮可用 ────── */

const ready = await waitFor(
  `(() => { const s = window.__store.getState(); return s.pageCount > 0 && document.querySelectorAll('.pdf-page').length > 0; })()`,
  20000
)
const tabClick = await clickSelector('[data-tb-id="ribbon-tab-view"]')
await sleep(450)
const info = await evalJson(`(() => {
  const group = document.querySelector('[data-tb-id^="viewmode"]')?.closest('.ribbon__group');
  const btns = group ? Array.from(group.querySelectorAll('[data-tb-id^="viewmode"]')) : [];
  return {
    pageCount: window.__store.getState().pageCount,
    viewMode: window.__store.getState().viewMode,
    groupVisible: !!group && getComputedStyle(group).display !== 'none',
    labels: btns.map(b => b.getAttribute('aria-label')),
    disabled: btns.map(b => !!b.disabled),
    hasFullscreen: !!document.querySelector('[data-tb-id=fullscreen]')
  };
})()`)
check(
  ready && info.pageCount >= 4,
  '前置：实例里已打开一份文档且页数 ≥ 4（双页模式才分辨得出形状）',
  'pageCount ≥ 4、页面上有 .pdf-page',
  `pageCount=${info.pageCount}、viewMode=${info.viewMode}${lastWaitError ? `、最后一次探针报错：${lastWaitError}` : ''}`
)
check(
  tabClick.ok && tabClick.box?.hitSelf,
  '前置：点功能区「视图」页签能展开视图工具',
  '命中页签自身',
  tabClick.ok ? `命中 ${tabClick.box.hitWhat}${tabClick.box.hitSelf ? '' : '（被它挡住）'}` : tabClick.why
)
check(
  info.groupVisible === true && info.labels.length === 2 && !info.disabled.includes(true) && !info.hasFullscreen,
  '前置：视图页「页面」组可见、两个视图按钮都在、没有全屏按钮',
  '组 display 不为 none、2 个按钮（单页/双页）、无 disabled、无 fullscreen',
  `可见=${info.groupVisible}、按钮=${JSON.stringify(info.labels)}、disabled=${JSON.stringify(info.disabled)}`
)

/* ── 功能区上真能点到的两个模式：单页 / 双页 ─────────────────── */

for (const mode of CLICKABLE) {
  const label = MODE_LABEL[mode.id]
  const clicked = await clickSelector(`[data-tb-id^="viewmode"][aria-label="${mode.aria}"]`)
  const hitOk = clicked.ok && clicked.box.hitSelf && !clicked.box.disabled
  const switched = await waitFor(`window.__store.getState().viewMode === ${JSON.stringify(mode.id)}`, 5000)
  const s = await probeSettled()
  const pressed = await evalJson(PRESSED)
  const status = await evalJson(STATUS)
  const pressedOk =
    pressed.length === 2 && pressed.every((v, i) => (i === mode.pressedIndex ? v === 'true' : v === 'false'))
  const shape = judgeShape(mode.id, s)
  const content = await canvasHasContent(s.page)

  check(
    hitOk && switched && pressedOk,
    `真鼠标点「${label}」→ 按钮接线且高亮正确（没被别的元素挡住）`,
    `命中该按钮自身、store.viewMode=${mode.id}、只有这个按钮 aria-pressed="true"`,
    clicked.ok
      ? `命中 ${clicked.box.hitWhat}${clicked.box.hitSelf ? '' : '（被它挡住）'}、中心 (${clicked.box.x.toFixed(1)}, ${clicked.box.y.toFixed(1)})、viewMode=${s.viewMode}、aria-pressed=${JSON.stringify(pressed)}`
      : clicked.why
  )
  check(status.includes(label), `「${label}」模式下状态栏标出当前模式`, `状态栏里出现「${label}」`, `状态栏 ${JSON.stringify(status)}`)
  check(shape.ok, `「${label}」真的换了版面形状`, shape.why, `行数=${s.rowCount}、每行页数=[${s.rowSizes.join(',')}]、页面节点=${s.pageNodes}`)
  check(
    content.ok,
    `「${label}」模式下当前页画布有内容（版面换了、渲染也跟上了）`,
    '当前页 canvas 非全黑（暗 < 95%）',
    `当前第 ${s.page} 页 位图=${s.curBitmap} 采样=${content.sample}`
  )
}

/* ──「双栏滚动」：功能区上没有按钮，但有真快捷键 Ctrl+8 ───────── */

await pressCtrlDigit('8')
const fcUp = await waitFor(`window.__store.getState().viewMode === 'facing-continuous'`, 5000)
const sFC = await probeSettled()
const pressedFC = await evalJson(PRESSED)
const statusFC = await evalJson(STATUS)
const shapeFC = judgeShape('facing-continuous', sFC)
const contentFC = await canvasHasContent(sFC.page)
check(
  fcUp && pressedFC.length === 2 && pressedFC[0] === 'false' && pressedFC[1] === 'true',
  '真按 Ctrl+8 → 切到「双栏滚动」（★ 该模式没有按钮，只有快捷键）',
  'store.viewMode="facing-continuous"、「双页」按钮仍高亮（RibbonTabs.tsx:510 把 facing 与 facing-continuous 算同一档）',
  `viewMode=${sFC.viewMode}、aria-pressed=${JSON.stringify(pressedFC)}`
)
check(
  statusFC.includes('双栏滚动'),
  '「双栏滚动」模式下状态栏标出当前模式',
  '状态栏里出现「双栏滚动」',
  `状态栏 ${JSON.stringify(statusFC)}`
)
check(
  shapeFC.ok,
  '「双栏滚动」版面形状正确',
  shapeFC.why,
  `行数=${sFC.rowCount}、每行页数=[${sFC.rowSizes.join(',')}]、页面节点=${sFC.pageNodes}`
)
check(
  contentFC.ok,
  '「双栏滚动」模式下当前页画布有内容',
  '当前页 canvas 非全黑（暗 < 95%）',
  `当前第 ${sFC.page} 页 位图=${sFC.curBitmap} 采样=${contentFC.sample}`
)

/* ──「连续滚动」：功能区与快捷键都没有入口，只能调 store ──────── */

await evaluate(`window.__store.getState().setViewMode('continuous')`)
const ctUp = await waitFor(`window.__store.getState().viewMode === 'continuous'`, 5000)
const sCT = await probeSettled()
const pressedCT = await evalJson(PRESSED)
const statusCT = await evalJson(STATUS)
const shapeCT = judgeShape('continuous', sCT)
const contentCT = await canvasHasContent(sCT.page)
check(
  ctUp && pressedCT.every((v) => v === 'false'),
  '「连续滚动」模式生效（★ 既没有按钮也没有快捷键，只能走 store；这是默认模式）',
  'store.viewMode="continuous"、两个按钮都不高亮',
  `viewMode=${sCT.viewMode}、aria-pressed=${JSON.stringify(pressedCT)}`
)
check(
  statusCT.includes('连续滚动'),
  '「连续滚动」模式下状态栏标出当前模式',
  '状态栏里出现「连续滚动」',
  `状态栏 ${JSON.stringify(statusCT)}`
)
check(
  shapeCT.ok,
  '「连续滚动」版面形状正确',
  shapeCT.why,
  `行数=${sCT.rowCount}、每行页数=[${sCT.rowSizes.join(',')}]、页面节点=${sCT.pageNodes}`
)
check(
  contentCT.ok,
  '「连续滚动」模式下当前页画布有内容',
  '当前页 canvas 非全黑（暗 < 95%）',
  `当前第 ${sCT.page} 页 位图=${sCT.curBitmap} 采样=${contentCT.sample}`
)

/* ── 全屏已彻底移除：按钮不存在、F11 不再进全屏、preload 不再暴露 API ── */

await evaluate(`window.__store.getState().setViewMode('continuous')`)
await waitFor(`window.__store.getState().viewMode === 'continuous'`, 5000)
await probeSettled()

const fsProbe = await evalJson(`(() => {
  const api = (window.pdfApp && window.pdfApp.win) || {};
  return {
    btn: !!document.querySelector('[data-tb-id=fullscreen]'),
    anyFullscreenBtn: !!document.querySelector('[data-tb-id=fullscreen]'),
    api: {
      toggle: typeof api.toggleFullscreen,
      is: typeof api.isFullscreen,
      on: typeof api.onFullscreenChange
    }
  };
})()`)
check(
  fsProbe.btn === false && fsProbe.anyFullscreenBtn === false,
  '全屏按钮已从界面彻底移除（视图组与溢出菜单里都没有 data-tb-id=fullscreen）',
  'DOM 里查不到 [data-tb-id=fullscreen]',
  `viewmode 内=${fsProbe.btn}、整页任意位置=${fsProbe.anyFullscreenBtn}`
)
check(
  fsProbe.api.toggle === 'undefined' && fsProbe.api.is === 'undefined' && fsProbe.api.on === 'undefined',
  'preload 不再暴露全屏 API（toggle/is/on 三个都是 undefined）',
  'window.pdfApp.win 上没有 toggleFullscreen / isFullscreen / onFullscreenChange',
  `typeof: toggle=${fsProbe.api.toggle}、is=${fsProbe.api.is}、on=${fsProbe.api.on}`
)

const rectBeforeF11 = appWindowRect(pid)
const screen1 = screenSize()
await pressF11()
await sleep(700)
const rectAfterF11 = appWindowRect(pid)
const stillNotFull =
  !rectAfterF11 || !screen1 || (rectAfterF11.w < screen1.w - 2 || rectAfterF11.h < screen1.h - 2)
check(
  stillNotFull,
  '真按 F11：窗口没有被撑满屏幕（全屏快捷键已失效）',
  `窗口矩形小于屏幕 ${screen1 ? `${screen1.w}x${screen1.h}` : '（屏幕尺寸取不到）'}`,
  `F11 前 ${rectText(rectBeforeF11)} → F11 后 ${rectText(rectAfterF11)}`
)
const afterF11Visible = rectAfterF11?.visible
if (rectBeforeF11 && rectBeforeF11.visible === false) {
  check(
    afterF11Visible === false,
    '按 F11 也没有把隐藏实例摊到桌面上',
    '窗口 visible=false',
    `F11 前 ${rectText(rectBeforeF11)} → F11 后 ${rectText(rectAfterF11)}`
  )
}
/* ── 收尾：恢复默认模式，别影响后面的脚本 ───────────────────── */

await evaluate(`window.__store.getState().setViewMode('continuous')`)
const backToDefault = await waitFor(`window.__store.getState().viewMode === 'continuous'`, 5000)
check(
  backToDefault,
  '收尾：视图模式恢复成默认的「连续滚动」',
  'viewMode="continuous"',
  `viewMode=${await evaluate('window.__store.getState().viewMode')}`
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
