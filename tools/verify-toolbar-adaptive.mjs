// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 验证单条 Office 功能区的自适应：先降密度，再把放不下的按钮收进「更多」。
 *
 * 背景：1.0.9.x 把「顶条 + 底条」的两条工具栏回退成**一条** Office 式功能区
 * （src/renderer/src/components/RibbonTabs.tsx）。旧契约里的 `--tb-scale` 缩放、
 * `.tb-overflow` 入口都不存在了，这里按新 DOM 重写判据：
 *
 *   ① 「不溢出」——任何宽度下 `.ribbon` 与 `.ribbon__body` 的 scrollWidth 都不超过 clientWidth。
 *   ② 「宽窗原样」——1440px 时 18 个按钮全在、无收起、`data-size=lg`。
 *   ③ 「略窄降密度」——900px 时 `data-size` 降到 md，放不下的按钮真的 `display:none`。
 *   ④ 「更窄收得更多」——560px 时收起数明显变多（颜色盘与撤销都被收）。
 *   ⑤ 「更多菜单能用」——很窄时点「更多」出来的菜单里就是被收起的按钮，点其中一项真生效。
 *   ⑥ 「收起/展开」——`ribbon-collapse` 收成一条 `.ribbon__peek`，点它还原。
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
  const r = document.querySelector('.ribbon');
  if (!r) return { ribbon: false };
  const body = r.querySelector('.ribbon__body');
  const btns = Array.from(r.querySelectorAll('.ribbon__body [data-tb-id]'));
  const hidden = btns.filter(b => b.style.display === 'none').map(b => b.dataset.tbId);
  const more = r.querySelector('[data-tb-id="ribbon-more"]');
  return {
    ribbon: true,
    size: r.dataset.size || '',
    clientWidth: r.clientWidth,
    scrollWidth: r.scrollWidth,
    bodyClient: body ? body.clientWidth : 0,
    bodyScroll: body ? body.scrollWidth : 0,
    total: btns.length,
    hidden,
    收起: hidden,
    可见: btns.length - hidden.length,
    moreShown: more ? more.offsetParent !== null : false,
    collapsed: r.classList.contains('ribbon--collapsed'),
    height: Math.round(r.getBoundingClientRect().height)
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

console.log('=== 单条功能区自适应验证 ===\n')

/*
 * 准备：把「装一次就不再动」的开关摆成固定状态（左栏开着、设置关着、开始页），
 * 否则上一支用例留下的开关会让同一宽度下的收起数量不可比（2026-10-18 实测过这种假红）。
 * 同时把页签切回「开始」，各宽度比较的是同一组 18 个按钮。
 */
console.log(
  '准备：' +
    (await evalJs(`(() => {
      const st = window.__store.getState();
      if (!st.showSidebar) st.toggleSidebar();
      if (st.showSettings) st.setShowSettings(false);
      const tab = document.querySelector('[data-tb-id="ribbon-tab-home"]');
      if (tab) tab.click();
      return JSON.stringify({ showSidebar: window.__store.getState().showSidebar, showSettings: window.__store.getState().showSettings });
    })()`))
)
await sleep(600)

const WIDTHS = [1440, 1200, 1000, 900, 860, 760, 640, 560, 520, 460]
const rows = []

/*
 * ★ 为什么要「等覆盖真的生效」而不是固定 sleep：
 *   Emulation.setDeviceMetricsOverride 偶尔会晚一拍（渲染进程正忙时尤其明显），
 *   固定 900ms 会量到**上一个宽度**的布局。2026-10-18 安装态整套里
 *   「520px 时出现溢出菜单」就是这么假红的：入口 无、收起 0 个，
 *   看起来像产品缺陷，其实是量早了。
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
   * 再等「密度档位 + 收起清单」收敛：这两件事都由 ResizeObserver 异步算，
   * 宽度变了可能连着改两轮（先降档、再收按钮）。
   * 等到连续两次采样完全一致才算稳，最多 3 秒。
   */
  const key = (x) => `${x.size}|${x.clientWidth}|${x.收起.join(',')}`
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
  const overflowRibbon = s.scrollWidth - s.clientWidth
  const overflowBody = s.bodyScroll - s.bodyClient
  console.log(
    `视口 ${String(w).padStart(4)}px  →  功能区 ${s.clientWidth}px  密度 ${s.size}  可见 ${s.可见}/${s.total}`
  )
  console.log(`   收起 [${s.收起.join(', ') || '无'}]`)
  console.log(
    `   溢出 表体 ${overflowBody > 1 ? `${overflowBody}px ✗` : '0 ✓'} / 整体 ${overflowRibbon > 1 ? `${overflowRibbon}px ✗` : '0 ✓'}`
  )
  console.log()
}

/* ---- ⑤ 很窄时的「更多」菜单：切到视图页，420px 下「工具箱/设置」会被收起 ---- */
await evalJs(`document.querySelector('[data-tb-id="ribbon-tab-view"]').click(); 1`)
await sleep(400)
const narrow = await measureAt(420)
const menuBefore = JSON.parse(
  await evalJs(
    `JSON.stringify({ showSettings: window.__store.getState().showSettings, hidden: Array.from(document.querySelectorAll('.ribbon__body [data-tb-id]')).filter(b => b.style.display === 'none').map(b => b.dataset.tbId) })`
  )
)
await evalJs(`document.querySelector('[data-tb-id="ribbon-more"]').click(); 1`)
await sleep(450)
/*
 * 菜单里到底有没有「被收起的那些按钮」：用 aria-label 对文本，而不是数个数。
 * 个数不可靠 —— 菜单项是 ResizeObserver 上一轮算出来的，可能比当前收起清单多一项，
 * 也可能少一项（点开瞬间刚好又降了一档）。判据只认「当前被收起的每一个都能在菜单里找到」。
 */
const menu = JSON.parse(
  await evalJs(`JSON.stringify((() => {
    const hidden = Array.from(document.querySelectorAll('.ribbon__body [data-tb-id]')).filter(b => b.style.display === 'none');
    const labels = hidden.map(b => (b.getAttribute('aria-label') || '').trim());
    const items = Array.from(document.querySelectorAll('.ribbon__menu-item')).map(i => (i.textContent || '').trim());
    return {
      open: !!document.querySelector('.ribbon__menu'),
      items,
      hidden: hidden.map(b => b.dataset.tbId),
      covered: labels.length > 0 && labels.every(l => items.includes(l))
    };
  })())`)
)
const menuClick = await evalJs(`(() => {
  const it = Array.from(document.querySelectorAll('.ribbon__menu-item')).find(i => (i.textContent || '').trim() === '设置');
  if (!it) return 'not-found';
  it.click();
  return 'clicked';
})()`)
await sleep(700)
const afterMenuClick = JSON.parse(
  await evalJs(
    `JSON.stringify({ showSettings: window.__store.getState().showSettings, menuOpen: !!document.querySelector('.ribbon__menu') })`
  )
)
console.log(`420px 视图页：收起 [${menuBefore.hidden.join(', ') || '无'}]`)
console.log(`   菜单 ${menu.open ? '已打开' : '没打开'}，项 [${menu.items.join(', ') || '空'}]，点「设置」→ ${menuClick}`)
console.log(`   点后 showSettings=${afterMenuClick.showSettings}，菜单${afterMenuClick.menuOpen ? '还开着 ✗' : '已关闭 ✓'}`)
await evalJs(`window.__store.getState().setShowSettings(false); 1`)
await sleep(300)

/* ---- ⑥ 收起 / 展开 ---- */
await send('Emulation.clearDeviceMetricsOverride', {})
await sleep(500)
await evalJs(`document.querySelector('[data-tb-id="ribbon-tab-home"]').click(); 1`)
await sleep(350)
const expandedH = JSON.parse(await evalJs(PROBE)).height
const collapsed = JSON.parse(
  await evalJs(`(() => {
    const btn = document.querySelector('[data-tb-id="ribbon-collapse"]');
    if (!btn) return JSON.stringify({ ok: false });
    btn.click();
    return JSON.stringify({ ok: true });
  })()`)
)
await sleep(500)
const collapsedState = JSON.parse(
  await evalJs(`(() => {
    const r = document.querySelector('.ribbon');
    return JSON.stringify({
      collapsed: r.classList.contains('ribbon--collapsed'),
      height: Math.round(r.getBoundingClientRect().height),
      peek: !!r.querySelector('.ribbon__peek'),
      body: !!r.querySelector('.ribbon__body')
    });
  })()`)
)
await evalJs(`(() => { const p = document.querySelector('.ribbon__peek'); if (p) p.click(); return 1 })()`)
await sleep(500)
const reopenedState = JSON.parse(
  await evalJs(`(() => {
    const r = document.querySelector('.ribbon');
    return JSON.stringify({ collapsed: r.classList.contains('ribbon--collapsed'), height: Math.round(r.getBoundingClientRect().height) });
  })()`)
)
console.log(`\n收起/展开：展开 ${expandedH}px → 收起 ${collapsedState.height}px（peek ${collapsedState.peek ? '有' : '无'}，body ${collapsedState.body ? '还在 ✗' : '已移除 ✓'}）→ 再展开 ${reopenedState.height}px`)

/* ---- ⑦ 版式与旧契约的回归项 ---- */
const layout = JSON.parse(
  await evalJs(`(() => {
    const r = document.querySelector('.ribbon');
    const tabs = document.querySelector('.sidebar__tabs');
    return JSON.stringify({
      hasRibbon: Boolean(r),
      display: r ? getComputedStyle(r).display : '',
      height: r ? Math.round(r.getBoundingClientRect().height) : 0,
      tabsH: tabs ? Math.round(tabs.getBoundingClientRect().height) : 0,
      oldToolbar: Boolean(document.querySelector('.toolbar')),
      dotDrawbar: Boolean(document.querySelector('.drawbar'))
    });
  })()`)
)

/*
 * v2.1.2.0：右侧「批注」列表整块下线。
 * 功能区里不该再有「右侧栏」按钮，DOM 里也不该再有 .right-panel；
 * 左栏按钮与设置按钮必须还在（只删了右栏这一个）。
 */
const rm = JSON.parse(
  await evalJs(`(() => {
    const btns = Array.from(document.querySelectorAll('.ribbon button'));
    const titleOf = (b) => (b.getAttribute('title') ?? '') + (b.getAttribute('aria-label') ?? '') + (b.textContent ?? '');
    return JSON.stringify({
      rightPanelBtn: btns.some((b) => titleOf(b).includes('右侧栏')),
      panelDom: Boolean(document.querySelector('.right-panel')),
      tabDom: Boolean(document.querySelector('.right-panel .sidebar__tab'))
    });
  })()`)
)

const wide = rows.find((r) => r.w === 1440)
const mid = rows.find((r) => r.w === 900)

const noOverflowEverywhere = rows.every((r) => r.scrollWidth - r.clientWidth <= 1 && r.bodyScroll - r.bodyClient <= 1)
/* 按钮总数会随功能增加（1.9.0 起「插入」组多了加页/删页），因此不写死个数：
   只要求宽窗下「全部按钮可见、一个都不收、保持 lg 密度」。 */
const wideIntact = Boolean(wide) && wide.total > 0 && wide.收起.length === 0 && wide.size === 'lg'
const midTiered = Boolean(mid) && mid.size !== 'lg'
/*
 * 2026-10-27 起「开始」页只放文档级操作（漫游 + 八个编辑工具 + 加页删页 + 撤销重做），
 * 画笔 / 橡皮 / 颜色 / 粗细搬到了下栏悬浮条 —— 按钮少了以后 900px 还放得下，
 * 真正开始收是在 460px 左右。所以判据从「900 必须收」改成「先降密度、再在更窄时收」。
 */
const narrowRow = rows.find((r) => r.w === 560)
const tinyRow = rows.find((r) => r.w === 460)
const narrowCollects = Boolean(tinyRow) && tinyRow.收起.length >= 1
const menuWorks =
  menu.hidden.length > 0 &&
  menu.open &&
  menu.covered &&
  menuClick === 'clicked' &&
  afterMenuClick.showSettings === true &&
  afterMenuClick.menuOpen === false
const collapseWorks =
  collapsed.ok &&
  collapsedState.collapsed &&
  collapsedState.height <= 40 &&
  collapsedState.peek &&
  !collapsedState.body &&
  !reopenedState.collapsed &&
  reopenedState.height > 50
const layoutOk = layout.hasRibbon && layout.display === 'flex' && layout.height > 50 && layout.height < 120
const legacyGone = !layout.oldToolbar && !layout.dotDrawbar
const rightPanelGone = !rm.rightPanelBtn && !rm.panelDom && !rm.tabDom

console.log('--- 判据 ---')
console.log(`① 任何宽度都不溢出:        ${noOverflowEverywhere ? '✓' : '✗'}`)
console.log(
  `② 宽窗保持原样:            ${wideIntact ? '✓' : '✗'}（1440px 密度 ${wide?.size}、可见 ${wide?.可见}/${wide?.total}、收起 ${wide?.收起.length} 个）`
)
console.log(
  `③ 略窄先降密度:            ${midTiered ? '✓' : '✗'}（900px 密度 ${mid?.size}，收起 [${mid?.收起.join(', ') || '无'}]）`
)
console.log(
  `④ 更窄收得更多:            ${narrowCollects ? '✓' : '✗'}（460px 收起 ${tinyRow?.收起.length} 个）`
)
console.log(
  `⑤ 溢出的按钮在「更多」里:  ${menuWorks ? '✓' : '✗'}（菜单 [${menu.items.join(', ') || '空'}]，点设置后 showSettings=${afterMenuClick.showSettings}）`
)
console.log(
  `⑥ 功能区能收能展:          ${collapseWorks ? '✓' : '✗'}（收起 ${collapsedState.height}px、peek ${collapsedState.peek ? '有' : '无'}、再展开 ${reopenedState.height}px）`
)
console.log(`⑦ 仍是一行功能区:          ${layoutOk ? '✓' : '✗'}（display=${layout.display}，高 ${layout.height}px，侧栏页签高 ${layout.tabsH}px）`)
console.log(`⑧ 旧的两条工具栏已下线:    ${legacyGone ? '✓' : '✗'}（.toolbar ${layout.oldToolbar ? '还在 ✗' : '不在 ✓'}、.drawbar ${layout.dotDrawbar ? '还在 ✗' : '不在 ✓'}）`)
console.log(`⑨ 右侧「批注」列表已下线:  ${rightPanelGone ? '✓' : '✗'}（右侧栏按钮 ${rm.rightPanelBtn ? '还在' : '已去掉'}、.right-panel ${rm.panelDom ? '还在' : '不在'}）`)

const pass =
  noOverflowEverywhere && wideIntact && midTiered && narrowCollects && menuWorks && collapseWorks && layoutOk && legacyGone && rightPanelGone

/* 收尾：视口覆盖必须清掉，否则会污染后面每一支脚本 */
await send('Emulation.clearDeviceMetricsOverride', {})
await sleep(300)

console.log(`\n=== 结论：${pass ? '全部通过 ✓' : '有未通过项 ✗'} ===`)
ws.close()
process.exit(pass ? 0 : 1)
