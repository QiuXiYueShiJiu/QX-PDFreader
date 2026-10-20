// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 单窗口多文件标签页：TabBar 与 store 里 tabs / activeTabId / openFile / switchTab /
 * closeTab 的回归验证。
 *
 * ── 为什么要有这个脚本 ───────────────────────────────────────
 *   「一个窗口里开多个 PDF」是 v2 的新功能，入口是
 *   src/renderer/src/components/TabBar.tsx + store 里那几个标签动作。
 *   它要同时满足五条硬要求，缺一条用户就会看出来：
 *     ① 打开第二个文件**不许再开第二个窗口**（用户要的就是「前台只有一个窗口」）
 *     ② 重复打开同一个路径只切过去，**不许新开一个标签**
 *     ③ 切标签要把页码/缩放/批注**暂存再恢复**（不存回去就只剩空壳）
 *     ④ 关掉一个标签，应用要**活着**
 *     ⑤ 关掉**最后一个**标签，应用要**退出**
 *   本脚本把五条钉成可复跑的判据。
 *
 * ── 判定依据（照抄实现，改了实现这里必须跟着改）────────────────
 *   · 标签 DOM：div.tabbar[data-tab-count] > .tabbar__tab[data-tab-id][data-tab-path]
 *     （激活的还带 .is-active 且 aria-selected="true"），
 *     关闭按钮 button.tabbar__close[data-tab-close=<id>]   —— TabBar.tsx:83-121
 *   · 打开：store.openFile(path) 先按 path 在 tabs 里查（store.ts:494-498）：
 *     命中 → switchTab、**不新增**；未命中 → push 新标签、activeTabId 指向它、
 *     并把 page/zoom 重置回 1 / 'fit-width'（store.ts:512-542）
 *   · 切换：switchTab 先 stashActiveTab 把当前文档的 page/zoom/annotations
 *     写回它自己的标签记录，再换上目标标签的那份（store.ts:570-595）
 *   · 关闭：closeTab 关掉最后一个时清空全部状态（store.ts:604-622），
 *     真正「退出应用」由 TabBar 的 closeWithGuard 调 app.quitNow()（TabBar.tsx:42-44）
 *   · 快捷键：Ctrl+W 关当前标签、Ctrl+Tab 轮换，都挂在 window keydown 上（TabBar.tsx:50-77）
 *   · 顶层窗口：复用 tools/foreground-snapshot.ps1 -ProcessId <端口监听进程 pid>
 *     （它连无标题、不可见的顶层窗口一起枚举，正是要数的那种）
 *
 * ── 实例从哪来（★ 与别的 verify 脚本不同，别照抄成「直接连端口」）──
 *   本脚本最后一条检查是「关掉最后一个标签 → 应用进程消失」，
 *   跑完端口上**不会再有实例**。所以：
 *     · 端口上有活实例（单跑，或排在 verify-quit-dialog.mjs 之前）→ 复用它；
 *     · 端口上没有（在套件里排最后，前一支已经把实例退掉了）→ 按套件的配方自己起一个
 *       （dev：electron.exe 以仓库根为 app 参数；已安装版：直接跑 exe）。
 *   两条路都支持，才不会出现「套件里绿、单跑红」或者反过来。
 *   ★ 单实例锁：端口上有活实例时**绝不**再 spawn 第二个 —— 第二个会转发参数后自杀。
 *
 * 用法：node tools/verify-tabs.mjs [端口]
 *       环境变量：PDF_READER_PORT / PDF_READER_EXE / PDF_READER_DEV / PDF_READER_LOG
 *                 （由 tools/run-verify-suite.mjs 自动传）
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, openSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installedExe, fixturePath, fixtureBPath } from '../scripts/packaging-paths.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const PORT = Number(process.argv[2] ?? process.env.PDF_READER_PORT ?? 9290)
const DEV = process.env.PDF_READER_DEV === '1'
const INSTALLED = installedExe()
const EXE = process.env.PDF_READER_EXE ?? (DEV ? join(root, 'node_modules', 'electron', 'dist', 'electron.exe') : INSTALLED)
const LOG = process.env.PDF_READER_LOG ?? join(root, 'test-results', `instance-${PORT}.log`)

/*
 * 两份**不同**的 PDF。
 * ★ 这里踩过：一度把两份都指向主夹具，于是第二个 open 命中
 *   「同路径复用已有标签」，永远开不出第 2 个标签，
 *   判据以「标签数没变」这种像产品 bug 的方式红掉。
 *   第二份由 tools/mk-fixture-b.mjs 生成（5 页、视觉上明显不同）。
 */
const PDF_A = fixturePath()
const NAME_A = 'fixture.pdf'
const PDF_B = fixtureBPath()
const NAME_B = 'fixture-b.pdf'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const fails = []
let checks = 0

/** 每条检查都把「检查项 → 期望 → 实际」打全，失败时报告里能直接抄原文 */
function check(ok, label, want, got) {
  checks += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  console.log(`      期望  ${want}`)
  console.log(`      实际  ${got}`)
  if (!ok) fails.push(`${label}\n      期望  ${want}\n      实际  ${got}`)
}

/* ============================================================
 * CDP：直接开一条 WebSocket，既读状态也发**真**键鼠事件
 *
 * 别的 verify 脚本用 scripts/cdp-eval.mjs 取数就够了（它们只需要读/写状态），
 * 这里不行 —— Ctrl+W / Ctrl+Tab 必须走 Input.dispatchKeyEvent 才是「真的按了键」
 * （页面里 new KeyboardEvent 只是自己造事件，绕过了 Chromium 的按键投递）。
 * ============================================================ */

let ws = null
let msgId = 0
const pending = new Map()

async function pageTarget() {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(3000) })).json()
    return list.find((t) => t.type === 'page' && t.url.includes('index.html')) ?? null
  } catch {
    return null
  }
}

async function connect() {
  const t = await pageTarget()
  if (!t) throw new Error(`端口 ${PORT} 上没有 index.html 页面`)
  ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('CDP WebSocket 连不上'))
  })
  ws.onmessage = (ev) => {
    let m = null
    try {
      m = JSON.parse(ev.data)
    } catch {
      return
    }
    const wait = m.id ? pending.get(m.id) : null
    if (wait) {
      pending.delete(m.id)
      wait(m)
    }
  }
}

function send(method, params = {}, timeout = 20000) {
  const id = (msgId += 1)
  return new Promise((res, rej) => {
    pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)))
    try {
      ws.send(JSON.stringify({ id, method, params }))
    } catch (e) {
      pending.delete(id)
      rej(e)
      return
    }
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        rej(new Error(`CDP 超时：${method}`))
      }
    }, timeout)
  })
}

/**
 * 发一条**不等回复**的 CDP 命令。
 *
 * ★ 为什么需要它：⑪ 那一下点击会关掉最后一个标签 → 应用自己退出 →
 *   渲染进程在派发事件的过程中就没了，`mouseReleased` 的回复**永远不会回来**。
 *   用 send() 会白等 20 秒然后抛「CDP 超时」，把「应用如期退出」这个**正确结果**
 *   误报成脚本异常（第一版就是这样挂的）。所以这一步只看结果，不看回执。
 */
function sendNoReply(method, params = {}) {
  const id = (msgId += 1)
  try {
    ws.send(JSON.stringify({ id, method, params }))
  } catch {
    /* 连接已经断开也正常：目标正在死 */
  }
}

async function evaluate(expr, timeout) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, timeout)
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text
    throw new Error(`页面异常：${String(d).split('\n')[0]}`)
  }
  return r.result?.value
}

/** 把页面里的值按 JSON 拿回来（避免 undefined/NaN 这类不能 returnByValue 的东西） */
async function evalJson(expr) {
  const s = await evaluate(`JSON.stringify(${expr})`)
  return s === undefined ? null : JSON.parse(s)
}

/** 真按键：rawKeyDown + keyUp（modifiers 位：Alt=1 Ctrl=2 Meta=4 Shift=8） */
async function keyPress(key, code, vk, modifiers) {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

/**
 * 真鼠标点击：按元素中心的**屏幕坐标**按下+抬起，并回报 hit-test 命中的是谁。
 * 命中别人 = 按钮被挡住了，这本身就是要报的问题（这个仓库里出现过好几次）。
 */
async function clickSelector(sel, index = 0) {
  const box = await evalJson(`(() => {
    const el = document.querySelectorAll(${JSON.stringify(sel)})[${index}];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, w: r.width, h: r.height, hitSelf: !!hit && (hit === el || el.contains(hit)), hitWhat: hit ? (hit.getAttribute('class') || hit.tagName) : null };
  })()`)
  if (!box || box.w <= 0 || box.h <= 0) return { ok: false, why: `找不到元素或尺寸为 0：${sel}[${index}]`, box }
  /*
   * 点击分三步发。切换标签会触发目标文档的整页重排，隐藏实例里渲染层
   * 偶尔会被占住十几秒 —— CDP 的输入事件要等渲染层确认，于是超时。
   * 超时后重试一次：事件多半已经送达，重试只是为了让用例不在这一步崩。
   */
  const dispatch = async (params) => {
    try {
      await send('Input.dispatchMouseEvent', params, 30000)
    } catch {
      await sleep(1500)
      await send('Input.dispatchMouseEvent', params, 30000)
    }
  }
  await dispatch({ type: 'mouseMoved', x: box.x, y: box.y, button: 'none', buttons: 0 })
  await dispatch({ type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 })
  await dispatch({ type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 })
  return { ok: true, box }
}

/** 轮询等待页面条件成立。★ 超时后把最后一次异常带出去：静默超时最难查 */
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

/* ============================================================
 * 实例：复用活着的，没有才自己起（见文件头「实例从哪来」）
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

function pidAlive(pid) {
  if (!pid) return false
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'alive' } else { 'gone' }`],
    { windowsHide: true, encoding: 'utf8', timeout: 30000 }
  )
  return `${r.stdout ?? ''}`.trim() === 'alive'
}

/** 某进程的全部顶层窗口（含不可见、无标题的） */
function topLevelWindows(pid) {
  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(root, 'tools', 'foreground-snapshot.ps1'),
      '-ProcessId',
      String(pid)
    ],
    { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 30000 }
  )
  const lines = `${r.stdout ?? ''}`.split(/\r?\n/).filter((l) => l.trim())
  return lines
    .filter((l) => l.startsWith('W|'))
    .map((l) => {
      const p = l.split('|')
      return { hwnd: p[1], visible: p[3] === 'true', size: p[4], cls: p[5], title: p.slice(6).join('|') }
    })
}

function winLine(w) {
  return `${w.cls}${w.title ? `「${w.title}」` : ''}(${w.size}${w.visible ? ',可见' : ',不可见'})`
}

/** 套件自己的收尾方式：按调试端口杀，绝不误伤用户自己开着的阅读器 */
function killByPort() {
  spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--remote-debugging-port=${PORT}*' -and $_.CommandLine -notlike '*--type=*' } | ForEach-Object { & taskkill.exe /PID $_.ProcessId /T /F 2>&1 | Out-Null }`
    ],
    { windowsHide: true, stdio: 'ignore' }
  )
}

let selfStarted = false

async function ensureInstance() {
  if (await pageTarget()) {
    await connect() // ★ 复用也要连上：漏了这一步，后面每次 evaluate 都会因为 ws === null 而静默超时
    return { reused: true }
  }

  if (!existsSync(EXE)) throw new Error(`端口 ${PORT} 上没有实例，而找不到可执行文件：${EXE}`)

  // 与 run-verify-suite.mjs:181-183 完全同一套参数：dev 模式第一个参数必须是 app 目录
  const args = DEV
    ? ['.', '--hidden', '--test-hooks', `--remote-debugging-port=${PORT}`, PDF_A]
    : ['--hidden', '--test-hooks', `--remote-debugging-port=${PORT}`, PDF_A]
  const child = spawn(EXE, args, {
    cwd: DEV ? root : dirname(EXE),
    detached: true,
    stdio: ['ignore', openSync(LOG, 'w'), openSync(LOG, 'a')],
    windowsHide: true
  })
  child.unref()
  selfStarted = true

  const t = await waitForPage(40000)
  if (!t) throw new Error(`自己起的实例 40 秒内没就绪（端口 ${PORT}，日志 ${LOG}）`)
  return { reused: false }
}

async function waitForPage(ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    await sleep(500)
    if (!(await pageTarget())) continue
    try {
      await connect()
      const ok = await waitFor(`(() => { const s = window.__store.getState(); return !!s.pageCount; })()`, 8000)
      if (ok) return true
    } catch {
      /* 还没挂上挂钩，再等 */
    }
  }
  return false
}

/* ============================================================
 * 主流程
 * ============================================================ */

console.log('=== 单窗口多文件标签页验证（TabBar / tabs）===')
console.log(`  端口    ${PORT}`)
console.log(`  目标    ${EXE}${DEV ? '  (dev 版)' : ''}`)
console.log(`  文件 A  ${PDF_A}`)
console.log(`  文件 B  ${PDF_B}`)

if (!existsSync(PDF_A) || !existsSync(PDF_B)) {
  console.error(`✗ 两份测试 PDF 必须都存在（A=${existsSync(PDF_A)} B=${existsSync(PDF_B)}）`)
  process.exit(2)
}

let reused = false
try {
  const r = await ensureInstance()
  reused = r.reused
} catch (e) {
  console.error(`✗ ${e.message}`)
  process.exit(2)
}
if (!(await waitFor(`(() => { const s = window.__store.getState(); return s.tabs.length >= 1 && s.pageCount > 0; })()`, 20000))) {
  console.error(`✗ 30 秒内实例没有进入「已打开一份文档」的状态${lastWaitError ? `（最后一次报错：${lastWaitError}）` : ''}`)
  process.exit(2)
}
console.log(`  实例    ${reused ? '复用端口上的活实例' : '端口上没有实例，按套件配方自起一个'}`)
console.log(`  主进程日志：${LOG}`)

const pid = listenerPid()
console.log(`  浏览器进程 pid=${pid}（端口 ${PORT} 的监听者）\n`)

/** 页面状态一把抓：标签表 + 当前文档 + 状态栏文本 */
const STATE = `(() => {
  const bar = document.querySelector('.tabbar');
  const st = window.__store.getState();
  return {
    count: document.querySelectorAll('.tabbar__tab').length,
    dataCount: bar ? bar.getAttribute('data-tab-count') : null,
    barPresent: !!bar,
    tabs: [...document.querySelectorAll('.tabbar__tab')].map((el) => ({
      id: el.dataset.tabId,
      path: el.dataset.tabPath,
      name: String((el.querySelector('.tabbar__name') || {}).textContent ?? ''),
      active: el.classList.contains('is-active'),
      ariaSelected: el.getAttribute('aria-selected')
    })),
    stored: st.tabs.map((t) => ({ id: t.id, path: t.path, page: t.page, zoom: t.zoom })),
    activeTabId: st.activeTabId,
    filePath: st.filePath,
    fileName: st.fileName,
    page: st.page,
    pageCount: st.pageCount,
    zoom: st.zoom,
    statusFile: String((document.querySelector('.statusbar__file') || {}).textContent ?? ''),
    statusItems: [...document.querySelectorAll('.statusbar__item')].map((e) => e.textContent)
  };
})()`

const s0 = await evalJson(STATE)
const wins0 = topLevelWindows(pid)
console.log(`  基线：${s0.count} 个标签、顶层窗口 ${wins0.length} 个 → ${wins0.map(winLine).join(' / ') || '（无）'}\n`)

/* ── ① 打开第一个文件：标签栏出现、且正好 1 个标签 ───────────── */
check(
  s0.barPresent && s0.count === 1 && s0.dataCount === '1' && s0.tabs[0]?.path === PDF_A && s0.tabs[0]?.active,
  '① 打开第一个 PDF：标签栏出现且只有 1 个标签（.tabbar[data-tab-count="1"]、该标签 is-active）',
  `1 个 .tabbar__tab、data-tab-count="1"、data-tab-path="${PDF_A}"、is-active`,
  `标签 ${s0.count} 个、data-tab-count="${s0.dataCount}"、path="${s0.tabs[0]?.path}"、is-active=${s0.tabs[0]?.active}`
)

/* ── ② 状态栏文件名跟着当前文档 ──────────────────────────── */
check(
  s0.statusFile === NAME_A && s0.fileName === NAME_A,
  '② 状态栏显示的就是当前文档（.statusbar__file 与 store.fileName 一致）',
  `"${NAME_A}"`,
  `状态栏 "${s0.statusFile}"、store.fileName "${s0.fileName}"`
)

/* ── ③ 打开第二个 PDF：顶层窗口不许变多 ─────────────────────── */
await evaluate(`window.__store.getState().openFile(${JSON.stringify(PDF_B)}).then(() => 'opened')`)
const loadedB = await waitFor(
  `(() => { const s = window.__store.getState(); return s.filePath === ${JSON.stringify(PDF_B)} && s.pageCount > 0; })()`,
  15000
)
await sleep(400)
const s1 = await evalJson(STATE)
const wins1 = topLevelWindows(pid)
const setOf = (arr) => arr.map((w) => w.hwnd).sort().join(',')
check(
  loadedB && setOf(wins1) === setOf(wins0) && wins1.length === wins0.length,
  '③ 打开第二个 PDF：本进程的顶层窗口**一个都没多**（不是又开了一个窗口）',
  `顶层窗口仍是 ${wins0.length} 个、句柄集合不变 [${setOf(wins0)}]`,
  `顶层窗口 ${wins1.length} 个、句柄集合 [${setOf(wins1)}] → ${wins1.map(winLine).join(' / ') || '（无）'}`
)

/* ── ④ 第二个标签出现并激活，状态栏切到第二个文件 ────────────── */
const tabB = s1.tabs.find((t) => t.path === PDF_B)
check(
  s1.count === 2 && s1.dataCount === '2' && !!tabB && tabB.active && s1.activeTabId === tabB.id && tabB.ariaSelected === 'true',
  '④ 第二个文件落成第 2 个标签并处于激活态（activeTabId 指向它）',
  `2 个标签、data-tab-count="2"、第二个标签 is-active、aria-selected="true"、activeTabId=${tabB?.id ?? '(无此标签)'}`,
  `标签 ${s1.count} 个、data-tab-count="${s1.dataCount}"、第二个标签 is-active=${tabB?.active}、aria-selected="${tabB?.ariaSelected}"、activeTabId=${s1.activeTabId}`
)
check(
  s1.filePath === PDF_B && s1.statusFile === NAME_B && s1.fileName === NAME_B && s1.page === 1 && s1.zoom === 'fit-width',
  '⑤ 当前文档真的换成第二个（状态栏文件名/页码/缩放都跟着重置）',
  `filePath="${PDF_B}"、状态栏 "${NAME_B}"、page=1、zoom="fit-width"`,
  `filePath="${s1.filePath}"、状态栏 "${s1.statusFile}"、page=${s1.page}、zoom=${JSON.stringify(s1.zoom)}`
)

/* ── ⑥ 按路径复用：再打开 A 只切过去，不新增标签 ─────────────── */
await evaluate(`window.__store.getState().openFile(${JSON.stringify(PDF_A)}).then(() => 'opened')`)
await waitFor(`window.__store.getState().filePath === ${JSON.stringify(PDF_A)}`, 10000)
await sleep(300)
const s2 = await evalJson(STATE)
const tabA = s2.tabs.find((t) => t.path === PDF_A)
check(
  s2.count === 2 && s2.activeTabId === tabA?.id && tabA?.active && s2.dataCount === '2',
  '⑥ 重复打开已开过的路径：只切过去（仍是 2 个标签，激活回第一个）',
  `仍是 2 个标签、第二个不再新增、activeTabId=${tabA?.id ?? '(无)'}（第一个标签）`,
  `标签 ${s2.count} 个、data-tab-count="${s2.dataCount}"、activeTabId=${s2.activeTabId}、激活标签 path="${s2.tabs.find((t) => t.active)?.path}"`
)

/* ── ⑦⑧ 真鼠标点标签切换：页码/缩放要暂存后再恢复 ───────────── */
await evaluate(`(() => { const st = window.__store.getState(); st.setPage(3); st.setZoom(1.25); return 'ok'; })()`)
await sleep(700)
/*
 * ★ 不写死「第 3 页」。设完页码后，滚动观察器会按当前滚动位置**回写**一次页码
 *   （125% 下第 3 页的可见中心可能已经落在第 4 页上）。实测：复用实例时是 3，
 *   套件里自起的新实例里漂成了 4 —— 写死就会假红。
 *   改成读「落定之后的真实值」当基准，断言强度不变：
 *   下面仍然要求「一个非默认页码 + 125%」原样活过一次切换来回。
 */
const s3 = await evalJson(STATE)
let pageA = s3.page
let onA = pageA >= 2 && s3.zoom === 1.25

/*
 * ★ 切换前再确认一次页码没继续漂。
 *
 *   滚动观察器按「可见中心」回写页码，回写时机不固定：实测同一个动作，
 *   复用实例里落定在第 3 页，套件自起的新实例里落定在第 4 页，而且
 *   有时在 700ms 之后还在改。这里以「切换那一刻的真实页码」为基准，
 *   断言强度不变（仍然要求一个非默认页码 + 125% 原样活过一次来回），
 *   但不再依赖「设页码之后多久才停」。
 */
const beforeSwitch = await evalJson(STATE)
if (beforeSwitch.page !== pageA) {
  console.log(`   页码在切换前又漂了一次：${pageA} → ${beforeSwitch.page}（以切换时的真实值为基准）`)
  pageA = beforeSwitch.page
  onA = pageA >= 2 && beforeSwitch.zoom === 1.25
}

/* 点**第二个标签**（真鼠标）：切到 B */
const clickB = await clickSelector('.tabbar__tab', 1)
check(
  clickB.ok && clickB.box.hitSelf,
  '⑦ 真鼠标点第二个标签：命中标签自身（没被别的元素挡住）',
  'elementFromPoint 落在该标签内部',
  clickB.ok
    ? `标签 ${clickB.box.w.toFixed(0)}x${clickB.box.h.toFixed(0)}、中心 (${clickB.box.x.toFixed(1)}, ${clickB.box.y.toFixed(1)})、命中 ${clickB.box.hitWhat}${clickB.box.hitSelf ? '' : '（被它挡住）'}`
    : clickB.why
)
await waitFor(`window.__store.getState().filePath === ${JSON.stringify(PDF_B)}`, 8000)
await sleep(400)
const s4 = await evalJson(STATE)
const stashedA = s4.stored.find((t) => t.path === PDF_A)
check(
  onA && stashedA?.page === pageA && stashedA?.zoom === 1.25 && s4.filePath === PDF_B,
  `⑧ 切走时把当前文档的页码/缩放暂存回它自己的标签（A 记下了 page=${pageA}、zoom=1.25）`,
  `A 的记录 page=${pageA}（落定值，且不是默认的第 1 页）、zoom=1.25；切过去后当前文档变成 B（page=1、zoom="fit-width"）`,
  `A 的记录 page=${stashedA?.page}、zoom=${JSON.stringify(stashedA?.zoom)}；当前 filePath="${s4.filePath}"、page=${s4.page}、zoom=${JSON.stringify(s4.zoom)}`
)

/* 点**第一个标签**（真鼠标）：切回 A，暂存的页码/缩放要回来 */
const clickA = await clickSelector('.tabbar__tab', 0)
await waitFor(`window.__store.getState().filePath === ${JSON.stringify(PDF_A)}`, 8000)
await sleep(500)
const s5 = await evalJson(STATE)
const statusRe = new RegExp(`第\\s*${pageA}\\s*\\/\\s*\\d+\\s*页`)
check(
  clickA.ok && clickA.box.hitSelf && s5.filePath === PDF_A && s5.page === pageA && s5.zoom === 1.25 && s5.statusFile === NAME_A && statusRe.test(String(s5.statusItems[0] ?? '')),
  `⑨ 真鼠标点第一个标签：切回来时把暂存的页码/缩放恢复（回到 A 的第 ${pageA} 页、125%、状态栏页码同步）`,
  `filePath="${PDF_A}"、page=${pageA}、zoom=1.25、状态栏 "${NAME_A}" 且页码显示「第 ${pageA} / N 页」`,
  `filePath="${s5.filePath}"、page=${s5.page}、zoom=${JSON.stringify(s5.zoom)}、状态栏 "${s5.statusFile}"、页码 "${s5.statusItems[0]}"、点击命中=${clickA.ok ? clickA.box.hitWhat : clickA.why}`
)

/* ── ⑩ Ctrl+Tab 轮换 ─────────────────────────────────────── */
const beforeTab = s5.activeTabId
await keyPress('Tab', 'Tab', 9, 2) // Ctrl
await sleep(400)
const s6 = await evalJson(STATE)
check(
  s6.activeTabId !== beforeTab && s6.tabs.find((t) => t.id === s6.activeTabId)?.active === true,
  '⑩ 真按 Ctrl+Tab：激活标签轮换到另一个（DOM 与 store 一致）',
  `activeTabId 从 ${beforeTab} 变成另一个标签，且该标签 is-active`,
  `activeTabId ${beforeTab} → ${s6.activeTabId}、is-active=${s6.tabs.find((t) => t.id === s6.activeTabId)?.active}`
)

/* ── ⑪ Ctrl+W 关掉当前标签，应用还得活着 ──────────────────── */
await keyPress('w', 'KeyW', 87, 2) // Ctrl+W
await sleep(700)
const s7 = await evalJson(STATE)
const wins7 = topLevelWindows(pid)
check(
  s7.count === 1 && s7.dataCount === '1' && pidAlive(pid) && wins7.length === wins0.length,
  '⑪ 真按 Ctrl+W：关掉当前标签（2 → 1），应用进程与顶层窗口都还在',
  `标签 1 个、data-tab-count="1"、pid ${pid} 存活、顶层窗口仍是 ${wins0.length} 个`,
  `标签 ${s7.count} 个、data-tab-count="${s7.dataCount}"、pid ${pid} ${pidAlive(pid) ? '存活' : '已消失'}、顶层窗口 ${wins7.length} 个`
)

/* ── ⑫⑬⑭ 关掉最后一个标签 → 应用退出 ─────────────────────── */
/**
 * ★ 这一下点击会**杀掉被点击的东西**：应用自己退出 → 渲染进程在事件派发中没了 →
 *   mouseReleased 的回执永远不会回来。所以：
 *     · 坐标与 hit-test 用页面查询（不依赖鼠标事件）
 *     · 三个鼠标事件用 sendNoReply 发出去，不等回执
 *     · 成败只看「端口断没断、进程在不在」（⑫⑬）
 */
const closeBox = await evalJson(`(() => {
  const el = document.querySelector('.tabbar__close');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  return { x, y, w: r.width, h: r.height, hitSelf: !!hit && (hit === el || el.contains(hit)), hitWhat: hit ? (hit.getAttribute('class') || hit.tagName) : null };
})()`)
check(
  !!closeBox && closeBox.w > 0 && closeBox.h > 0 && closeBox.hitSelf,
  '⑫ 点最后一个标签的关闭按钮（.tabbar__close）：点得到且没被别的元素挡住',
  '按钮存在、尺寸 > 0、elementFromPoint 落在按钮内部',
  closeBox
    ? `按钮 ${closeBox.w.toFixed(1)}x${closeBox.h.toFixed(1)}、中心 (${closeBox.x.toFixed(1)}, ${closeBox.y.toFixed(1)})、命中 ${closeBox.hitWhat}${closeBox.hitSelf ? '' : '（被它挡住）'}`
    : '页面上找不到 .tabbar__close'
)
if (closeBox) {
  const at = { x: closeBox.x, y: closeBox.y }
  sendNoReply('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at, button: 'none', buttons: 0 })
  await sleep(120)
  sendNoReply('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'left', buttons: 1, clickCount: 1 })
  await sleep(120)
  sendNoReply('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', buttons: 0, clickCount: 1 })
}

const portGone = await (async () => {
  const t0 = Date.now()
  while (Date.now() - t0 < 8000) {
    if (!(await pageTarget())) return ((Date.now() - t0) / 1000).toFixed(1)
    await sleep(300)
  }
  return null
})()
check(
  portGone !== null,
  '⑬ 关闭最后一个标签：CDP 端口连同页面一起消失（应用真的在退出）',
  `8 秒内 http://127.0.0.1:${PORT}/json/list 不再返回 index.html`,
  portGone ? `连接在 ${portGone}s 断开` : `8 秒后端口仍在应答 —— 应用没退出`
)

/*
 * 端口先于进程消失是常态（⑬ 已经等到端口断开），这里再给进程最多 5 秒走完。
 * 早先只查一次导致偶发假红：端口断了但进程还在做退出收尾。
 */
let stillAlive = pidAlive(pid)
let pidGoneAfter = 0
if (stillAlive) {
  const tGone = Date.now()
  while (Date.now() - tGone < 5000) {
    await sleep(200)
    stillAlive = pidAlive(pid)
    if (!stillAlive) {
      pidGoneAfter = (Date.now() - tGone) / 1000
      break
    }
  }
}
check(
  !stillAlive,
  '⑭ 关闭最后一个标签：整个进程消失（不是只关掉窗口留下后台进程）',
  `pid ${pid} 在端口断开后 5 秒内从进程表消失`,
  `pid ${pid} ${stillAlive ? '仍然存活' : `已消失（端口断开后 ${pidGoneAfter.toFixed(1)}s）`}`
)

/* 兜底：万一是功能坏了（应用没退），别把自己的实例留在端口上 */
if (stillAlive) {
  console.log('\n  ! 应用没有退出，按端口清理掉这个实例，避免它挡住后面跑套件')
  killByPort()
}

await sleep(300)
console.log(`\n=== 结果：${checks} 项检查，${fails.length} 项失败${selfStarted ? '（实例为本脚本自起）' : '（复用套件实例）'} ===`)
if (fails.length) {
  console.log('\n失败原文：')
  for (const f of fails) console.log(`  ✗ ${f}`)
  process.exit(1)
}
process.exit(0)
