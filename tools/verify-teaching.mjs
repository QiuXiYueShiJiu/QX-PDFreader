/**
 * 验证「课堂辅助 + 侧栏 + 主题 + 旋转」等日常功能（v1.0.0 全量普查）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么单独一支
 * ══════════════════════════════════════════════════════════════════
 *   之前的套件把力气都花在缩放手感、画笔、选区这些容易退化的地方，
 *   而「缩略图 / 目录 / 搜索 / 主题 / 聚光灯 / 黑屏 / 放大镜 / 旋转 /
 *   批注四件套 / 撤销」这些**每节课都会用**的功能反而没有回归。
 *   这一支把它们串起来跑一遍，任何一处 DOM 或 store 改名都会当场红。
 *
 * ══════════════════════════════════════════════════════════════════
 * 判据
 * ══════════════════════════════════════════════════════════════════
 *   ① 侧栏三个页签齐全，缩略图/目录/搜索都能出内容
 *   ② 搜索结果可点，点了会跳到命中页
 *   ③ 主题三档（亮/暗/护眼）切换后 html[data-theme] 跟着变
 *   ④ 聚光灯 / 黑屏 / 放大镜 三个遮罩能开、能关
 *   ⑤ 旋转 90° 后画布宽高互换
 *   ⑥ 适应宽度：zoom=fit-width 且 actualScale>0
 *   ⑦ 批注四件套（高亮/下划线/删除线/便签）都落库，撤销可回退，清空可归零
 *   ⑧ 右侧栏不再有「全屏」按钮（v2.1.3 起彻底移除）
 *
 * 用法：node tools/run-verify-suite.mjs --dev 9531 verify-teaching.mjs
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const PORT = Number(process.argv[2] ?? process.env.PDF_READER_PORT ?? 9531)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let fails = 0
let checks = 0
const check = (ok, label, detail = '') => {
  checks += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  —— ${detail}` : ''}`)
  if (!ok) fails += 1
}

/* ---------- CDP 直连 ---------- */
const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
const target = list.find((t) => t.type === 'page' && t.url.includes('index.html')) ?? list.find((t) => t.type === 'page')
if (!target) {
  console.error('✗ 找不到页面目标')
  process.exit(1)
}
const ws = new WebSocket(target.webSocketDebuggerUrl)
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
const json = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'eval 异常')
  return r.result?.value
}

console.log('课堂辅助 / 侧栏 / 主题 / 旋转（隐藏窗口）')
console.log(`  端口 ${PORT}\n`)

/* ---------- 准备 ---------- */
for (let i = 0; i < 40; i++) {
  if ((await json(`document.querySelectorAll('.textLayer span').length`).catch(() => 0)) > 0) break
  await sleep(500)
}
await json(`(() => {
  const s = window.__store.getState()
  s.setMaskMode('off')
  s.clearAnnotations()
  s.setEditTool('none')
  if (!s.showSidebar) s.toggleSidebar()
  return true
})()`)
await sleep(400)

/* ---------- ① 侧栏三个页签 ---------- */
const tabs = await json(`(() => {
  const nodes = Array.from(document.querySelectorAll('.sidebar__tab'))
  return { count: nodes.length, labels: nodes.map((n) => (n.textContent || '').trim()) }
})()`)
check(tabs.count === 3, '侧栏三个页签齐全', `页签=${tabs.labels.join(' / ')}`)

const thumbs = await json(`(async () => {
  window.__store.getState().setSidebarTab('thumbnails')
  await new Promise((r) => setTimeout(r, 900))
  return document.querySelectorAll('.thumb__canvas').length
})()`)
check(thumbs > 0, '缩略图页签渲染出缩略图', `${thumbs} 张`)

const outline = await json(`(async () => {
  window.__store.getState().setSidebarTab('outline')
  await new Promise((r) => setTimeout(r, 600))
  return {
    nodes: document.querySelectorAll('.outline__node').length,
    empty: !!document.querySelector('.sidebar__empty'),
    body: !!document.querySelector('.outline')
  }
})()`)
check(outline.body && (outline.nodes > 0 || outline.empty), '目录页签可用（有节点或明确空提示）', `节点=${outline.nodes} 空提示=${outline.empty}`)

/* ---------- ② 搜索 ---------- */
const search = await json(`(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms))
  const s = window.__store.getState()
  s.setSidebarTab('search')
  await w(400)
  /* 搜索框是组件内 state，必须像真人一样往 input 里写值并派发 input 事件，
     直接调 store 的 setSearchQuery 不会触发 SearchPanel 的检索。 */
  const input = document.querySelector('.search-panel__input')
  if (input) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, 'Reader')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  await w(2200)
  const hits = Array.from(document.querySelectorAll('.search-hit'))
  return {
    hits: hits.length,
    pages: hits.slice(0, 3).map((h) => Number(h.getAttribute('data-page') || 0)),
    text: hits.slice(0, 2).map((h) => (h.textContent || '').trim().slice(0, 30))
  }
})()`)
check(search.hits > 0, '全文搜索能出结果', `${search.hits} 条；样本「${(search.text || []).join('」/「')}」`)

const jumped = await json(`(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms))
  const s = window.__store.getState()
  const hits = Array.from(document.querySelectorAll('.search-hit'))
  if (!hits.length) return { ok: false, page: s.page }
  const pick = hits[hits.length > 1 ? 1 : 0]
  /* 命中项没有 data-page，页号在「第 N 页」这一行文字里 */
  const label = (pick.querySelector('.search-hit__page')?.textContent || '').trim()
  const want = Number((label.match(/([0-9]+)/) || [])[1] || 0)
  pick.click()
  await w(1200)
  return { ok: true, want, label, page: window.__store.getState().page }
})()`)
check(
  jumped.ok && jumped.want > 0 && jumped.page === jumped.want,
  '点搜索结果跳到命中页',
  `目标第 ${jumped.want} 页（${jumped.label ?? ''}）→ 当前第 ${jumped.page} 页`
)

await json(`window.__store.getState().setShowSearch(false)`)
await json(`window.__store.getState().setSidebarTab('thumbnails')`)

/* ---------- ③ 主题三档 ---------- */
const themes = {}
for (const mode of ['dark', 'sepia', 'light']) {
  themes[mode] = await json(`(async () => {
    window.__store.getState().patchSettings({ theme: '${mode}' })
    await new Promise((r) => setTimeout(r, 350))
    const cs = getComputedStyle(document.documentElement)
    return { attr: document.documentElement.dataset.theme, bg: cs.getPropertyValue('--bg').trim(), text: cs.getPropertyValue('--text').trim() }
  })()`)
}
check(
  themes.dark.attr === 'dark' && themes.sepia.attr === 'sepia' && themes.light.attr === 'light',
  '主题三档（亮/暗/护眼）切换生效',
  `暗=${themes.dark.attr}/${themes.dark.bg} 护眼=${themes.sepia.attr}/${themes.sepia.bg} 亮=${themes.light.attr}/${themes.light.bg}`
)
check(
  themes.dark.bg !== themes.light.bg && themes.sepia.bg !== themes.light.bg,
  '主题切换确实换了配色变量',
  `${themes.light.bg} → ${themes.dark.bg} / ${themes.sepia.bg}`
)

/* ---------- ④ 课堂辅助遮罩 ---------- */
const masks = {}
for (const mode of ['spotlight', 'black', 'magnifier']) {
  masks[mode] = await json(`(async () => {
    const w = (ms) => new Promise((r) => setTimeout(r, ms))
    window.__store.getState().setMaskMode('${mode}')
    await w(450)
    const on = {
      mask: !!document.querySelector('.screen-mask'),
      canvas: !!document.querySelector('.screen-mask__canvas'),
      label: (document.querySelector('.screen-mask__label')?.textContent || '').trim()
    }
    window.__store.getState().setMaskMode('off')
    await w(350)
    on.off = !document.querySelector('.screen-mask')
    return on
  })()`)
}
check(
  ['spotlight', 'black', 'magnifier'].every((m) => masks[m].mask && masks[m].canvas && masks[m].off),
  '聚光灯 / 黑屏 / 放大镜 都能开、能关',
  ['spotlight', 'black', 'magnifier'].map((m) => `${m}=${masks[m].mask ? '开' : '未开'}/${masks[m].off ? '关' : '未关'}`).join('，')
)

/* ---------- ⑤ 旋转 ---------- */
const rotate = await json(`(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms))
  const s0 = window.__store.getState()
  s0.setZoom('fit-width')
  await w(800)
  const before = document.querySelector('.pdf-page__canvas')
  const b = before ? { w: before.width, h: before.height } : null
  s0.rotate(90)
  await w(1200)
  const after = document.querySelector('.pdf-page__canvas')
  const a = after ? { w: after.width, h: after.height } : null
  window.__store.getState().rotate(270)
  await w(900)
  return { b, a, rotation: window.__store.getState().rotation }
})()`)
const swapped =
  rotate.b && rotate.a && Math.abs(rotate.b.w / rotate.b.h - rotate.a.h / rotate.a.w) / Math.max(0.01, rotate.b.w / rotate.b.h) < 0.06
check(
  !!swapped,
  '旋转 90° 后画布宽高比翻转',
  `${rotate.b?.w}x${rotate.b?.h} → ${rotate.a?.w}x${rotate.a?.h}；复位后 rotation=${rotate.rotation}`
)

/* ---------- ⑥ 适应宽度 ---------- */
const fit = await json(`(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms))
  const s = window.__store.getState()
  s.setZoom(1.6)
  await w(600)
  s.setZoom('fit-width')
  await w(700)
  const st = window.__store.getState()
  return { zoom: st.zoom, scale: st.actualScale }
})()`)
check(fit.zoom === 'fit-width' && fit.scale > 0, '「适应宽度」切得回来', `zoom=${fit.zoom} scale=${fit.scale?.toFixed?.(3) ?? fit.scale}`)

/* ---------- ⑦ 批注四件套 + 撤销 + 清空 ---------- */
const annot = await json(`(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms))
  const s = window.__store.getState()
  await s.clearAnnotations()
  await w(200)
  const page = 1
  const base = { page, color: '#f4c542', quote: 'verify-teaching', at: Date.now() }
  const rect = { x: 40, y: 40, width: 160, height: 14 }
  await s.addAnnotation({ ...base, type: 'highlight', rects: [rect] })
  await s.addAnnotation({ ...base, type: 'underline', rects: [rect] })
  await s.addAnnotation({ ...base, type: 'strikeout', rects: [rect] })
  await s.addAnnotation({ ...base, type: 'note', rects: [rect], note: '教学检查' })
  await w(300)
  const afterAdd = window.__store.getState().annotations.length
  window.__store.getState().undo()
  await w(250)
  const afterUndo = window.__store.getState().annotations.length
  window.__store.getState().redo()
  await w(250)
  const afterRedo = window.__store.getState().annotations.length
  const types = window.__store.getState().annotations.map((a) => a.type)
  await window.__store.getState().clearAnnotations()
  await w(250)
  const afterClear = window.__store.getState().annotations.length
  return { afterAdd, afterUndo, afterRedo, afterClear, types }
})()`)
check(annot.afterAdd === 4, '批注四件套（高亮/下划线/删除线/便签）都落库', `${annot.afterAdd} 条：${annot.types.join(', ')}`)
check(annot.afterUndo === 3, '撤销回退一条', `4 → ${annot.afterUndo}`)
check(annot.afterRedo === 4, '重做恢复', `3 → ${annot.afterRedo}`)
check(annot.afterClear === 0, '清空批注归零', `4 → ${annot.afterClear}`)

/* ---------- ⑧ 右侧栏不再有全屏 ---------- */
const rail = await json(`(() => {
  const buttons = Array.from(document.querySelectorAll('.rail--right button'))
  return {
    count: buttons.length,
    labels: buttons.map((b) => (b.textContent || '').trim()),
    hasFullscreen: buttons.some((b) => /全屏/.test((b.textContent || '') + (b.getAttribute('title') || '')))
  }
})()`)
check(!rail.hasFullscreen, '右侧栏没有「全屏」按钮（v2.1.3 起彻底移除）', `右侧 ${rail.count} 个按钮：${rail.labels.join('/')}`)

/* ---------- ⑨ 启动声明浮层（右下角 / 三行文案 / × 与「不再提示」） ---------- */
const showToast = async () => {
  await json(`(() => {
    window.__store.setState({ disclaimerDismissed: false })
    void window.__store.getState().patchSettings({ disclaimerHidden: false })
    return true
  })()`)
  await sleep(450)
}

await showToast()
const dis = await json(`(() => {
  const el = document.querySelector('[data-disclaimer="1"]')
  const cs = el ? getComputedStyle(el) : null
  return {
    present: !!el,
    text: el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : '',
    hasClose: !!document.querySelector('[data-tb-id="disclaimer-close"]'),
    hasMute: !!document.querySelector('[data-tb-id="disclaimer-mute"]'),
    zIndex: cs ? cs.zIndex : '',
    radius: cs ? cs.borderTopLeftRadius : '',
    right: cs ? cs.right : '',
    bottom: cs ? cs.bottom : ''
  }
})()`)
check(dis.present, '启动声明浮层出现在右下角', dis.present ? `right=${dis.right} bottom=${dis.bottom} z=${dis.zIndex}` : '未出现')
check(
  /本软件免费提供/.test(dis.text) && /早期版本/.test(dis.text) && /报告给开发者/.test(dis.text),
  '声明三行文案齐全（免费 / 早期版本 / 反馈）',
  dis.text.slice(0, 60)
)
check(dis.hasClose && dis.hasMute, '有 × 关闭按钮与「知道了，不再提示」勾选框', `×=${dis.hasClose} 勾选=${dis.hasMute}`)
check(parseFloat(dis.radius) >= 10, '浮层是圆角（≥10px）', `radius=${dis.radius}`)

// ① 只点 ×：本次消失，但不写持久化开关
const onceClose = await json(`(async () => {
  document.querySelector('[data-tb-id="disclaimer-close"]')?.click()
  await new Promise((r) => setTimeout(r, 320))
  return {
    gone: !document.querySelector('[data-disclaimer="1"]'),
    hidden: window.__store.getState().settings.disclaimerHidden,
    dismissed: window.__store.getState().disclaimerDismissed
  }
})()`)
check(
  onceClose.gone && onceClose.dismissed && !onceClose.hidden,
  '点 × 只关本次、不写「不再提示」',
  `gone=${onceClose.gone} dismissed=${onceClose.dismissed} hidden=${onceClose.hidden}`
)

// ② 勾「不再提示」再关：写进设置（持久化）
await showToast()
const mutedClose = await json(`(async () => {
  document.querySelector('[data-tb-id="disclaimer-mute"]')?.click()
  await new Promise((r) => setTimeout(r, 120))
  document.querySelector('[data-tb-id="disclaimer-close"]')?.click()
  await new Promise((r) => setTimeout(r, 380))
  return {
    gone: !document.querySelector('[data-disclaimer="1"]'),
    hidden: window.__store.getState().settings.disclaimerHidden
  }
})()`)
check(
  mutedClose.gone && mutedClose.hidden,
  '勾「不再提示」后关闭会持久化到设置',
  `gone=${mutedClose.gone} hidden=${mutedClose.hidden}`
)

// ③ 已持久化时不再出现
await json(`(async () => { await window.__store.getState().patchSettings({ disclaimerHidden: true }); return true })()`)
await sleep(250)
const afterPersist = await json(
  `(!document.querySelector('[data-disclaimer="1"]'))`
)
check(afterPersist === true, '持久化后重启不再出现（设置生效）', `present=${!afterPersist}`)

/* ---------- 收尾：恢复干净状态 ---------- */
await json(`(() => {
  const s = window.__store.getState()
  s.setMaskMode('off')
  s.setEditTool('none')
  s.setZoom('fit-width')
  s.clearAnnotations()
  s.patchSettings({ theme: 'light' })
  // 声明要在下次真的启动时出现，用例不能把「不再提示」留给用户
  window.__store.setState({ disclaimerDismissed: false })
  void s.patchSettings({ disclaimerHidden: false })
  return true
})()`)

console.log(`\n${fails === 0 ? '✓' : '✗'} 课堂辅助与日常功能 ${checks} 项里 ${fails} 项失败`)
ws.close()
process.exit(fails === 0 ? 0 : 1)
