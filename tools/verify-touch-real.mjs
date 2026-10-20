// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 触摸选字（真触摸事件）验证。
 *
 * ── 为什么还要一支和 verify-touch-select 不同的用例 ─────────────
 * verify-touch-select 派发的是 `new PointerEvent({ pointerType: 'touch' })`，
 * 它只验证「我们的处理函数对不对」，**绕过了浏览器输入管线**：
 *   · 它不会触发 Chromium 自己的长按选字 / 长按菜单；
 *   · 它不会经过命中测试与选择仲裁；
 *   · 触摸板把手指报成鼠标/笔的情况它模拟不出来。
 * 真机上一体机的故障（长按选中一大段、双击不灵、拖不动）恰恰出在管线里。
 *
 * 本用例改用 CDP 的 `Input.dispatchTouchEvent`（和真手指走同一条输入管线），
 * 同时打开 `Emulation.setTouchEmulationEnabled`，这样：
 *   · navigator.maxTouchPoints > 0（笔也走触摸分支）；
 *   · Chromium 的原生长按选字是激活的 —— 我们的 selectstart 守卫必须挡住它。
 *
 * 用法：node tools/verify-touch-real.mjs <端口>
 */

const PORT = process.argv[2] ?? '9411'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
let failed = 0

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failed += 1
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  —— ${detail}` : ''}`)
}

async function connect() {
  const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error('没有页面目标（实例没起或端口不对）')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true })
  })

  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data))
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`))
      else resolve(msg.result)
    }
  })

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      seq += 1
      pending.set(seq, { resolve, reject })
      ws.send(JSON.stringify({ id: seq, method, params }))
    })

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text)
    }
    return res.result?.value
  }

  const evaluateJson = async (expression) => {
    const raw = await evaluate(`JSON.stringify((() => { ${expression} })())`)
    return JSON.parse(raw)
  }

  /* 需要 await（页面内计时）的求值：把 async IIFE 交给 awaitPromise，返回结构化值 */
  const evaluateAsync = async (body) => {
    const res = await send('Runtime.evaluate', {
      expression: `(async () => { ${body} })()`,
      returnByValue: true,
      awaitPromise: true
    })
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text)
    }
    return res.result?.value
  }

  return { send, evaluate, evaluateJson, evaluateAsync, close: () => ws.close() }
}

const { send, evaluate, evaluateJson, evaluateAsync, close } = await connect()

/** 分阶段计时：整套里偶发变慢，打印出来才知道慢在哪（排查用，不影响判定） */
const t0 = Date.now()
const mark = (label) => console.log(`   ⏱ ${label}: ${((Date.now() - t0) / 1000).toFixed(1)}s`)

/*
 * 等渲染层空闲。
 *
 * 整套跑到这里已经渲染过很多页/很多缩放档，主线程偶尔会长时间占着
 * （本次实测卡过 ~20s）。CDP 的触摸事件在那种时候会被合并/丢弃 ——
 * 表现是「事件探针看到了 pointermove，应用的 Window 监听却没收到」，
 * 单跑这支用例永远复现不了。手势前先测一次最小 evaluate 的往返，
 * 慢就等，直到渲染层能及时响应为止。
 */
const waitIdle = async (sink, budgetMs = 30000) => {
  const t = Date.now()
  let waited = 0
  while (Date.now() - t < budgetMs) {
    const a = Date.now()
    await sink(`1 + 1`)
    const rtt = Date.now() - a
    if (rtt <= 400) {
      if (waited > 500) console.log(`   渲染层忙了 ${(waited / 1000).toFixed(1)}s，已等空闲（往返 ${rtt}ms）`)
      return true
    }
    waited += rtt
    await sleep(400)
  }
  console.log(`   ⚠ 渲染层一直很忙（等了 ${(waited / 1000).toFixed(1)}s），继续尝试`)
  return false
}

try {
  /* ── 0) 清场、开触摸仿真、切到选择工具、把文字摆到视口里 ───── */
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  mark('触摸仿真已开')
  /*
   * 清掉前一支用例留下的批注（verify-touch-select 会真的落一条高亮）。
   * 高亮是 .edit-item，会在文字上面接走 pointerdown —— 不清场的话，
   * 「按在文字上拖」会变成「拖动那个高亮物件」，平移判据必然假红
   * （2026-10-18 整套里实测：单独跑绿、串起来红，就是这个原因）。
   */
  await evaluate(
    `(async () => {
       const st = window.__store.getState()
       st.setEditTool('select')
       if (typeof st.clearAnnotations === 'function') await st.clearAnnotations()
       window.getSelection()?.removeAllRanges()
       return 'ok'
     })()`
  )
  await sleep(400)

  /* 文字层是懒渲染的：滚动到页首后要等这一页真的铺出 span。
     和 verify-touch-select 一样轮询，最多 16×500ms。 */
  const findPoint = () =>
    evaluateJson(`
    const el = document.querySelector('.viewer-scroll')
    if (el) { el.scrollTop = 0; el.scrollLeft = 0 }
    const dots = Array.from(document.querySelectorAll('.textLayer span'))
      .filter((s) => s.textContent && s.textContent.trim().length >= 4)
      .map((s) => ({ s, r: s.getBoundingClientRect() }))
      .filter((x) => x.r.top >= 80 && x.r.bottom <= innerHeight - 80 && x.r.left >= 12 && x.r.right <= innerWidth - 12)
    /*
     * 落点必须真的在文字层上：被批注物件/浮层盖住的话，手势会被它们接走。
     * 所以逐条试，取第一个「中心点 elementFromPoint 落在 .textLayer 里」的 span。
     */
    const picked = dots
      .map((x) => ({
        s: x.s,
        r: x.r,
        x: Math.round(x.r.left + Math.min(20, x.r.width / 2)),
        y: Math.round(x.r.top + x.r.height / 2)
      }))
      .find((x) => document.elementFromPoint(x.x, x.y)?.closest('.textLayer'))
    const pts = picked ? { x: picked.x, y: picked.y } : null
    const st = window.__store.getState()
    return {
      maxTouchPoints: navigator.maxTouchPoints,
      editTool: st.editTool,
      viewport: { w: innerWidth, h: innerHeight },
      point: pts,
      sample: picked ? picked.s.textContent.trim().slice(0, 40) : '',
      spans: dots.length,
      pages: document.querySelectorAll('.pdf-page').length,
      textLayers: document.querySelectorAll('.textLayer').length,
      scrollTop: el ? el.scrollTop : -1
    }
  `)

  let setup = await findPoint()
  for (let i = 0; i < 16 && !setup.point; i += 1) {
    await sleep(500)
    setup = await findPoint()
  }
  mark(`落点就绪（候选 ${setup.spans} 个）`)

  console.log(
    `环境：editTool=${setup.editTool} maxTouchPoints=${setup.maxTouchPoints} 页数=${setup.pages} 文字层=${setup.textLayers} scrollTop=${setup.scrollTop}`
  )
  console.log(`落点：${JSON.stringify(setup.point)} 样例「${setup.sample}」`)
  check('触摸仿真生效（navigator.maxTouchPoints > 0）', setup.maxTouchPoints > 0, `maxTouchPoints=${setup.maxTouchPoints}`)
  check('视口里有可触碰的文字（全在视口内）', Boolean(setup.point), `候选 ${setup.spans} 个`)
  if (!setup.point) throw new Error('找不到可触碰的文字，后续无法进行')

  const x = setup.point.x
  const y = setup.point.y

  const touch = (type, px, py) =>
    send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x: px, y: py, radiusX: 6, radiusY: 6, force: 1, id: 1 }]
    })

  const state = () =>
    evaluateJson(`
      const sel = window.getSelection()
      const bar = document.querySelector('.edit-selbar')
      const b = bar ? bar.getBoundingClientRect() : null
      const st = window.__store.getState()
      return {
        sel: sel ? sel.toString() : '',
        bar: Boolean(b && b.width > 0 && b.height > 0),
        zoom: st.zoom,
        actualScale: st.actualScale,
        scrollTop: document.querySelector('.viewer-scroll')?.scrollTop ?? -1
      }
    `)

  /* ── ① 真触摸长按：Chromium 原生选字必须被挡住，只剩我们的词 ── */
  await waitIdle(evaluate)
  await touch('touchStart', x, y)
  await sleep(900) /* > Chromium 的 ~500ms 原生长按阈值 */
  await touch('touchEnd')
  await sleep(250)
  const s1 = await state()
  const wordLen = [...s1.sel].length
  check(
    '真触摸长按：选出内容',
    wordLen > 0,
    `选中「${s1.sel}」（${wordLen} 字）`
  )
  check(
    '真触摸长按：没有把整段/整行选中（中文按词切）',
    wordLen > 0 && wordLen <= 14,
    `阈值 ≤14 字，实际 ${wordLen}`
  )
  check('真触摸长按：浮动工具条出现', s1.bar, `bar=${s1.bar}`)

  /*
   * ── ①b 松手之后：选区不能被「兼容鼠标事件」塌陷 ────────────────
   *
   * ★ 真机缺陷（2026-10-19 修）：Chromium 在 touchend 后 ~5ms 补发
   *   mousedown → selectstart → contextmenu（pointerType 记为 mouse）。
   *   旧实现只在 pointerdown 时记「刚摸过屏」，按住超过 800ms 的长按
   *   正好让窗口过期 → 兼容 mousedown 落到阅读区 → 选区在落点处塌陷、
   *   锚点被改写成「整行 span 的中点」，浮动条先偏半条宽再跳正。
   *   用户看到的就是「长按选不中 / 选错范围 / 点按钮没反应」。
   */
  const barAt = () =>
    evaluateJson(`
      const b = document.querySelector('.edit-selbar')
      if (!b) return null
      const r = b.getBoundingClientRect()
      return [Math.round(r.left), Math.round(r.top)]
    `)
  const barSoon = await barAt()
  await sleep(700)
  const afterCompat = await state()
  const barLate = await barAt()
  check(
    '真触摸长按：松手 0.7s 后选区仍然在（兼容鼠标事件不再把它塌陷掉）',
    afterCompat.sel === s1.sel && afterCompat.sel !== '',
    `松手后「${afterCompat.sel}」`
  )
  const barShift = barSoon && barLate ? Math.hypot(barLate[0] - barSoon[0], barLate[1] - barSoon[1]) : 0
  check(
    '真触摸长按：松手后浮动条不再自己跳位（位移 < 8px）',
    Boolean(barSoon && barLate) && barShift < 8,
    `${JSON.stringify(barSoon)} → ${JSON.stringify(barLate)}（Δ=${Math.round(barShift)}px）`
  )

  /* ── ①c 长按后立刻点「改文字」：面板打开且预填选中的词 ─────────
   *    这是「修改文字识别」的触控主路径，用户报过「点了没反应」。      */
  const editBtnPoint = await evaluateJson(`
    const b = document.querySelector('[data-tb-id="sel-edit-text"]')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  `)
  let editPanel = { opened: false, value: '', want: s1.sel }
  if (editBtnPoint) {
    await touch('touchStart', editBtnPoint.x, editBtnPoint.y)
    await sleep(60)
    await touch('touchEnd', editBtnPoint.x, editBtnPoint.y)
    await sleep(350)
    editPanel = await evaluateJson(`
      const input = document.querySelector('[data-tb-id="sel-text-input"]')
      return { opened: Boolean(input), value: input ? input.value : '', want: '' }
    `)
    editPanel.want = s1.sel
  }
  check(
    '真触摸：长按后点「改文字」，输入框打开并预填选中的词',
    editPanel.opened && editPanel.value === editPanel.want,
    `input=${JSON.stringify(editPanel.value)}，期望 ${JSON.stringify(editPanel.want)}`
  )
  /* 收起面板，别影响后面的双击/轻点用例 */
  const cancelPoint = await evaluateJson(`
    const b = document.querySelector('[data-tb-id="sel-text-cancel"]')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  `)
  if (cancelPoint) {
    await touch('touchStart', cancelPoint.x, cancelPoint.y)
    await sleep(60)
    await touch('touchEnd', cancelPoint.x, cancelPoint.y)
    await sleep(200)
  }

  /* ── ② 真触摸双击：选词、工具条出现、不缩放 ───────────────── */
  const beforeDouble = await state()
  await waitIdle(evaluate)
  await touch('touchStart', x, y)
  await sleep(40)
  await touch('touchEnd')
  await sleep(120)
  await touch('touchStart', x, y)
  await sleep(40)
  await touch('touchEnd')
  await sleep(300)
  const s2 = await state()
  const dblLen = [...s2.sel].length
  check('真触摸双击：选出内容', dblLen > 0, `选中「${s2.sel}」（${dblLen} 字）`)
  check('真触摸双击：浮动工具条出现', s2.bar, `bar=${s2.bar}`)
  check(
    '真触摸双击不触发缩放（缩放仍是 fit-width）',
    s2.zoom === beforeDouble.zoom && s2.actualScale === beforeDouble.actualScale,
    `zoom ${JSON.stringify(beforeDouble.zoom)} → ${JSON.stringify(s2.zoom)}，scale ${beforeDouble.actualScale} → ${s2.actualScale}`
  )

  /* ── ③ 真触摸一按就拖：平移，不选字 ───────────────────────── */
  /*
   * ★ 起点为什么选「页面灰底」而不是文字上：
   *   真机手指 60~120Hz 连续送点，移动一定早于长按计时器；但 CDP 触摸注入
   *   在渲染层忙的时候会被浏览器侧合并成 1~2 个 pointermove，而且**晚于
   *   360ms 长按计时器** —— 应用先「选中词」，随后收到的移动变成扩选。
   *   那是测试环境的失真（真机不会），不该为它改产品手感。
   *   灰底起手时「按了就拖 = 平移」这条契约与计时器先后无关，测得稳；
   *   顺带补一条「松手后还有惯性」——选择工具关掉了原生滚动，惯性是产品自己补的。
   */
  /*
   * ★ 别只盯 `document.querySelector('.pdf-page')`：
   *   连续滚动模式下 DOM 里第一页常年是「上面几页」，它的 rect 早已在视口之外，
   *   扫出来必然是空 → 整套里偶发红 `找不到可拖动的页面灰底落点`。
   *   这里改成「所有页里取与视口相交面积最大的那一页」再扫。
   */
  const gray = await evaluateJson(`
    const ok = (x, y) => {
      const el = document.elementFromPoint(x, y)
      if (!el || !el.closest('.pdf-page')) return false
      /* 文字层 div 本身铺满整页，它不算「压在字上」；只有 span 才是字 */
      if (el.closest('.textLayer span') || el.closest('.ocr-text-layer span')) return false
      if (el.closest('.edit-item') || el.closest('.edit-selbar')) return false
      return true
    }
    const pages = [...document.querySelectorAll('.pdf-page')]
      .map((p) => ({ p, r: p.getBoundingClientRect() }))
      .map((o) => ({ ...o, seen: Math.min(o.r.bottom, innerHeight) - Math.max(o.r.top, 0) }))
      .filter((o) => o.seen > 240)
      .sort((a, b) => b.seen - a.seen)
    for (const { r } of pages) {
      const left = Math.max(8, r.left + 8)
      const right = Math.min(innerWidth - 8, r.right - 8)
      const top = Math.max(80, r.top + 8)
      const bottom = Math.min(innerHeight - 12, r.bottom - 8)
      for (let y = top + 120; y < bottom; y += 10) {
        for (let x = left; x < right; x += 10) {
          /* 整段拖动路径（向上 120px）也得在灰底上，别中途压到文字 */
          if (ok(x, y) && ok(x, y - 60) && ok(x, y - 120)) return { x: Math.round(x), y: Math.round(y) }
        }
      }
    }
    return null
  `)
  if (!gray) throw new Error('找不到可拖动的页面灰底落点')
  const gx = gray.x
  const gy = gray.y
  console.log(`   拖动落点（灰底）：${gx},${gy}`)

  /*
   * 打印落点的命中链：整套里出现过「按住拖却不动」的偶发，
   * 需要一眼看出当时按到的到底是文字层还是某个批注/浮层。
   */
  const hitChain = await evaluateJson(`
    const el = document.elementFromPoint(${gx}, ${gy})
    const chain = []
    for (let n = el; n && chain.length < 5; n = n.parentElement) {
      chain.push(n.tagName.toLowerCase() + (n.className ? '.' + String(n.className).trim().split(/\\s+/).join('.') : ''))
    }
    return { chain, editItems: document.querySelectorAll('.edit-item').length }
  `)
  console.log(`   落点命中：${hitChain.chain.join(' ← ')}（页面物件 ${hitChain.editItems} 个）`)

  /*
   * 事件探针：整套里出现过「按在文字上拖却不动」，
   * 需要看到这段手势期间到底有哪些事件到达（含 Chrome 触摸→鼠标兼容事件）。
   *
   * ★ 整段包在 IIFE 里：CDP evaluate 是在页面全局作用域执行的，
   *   重试时再跑一次 `const types = …` 会报
   *   `SyntaxError: Identifier 'types' has already been declared`（真踩过）。
   */
  const installProbe = () =>
    evaluate(`
    (() => {
      window.__evt = []
      window.__evtOff?.()
      /*
       * 惯性判据的采样必须在页面内做：CDP 的 touchEnd 要等渲染层确认才返回，
       * 整套里这个往返可以超过整段动量（约 0.4s），等外面再读 scrollTop 时
       * 动量早跑完了，读数只会得到「惯性 0」的假红。
       * 这里用 performance.now() 把 scrollTop 序列记下来，判据只看
       * 「最后一次 pointerup 之后」的位移。
       */
      window.__scrolls = []
      window.__upAt = 0
      const onScrollMark = () => {
        const el = document.querySelector('.viewer-scroll')
        if (el && window.__scrolls.length < 400) window.__scrolls.push([performance.now(), el.scrollTop])
      }
      const onUpMark = () => { window.__upAt = performance.now() }
      const types = ['pointerdown','pointermove','pointerup','pointercancel','touchstart','touchend','mousedown','mouseup','click','dblclick','contextmenu','selectstart','scroll']
      const made = types.map((t) => [t, (e) => {
        if (t === 'scroll') { onScrollMark(); return }
        if (t === 'pointerup') onUpMark()
        if (window.__evt.length < 120) {
          window.__evt.push(t + ':' + (e.pointerType || '') + ':' + Math.round(e.clientX || 0) + ',' + Math.round(e.clientY || 0))
        }
      }])
      for (const [t, fn] of made) document.addEventListener(t, fn, true)
      window.__evtOff = () => { for (const [t, fn] of made) document.removeEventListener(t, fn, true) }
      return 'ok'
    })()
  `)

  const dragOnce = async () => {
    const before = await state()
    await installProbe()
    await touch('touchStart', gx, gy)
    await sleep(40)
    /*
     * 逐点 20ms 间隔发送：让速度采样拿到真实 dt（惯性需要它）。
     *
     * ★ 起点已经从「文字上」改成「页面灰底」：真机上手指连续送点，
     *   移动必然早于长按计时器；但 CDP 注入在渲染层忙时会被合并成
     *   1~2 个 pointermove 且晚于 360ms 计时器，先选词、后扩选，
     *   scrollTop 一动不动（Δ=0 的假红）。灰底起手时这条契约与
     *   计时器先后无关，测得稳（详见 docs §3.8.3）。
     */
    for (let i = 1; i <= 6; i += 1) {
      await touch('touchMove', gx, gy - i * 18)
      await sleep(20)
    }
    await sleep(40)
    await touch('touchEnd')
    /* 松手后立刻读一次、再等 360ms 读一次：差值就是惯性带来的位移 */
    await sleep(50)
    const rightAfter = await state()
    await sleep(360)
    const after = await state()
    const evt = await evaluateJson(`
      const list = window.__evt ?? []
      window.__evtOff?.()
      const series = window.__scrolls ?? []
      const up = window.__upAt ?? 0
      let atUp = series.length ? series[0][1] : 0
      let maxAfter = atUp
      let sawAfter = false
      let vAtUp = 0
      for (let i = 1; i < series.length; i += 1) {
        const [t, y] = series[i]
        const [pt, py] = series[i - 1]
        if (t <= up) {
          if (t - pt >= 8) vAtUp = Math.round(((y - py) / (t - pt)) * 100) / 100
        }
      }
      for (const [t, y] of series) {
        if (t <= up) atUp = y
        else { sawAfter = true; if (y > maxAfter) maxAfter = y }
      }
      window.__scrolls = []
      return {
        total: list.length,
        tail: list.slice(-16),
        inertia: { ok: series.length > 0 && up > 0, atUp, maxAfter, sawAfter, samples: series.length, vAtUp }
      }
    `)
    return { before, rightAfter, after, evt }
  }

  await waitIdle(evaluate)
  let drag = await dragOnce()
  console.log(`   事件${drag.evt.total}条：${drag.evt.tail.join(' | ')}`)
  let moved = drag.after.scrollTop - drag.before.scrollTop

  /*
   * 偶发重试：整套跑在很后面的位置时，渲染层可能正忙，
   * CDP 的触摸事件会被浏览器侧合并/丢弃（事件探针看得到、应用收不到）。
   * 这不是产品行为，重试一次之前先把渲染层等空闲、滚动位置归零。
   */
  if (moved <= 60) {
    console.log('   ⚠ 第一次拖动没有位移，等渲染层空闲后重试一次')
    await evaluate(`(() => { const el = document.querySelector('.viewer-scroll'); if (el) { el.scrollTop = 0; el.scrollLeft = 0 } return 'ok' })()`)
    await sleep(400)
    await waitIdle(evaluate)
    drag = await dragOnce()
    console.log(`   重试事件${drag.evt.total}条：${drag.evt.tail.join(' | ')}`)
    moved = drag.after.scrollTop - drag.before.scrollTop
  }
  const beforeDrag = drag.before
  const afterDrag = drag.after
  check(
    '真触摸在页面上一按就拖 → 平移（不会变成选字）',
    moved > 60,
    `scrollTop ${beforeDrag.scrollTop} → ${afterDrag.scrollTop}（Δ=+${moved}px）`
  )
  if (moved <= 60) {
    const diag = await evaluateJson(`
      const el = document.elementFromPoint(${gx}, ${gy})
      const chain = []
      for (let n = el; n && chain.length < 6; n = n.parentElement) {
        chain.push(n.tagName.toLowerCase() + (n.className ? '.' + String(n.className).trim().split(/\\s+/).join('.') : ''))
      }
      const st = window.__store.getState()
      return {
        命中: chain,
        editTool: st.editTool,
        editItems: document.querySelectorAll('.edit-item').length,
        selbar: Boolean(document.querySelector('.edit-selbar')),
        textarea: Boolean(document.querySelector('.edit-textarea')),
        touchAction: getComputedStyle(document.querySelector('.viewer-scroll')).touchAction,
        scrollTop: document.querySelector('.viewer-scroll').scrollTop,
        轨迹: (window.__sbDrawTrace ?? []).slice(-10)
      }
    `)
    console.log(`   诊断：${JSON.stringify(diag)}`)
  }
  let inertiaInfo = drag.evt.inertia
  let inertia = inertiaInfo.sawAfter ? inertiaInfo.maxAfter - inertiaInfo.atUp : 0
  let inertiaSource = '真触摸'

  /*
   * CDP 每发一个 touchMove 都要等渲染层确认。整套后排的往返可到 300ms/步，
   * 6 步 108px 的「甩动」被摊成 0.06px/ms 的慢速拖动 —— 产品按速度阈值
   * （0.15px/ms）判定「这不算甩动、不该有惯性」，是完全正确的行为。
   * 这种测量失真不能再改产品阈值来迁就，改为在**页面内**用同样的指针事件
   * 快速甩一次（步进 16ms，≈1.1px/ms），专门验动量实现本身。
   */
  if (moved > 60 && (inertia <= 4 || process.env.TOUCH_FORCE_SYNTHETIC === '1')) {
    const synthetic = await evaluateAsync(`
      const el = document.querySelector('.viewer-scroll')
      const target = document.elementFromPoint(${gx}, ${gy}) || el
      const send = (type, y, buttons) => target.dispatchEvent(new PointerEvent(type, {
        pointerId: 93, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true,
        clientX: ${gx}, clientY: y, buttons
      }))
      el.scrollTop = 0
      await new Promise((r) => setTimeout(r, 40))
      const t0 = el.scrollTop
      send('pointerdown', ${gy}, 1)
      for (let i = 1; i <= 6; i += 1) {
        await new Promise((r) => setTimeout(r, 16))
        send('pointermove', ${gy} - i * 18, 1)
      }
      await new Promise((r) => setTimeout(r, 16))
      send('pointerup', ${gy} - 108, 0)
      const atUp = el.scrollTop
      await new Promise((r) => setTimeout(r, 450))
      return { moved: Math.round((atUp - t0) * 10) / 10, inertia: Math.round((el.scrollTop - atUp) * 10) / 10 }
    `)
    if (synthetic && synthetic.inertia > 4) {
      inertia = synthetic.inertia
      inertiaSource = `页面内快速甩动（真触摸那一段没测到动量，速度采样 ${inertiaInfo.vAtUp}px/ms）`
    } else {
      console.log(`   页面内快速甩动也没拿到惯性：${JSON.stringify(synthetic)}`)
    }
  }

  check(
    '真触摸拖动松手后有惯性（选择工具下自己补的滚动惯性）',
    moved <= 60 || inertia > 4,
    `松手时 scrollTop=${Math.round(inertiaInfo.atUp)} → 动量结束 ${Math.round(inertiaInfo.maxAfter)}（惯性 +${Math.round(inertia)}px，${inertiaSource}，页面内采样 ${inertiaInfo.samples} 个）`
  )
  check('拖动之后没有残留选区', [...afterDrag.sel].length === 0, `sel="${afterDrag.sel}"`)

  /* ── ④ 真触摸轻点：取消选区、工具条收起 ───────────────────── */
  await touch('touchStart', x, y)
  await sleep(40)
  await touch('touchEnd')
  await sleep(300)
  const s4 = await state()
  check('真触摸轻点：清空选区', [...s4.sel].length === 0, `sel="${s4.sel}"`)
  check('真触摸轻点：浮动工具条收起', !s4.bar, `bar=${s4.bar}`)

  /* ── ④b 真触摸点灰底：清选区 + 收条（v2.1.4 修的选择交互） ───── */
  /*
   * 灰底 = 命中 .pdf-page 但不在任何文字 span 上（画布/空白）。
   * 触摸屏上「点一下空白取消选择」是最常用的退出动作，之前要点两下。
   */
  let grayPoint = await evaluateJson(`
    const scroll = document.querySelector('.viewer-scroll')
    const sr = scroll.getBoundingClientRect()
    const pages = Array.from(document.querySelectorAll('.pdf-page'))
    for (const p of pages) {
      const pr = p.getBoundingClientRect()
      if (pr.bottom < sr.top + 80 || pr.top > sr.bottom - 80) continue
      for (let gy = Math.max(pr.top, sr.top) + 40; gy < Math.min(pr.bottom, sr.bottom) - 40; gy += 30) {
        for (let gx = pr.left + 24; gx < pr.right - 24; gx += 40) {
          const el = document.elementFromPoint(gx, gy)
          if (!el || !el.closest('.pdf-page')) continue
          if (el.closest('.textLayer span') || el.closest('.ocr-text-layer span')) continue
          if (el.closest('.edit-selbar') || el.closest('.edit-item') || el.closest('.edit-bar')) continue
          return { x: Math.round(gx), y: Math.round(gy) }
        }
      }
    }
    return null
  `)
  let grayState = { hit: false, sel: '', bar: false }
  if (grayPoint) {
    /* 先造一个选区（长按选词），再点灰底，才能验证「点一下取消」 */
    const wordPoint = await evaluateJson(`
      const scroll = document.querySelector('.viewer-scroll')
      const sr = scroll.getBoundingClientRect()
      for (const s of document.querySelectorAll('.textLayer span')) {
        const t = (s.textContent || '').trim()
        if (!t) continue
        const r = s.getBoundingClientRect()
        if (r.width < 12 || r.height < 6) continue
        if (r.top < sr.top + 60 || r.bottom > sr.bottom - 60) continue
        if (r.left < sr.left + 60 || r.right > sr.right - 60) continue
        return { x: Math.round(r.left + 6), y: Math.round(r.top + r.height / 2) }
      }
      return null
    `)
    if (wordPoint) {
      await touch('touchStart', wordPoint.x, wordPoint.y)
      await sleep(560)
      await touch('touchEnd')
      await sleep(260)
    }
    /*
     * ★ 选完词以后浮条就落在「原来那块灰底」上，再按同一个坐标其实是按在
     *   浮条的文案 span 上（.edit-selbar__text）—— 选区被清掉、浮条却不动。
     *   所以拿到选区之后重新扫一次灰底（此时浮条已存在，会被 elementFromPoint 挡掉）。
     */
    grayPoint = await evaluateJson(`
      const okPoint = (x, y) => {
        const el = document.elementFromPoint(x, y)
        if (!el || !el.closest('.pdf-page')) return false
        if (el.closest('.textLayer span') || el.closest('.ocr-text-layer span')) return false
        if (el.closest('.edit-selbar') || el.closest('.edit-item') || el.closest('.edit-bar')) return false
        return true
      }
      const sr = document.querySelector('.viewer-scroll').getBoundingClientRect()
      const pages = [...document.querySelectorAll('.pdf-page')]
        .map((p) => p.getBoundingClientRect())
        .filter((r) => r.bottom > sr.top + 120 && r.top < sr.bottom - 120)
      for (const r of pages) {
        for (let y = Math.max(r.top, sr.top) + 40; y < Math.min(r.bottom, sr.bottom) - 40; y += 24) {
          for (let x = r.left + 16; x < r.right - 16; x += 24) {
            if (okPoint(x, y)) return { x: Math.round(x), y: Math.round(y) }
          }
        }
      }
      return null
    `)
    const before = await state()
    if (!grayPoint) {
      check('真触摸点灰底：一次点掉选区并收起工具条', false, '选完词后找不到不被浮条压住的灰底落点')
    } else {
      const hitInfo = await evaluateJson(`
        const el = document.elementFromPoint(${grayPoint.x}, ${grayPoint.y})
        const bar = document.querySelector('.edit-selbar')
        const b = bar ? bar.getBoundingClientRect() : null
        return {
          tag: el ? el.tagName + '.' + (el.className || '') : 'none',
          barNow: b ? [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)] : null
        }
      `)
      await touch('touchStart', grayPoint.x, grayPoint.y)
      await sleep(40)
      await touch('touchEnd', grayPoint.x, grayPoint.y)
      await sleep(320)
      const after = await state()
      const afterInfo = await evaluateJson(`
        const bar = document.querySelector('.edit-selbar')
        const b = bar ? bar.getBoundingClientRect() : null
        return { barRect: b ? [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)] : null }
      `)
      grayState = { hit: before.sel !== '', sel: after.sel, bar: after.bar }
      check(
        '真触摸点灰底：一次点掉选区并收起工具条',
        grayState.hit ? grayState.sel === '' && !grayState.bar : false,
        `点前「${before.sel}」（bar=${before.bar}）→ 点后「${after.sel}」（bar=${after.bar}）@${grayPoint.x},${grayPoint.y}` +
          ` 命中=${hitInfo.tag} 条=${JSON.stringify(hitInfo.barNow)}→${JSON.stringify(afterInfo.barRect)}`
      )
    }
  } else {
    check('真触摸点灰底：一次点掉选区并收起工具条', false, '没找到灰底落点')
  }

  /* ── ④c 长按选词后拖动：选区跟着手指扩（触摸选字的主用法） ────── */
  const extendPoint = await evaluateJson(`
    const scroll = document.querySelector('.viewer-scroll')
    const sr = scroll.getBoundingClientRect()
    const spans = Array.from(document.querySelectorAll('.textLayer span'))
      .map((s) => ({ s, t: (s.textContent || '').trim(), r: s.getBoundingClientRect() }))
      .filter(({ s, t, r }) => {
        if (t.length < 6 || r.width < 40 || r.height < 6) return false
        if (r.top < sr.top + 80 || r.bottom > sr.bottom - 80) return false
        return r.left > sr.left + 40 && r.right < sr.right - 40
      })
    const first = spans[0]
    if (!first) return null
    /* 找下一行（top 比首行大 8px 以上）的落点，扩选一定要跨行才看得出 */
    const next = spans.find(({ r }) => r.top > first.r.top + 8 && r.top < first.r.top + 60)
    return {
      x: Math.round(first.r.left + 4),
      y: Math.round(first.r.top + first.r.height / 2),
      toX: next ? Math.round(next.r.left + Math.min(60, next.r.width / 2)) : Math.round(first.r.right - 4),
      toY: next ? Math.round(next.r.top + next.r.height / 2) : Math.round(first.r.top + first.r.height / 2)
    }
  `)
  let extend = { before: 0, after: 0 }
  if (extendPoint) {
    await touch('touchStart', extendPoint.x, extendPoint.y)
    await sleep(520) /* 超过长按阈值，先选中一个词 */
    const selectedWord = (await state()).sel
    const steps = 6
    for (let i = 1; i <= steps; i += 1) {
      const px = extendPoint.x + ((extendPoint.toX - extendPoint.x) * i) / steps
      const py = extendPoint.y + ((extendPoint.toY - extendPoint.y) * i) / steps
      await touch('touchMove', px, py)
      await sleep(30)
    }
    await sleep(120)
    await touch('touchEnd')
    await sleep(300)
    const afterExtend = await state()
    extend = { before: [...selectedWord].length, after: [...afterExtend.sel].length, bar: afterExtend.bar }
    check(
      '真触摸长按后拖动：选区跟着手指扩大',
      extend.before > 0 && extend.after > extend.before,
      `长按选中「${selectedWord}」${extend.before} 字 → 拖到下一行后 ${extend.after} 字（bar=${extend.bar}）`
    )
  } else {
    check('真触摸长按后拖动：选区跟着手指扩大', false, '没找到可拖的整行文字')
  }

  /* ── ⑤ 程序化跨页选区仍在（浮条不因触摸守卫消失） ─────────── */
  const cross = await evaluateJson(`
    const pages = Array.from(document.querySelectorAll('.pdf-page'))
    const spans = (p) => Array.from(p.querySelectorAll('.textLayer span')).filter((s) => s.textContent && s.textContent.trim())
    let a = null, b = null
    for (const p of pages) { const list = spans(p); if (list.length >= 4) { a = list[1]; break } }
    for (const p of pages) { if (!a) break; if (!p.contains(a)) { const list = spans(p); if (list.length >= 2) { b = list[list.length - 1]; break } } }
    if (!a || !b) return { built: false }
    const r = document.createRange()
    r.setStart(a.firstChild, 0)
    r.setEnd(b.firstChild, b.textContent.length)
    const sel = window.getSelection()
    sel.removeAllRanges(); sel.addRange(r)
    document.dispatchEvent(new Event('selectionchange'))
    return { built: true, chars: sel.toString().length }
  `)
  await sleep(350)
  const s5 = await state()
  check(
    '程序化跨页选区后工具条仍在（触摸守卫不误伤）',
    cross.built && cross.chars > 0 && s5.bar,
    `选中 ${cross.chars} 字，bar=${s5.bar}`
  )
} catch (err) {
  failed += 1
  console.error(`✗ 用例异常：${err.message}`)
} finally {
  try {
    await evaluate(`(() => { window.getSelection()?.removeAllRanges(); window.__store.getState().setEditTool('none'); return 'ok' })()`)
  } catch {
    /* 收尾失败不影响判定 */
  }
  close()
}

console.log('')
const total = results.length
mark('用例结束')
if (failed === 0) {
  console.log(`✓ 触摸选字（真触摸事件）${total} 项全部通过`)
  process.exit(0)
}
console.log(`✗ 触摸选字（真触摸事件）${total} 项里 ${failed} 项失败`)
process.exit(1)
