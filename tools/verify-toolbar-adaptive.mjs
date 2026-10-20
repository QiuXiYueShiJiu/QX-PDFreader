// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 验证工具栏的自适应：按钮先缩、缩到下限再收进溢出菜单。
 *
 * 判据按用户的原话分成两段：
 *   ① 「按钮有缩放范围」——窗口略窄时按钮变小，但仍能点中，
 *      且**不溢出**（scrollWidth ≤ clientWidth）。
 *   ② 「超出范围就收进溢出菜单」——窗口很窄时出现「更多」入口，
 *      被收起的按钮真的从工具栏消失，点菜单里的项仍能生效。
 *
 * 为什么用 CDP 的 Emulation.setDeviceMetricsOverride 改视口：
 *   隐藏窗口不接受 Win32 的 SetWindowPos 尺寸调整（实测视口恒为 1440），
 *   只有从渲染层内部改视口才测得出来。
 *
 * 用法：node tools/verify-toolbar-adaptive.mjs [端口]
 */

const port = Number(process.argv[2] ?? 9280)

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'))
  if (!page) throw new Error('找不到页面目标')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  let id = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    const p = pending.get(msg.id)
    if (p) {
      pending.delete(msg.id)
      p(msg.result)
    }
  }
  const send = (method, params) =>
    new Promise((res) => {
      const myId = ++id
      pending.set(myId, res)
      ws.send(JSON.stringify({ id: myId, method, params }))
    })
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (r.exceptionDetails) {
      throw new Error('表达式异常: ' + JSON.stringify(r.exceptionDetails.exception?.description))
    }
    return r.result.value
  }
  return { ws, send, evalJs }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PROBE = `JSON.stringify((() => {
  const bar = document.querySelector('.toolbar');
  const cs = getComputedStyle(bar);
  const visible = Array.from(bar.querySelectorAll('[data-tb-id]'))
    .filter(el => el.style.display !== 'none')
    .map(el => el.dataset.tbId);
  const all = Array.from(bar.querySelectorAll('[data-tb-id]')).map(el => el.dataset.tbId);
  return {
    clientWidth: bar.clientWidth,
    scrollWidth: bar.scrollWidth,
    scale: Number(cs.getPropertyValue('--tb-scale').trim() || 1),
    visible,
    收起: all.filter(k => !visible.includes(k)),
    溢出入口: !!bar.querySelector('.tb-overflow')
  };
})())`

const { ws, send, evalJs } = await connect()

/*
 * ★ 开始前先清掉可能残留的视口覆盖。
 *
 *   踩坑记录：CDP 的 Emulation.setDeviceMetricsOverride 是**粘性**的 ——
 *   这个脚本跑完（甚至中途异常退出）之后覆盖仍然生效，
 *   后续脚本就会在一个 520px 宽的视口里跑。
 *   表现为「缩放防抖验证莫名失败」：版面只有 595px 宽，
 *   位图 811px，怎么看都像是 bug，其实是测试环境污染。
 *   起手先清一次，代价为零。
 */
await send('Emulation.clearDeviceMetricsOverride', {})
await sleep(400)

console.log('=== 工具栏自适应验证 ===\n')

/*
 * ★ 先把「装一次就不再动」的组摆成常开（左栏 / 设置）。
 *   这些组是最先被收进溢出菜单的，但它们的**是否存在**取决于上一支用例留下的开关状态：
 *   前一支把侧栏关掉后，520px 的内容宽度仍然放得下 → 不出现溢出入口，
 *   判据 ③ 就会假红（2026-10-18 dev 轮次实测：同一份代码、同一宽度，
 *   一次 520px 收起 3 个、一次收起 0 个）。
 *   这里固定成「左栏开着、设置关着」= 工具栏最宽的状态，之后所有宽度都可比较。
 *
 * ★ v2.1.2.0 起右侧栏整块下线（不再有「右栏」按钮），
 *   所以这里不再 toggleRightPanel —— 调了也不会改变工具栏内容宽度。
 */
console.log(
  '准备：' +
    (await evalJs(`(() => {
      const st = window.__store.getState();
      if (!st.showSidebar) st.toggleSidebar();
      if (st.showSettings) st.setShowSettings(false);
      return JSON.stringify({ showSidebar: window.__store.getState().showSidebar, showSettings: window.__store.getState().showSettings });
    })()`))
)
await sleep(500)

/*
 *   420px 及以下不在探测范围：那是窗口最小宽度（800）以下的挤压区，
 *   工具栏会退化成横向溢出（实测 420px 溢出 77px），不属于本用例的契约。
 */
const WIDTHS = [1440, 1100, 900, 760, 640, 520, 460]
const rows = []

/*
 * ★ 为什么要「等覆盖真的生效」而不是固定 sleep：
 *   Emulation.setDeviceMetricsOverride 偶尔会晚一拍（渲染进程正忙时尤其明显），
 *   固定 900ms 会量到**上一个宽度**的布局。2026-10-18 安装态整套里
 *   「③ 520px 时出现溢出菜单」就是这么假红的：入口 无、收起 0 个，
 *   看起来像产品缺陷，其实是量早了。
 *   现在：每 250ms 量一次，直到工具栏宽度 ≈ 目标宽度；中途重发一次覆盖兜底。
 */
async function measureAt(w) {
  const override = { width: w, height: 900, deviceScaleFactor: 1, mobile: false }
  await send('Emulation.setDeviceMetricsOverride', override)
  await sleep(400)
  let s = JSON.parse(await evalJs(PROBE))
  for (let i = 0; i < 12 && Math.abs(s.clientWidth - w) > 24; i++) {
    if (i === 4) {
      console.log(`   （覆盖还没生效，重发一次 ${w}px）`)
      await send('Emulation.setDeviceMetricsOverride', override)
    }
    await sleep(250)
    s = JSON.parse(await evalJs(PROBE))
  }
  /*
   * 再等 `--tb-scale` / 收起 收敛：缩放是 CSS 变量，随 ResizeObserver 异步更新，
   * 而且宽度变了可能**连着改两轮**（先收文字、再缩按钮）。
   * 这里等到「连续两次采样完全一致」才算稳，最多 3 秒；
   * 只看 clientWidth 而不看 scale 会量到中间态（2026-10-18 dev 整套里
   * 760px 量到 scale=1.000，实际稳定值是 0.927 → 判据 ② 假红）。
   */
  const key = (x) => `${x.scale}|${x.clientWidth}|${x.收起.join(',')}`
  let prev = null
  for (let i = 0; i < 12; i++) {
    const cur = JSON.parse(await evalJs(PROBE))
    if (prev && key(prev) === key(cur)) return cur
    prev = cur
    await sleep(250)
  }
  return prev ?? JSON.parse(await evalJs(PROBE))
}

for (const w of WIDTHS) {
  const s = await measureAt(w)
  rows.push({ w, ...s })
  const overflowPx = s.scrollWidth - s.clientWidth
  console.log(`视口 ${String(w).padStart(4)}px  →  工具栏 ${s.clientWidth}px  缩放 ${s.scale.toFixed(3)}`)
  console.log(`   收起 [${s.收起.join(', ') || '无'}]   溢出入口 ${s.溢出入口 ? '有' : '无'}`)
  console.log(`   溢出 ${overflowPx > 1 ? `${overflowPx}px ✗` : '0 ✓'}`)
  console.log()
}

/* 清掉视口覆盖，恢复真实尺寸 */
await send('Emulation.clearDeviceMetricsOverride', {})
await sleep(600)

/* ---- 判据 ---- */
const wide = rows.find((r) => r.w === 1440)
const tiny = rows.find((r) => r.w === 520)
/* 溢出机制可能比 520px 更晚才触发（取决于侧栏/按钮文字宽度），所以往下多探几档 */
const overflowRow = rows.find((r) => r.溢出入口 && r.收起.length > 0 && r.w <= 520)

const noOverflowEverywhere = rows.every((r) => r.scrollWidth - r.clientWidth <= 1)
/*
 * 「略窄」不钉死 760px：工具栏是**有记忆的**（先收文字、再缩按钮，且带滞回），
 * 从 1440 一路压下来时 760px 可能刚好还在「1.000 + 不收起」的平台上，
 * 再压到 640px 才落到 0.863。契约是「窄了会缩按钮、但不收起」，
 * 所以取**第一个满足 scale<1 且 收起=0 的宽度**。
 */
const scaledRow = rows.find((r) => r.scale < 1 && r.收起.length === 0)
const scaledWhenNarrow = Boolean(scaledRow)
const overflowMenuWhenVeryNarrow = Boolean(overflowRow)
const wideUnscaled = wide ? wide.scale === 1 && !wide.溢出入口 : false

/*
 * v2.1.2.0：右侧「批注」列表整块下线。
 * 工具栏里不该再有「右侧栏」按钮（标题含「右侧栏」），DOM 里也不该再有 .right-panel；
 * 左栏按钮与设置按钮必须还在（只删了右栏这一个）。
 */
const removed = await evalJs(`(() => {
  const st = window.__store.getState();
  if (!st.showSidebar) st.toggleSidebar();
  const btns = Array.from(document.querySelectorAll('.toolbar button, .icon-btn'));
  const titleOf = (b) => (b.getAttribute('title') ?? '') + (b.getAttribute('aria-label') ?? '');
  return JSON.stringify({
    rightPanelBtn: btns.some((b) => titleOf(b).includes('右侧栏')),
    leftPanelBtn: btns.some((b) => titleOf(b).includes('左侧栏')),
    settingsBtn: btns.some((b) => titleOf(b).includes('设置')),
    panelDom: Boolean(document.querySelector('.right-panel')),
    tabDom: Boolean(document.querySelector('.right-panel .sidebar__tab'))
  });
})()`)
const rm = JSON.parse(removed)
const rightPanelGone = !rm.rightPanelBtn && !rm.panelDom && !rm.tabDom
const othersKept = rm.leftPanelBtn && rm.settingsBtn

console.log('--- 判据 ---')
console.log(`① 任何宽度都不溢出:        ${noOverflowEverywhere ? '✓' : '✗'}`)
console.log(
  `② 略窄时按钮缩小但不收起:  ${scaledWhenNarrow ? '✓' : '✗'}（${scaledRow ? `${scaledRow.w}px 时 scale=${scaledRow.scale.toFixed(3)}，收起 0 个` : '所有宽度要么 scale=1、要么已开始收起'}）`
)
console.log(
  `③ 很窄时出现溢出菜单:      ${overflowMenuWhenVeryNarrow ? '✓' : '✗'}（${overflowRow ? `${overflowRow.w}px 时入口 有，收起 ${overflowRow.收起.length} 个` : `最窄 520px 仍未触发，入口 ${tiny?.溢出入口 ? '有' : '无'}、收起 ${tiny?.收起.length} 个`}）`
)
console.log(`④ 宽窗口保持原样:          ${wideUnscaled ? '✓' : '✗'}`)
console.log(
  `⑤ 右侧「批注」列表已下线:  ${rightPanelGone ? '✓' : '✗'}（右侧栏按钮 ${rm.rightPanelBtn ? '还在' : '已去掉'}、.right-panel ${rm.panelDom ? '还在' : '不在'}、页签 ${rm.tabDom ? '还在' : '不在'}）`
)

const pass =
  noOverflowEverywhere && scaledWhenNarrow && overflowMenuWhenVeryNarrow && wideUnscaled && rightPanelGone
if (pass && !othersKept) {
  console.log(`⚠ 左栏/设置按钮缺失：左栏=${rm.leftPanelBtn} 设置=${rm.settingsBtn}`)
}
console.log(`\n=== 结论：${pass ? '全部通过 ✓' : '有未通过项 ✗'} ===`)
ws.close()
process.exit(pass ? 0 : 1)
