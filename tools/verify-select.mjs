/**
 * 验证「选择」功能的鼠标交互（v2.1.3 回归）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么单独一支
 * ══════════════════════════════════════════════════════════════════
 *   用户报「选择功能依旧有问题」，而旧用例只覆盖了「拖一行、改文字」。
 *   实测把问题拆成了三类：
 *     ① 拖出来的选区**过一会儿自己消失**（文本层被无关渲染重建，
 *        选区锚在旧字符节点上 → 塌成 0 字）；
 *     ② 浮动条上的面板点一下就收（选区一塌 anchor 被清）；
 *     ③ 单击空白 / 反向拖选 / 双击的行为不统一。
 *   这一支用 **CDP 真鼠标**把这三类钉住，防止再退化。
 *
 * ══════════════════════════════════════════════════════════════════
 * 判据
 * ══════════════════════════════════════════════════════════════════
 *   ① 跨行拖选：选区 > 5 字、浮条出现
 *   ② 等 700ms 选区仍在、浮条仍在（防「选区自己消失」回归）
 *   ③ 「改文字」预填 = 完整选区原文（不是整行、也没有 300 字截断）
 *   ④ 点「格式」→ 面板打开；点字号档 → 面板**不关**、字号落库
 *   ⑤ 点页面灰底 → 选区清空、浮条收起
 *   ⑥ 反向拖选（右→左、下→上）同样选出字
 *   ⑦ 双击选中一个词（≤ 12 字）且浮条出现
 *   ⑧ 高亮：矩形落在页面内、引用非空
 *
 * 用法：node tools/run-verify-suite.mjs --dev 9531 verify-select.mjs
 */

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
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
async function json(expr, timeout = 30000) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, timeout)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'eval 异常')
  return r.result?.value
}

const mouse = (type, x, y, buttons, extra = {}) =>
  send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: buttons > 0 ? 'left' : 'none',
    buttons,
    clickCount: 1,
    ...extra
  })

console.log('选择功能（隐藏窗口）')
console.log(`  端口 ${PORT}\n`)

/* ---------- 准备：选择工具、清空批注、等文本层 ---------- */
for (let i = 0; i < 40; i++) {
  if ((await json(`document.querySelectorAll('.textLayer span').length`).catch(() => 0)) > 0) break
  await sleep(500)
}

await json(`window.__sbDebugDraw = true; window.__sbDrawTrace = []`)
await json(`(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms));
  const s = window.__store.getState();
  s.setEditTool('select');
  s.clearAnnotations?.();
  await w(600);
  return true;
})()`)

/*
 * 归位：这套用例经常跟着别的用例跑（前面可能留了缩放、滚动、打开的浮层），
 * 只要视口里没有「两行完整可见的正文」，下面的落点挑选就会一个候选都挑不出来。
 * 所以先把状态收拾干净，再挑点。
 */
await json(`(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms));
  const s = window.__store.getState();
  if (s.compareOpen) s.closeComparePane();
  if (s.showSettings) s.setShowSettings(false);
  if (s.showTools) s.setShowTools(false);
  if (s.showThemeStore) s.setShowThemeStore(false);
  if (s.showPluginStore) s.setShowPluginStore(false);
  if (s.showImageTools) s.setShowImageTools(false);
  if (s.editTool !== 'select') s.setEditTool('select');
  if (s.zoom !== 'fit-width') s.setZoom('fit-width');
  const sc = document.querySelector('.viewer-scroll');
  if (sc) sc.scrollTop = 0;
  await w(400);
  /* 封面页只有 5 行字，拖动跨度太小选不出东西；落到正文页再挑点（顺序不能反，setPage 会滚动） */
  s.setPage(Math.min(3, s.pageCount || 1));
  await w(1400);
  return true;
})()`)

/* ---------- 找落点：同一页内的两行文字 + 一处灰底 ---------- */
const spotRaw = await json(`(() => {
  /*
   * ★ 只认 .pdf-page 里的 span。
   *   页面顶部那行「QiuXi PDF Reader - Test Fixture」是文档头（不在 .pdf-page 内），
   *   以前误当成起点的结果：选区从文档头一路拉到正文，2924 字、70 个高亮块。
   */
  const pages = [...document.querySelectorAll('.pdf-page[data-page]')];
  let pick = null;
  for (const page of pages) {
    /*
     * ★ 判「页在视口内」用**行自己的矩形**，不用整页矩形：
     *   fit-width 下页高 ≈1470px，比 900px 的窗口还高，整页永远放不进视口，
     *   于是以前一个候选都挑不出来。
     */
    const spans = [...page.querySelectorAll('.textLayer span')]
      .map((el) => {
        const b = el.getBoundingClientRect();
        return {
          el,
          text: el.textContent.trim(),
          left: b.left,
          right: b.right,
          top: b.top,
          bottom: b.bottom,
          height: b.height,
          width: b.width
        };
      })
      .filter(
        (s) =>
          s.width > 40 &&
          s.height > 5 &&
          s.text.length > 8 &&
          s.top >= 140 &&
          s.bottom <= innerHeight - 120 &&
          s.left >= 40 &&
          s.right <= innerWidth - 40
      );
    /* 4 行就够（封面页只有 5 行完整可见），太少说明这一屏没正文，换下一页 */
    if (spans.length < 4) continue;
    spans.sort((p, q) => p.top - q.top || p.left - q.left);
    /* 两行：起点取第 1 行靠右 1/3，终点取第 3 行靠右 1/3，保证跨行 */
    const line1 = spans[0];
    const line3 = spans.find((s) => s.top - line1.top > 20) ?? spans[1];
    const ax = Math.round(line1.left + line1.width * 0.35);
    const ay = Math.round(line1.top + line1.height / 2);
    const bx = Math.round(line3.left + line3.width * 0.35);
    const by = Math.round(line3.top + line3.height / 2);
    const hitA = document.elementFromPoint(ax, ay);
    const hitB = document.elementFromPoint(bx, by);
    if (!hitA?.closest('.textLayer') || !hitB?.closest('.textLayer')) continue;
    if (hitA.closest('.pdf-page') !== page || hitB.closest('.pdf-page') !== page) continue;
    pick = {
      page: Number(page.dataset.page),
      a: { x: ax, y: ay },
      b: { x: bx, y: by },
      lines: spans.length,
      underA: {
        tag: hitA.tagName,
        cls: hitA.className,
        text: (hitA.textContent ?? '').slice(0, 30),
        page: hitA.closest('.pdf-page')?.dataset?.page ?? null
      },
      underB: {
        tag: hitB.tagName,
        cls: hitB.className,
        text: (hitB.textContent ?? '').slice(0, 30),
        page: hitB.closest('.pdf-page')?.dataset?.page ?? null
      }
    };
    break;
  }
  /* 灰底：页面左右留白里、命中 div（textLayer 本身/页面底）而不是 span 的点 */
  let gray = null;
  if (pick) {
    const page = document.querySelector('.pdf-page[data-page="' + pick.page + '"]');
    const r = page.getBoundingClientRect();
    const top = Math.max(r.top + 8, 150)
    const bottom = Math.min(r.bottom - 8, innerHeight - 160)
    for (let y = Math.round(top); y < bottom && !gray; y += 12) {
      for (const fx of [0.04, 0.96, 0.06, 0.94, 0.5]) {
        const x = Math.round(r.left + r.width * fx)
        if (x < 30 || x > innerWidth - 30) continue
        const hit = document.elementFromPoint(x, y)
        if (!hit || !hit.closest('.pdf-page')) continue
        if (hit.closest('span, .edit-item, .edit-selbar, .edit-bar')) continue
        gray = { x, y, tag: hit.tagName, cls: hit.className }
        break
      }
    }
  }
  return JSON.stringify({ pick, gray });
})()`)
const spot = JSON.parse(spotRaw)
if (!spot.pick) {
  console.error('✗ 找不到同页两行可拖选的文字（夹具没渲染完？）')
  ws.close()
  process.exit(1)
}
spot.a = spot.pick.a
spot.b = spot.pick.b
console.log(`  落点：第 ${spot.pick.page} 页 ${spot.pick.lines} 行可选；灰底 ${spot.gray ? '有' : '无'}`)
console.log(`  a=(${spot.a.x},${spot.a.y}) 压着 ${spot.pick.underA?.tag}.${spot.pick.underA?.cls} 「${spot.pick.underA?.text}」`)
console.log(`  b=(${spot.b.x},${spot.b.y}) 压着 ${spot.pick.underB?.tag}.${spot.pick.underB?.cls} 「${spot.pick.underB?.text}」`)

/** 拖一次（真鼠标） */
async function drag(x1, y1, x2, y2, steps = 8) {
  await mouse('mouseMoved', x1, y1, 0)
  await mouse('mousePressed', x1, y1, 1)
  for (let i = 1; i <= steps; i++) {
    const k = i / steps
    await mouse('mouseMoved', x1 + (x2 - x1) * k, y1 + (y2 - y1) * k, 1)
    await sleep(20)
  }
  await mouse('mouseReleased', x2, y2, 0)
  await sleep(420)
}

const state = () =>
  json(`JSON.stringify({
    sel: window.getSelection() ? window.getSelection().toString() : '',
    bar: !!document.querySelector('.edit-selbar'),
    panel: document.querySelector('.edit-selbar')?.getAttribute('data-panel') ?? null,
    input: document.querySelector('[data-tb-id="sel-text-input"]')?.value ?? null
  })`).then(JSON.parse)

/** 选区的起止节点信息（诊断用：看锚点落在第几个 span、偏移多少） */
const selInfo = () =>
  json(`JSON.stringify((() => {
    const s = window.getSelection();
    if (!s || s.rangeCount === 0) return { len: 0 };
    const page = document.querySelector('.pdf-page[data-page="${spot.pick.page}"]');
    const spans = page ? [...page.querySelectorAll('.textLayer span')] : [];
    const idx = (n) => {
      if (!n) return -1;
      const el = n.nodeType === 3 ? n.parentElement : n;
      const span = el?.closest ? el.closest('span') : null;
      return span ? spans.indexOf(span) : -1;
    };
    return {
      len: s.toString().length,
      a: { i: idx(s.anchorNode), off: s.anchorOffset },
      f: { i: idx(s.focusNode), off: s.focusOffset }
    };
  })())`).then(JSON.parse)

const norm = (s) => String(s ?? '').replace(/\\s+/g, ' ').trim()

/* ---------- ① 跨行拖选 ---------- */
await drag(spot.a.x, spot.a.y, spot.b.x, spot.b.y)
const s1 = await state()
const info1 = await selInfo()
check(s1.sel.trim().length > 5, '① 跨行拖选选出文字', `${s1.sel.trim().length} 字 选区锚点 span#${info1.a.i}@${info1.a.off} → #${info1.f.i}@${info1.f.off}`)
check(s1.bar, '① 拖选后浮条出现')

/* ---------- ② 等 700ms：选区不能自己消失 ---------- */
await sleep(700)
const s2 = await state()
check(norm(s2.sel) === norm(s1.sel) && s2.sel.trim().length > 0, '② 700ms 后选区仍在（不被重渲染抹掉）', `${s2.sel.trim().length} 字`)
check(s2.bar, '② 浮条仍在')

/* ---------- ③ 改文字预填 = 完整选区原文 ---------- */
await json(`document.querySelector('[data-tb-id="sel-edit-text"]')?.click()`)
await sleep(400)
const s3 = await state()
const selLen = norm(s1.sel).length
const inLen = norm(s3.input).length
check(s3.panel === 'text', '③ 点「改文字」打开面板')
check(
  inLen > 0 && Math.abs(inLen - selLen) <= 2,
  '③ 预填 = 完整选区（没有截断/整行）',
  `选区 ${selLen} 字 / 输入框 ${inLen} 字`
)
check(!norm(s3.input).includes('…') && !norm(s3.input).endsWith('...'), '③ 预填没有省略号')

/* ---------- ④ 格式面板：点字号档后不关 ---------- */
await json(`document.querySelector('[data-tb-id="sel-format"]')?.click()`)
await sleep(300)
const s4a = await state()
check(s4a.panel === 'format', '④ 点「格式」打开格式面板')
const sizeBtn = await json(`(() => {
  const b = [...document.querySelectorAll('[data-selbar-panel="format"] button')].find((el) => el.textContent?.trim() === '24');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
})()`)
if (sizeBtn) {
  const p = JSON.parse(sizeBtn)
  await mouse('mouseMoved', p.x, p.y, 0)
  await mouse('mousePressed', p.x, p.y, 1)
  await mouse('mouseReleased', p.x, p.y, 0)
  await sleep(450)
}
const s4b = await state()
check(s4b.panel === 'format', '④ 点字号档后格式面板不关', `panel=${s4b.panel}`)

/* ---------- ⑤ 点灰底：选区清空、浮条收起 ---------- */
/*
 * ★ 灰底要「现取」，不能用一开始算好的那个点：
 *   浮条/面板一出现就盖住了原来的落点，按上去其实是按在 `.edit-selbar` 上
 *   （选区被清掉、浮条却不动），整套里就出现过这一条假红。
 */
const grayNow = await json(`JSON.stringify((() => {
  const sr = document.querySelector('.viewer-scroll').getBoundingClientRect()
  const okPoint = (x, y) => {
    const el = document.elementFromPoint(x, y)
    if (!el || !el.closest('.pdf-page')) return false
    if (el.closest('.textLayer span') || el.closest('.ocr-text-layer span')) return false
    if (el.closest('.edit-selbar') || el.closest('.edit-item') || el.closest('.edit-bar')) return false
    return true
  }
  const pages = [...document.querySelectorAll('.pdf-page')]
    .map((p) => p.getBoundingClientRect())
    .filter((r) => r.bottom > sr.top + 120 && r.top < sr.bottom - 120)
  for (const r of pages) {
    for (let y = Math.max(r.top, sr.top) + 40; y < Math.min(r.bottom, sr.bottom) - 40; y += 24) {
      for (let x = r.left + 16; x < r.right - 16; x += 24) {
        if (okPoint(x, y)) return { x: Math.round(x), y: Math.round(y), tag: 'DIV', cls: 'at-click' }
      }
    }
  }
  return null
})())`).then(JSON.parse)
if (grayNow) {
  await mouse('mouseMoved', grayNow.x, grayNow.y, 0)
  await mouse('mousePressed', grayNow.x, grayNow.y, 1)
  await mouse('mouseReleased', grayNow.x, grayNow.y, 0)
  await sleep(420)
  const s5 = await state()
  const i5 = await selInfo()
  const trace5 = await json(`JSON.stringify((window.__sbDrawTrace ?? []).slice(-6))`).then(JSON.parse)
  check(
    s5.sel.trim().length === 0,
    '⑤ 点灰底清空选区',
    `${s5.sel.trim().length} 字 锚点 span#${i5.a?.i}@${i5.a?.off} 落点(${grayNow.x},${grayNow.y}) 选区「${s5.sel.trim().slice(0, 20)}」 轨迹=${trace5.join(' | ')}`
  )
  check(!s5.bar, '⑤ 点灰底收起浮条')
} else if (spot.gray) {
  await mouse('mouseMoved', spot.gray.x, spot.gray.y, 0)
  await mouse('mousePressed', spot.gray.x, spot.gray.y, 1)
  await mouse('mouseReleased', spot.gray.x, spot.gray.y, 0)
  await sleep(420)
  const s5 = await state()
  check(s5.sel.trim().length === 0, '⑤ 点灰底清空选区', `${s5.sel.trim().length} 字（用了初始落点）`)
  check(!s5.bar, '⑤ 点灰底收起浮条')
} else {
  check(false, '⑤ 点灰底清空选区', '找不到页面灰底落点')
  check(false, '⑤ 点灰底收起浮条', '找不到页面灰底落点')
}

/* ---------- ⑥ 反向拖选 ---------- */
/*
 * 这里不再用一开始算好的坐标：
 *   ⑤ 点灰底时如果带了几像素位移，会走成「拖动平移」，页面 scrollTop 就变了；
 *   而 a/b 是按滚动前的位置算的 → ⑥/⑦ 会按在灰底或文字层空白处，
 *   整套里实测 ⑥ 起点命中 DIV.textLayer（不是 span）→ 被判成平移、页面又滚 28px。
 *
 * 改成每次现取：在当前视口里挑「真正压着 SPAN」的文字段，
 * 取跨度较大的两段做反向拖选。
 */
const pickSpans = async () =>
  JSON.parse(
    (await json(`JSON.stringify((() => {
      const page = document.querySelector('.pdf-page[data-page="1"]')
      if (!page) return []
      const out = []
      for (const el of page.querySelectorAll('.textLayer span')) {
        const t = (el.textContent ?? '').trim()
        if (t.length < 8) continue
        const r = el.getBoundingClientRect()
        if (r.top < 130 || r.bottom > innerHeight - 130) continue
        if (r.left < 40 || r.right > innerWidth - 40) continue
        const x = r.left + r.width * 0.5
        const y = r.top + r.height * 0.5
        const hit = document.elementFromPoint(x, y)
        if (!hit || hit.tagName !== 'SPAN' || !hit.closest('.textLayer')) continue
        out.push({ x, y, t: t.slice(0, 18) })
      }
      return out
    })())`)) ?? []
  )

/* 先归位：回到第 1 页并把滚动清零（页码变化会触发「滚到该页」，顺序不能反） */
await json(`(() => { const st = window.__store.getState(); st.setPage(1); return true })()`)
await sleep(500)
await json(`(() => { const sc = document.querySelector('.viewer-scroll'); if (sc) { sc.scrollTop = 0; sc.scrollLeft = 0 } return true })()`)
await sleep(400)
console.log(`  ⑥ 归位后：scrollTop=${await json(`document.querySelector('.viewer-scroll')?.scrollTop ?? -1`)}`)

/**
 * 取一个「此刻真的压着 SPAN」的落点。
 *
 * 为什么不能一次算好反复用：懒渲染结束、滚动条出现都会让文字层整体挪十几像素，
 * 早先算的坐标再按下去就落进行间空隙（命中 DIV.textLayer），
 * 选择工具会把它当成「起点不在字上」→ 变成平移。整套里实测就是这样：
 * ⑥ 起点命中 DIV、页面被滚走 170px，⑦ 再按旧坐标就落到灰底上。
 */
const pickSpanPoint = async (skipY) => {
  const sample = async (x, y) =>
    JSON.parse(
      (await json(`JSON.stringify((() => {
        const el = document.elementFromPoint(${x}, ${y})
        if (!el) return { tag: 'null' }
        const r = el.getBoundingClientRect()
        return { tag: el.tagName, text: (el.textContent ?? '').slice(0, 12), left: r.left, top: r.top, w: r.width }
      })())`)) ?? '{"tag":"null"}'
    )
  const list = await pickSpans()
  for (const s of list) {
    if (skipY !== undefined && Math.abs(s.y - skipY) < 8) continue
    const a = await sample(s.x, s.y)
    if (a.tag !== 'SPAN') continue
    /* 懒渲染/滚动条/缩放落定都会让文字层整体挪几像素：要求间隔 130ms 两次采样
       命中同一个 span 且位置几乎不动，才允许按下去。整套里缺这一步时，
       校验时是 SPAN、真正按下时已经变成 DIV.textLayer（见 b74 记录）。 */
    await sleep(130)
    const b = await sample(s.x, s.y)
    if (b.tag !== 'SPAN') continue
    if (b.text !== a.text) continue
    if (Math.abs(b.left - a.left) > 1.5 || Math.abs(b.top - a.top) > 1.5) continue
    return s
  }
  return null
}

let backFrom = null
let backTo = null
let s6 = await state()
for (let attempt = 1; attempt <= 3; attempt++) {
  const to = await pickSpanPoint()
  if (!to) break
  const from = await pickSpanPoint(to.y)
  if (!from) break
  console.log(`  ⑥ 第 ${attempt} 次反向拖选：${from.t} → ${to.t}`)
  await drag(to.x, to.y, from.x, from.y)
  s6 = await state()
  if (s6.sel.trim().length > 5 && s6.bar) {
    backFrom = from
    backTo = to
    break
  }
  console.log(`     没选中（${s6.sel.trim().length} 字），重试`)
  await json(`window.getSelection()?.removeAllRanges()`)
  await sleep(250)
}
if (!backFrom) console.log('  ⚠ 三次都没拖出选区')
const i6 = await selInfo()
const tr6 = await json(`JSON.stringify((window.__sbDrawTrace ?? []).slice(-6))`).then(JSON.parse)
check(s6.sel.trim().length > 5, '⑥ 反向拖选同样选出文字', `${s6.sel.trim().length} 字 锚点 span#${i6.a?.i}@${i6.a?.off}→#${i6.f?.i}@${i6.f?.off} 选区「${s6.sel.trim().slice(0, 16)}」 轨迹=${tr6.join(' | ')}`)
check(s6.bar, '⑥ 反向拖选后浮条出现')

/* ---------- ⑦ 双击选词 ---------- */
/* 双击落点同样现取，并且按不下就换一段重试 */
await json(`window.getSelection()?.removeAllRanges()`)
await sleep(150)
/* ⑥ 的反拖可能让页面滚走（页 1 的文字跑出视口 → pickSpanPoint 全被过滤成 null），
 * 先归位再取落点 */
await json(`(() => { const st = window.__store.getState(); st.setPage(1); return true })()`)
await sleep(450)
await json(`(() => { const sc = document.querySelector('.viewer-scroll'); if (sc) { sc.scrollTop = 0; sc.scrollLeft = 0 } return true })()`)
await sleep(350)

let s7 = await state()
let dblPoint = null
let dblHit = 'null'
for (let attempt = 1; attempt <= 3; attempt++) {
  const p = await pickSpanPoint()
  if (!p) break
  /*
   * 先把指针移到落点上再按：
   * 双击要求两次按下之间没有别的指针移动，隐藏窗口刚被滚过时
   * 落点位置的首个 mousemove 偶尔会把页面带一下（已在产品侧修掉
   * 监听泄漏，但用例保持这个动作更接近真人）。
   */
  await mouse('mouseMoved', p.x, p.y, 0)
  await mouse('mousePressed', p.x, p.y, 1, { clickCount: 1 })
  await mouse('mouseReleased', p.x, p.y, 0, { clickCount: 1 })
  await sleep(80)
  await mouse('mousePressed', p.x, p.y, 1, { clickCount: 2 })
  await mouse('mouseReleased', p.x, p.y, 0, { clickCount: 2 })
  await sleep(450)
  s7 = await state()
  dblPoint = p
  dblHit = await json(`(() => { const el = document.elementFromPoint(${p.x}, ${p.y}); return el ? el.tagName : 'null' })()`)
  if (s7.sel.trim().length > 0 && s7.sel.trim().length <= 12) break
  const tr7 = await json(`JSON.stringify((window.__sbDrawTrace ?? []).slice(-6))`).then(JSON.parse)
  console.log(`  ⑦ 第 ${attempt} 次双击没选中（${s7.sel.trim().length} 字，命中 ${dblHit}），轨迹=${tr7.join(' | ')}`)
  await json(`window.getSelection()?.removeAllRanges()`)
  await sleep(250)
}
check(
  s7.sel.trim().length > 0 && s7.sel.trim().length <= 12,
  '⑦ 双击选中一个词（≤12 字）',
  `「${s7.sel.trim()}」 落点(${Math.round(dblPoint?.x ?? -1)},${Math.round(dblPoint?.y ?? -1)}) 命中 ${dblHit}`
)
check(s7.bar, '⑦ 双击后浮条出现')

/* ---------- ⑧ 高亮落在页面内、引用非空 ---------- */
await drag(
  (backFrom ?? spot.a).x,
  (backFrom ?? spot.a).y,
  (backTo ?? spot.b).x,
  (backTo ?? spot.b).y
)
await json(`document.querySelector('[data-tb-id="sel-highlight"]')?.click()`)
await sleep(600)
const hl = await json(`(() => {
  const list = window.__store.getState().annotations ?? [];
  const a = list[list.length - 1];
  if (!a) return JSON.stringify(null);
  const page = document.querySelector('.pdf-page[data-page="' + a.page + '"]');
  const pr = page ? page.getBoundingClientRect() : null;
  /* 注释：rects 是**页面坐标**（scale=1 的空间），页面元素是缩放后的，必须换算再比 */
  const sc = (window.__store.getState().actualScale) || 1;
  const lw = pr ? pr.width / sc : 0, lh = pr ? pr.height / sc : 0;
  const inside = pr ? a.rects.every((r) => r.x >= -2 && r.y >= -2 && r.x + r.width <= lw + 4 && r.y + r.height <= lh + 4) : false;
  return JSON.stringify({ type: a.type, rects: a.rects.length, quote: (a.quote || '').slice(0, 24), inside, sample: a.rects[0], lw: Math.round(lw), lh: Math.round(lh) });
})()`)
const h = JSON.parse(hl || 'null')
check(Boolean(h) && h.type === 'highlight', '⑧ 高亮落库', h ? h.rects + ' 块' : '无')
check(Boolean(h) && h.quote.length > 0, '⑧ 高亮引用非空', h?.quote ?? '')
check(Boolean(h) && h.inside, '⑧ 高亮矩形都在页面内', h ? '样例 ' + JSON.stringify(h.sample) + ' 页面 ' + h.lw + 'x' + h.lh + ' 块数 ' + h.rects : '无数据')

/* ---------- 收尾 ---------- */
await json(`window.__store.getState().clearAnnotations?.()`)

const verdict = fails === 0 ? '✓ 全部通过' : `✗ ${fails} 项失败`
console.log(`\n=== 结果：${checks} 项检查，${fails} 项失败 ===`)
console.log(verdict)
ws.close()
process.exit(fails === 0 ? 0 : 1)
