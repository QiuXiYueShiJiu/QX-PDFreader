/**
 * 临时脚本：为 README 拍一轮「全功能演示 + 各界面 + 多主题」截图（标准版界面）。
 * 用法：先起隐藏实例与帧泵，再 node tools/_shot-set.mjs <port>
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const PORT = Number(process.argv[2] ?? 9801)
const OUT = resolve('docs/screenshots')
mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function pageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* 还没起来 */
    }
    await sleep(500)
  }
  throw new Error('找不到页面调试目标')
}

const target = await pageTarget()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})

let seq = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve: ok, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(msg.error.message))
    else ok(msg.result)
  }
})
function send(method, params = {}) {
  const id = ++seq
  return new Promise((ok, reject) => {
    pending.set(id, { resolve: ok, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'evaluate 失败')
  return r.result?.value
}

async function shot(name) {
  await sleep(560)
  let best = null
  for (let i = 0; i < 3; i++) {
    const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    const buf = Buffer.from(r.data, 'base64')
    if (!best || buf.length > best.length) best = buf
    await sleep(180)
  }
  writeFileSync(join(OUT, name), best)
  console.log(`  ✓ ${name}  ${Math.round(best.length / 1024)} KB`)
}

async function waitFor(expression, budget = 24000, step = 300) {
  const deadline = Date.now() + budget
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return true
    await sleep(step)
  }
  return false
}

/** 鼠标拖一条线（用于手写、拖选、画框） */
async function drag(from, to, steps = 10) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 })
  for (let i = 1; i <= steps; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x + ((to.x - from.x) * i) / steps,
      y: from.y + ((to.y - from.y) * i) / steps,
      button: 'left'
    })
    await sleep(14)
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 })
  await sleep(220)
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 1600,
  height: 1000,
  deviceScaleFactor: 1.5,
  mobile: false
})
await send('Emulation.setFocusEmulationEnabled', { enabled: true })
await send('Page.setWebLifecycleState', { state: 'active' })

if (!(await waitFor(`Boolean(window.__store && document.querySelector('.pdf-page__canvas'))`, 60000))) {
  throw new Error('页面没就绪')
}

const reset = `(async () => {
  const s = window.__store.getState()
  const keep = s.tabs[s.tabs.length - 1]
  for (const t of [...s.tabs]) if (keep && t.id !== keep.id) s.closeTab(t.id)
  if (keep) s.switchTab(keep.id)
  await s.patchSettings({ theme: 'light' })
  s.setViewMode('continuous')
  s.setMaskMode('off')
  s.setEditTool('none')
  s.setShowSettings(false)
  s.setShowTools(false)
  s.setShowSearch(false)
  s.setSidebarTab('thumbnails')
  if (!s.showSidebar) s.toggleSidebar()
  await s.clearAnnotations()
  window.getSelection()?.removeAllRanges()
  s.dismissDisclaimer()
  s.setUpdateInfo(null)
  return true
})()`

await evaluate(reset)
await sleep(400)
await evaluate(`(async () => { window.__store.getState().openFile(resolve('docs', '示例文档.pdf')); return true })()`)
await sleep(2600)
await evaluate(`(async () => { const s = window.__store.getState(); const keep = s.tabs[s.tabs.length - 1]; for (const t of [...s.tabs]) if (keep && t.id !== keep.id) s.closeTab(t.id); if (keep) s.switchTab(keep.id); return true })()`)
await sleep(900)
await evaluate(`(async () => { const s = window.__store.getState(); if (!s.pageCount) return false; s.setPage(2); return true })()`)
await sleep(1000)

/* ========== 一、界面总览 ========== */
await shot('01-main.png')

await evaluate(`(async () => { window.__store.getState().setViewMode('single'); return true })()`)
await sleep(900)
await shot('02-single.png')

await evaluate(`(async () => { const s = window.__store.getState(); s.setViewMode('facing'); s.setPage(2); return true })()`)
await sleep(1100)
await shot('03-facing.png')

await evaluate(`(async () => {
  const s = window.__store.getState()
  s.setViewMode('continuous')
  s.setPage(2)
  s.setSidebarTab('outline')
  return true
})()`)
await sleep(1000)
await shot('04-outline.png')

/* ========== 二、搜索 ========== */
await evaluate(`(async () => { window.__store.getState().setSidebarTab('search'); return true })()`)
await sleep(700)
await evaluate(`(() => {
  const input = document.querySelector('.search-panel__input')
  if (!input) return false
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, 'PDF')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await sleep(2400)
await shot('05-search.png')
await evaluate(`(async () => { const s = window.__store.getState(); s.setShowSearch(false); s.setSidebarTab('thumbnails'); return true })()`)
await sleep(600)

/* ========== 三、批注（高亮/下划线/删除线/便签） ========== */
const anno = await evaluate(`(() => {
  const page = document.querySelector('.pdf-page[data-page="2"]')
  if (!page) return { ok: false, why: '没有第 2 页' }
  const pr = page.getBoundingClientRect()
  const sc = window.__store.getState().actualScale || 1
  const spans = [...page.querySelectorAll('.textLayer span')]
    .map((el) => ({ el, r: el.getBoundingClientRect(), t: (el.textContent || '').trim() }))
    .filter((x) => x.t.length > 4 && x.r.width > 120 && x.r.top > pr.top + 130 && x.r.bottom < pr.bottom - 220)
  if (spans.length < 4) return { ok: false, why: '可选行不足 ' + spans.length }
  const mid = (spans[0].r.top + spans[spans.length - 1].r.top) / 2
  const picked = spans
    .sort((a, b) => Math.abs(a.r.top - mid) - Math.abs(b.r.top - mid))
    .slice(0, 4)
    .sort((a, b) => a.r.top - b.r.top)
  const mk = (x, type, color) => ({
    page: 2,
    type,
    color,
    quote: x.t,
    at: Date.now(),
    rects: [{
      x: (x.r.left - pr.left) / sc,
      y: (x.r.top - pr.top) / sc,
      width: x.r.width / sc,
      height: Math.max(8, x.r.height / sc)
    }]
  })
  const s = window.__store.getState()
  s.addAnnotation(mk(picked[0], 'highlight', '#f7d154'))
  s.addAnnotation(mk(picked[1], 'highlight', '#8fd694'))
  s.addAnnotation(mk(picked[2], 'underline', '#e5484d'))
  s.addAnnotation({ ...mk(picked[3], 'strikeout', '#2f6fed'), note: '这一行改成「先翻页、再点批注」' })
  window.getSelection()?.removeAllRanges()
  return { ok: true, rows: picked.length, annos: window.__store.getState().annotations.length }
})()`)
console.log('   批注', JSON.stringify(anno))
await sleep(700)
await shot('06-annotate.png')

/* ========== 四、画笔手写 ========== */
await evaluate(`(async () => {
  const s = window.__store.getState()
  await s.clearAnnotations()
  s.setDrawColor('#e5484d')
  s.setDrawWidth(3)
  s.setDrawMode(true)
  return true
})()`)
await sleep(500)
const geo = await evaluate(`(() => {
  const page = document.querySelector('.pdf-page[data-page="2"]')
  const r = page.getBoundingClientRect()
  return { l: r.left, t: r.top, w: r.width, h: r.height }
})()`)
const baseY = Math.min(geo.t + geo.h * 0.55, 760)
/*
 * 画笔只认 pen/touch 指针。用 CDP 的 mousePressed/Moved/Released 带上
 * pointerType:'pen' 走真实输入管线；落点必须留在视口内——页面高 1600+，
 * 取 h*0.62 会落到屏幕外，事件根本不进窗口（踩过一次，笔迹始终为空）。
 */
const penStroke = async (x0, x1, amp, color) => {
  await evaluate(`(() => { window.__store.getState().setDrawColor('${color}'); return true })()`)
  const n = 14
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: x0, y: baseY, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.5
  })
  for (let i = 1; i <= n; i += 1) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: x0 + ((x1 - x0) * i) / n,
      y: baseY - Math.sin((i / n) * Math.PI) * amp,
      button: 'left',
      buttons: 1,
      pointerType: 'pen',
      force: 0.5
    })
    await sleep(14)
  }
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: x1, y: baseY, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen'
  })
  await sleep(260)
}
await penStroke(geo.l + geo.w * 0.16, geo.l + geo.w * 0.34, 26, '#e5484d')
await penStroke(geo.l + geo.w * 0.40, geo.l + geo.w * 0.58, 20, '#2f6fed')
await penStroke(geo.l + geo.w * 0.64, geo.l + geo.w * 0.82, 30, '#16a34a')
await evaluate(`(async () => { window.__store.getState().setDrawMode(false); return true })()`)
await sleep(500)
await shot('07-pen.png')

/* ========== 五、选中文字浮条 / 改文字 / 改格式 ========== */
/* 浮条上的「复制 / 改文字 / 格式」只在选择工具下出现（非选择工具给的是批注四条） */
await evaluate(`(async () => { window.__store.getState().setEditTool('select'); return true })()`)
await sleep(400)
const spot = await evaluate(`(() => {
  const page = document.querySelector('.pdf-page[data-page="2"]')
  const pr = page.getBoundingClientRect()
  const spans = [...page.querySelectorAll('.textLayer span')]
    .map((el) => ({ r: el.getBoundingClientRect(), t: (el.textContent || '').trim() }))
    .filter((x) => x.t.length >= 8 && x.r.width > 200 && x.r.top > pr.top + 140 && x.r.bottom < pr.bottom - 240)
  if (!spans.length) return null
  const a = spans[0], b = spans[Math.min(1, spans.length - 1)]
  return {
    from: { x: a.r.left + 6, y: a.r.top + a.r.height / 2 },
    to: { x: Math.min(b.r.right - 4, a.r.right - 6), y: b.r.top + b.r.height / 2 }
  }
})()`)
if (!spot) throw new Error('找不到可拖选的文字行')
await drag(spot.from, spot.to, 8)
await sleep(600)
await shot('08-select.png')

await evaluate(`(() => { const b = document.querySelector('[data-tb-id="sel-edit-text"]'); if (b) b.click(); return Boolean(b) })()`)
await sleep(800)
await shot('09-edit-text.png')

await evaluate(`(() => { const b = document.querySelector('[data-tb-id="sel-format"]'); if (b) b.click(); return Boolean(b) })()`)
await sleep(800)
await shot('10-format.png')

/* ========== 六、内容编辑物件（涂白/矩形/椭圆/文字/图片占位） ========== */
await evaluate(`(async () => {
  window.getSelection()?.removeAllRanges()
  const s = window.__store.getState()
  await s.clearAnnotations()
  s.setEditTool('none')
  return true
})()`)
await sleep(400)
const items = await evaluate(`(() => {
  const page = document.querySelector('.pdf-page[data-page="2"]')
  const pr = page.getBoundingClientRect()
  const sc = window.__store.getState().actualScale || 1
  const conv = (l, t, w, h) => ({
    x: (l - pr.left) / sc, y: (t - pr.top) / sc, width: w / sc, height: h / sc
  })
  const s = window.__store.getState()
  s.addAnnotation({ page: 2, type: 'whiteout', color: '#ffffff', at: Date.now(), quote: '',
    rects: [conv(pr.left + pr.width * 0.12, pr.top + pr.height * 0.30, pr.width * 0.36, 26)] })
  s.addAnnotation({ page: 2, type: 'rect', color: '#e5484d', at: Date.now(), quote: '',
    rects: [conv(pr.left + pr.width * 0.12, pr.top + pr.height * 0.40, pr.width * 0.30, 60)] })
  s.addAnnotation({ page: 2, type: 'ellipse', color: '#2f6fed', at: Date.now(), quote: '',
    rects: [conv(pr.left + pr.width * 0.50, pr.top + pr.height * 0.40, pr.width * 0.26, 60)] })
  s.addAnnotation({ page: 2, type: 'text', color: '#16a34a', at: Date.now(), quote: '',
    text: '课堂批注：先翻页，再标记', fontSize: 20,
    rects: [conv(pr.left + pr.width * 0.12, pr.top + pr.height * 0.30, pr.width * 0.36, 26)] })
  return window.__store.getState().annotations.length
})()`)
console.log('   内容编辑物件', items)
await sleep(700)
await shot('11-content-edit.png')

/* ========== 七、扫描页 OCR ========== */
await evaluate(`(async () => {
  await window.__store.getState().clearAnnotations()
  await window.__store.getState().openFile(resolve('docs', '示例文档-扫描页.pdf'))
  return true
})()`)
await waitFor(`Boolean(document.querySelector('.pdf-page .pdf-page__canvas'))`, 20000, 500)
await sleep(1600)
await evaluate(`(() => { window.__store.getState().requestOcr(); return true })()`)
const ocrOk = await waitFor(`Boolean(document.querySelector('.ocr-text-layer span'))`, 45000, 700)
console.log('   OCR 文字层', ocrOk ? '已出现' : '未出现')
await evaluate(`(() => {
  const spans = [...document.querySelectorAll('.ocr-text-layer span')].slice(0, 3)
  if (!spans.length) return 'no-span'
  const a = spans[0].firstChild
  const b = spans[spans.length - 1].firstChild
  if (!a || !b) return 'no-node'
  const r = document.createRange()
  r.setStart(a, 0)
  r.setEnd(b, b.textContent ? b.textContent.length : 0)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(r)
  return sel ? sel.toString().slice(0, 20) : 'none'
})()`)
await sleep(700)
await shot('12-ocr.png')
await evaluate(`(async () => {
  const s = window.__store.getState()
  const scan = s.tabs.find((t) => t.name.includes('扫描页'))
  const main = s.tabs.find((t) => t.name.includes('示例文档.pdf'))
  if (main) s.switchTab(main.id)
  if (scan) s.closeTab(scan.id)
  return true
})()`)
await sleep(900)

await evaluate(`(async () => { window.__store.getState().setPage(2); return true })()`)
await sleep(1200)

/* ========== 八、PDF 工具箱 ========== */
await evaluate(`(async () => { window.__store.getState().setShowTools(true); return true })()`)
await sleep(1300)
await shot('13-tools.png')
await evaluate(`(() => {
  const tiles = [...document.querySelectorAll('.tools-home__tile')]
  const tile = tiles.find((t) => t.textContent && t.textContent.includes('水印'))
  if (!tile) return 'no-tile'
  tile.click()
  return 'clicked'
})()`)
await sleep(1200)
await shot('14-tools-advanced.png')
await evaluate(`(async () => { window.__store.getState().setShowTools(false); return true })()`)
await sleep(600)

/* ========== 九、课堂辅助 ========== */
for (const [mode, file] of [
  ['spotlight', '15-spotlight.png'],
  ['black', '16-blackboard.png'],
  ['magnifier', '17-magnifier.png']
]) {
  await evaluate(`(async () => { window.__store.getState().setMaskMode('${mode}'); return true })()`)
  await sleep(900)
  /*
   * 放大镜的光圈跟随指针取景：不移动指针，镜片里就是一片白
   * （默认中心落在空白处），所以先真移两下鼠标再截图。
   */
  if (mode === 'magnifier') {
    for (const [px, py] of [[700, 430], [760, 470], [820, 500]]) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py })
      await sleep(220)
    }
  }
  await shot(file)
}
await evaluate(`(async () => { window.__store.getState().setMaskMode('off'); return true })()`)
await sleep(600)

/* ========== 十、设置面板（外观 / 阅读与更新） ========== */
await evaluate(`(async () => { window.__store.getState().setShowSettings(true); return true })()`)
await sleep(1100)
await shot('18-settings-appearance.png')
await evaluate(`(() => {
  const box = document.querySelector('.sb-settings-body')
  if (!box) return false
  box.scrollTop = box.scrollHeight
  return true
})()`)
await sleep(900)
await shot('19-settings-reading.png')
await evaluate(`(async () => { window.__store.getState().setShowSettings(false); return true })()`)
await sleep(600)

/* ========== 十一、更新浮层 + 启动声明 ========== */
await evaluate(`(() => {
  const s = window.__store.getState()
  s.setUpdateInfo({
    ok: true, newer: true, current: '1.0.3.0', latest: '1.0.4.0',
    page: 'https://xn--6rso4u4lc86ad09c.top/contact/',
    notes: '修复若干问题；设置页可手动检查更新'
  })
  s.setUpdateProgress({ received: 106880224, total: 106880224, fraction: 1 })
  s.setUpdateStage('ready', 'C:/<user>/秋夕-PDF阅读器-1.0.9.0-安装程序.exe')
  return true
})()`)
await sleep(900)
await shot('20-update.png')
await evaluate(`(() => { const s = window.__store.getState(); s.dismissUpdate(); s.setUpdateInfo(null); return true })()`)
await sleep(400)

await evaluate(`(() => {
  window.__store.setState({ disclaimerDismissed: false })
  return true
})()`)
await sleep(800)
await shot('21-disclaimer.png')
await evaluate(`(() => { window.__store.getState().dismissDisclaimer(); return true })()`)
await sleep(300)

/* ========== 十二、四套主题 ========== */
for (const [theme, file] of [
  ['dark', '22-theme-dark.png'],
  ['sepia', '23-theme-sepia.png'],
  ['metro', '24-theme-metro.png']
]) {
  await evaluate(`(async () => { await window.__store.getState().patchSettings({ theme: '${theme}' }); return true })()`)
  await sleep(1200)
  await shot(file)
}
await evaluate(`(async () => { await window.__store.getState().patchSettings({ theme: 'light' }); return true })()`)
await sleep(600)

console.log('完成')
ws.close()
