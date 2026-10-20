// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 扫描件 OCR 文字层验证（v2.1.3）。
 *
 * ── 这支用例在验什么 ───────────────────────────────────────────
 * 扫描件（图片型 PDF）没有文字层，`caretRangeFromPoint` 拿不到字符，
 * 于是「选中 → 复制 → 改文字」整条主路径都失效。v2.1.3 用 tesseract.js
 * 在渲染层离线识别，把结果做成一层**透明可选文字**叠在页面上。
 *
 * 这条链路里最容易坏的不是算法，而是**资源路径**：
 *   dev 走 http://localhost，打包后走 file://，
 *   worker / wasm 核心 / 语言包任一 404，都表现为「点了识别没反应」。
 * 所以这里必须端到端真识别一次，而不是只测注入。
 *
 * 为控制体积，fixture 不放真实扫描件（十几 MB），
 * 由用例在页面里现画一张带中文的图交给识别器。
 *
 * 用法：node tools/verify-ocr.mjs <端口>
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

  return { send, evaluate, evaluateJson, close: () => ws.close() }
}

const { send, evaluate, evaluateJson, close } = await connect()

const t0 = Date.now()
const mark = (label) => console.log(`   ⏱ ${label}: ${((Date.now() - t0) / 1000).toFixed(1)}s`)

/** 真鼠标点击/拖动（走浏览器输入管线，与教师真机一致） */
async function mouse(type, x, y, extra = {}) {
  await send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: type === 'mouseMoved' ? 'none' : 'left',
    buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: 1,
    ...extra
  })
}

try {
  /* ── 1) 钩子与文档就绪 ─────────────────────────────────── */
  const ready = await evaluateJson(`
    const st = window.__store.getState()
    return {
      hooks: Boolean(window.__ocrTest),
      name: st.fileName || null,
      page: st.page,
      pages: st.pageCount,
      tool: st.editTool ?? null
    }
  `)
  check('测试钩子可用（--test-hooks）', ready.hooks, JSON.stringify(ready))
  check('文档已打开', Boolean(ready.name), `${ready.name ?? '无'}，${ready.pages} 页`)
  if (!ready.hooks || !ready.name) throw new Error('前置条件不足，后续判据跳过')

  /* 切到选择工具：OCR 文字层的选中/改字都只在选择工具下成立 */
  await evaluate(`window.__store.getState().setEditTool('select')`)
  /*
   * 等第一页渲染出画布：识别要拿真实位图。
   * 隐藏窗口里 pdf.js 的首次渲染 + 字体测量通常 0.5~2s，给足 10s。
   */
  let hasCanvas = false
  for (let i = 0; i < 20; i += 1) {
    hasCanvas = await evaluate(`Boolean(document.querySelector('.pdf-page canvas')?.width)`)
    if (hasCanvas) break
    await sleep(500)
  }
  check('第一页画布已渲染', hasCanvas)
  if (!hasCanvas) throw new Error('画布没渲染，无法识别')

  /* ── 2) 端到端识别（真资源、真 wasm、真语言包） ──────────── */
  const recognized = await evaluate(`
    (async () => {
      /* 现画一张"扫描页"：白底黑字，字号足够大（小字识别率低，样本要稳） */
      const c = document.createElement('canvas')
      c.width = 900
      c.height = 260
      const ctx = c.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, c.width, c.height)
      ctx.fillStyle = '#111111'
      ctx.font = '72px "Microsoft YaHei", sans-serif'
      ctx.textBaseline = 'middle'
      ctx.fillText('秋夕阅读器', 60, 90)
      ctx.font = '48px "Microsoft YaHei", sans-serif'
      ctx.fillText('PDF 123', 60, 190)
      const started = performance.now()
      const lines = await window.__ocrTest.recognize(c.toDataURL('image/png'), 1)
      return { lines, ms: Math.round(performance.now() - started) }
    })()
  `)
  const text = (recognized.lines ?? []).map((l) => l.text).join(' ')
  mark(`识别完成（${recognized.ms}ms）`)
  check(
    '识别出至少一行文字',
    (recognized.lines ?? []).length >= 1,
    `${recognized.lines?.length ?? 0} 行：${text.slice(0, 60)}`
  )
  check('识别结果包含中文「秋夕」', /秋夕/.test(text), text.slice(0, 60))
  check('识别结果包含英文/数字「PDF」或「123」', /PDF|123/i.test(text), text.slice(0, 60))
  const boxesOk = (recognized.lines ?? []).every(
    (l) => Number.isFinite(l.x) && Number.isFinite(l.y) && l.width > 0 && l.height > 0
  )
  check('每行都有有效的页面坐标与尺寸', (recognized.lines ?? []).length > 0 && boxesOk)

  /* ── 3) 叠成可选文字层（用真实识别结果，顺带验坐标换算） ── */
  await evaluate(`
    window.__ocrTest.inject(${JSON.stringify(recognized.lines ?? [])})
  `)
  await sleep(300)
  const layer = await evaluateJson(`
    const pageEl = document.querySelector('.pdf-page[data-page="' + window.__ocrTest.page() + '"]')
    const layerEl = pageEl?.querySelector('.pdf-page__ocr')
    if (!layerEl) return { spans: 0, inside: false, text: '' }
    const pageBox = pageEl.getBoundingClientRect()
    const spans = [...layerEl.querySelectorAll('span')]
    const inside = spans.every((s) => {
      const r = s.getBoundingClientRect()
      return r.left >= pageBox.left - 2 && r.right <= pageBox.right + 2 &&
             r.top >= pageBox.top - 2 && r.bottom <= pageBox.bottom + 2
    })
    return { spans: spans.length, inside, text: spans.map((s) => s.textContent).join(' ') }
  `)
  check('页面上出现 OCR 文字层', layer.spans > 0, `${layer.spans} 个 span`)
  check('文字层落在页面范围内', layer.spans > 0 && layer.inside)
  check('文字层内容与识别结果一致', /秋夕/.test(layer.text ?? ''), (layer.text ?? '').slice(0, 40))

  /* ── 4) 真鼠标拖动：选中 OCR 文字 ────────────────────────── */
  // 先清掉可能残留的选区：整套里前面几支（尤其触摸用例）会留下
  // 程序化选区，鼠标从「已有选区内部」按下时 Chromium 会当成拖动
  // 已选文本，不会再产生新选区 —— 那样这条判据会假红。
  await evaluate(`
    (() => {
      const sel = window.getSelection()
      if (sel) sel.removeAllRanges()
      return true
    })()
  `)
  await sleep(120)

  /* 先把页面滚回顶部：前面几支（尤其触摸拖动）可能把页面滚走，
     导致 OCR 文字被标签栏压住 —— 那样鼠标落点命中的是标签栏，不是文字 */
  await evaluate(`
    (() => {
      const sc = document.querySelector('.viewer-scroll')
      if (sc) sc.scrollTop = 0
      return true
    })()
  `)
  await sleep(250)

  /* 挑一个「真正能被点到」的 OCR 字符段：落点必须命中 OCR 层自身 */
  const spanBox = await evaluateJson(`
    const spans = [...document.querySelectorAll('.pdf-page__ocr span')]
    for (const span of spans) {
      const r = span.getBoundingClientRect()
      if (r.width <= 8 || r.height <= 0) continue
      const y = r.top + r.height / 2
      const x = r.left + Math.min(6, r.width * 0.1)
      if (y < 110 || y > window.innerHeight - 40) continue
      const hit = document.elementFromPoint(x, y)
      if (!hit || !hit.closest('.pdf-page__ocr')) continue
      return { x: r.left, y: r.top, w: r.width, h: r.height, text: span.textContent }
    }
    return null
  `)
  check('找到可拖选的 OCR 字符段', Boolean(spanBox) && spanBox.w > 8, spanBox ? `${Math.round(spanBox.w)}x${Math.round(spanBox.h)}` : '无')

  let selected = ''
  if (spanBox) {
    const y = spanBox.y + spanBox.h / 2
    const x0 = spanBox.x + Math.min(6, spanBox.w * 0.1)
    const x1 = spanBox.x + spanBox.w * 0.9
    await mouse('mousePressed', x0, y)
    for (let i = 1; i <= 6; i += 1) {
      await mouse('mouseMoved', x0 + ((x1 - x0) * i) / 6, y)
      await sleep(20)
    }
    await mouse('mouseReleased', x1, y)
    await sleep(300)
    selected = await evaluate(`window.getSelection()?.toString() ?? ''`)
  }
  check('鼠标拖选能选中 OCR 文字', selected.trim().length > 0, JSON.stringify(selected.slice(0, 24)))

  /* ── 5) 选中后浮条出现，且「改文字」预填正确 ─────────────── */
  const bar = await evaluateJson(`
    const bar = document.querySelector('.edit-selbar')
    const btn = document.querySelector('[data-tb-id="sel-edit-text"]')
    return {
      bar: Boolean(bar),
      btn: Boolean(btn),
      quote: window.__store.getState().annotationAnchor?.quote ?? null
    }
  `)
  check('选中后出现浮动工具条', bar.bar && bar.btn, JSON.stringify(bar))

  let prefilled = null
  if (bar.btn) {
    const b = await evaluateJson(`
      const r = document.querySelector('[data-tb-id="sel-edit-text"]').getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    `)
    await mouse('mousePressed', b.x, b.y)
    await mouse('mouseReleased', b.x, b.y)
    await sleep(400)
    prefilled = await evaluateJson(`
      const input = document.querySelector('[data-tb-id="sel-text-input"]')
      return input ? { value: input.value, panel: true } : { value: null, panel: false }
    `)
  }
  check('「改文字」面板打开并预填选中内容', Boolean(prefilled?.panel) && (prefilled?.value ?? '').length > 0, JSON.stringify(prefilled?.value ?? null))

  /* ── 6) 清理 ─────────────────────────────────────────────── */
  await evaluate(`window.__ocrTest.clear()`)
  await sleep(200)
  const cleared = await evaluateJson(`
    return {
      spans: document.querySelectorAll('.pdf-page__ocr span').length,
      bar: Boolean(document.querySelector('.edit-selbar'))
    }
  `)
  check('清理后文字层与工具条都消失', cleared.spans === 0, `spans=${cleared.spans}`)

  mark('全部判据完成')
} catch (err) {
  check('用例执行', false, String(err?.message ?? err))
} finally {
  const passed = results.length - failed
  console.log(`\n  OCR 文字层：${passed} / ${results.length} 通过${failed ? `，${failed} 项失败` : ''}`)
  close()
  process.exit(failed ? 1 : 0)
}
