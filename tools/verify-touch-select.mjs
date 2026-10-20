// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 「选择」工具在**触摸屏**上的交互验证（2026-10-18 的交互优化）。
 *
 * ── 为什么要有这支用例 ───────────────────────────────────────
 *   一体机上的老师用「选择」工具选字，反馈过三件事：
 *     ① 手指按在字上拖，页面跟着滚，一个字都选不出来；
 *     ② 拖过页边界（第 1 页拖到第 2 页）浮动工具条**当场消失**；
 *     ③ 工具条按钮手指点不中。
 *   前两条是行为缺陷，第三条是 CSS 尺寸问题。三处都改了，
 *   这支用例把「手指下的分工」钉死，防止以后回退。
 *
 * ── 被测的分工（见 DocumentView.startTouchSelect / AnnotationLayer.selectionToRects）──
 *   · 轻点             → 取消选区（工具条收起）
 *   · 快速连点两下     → 选中该处这个词
 *   · 长按 420ms       → 选中该处这个词，继续拖动**扩选**
 *   · 一按就拖（>10px）→ 平移页面（选择工具下也要能翻页）
 *   · 选区跨页         → 锚点只挂在起点那一页，矩形裁到该页，工具条不消失
 *
 * ── 断言前提 ─────────────────────────────────────────────────
 *   选择工具下 `.viewer-scroll` 的 touch-action 必须是 none
 *   （否则原生滚动会和长按选词打架），这是 ① 的判据。
 *   触摸用合成 PointerEvent（pointerType:'touch'）派发：
 *   本实现响应的是 pointer 事件，合成 TouchEvent 不会产生 pointer 事件。
 *
 * 用法：node tools/verify-touch-select.mjs [端口]
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

/** 在页面里跑一段语句，并把结果当 JSON 取回来（失败时回带原文，便于定位） */
function page(body) {
  const raw = cdp(`JSON.stringify((() => { ${body} })())`)
  try {
    return JSON.parse(raw)
  } catch {
    return { __raw: String(raw).slice(0, 300) }
  }
}

/**
 * 跑一段**异步**语句并等它完成（cdp-eval 带 awaitPromise）。
 *
 * ★ 手势类调用必须走这个：页面内的 await 才不受 cdp 往返延迟影响，
 *   详见 INSTALL 里 tap/holdDrag/drag/doubleTap 的注释。
 */
function pageAsync(body) {
  const raw = cdp(`(async () => { ${body} })().then((v) => JSON.stringify(v))`)
  try {
    return JSON.parse(raw)
  } catch {
    return { __raw: String(raw).slice(0, 300) }
  }
}

const fails = []
let checks = 0
function check(ok, label, extra) {
  checks += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra === undefined ? '' : `  —— ${extra}`}`)
  if (!ok) fails.push(label)
}

/* ============================================================
 * 页面侧助手（只装一次，后续所有 cdp 调用都复用它）
 * ============================================================ */
const INSTALL = `
  if (window.__tsHelper) return '已就绪'
  const SCROLL = () => document.querySelector('.viewer-scroll')

  /** 派发一个触摸指针事件（React 与 window 捕获都能收到） */
  const P = (type, x, y, id = 71) => {
    const el = document.elementFromPoint(x, y) || SCROLL()
    if (!el) return '无目标'
    const ev = new PointerEvent(type, {
      pointerId: id,
      pointerType: 'touch',
      isPrimary: true,
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: Math.round(x),
      clientY: Math.round(y),
      button: type === 'pointermove' ? -1 : 0,
      buttons: type === 'pointerdown' ? 1 : 0
    })
    el.dispatchEvent(ev)
    return el.className
  }

  /**
   * 找一页里「可以按下去的文字」，返回一个**在视口内**的落点。
   *
   * ★ 两个坑都在这里踩过：
   *   1. 刚启动时文字层是懒渲染的 —— 拿不到就返回 null，由调用方轮询等待；
   *   2. 恢复上次阅读位置会让视口停在别的页 —— 只有 elementFromPoint 能命中的点才有意义，
   */
  const spanPoint = (page, nth = 1) => {
    const vh = window.innerHeight
    const vw = window.innerWidth
    const visible = (r) =>
      r.width >= 6 && r.height >= 6 && r.top >= 60 && r.bottom <= vh - 60 && r.left >= 8 && r.right <= vw - 8
    const order = [page, 1, 2, 3].filter((p, i, a) => p > 0 && a.indexOf(p) === i)
    for (const p of order) {
      const spans = Array.from(
        document.querySelectorAll('.pdf-page[data-page="' + p + '"] .textLayer span')
      )
        .filter((s) => (s.textContent || '').trim().length > 0)
        .filter((s) => visible(s.getBoundingClientRect()))
      if (spans.length === 0) continue
      /* 优先挑文字长一点的（选词才有意义） */
      const long = spans.filter((s) => (s.textContent || '').trim().length >= 4)
      const pool = long.length ? long : spans
      const pick = pool[Math.min(nth, pool.length - 1)]
      if (!pick) continue
      const r = pick.getBoundingClientRect()
      return {
        x: Math.round(r.left + Math.min(6, r.width / 2)),
        y: Math.round(r.top + r.height / 2),
        text: (pick.textContent || '').trim(),
        page: p
      }
    }
    return null
  }

  /** 视口里页面外的灰底上取一点（用来测「空白处拖=平移」） */
  const marginPoint = () => {
    const pageEl = document.querySelector('.pdf-page[data-page]')
    if (!pageEl) return null
    const r = pageEl.getBoundingClientRect()
    const vw = window.innerWidth
    const y = Math.round(Math.min(Math.max(r.top + 40, 120), window.innerHeight - 120))
    if (r.right + 24 < vw - 8) return { x: Math.round(r.right + 24), y }
    if (r.left - 24 > 8) return { x: Math.round(r.left - 24), y }
    return { x: Math.round(vw - 12), y }
  }

  /** 把视口拉回顶部（位置恢复会把它停在别处，测坐标前必须归零） */
  const toTop = () => {
    const el = SCROLL()
    if (!el) return null
    el.scrollTop = 0
    el.scrollLeft = 0
    return el.scrollTop
  }

  /*
   * ── 手势必须整段在页面里跑 ────────────────────────────────
   *
   * ★ 一次 cdp-eval 的往返是 200~400ms（起 node 进程 + 连 ws）。
   *   如果「按下」和「抬起」分成两次调用，长按计时器（420ms）就会
   *   在两次调用之间自己走完 —— 轻点变成"长按选词"，平移变成"扩选"，
   *   测出来的全是假故障。所以下面每个手势都在页面内用 await 排时序，
   *   一次调用跑完。
   */
  const sleepIn = (ms) => new Promise((r) => setTimeout(r, ms))

  /** 轻点/长按：hold 决定是 tap（<420ms）还是 long-press（>420ms） */
  const tap = async (x, y, hold = 80) => {
    P('pointerdown', x, y)
    await sleepIn(hold)
    P('pointerup', x, y)
    await sleepIn(120)
    return { sel: (window.getSelection()?.toString() ?? '').trim() }
  }

  /** 按住 hold 毫秒后向右拖 dx，再松手（长按扩选） */
  const holdDrag = async (x, y, dx, steps = 6, step = 60, hold = 620) => {
    P('pointerdown', x, y)
    await sleepIn(hold)
    for (let i = 1; i <= steps; i += 1) {
      P('pointermove', x + (dx * i) / steps, y)
      await sleepIn(step)
    }
    P('pointerup', x + dx, y)
    await sleepIn(120)
    return { sel: (window.getSelection()?.toString() ?? '').trim() }
  }

  /** 按下就拖（<420ms 内起手）：用来测「拖=平移」 */
  const drag = async (x, y, dx, dy, steps = 5, step = 45) => {
    const el = SCROLL()
    const before = el ? el.scrollTop : -1
    P('pointerdown', x, y)
    await sleepIn(40)
    for (let i = 1; i <= steps; i += 1) {
      P('pointermove', x + (dx * i) / steps, y + (dy * i) / steps)
      await sleepIn(step)
    }
    P('pointerup', x + dx, y + dy)
    await sleepIn(150)
    return {
      before: Math.round(before),
      after: Math.round(SCROLL()?.scrollTop ?? -1),
      sel: (window.getSelection()?.toString() ?? '').trim()
    }
  }

  /** 连点两下（第二下之前 gap 毫秒） */
  const doubleTap = async (x, y, gap = 90) => {
    P('pointerdown', x, y)
    P('pointerup', x, y)
    await sleepIn(gap)
    P('pointerdown', x, y)
    await sleepIn(70)
    P('pointerup', x, y)
    await sleepIn(150)
    return { sel: (window.getSelection()?.toString() ?? '').trim() }
  }

  window.__tsHelper = {
    press: (x, y) => P('pointerdown', x, y),
    move: (x, y) => P('pointermove', x, y),
    up: (x, y) => P('pointerup', x, y),
    tap,
    holdDrag,
    drag,
    doubleTap,
    scrollTop: () => Math.round((SCROLL()?.scrollTop ?? 0) * 100) / 100,
    spanPoint,
    marginPoint,
    toTop,
    selection: () => (window.getSelection()?.toString() ?? '').trim(),
    barVisible: () => {
      const el = document.querySelector('.edit-selbar')
      if (!el) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    },
    touchAction: () => SCROLL() ? getComputedStyle(SCROLL()).touchAction : ''
  }
  return '已安装'
`
/* ★ 分号不能省：上一行是模板字符串，紧接 `(async () => {…})` 会被解析成
 *   「把模板当成函数调用」（报 `"<整段模板>" is not a function`）。 */
;(async () => {
  console.log('=== 「选择」工具触摸交互验证 ===\n')

  /* ---------- ⓪ 前置：实例可用、切到选择工具 ---------- */
  const alive = page(`return !!window.__store && !!document.querySelector('.viewer-scroll')`)
  if (alive !== true) {
    console.log('  ✗ 端口 ' + PORT + ' 上没有可用的实例（先由套件实例启动）')
    console.log('\n=== 结果：未通过 ✗ ===')
    process.exitCode = 1
    return
  }

  const ready = page(INSTALL)
  console.log('⓪ 准备：', ready === '已安装' ? '页面助手就绪' : ready)

  page(`
    const s = window.__store.getState()
    s.setEditTool('select')
    s.setZoom('fit-width')
    window.getSelection()?.removeAllRanges()
    return true
  `)
  await sleep(500)

  const prep = page(`
    return {
      cls: document.querySelector('.viewer-scroll')?.className ?? '',
      touchAction: window.__tsHelper.touchAction(),
      page: window.__store.getState().page,
      pages: document.querySelectorAll('.pdf-page').length
    }
  `)
  check(
    typeof prep.cls === 'string' && prep.cls.includes('is-edit-select'),
    '选择工具激活后视口带 is-edit-select',
    prep.cls
  )
  check(
    prep.touchAction === 'none',
    '选择工具下 touch-action 改成 none（原生滚动让位给长按选词）',
    prep.touchAction
  )

  /* 文字层是懒渲染的 + 可能恢复到了上次的阅读位置：先拉回顶部，等它铺好再取落点 */
  page(`return window.__tsHelper.toTop()`)
  await sleep(300)
  let point = null
  for (let i = 0; i < 16; i += 1) {
    point = page(`return window.__tsHelper.spanPoint(1, 1)`)
    if (point && point.x !== undefined) break
    page(`return window.__tsHelper.toTop()`)
    await sleep(500)
  }
  if (!point || point.x === undefined) {
    const diag = page(`
      return {
        pages: document.querySelectorAll('.pdf-page').length,
        textLayers: document.querySelectorAll('.pdf-page .textLayer').length,
        spans: document.querySelectorAll('.pdf-page .textLayer span').length,
        p1spans: document.querySelectorAll('.pdf-page[data-page="1"] .textLayer span').length,
        zoom: window.__store.getState().zoom,
        painter: document.querySelectorAll('.pdf-page__canvas').length
      }
    `)
    check(false, '第 1 页找得到可触碰的文字', JSON.stringify(diag))
    console.log('\n=== 结果：未通过 ✗ ===')
    process.exitCode = 1
    return
  }
  console.log(
    `   文字落点：第 ${point.page} 页 (${point.x}, ${point.y})  「${String(point.text).slice(0, 16)}…」`
  )

  /* ---------- ① 长按 → 选中该词，工具条出现 ---------- */
  const held = pageAsync(`return window.__tsHelper.tap(${point.x}, ${point.y}, 620)`)
  const heldState = page(`
    return { bar: window.__tsHelper.barVisible() }
  `)
  check(typeof held.sel === 'string' && held.sel.length > 0, '长按 620ms 选中了文字', JSON.stringify(held.sel))
  check(held.sel.length <= 16, '长按选的是「一个词」，不是整段', String(held.sel).length + ' 字')
  check(heldState.bar === true, '选中后浮动工具条出现', String(heldState.bar))
  const heldLen = String(held.sel ?? '').length

  /* ---------- ② 长按后继续拖动 → 扩选 ---------- */
  const extended = pageAsync(`return window.__tsHelper.holdDrag(${point.x}, ${point.y}, 132)`)
  check(
    typeof extended.sel === 'string' && extended.sel.length > heldLen,
    '长按后拖动可以继续扩选',
    `${heldLen} 字 → ${String(extended.sel).length} 字`
  )

  /* ---------- ③ 轻点 → 取消选区 ---------- */
  const tapped = pageAsync(`return window.__tsHelper.tap(${point.x}, ${point.y}, 90)`)
  const tappedState = page(`
    return { sel: window.__tsHelper.selection(), bar: window.__tsHelper.barVisible() }
  `)
  check(String(tappedState.sel ?? '').length === 0, '轻点一次清掉选区', JSON.stringify(tappedState.sel))
  check(tappedState.bar === false, '轻点后浮动工具条收起', String(tappedState.bar))

  /* ---------- ④ 连点两下 → 选中该词 ---------- */
  const doubled = pageAsync(`return window.__tsHelper.doubleTap(${point.x}, ${point.y}, 90)`)
  const doubledState = page(`
    return { sel: window.__tsHelper.selection(), bar: window.__tsHelper.barVisible() }
  `)
  check(
    String(doubled.sel ?? '').length > 0 && String(doubled.sel).length <= 16,
    '双击选中一个词（并且没有把页面缩放掉）',
    JSON.stringify(doubled.sel)
  )
  check(doubledState.bar === true, '双击选词后工具条出现', String(doubledState.bar))

  const zoomAfterDouble = page(`
    const s = window.__store.getState()
    return { zoom: s.zoom, scale: Math.round(s.actualScale * 100) / 100 }
  `)
  check(
    zoomAfterDouble.zoom === 'fit-width',
    '双击不再顺带切缩放（选择工具下双击归选词）',
    JSON.stringify(zoomAfterDouble)
  )

  /* ---------- ⑤ 一按就拖 → 平移页面，且不选字 ----------
   * 两个落点都测：灰底上起手（最常见的翻页姿势）、文字上起手（不想选字时也能滚）。
   * 起手 40ms 内就动，长按计时器（360ms）还没到，所以走的是平移分支。
   *
   * ★ 位移判据是**区间**而不是 ±24：v2.1.3 给触摸平移加了惯性
   *   （松手后还会再滑一段），所以松手后测到的 Δ 会比手指实际拖的 90px 大
   *   （实测 129px）。手指拖动本身仍是 90px，判据只要求「明显滚动了」。 */
  const panFrom = (x, y, label) => {
    const r = pageAsync(`return window.__tsHelper.drag(${x}, ${y}, 0, -90)`)
    const moved = typeof r.after === 'number' ? r.after - r.before : NaN
    check(
      Number.isFinite(moved) && moved >= 84 && moved <= 240,
      `${label}手指拖动可以平移页面`,
      `scrollTop ${r.before} → ${r.after}（Δ=${moved}，手指 90px + 惯性）`
    )
    check(String(r.sel ?? '').length === 0, `${label}平移时不会顺手选中文字`, JSON.stringify(r.sel))
    page(`return window.__tsHelper.toTop()`)
  }

  const margin = page(`return window.__tsHelper.marginPoint()`)
  if (margin && margin.x !== undefined) {
    panFrom(margin.x, margin.y, '选择工具下灰底起手：')
    /* 文字上起手：移动量超过 slop 就该当平移，而不是选字 */
    panFrom(point.x, point.y, '文字上起手（不选字）：')
  } else {
    check(false, '找得到页面外的灰底（用来测平移）', JSON.stringify(margin))
  }

  /* ---------- ⑥ 跨页选区：工具条不消失，高亮只落在起始页 ---------- */
  page(`
    const s = window.__store.getState()
    s.setZoom('fit-width')
    s.setPage(1)
    return true
  `)
  await sleep(400)
  const crossSetup = page(`
    /* 确认第 1、2 页的文字层都在（连续滚动时相邻页都在视口附近） */
    const spans1 = document.querySelectorAll('.pdf-page[data-page="1"] .textLayer span')
    const spans2 = document.querySelectorAll('.pdf-page[data-page="2"] .textLayer span')
    if (!spans1.length || !spans2.length) return { ok: false, n1: spans1.length, n2: spans2.length }
    const first = spans1[Math.min(3, spans1.length - 1)].firstChild
    const second = spans2[Math.min(2, spans2.length - 1)].firstChild
    if (!first || !second) return { ok: false, why: '空文本节点' }
    const range = document.createRange()
    range.setStart(first, 0)
    range.setEnd(second, Math.min(12, (second.data || '').length))
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    return { ok: true, text: sel.toString().trim().slice(0, 40) }
  `)
  await sleep(400)

  if (!crossSetup || crossSetup.ok !== true) {
    check(false, '跨页选区的测试前提成立（两页都有文字层）', JSON.stringify(crossSetup))
  } else {
    console.log(`   跨页选中：「${String(crossSetup.text).slice(0, 24)}…」`)
    const cross = page(`
      const bar = document.querySelector('.edit-selbar')
      return {
        bar: !!bar,
        visible: bar ? bar.getBoundingClientRect().width > 0 : false,
        text: (window.getSelection()?.toString() ?? '').trim().length
      }
    `)
    check(cross.bar === true && cross.visible === true, '跨页选区时浮动工具条不消失（旧实现会当场没掉）', JSON.stringify(cross))

    /* 点「高亮」：应当只在起始页（第 1 页）落一条，且矩形都在页内 */
    const before = page(`return window.__store.getState().annotations.length`)
    page(`document.querySelector('[data-tb-id="sel-highlight"]')?.click(); return true`)
    await sleep(500)
    const after = page(`
      const s = window.__store.getState()
      const list = s.annotations.filter((a) => a.type === 'highlight')
      const last = list[list.length - 1]
      /* 页面坐标系（scale=1）的页面尺寸：store 里没有 pageSize，
         用 DOM 的 CSS 尺寸除以实际缩放反推（批注 rect 就是这套坐标）。 */
      const pageEl = document.querySelector('.pdf-page[data-page="1"]')
      const scale = s.actualScale > 0 ? s.actualScale : 1
      const box = pageEl
        ? {
            width: pageEl.getBoundingClientRect().width / scale,
            height: pageEl.getBoundingClientRect().height / scale
          }
        : { width: 0, height: 0 }
      return {
        total: s.annotations.length,
        highlights: list.length,
        page: last?.page,
        rects: last?.rects?.length ?? 0,
        页内: last
          ? last.rects.every(
              (r) =>
                r.x >= -1 &&
                r.y >= -1 &&
                r.width > 0 &&
                r.height > 0 &&
                r.x + r.width <= box.width + 1 &&
                r.y + r.height <= box.height + 1
            )
          : false,
        box: { w: Math.round(box.width), h: Math.round(box.height), scale: Math.round(scale * 100) / 100 }
      }
    `)
    check(after.total > before, '跨页选区点「高亮」成功落库', `${before} → ${after.total}`)
    check(after.page === 1, '高亮挂在起始页（第 1 页）', String(after.page))
    check(after.rects > 0, '高亮带着矩形', String(after.rects) + ' 个')
    check(after.页内 === true, '高亮矩形被裁在页面范围内（不越界到灰底上）', JSON.stringify(after.box))

    /* 收尾：删掉这条高亮，别把脏数据留给后面的用例 */
    page(`
      const s = window.__store.getState()
      const list = s.annotations.filter((a) => a.type === 'highlight')
      const last = list[list.length - 1]
      if (last) void s.removeAnnotation(last.id)
      return true
    `)
    await sleep(300)
  }

  /* ---------- ⑦ 收尾：退出选择工具 ---------- */
  page(`
    window.getSelection()?.removeAllRanges()
    window.__store.getState().setEditTool('none')
    return true
  `)
  await sleep(200)
  const restored = page(`
    return {
      cls: document.querySelector('.viewer-scroll')?.className ?? '',
      touchAction: window.__tsHelper.touchAction()
    }
  `)
  check(
    !String(restored.cls).includes('is-edit-select') && restored.touchAction !== 'none',
    '退出选择工具后触摸交回原生滚动',
    `${restored.cls} / ${restored.touchAction}`
  )

  console.log(`\n=== 结果：${fails.length === 0 ? '全部通过 ✓' : '未通过 ✗'} ===`)
  if (fails.length) for (const f of fails) console.log('  - ' + f)
  process.exitCode = fails.length === 0 ? 0 : 1
})().catch((error) => {
  console.error('脚本异常：', error)
  process.exitCode = 1
})
