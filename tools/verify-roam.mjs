// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 漫游工具（第三个工具）验证 —— 2026-10-16 用户需求。
 *
 * 用户原话：
 *   「把退出批注这一个功能栏按钮改成漫游功能 图标是一只手
 *     然后漫游的意思就是拖动缩放页面 保证工具栏总是有一个功能处于激活状态」
 *
 * 因此本脚本钉住四件事：
 *   ① 工具条上是「漫游」（手形图标），不再是「退出绘画」，也没有谁都不激活的状态
 *   ② 画笔 / 橡皮 / 漫游 **恒有且只有一个**处于激活，且与 store 状态严格一致
 *   ③ 已激活的工具再点一次**不再退出**（旧行为是退回「三个全灭」）
 *   ④ 漫游态拖动 = 平移页面：
 *        · 从空白处拖 → scrollTop 跟着走
 *        · 从文字层上拖 → 让给选字，页面不动
 *        · Esc → 回到漫游
 *
 * ⚠️ 修改这个文件一律用编辑工具，不要用 PowerShell 重写
 *    （PowerShell 会把中文写成 GBK，Node 直接 SyntaxError）。
 *
 * 用法：node tools/verify-roam.mjs [端口]
 *   端口由套件传入（见 tools/run-verify-suite.mjs）。
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = process.argv[2] ?? '9229'

/** 调一次 CDP 表达式（走项目统一的 cdp-eval，返回原始文本） */
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

/** 页面里都返回 JSON.stringify(..., null, 1)，取第一个 { 到最后一个 } 再解析 */
function parseObj(text) {
  const a = text.indexOf('{')
  const b = text.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    return JSON.parse(text.slice(a, b + 1))
  } catch {
    return null
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 统一探针：工具条三个按钮 + store 状态 + 视口类名 + 滚动量。
 * 激活数/激活工具是从 DOM 里数出来的，不是从 store 推的 ——
 * 「界面上到底亮着几个、亮的是谁」才是用户看到的东西。
 */
const SNAP = `(() => {
  const btns = Array.from(document.querySelectorAll('.drawbar__tool'))
  const info = btns.map((b) => ({
    文字: (b.textContent || '').trim(),
    名称: b.getAttribute('aria-label') || '',
    激活: b.classList.contains('is-active'),
    禁用: b.disabled === true,
    图标: (b.querySelector('svg')?.getAttribute('class') || '')
  }))
  const s = window.__store.getState()
  const sc = document.querySelector('.viewer-scroll')
  return JSON.stringify({
    工具: info,
    激活数: info.filter((i) => i.激活).length,
    激活工具: info.filter((i) => i.激活).map((i) => i.名称 || i.文字).join('|'),
    有退出绘画: /退出绘画/.test(document.querySelector('.drawbar')?.textContent || ''),
    退出类数: document.querySelectorAll('.drawbar__exit').length,
    drawMode: s.drawMode,
    eraserMode: s.eraserMode,
    视口类: sc ? sc.className : '',
    滚动上: sc ? Math.round(sc.scrollTop) : -1,
    可滚高: sc ? Math.round(sc.scrollHeight - sc.clientHeight) : -1
  }, null, 1)
})()`

const snap = () => parseObj(cdp(SNAP))

/** 点工具条上的某个工具（按 aria-label 找，找不到/禁用都返回原文） */
function clickTool(name) {
  return cdp(`(() => {
    const b = Array.from(document.querySelectorAll('.drawbar__tool'))
      .find((x) => (x.getAttribute('aria-label') || '') === ${JSON.stringify(name)})
    if (!b) return 'NOT_FOUND'
    if (b.disabled) return 'DISABLED'
    b.click()
    return 'ok'
  })()`)
}

/**
 * 在页面里找一个「适合拖动」的点：
 *   wantGlyph=true  → 落在文字**字符**（.textLayer span）上的点 → 拖动应该是选字
 *   wantGlyph=false → 落在字符之外（文字层容器的行间空隙 / 图片 / 页边）的点 → 拖动应该是平移
 *
 * ★ 不能按「有没有碰到 .textLayer」来区分：实测文字层 div 铺满整页，
 *   在视口内均匀取样 190 个点里 158 个都命中层容器 div、只有 16 个命中字符 span。
 *   所以「非字符」的点遍地都是，「字符」的点反而要仔细找。
 *
 * 只取视口内的点，并排除工具条盖住的区域（底部）。
 */
function findPoint(wantGlyph) {
  const raw = cdp(`(() => {
    const c = document.querySelector('.pdf-page[data-page="1"] canvas.pdf-page__canvas')
    if (!c) return 'NO_CANVAS'
    const r = c.getBoundingClientRect()
    const bar = document.querySelector('.drawbar')?.getBoundingClientRect()
    const bottomLimit = bar ? Math.min(innerHeight, bar.top - 6) : innerHeight
    for (let gy = 0; gy < 30; gy++) {
      for (let gx = 0; gx < 18; gx++) {
        const x = Math.round(r.left + 6 + (r.width - 12) * gx / 17)
        const y = Math.round(r.top + 6 + (r.height - 12) * gy / 29)
        if (x < 4 || y < 4 || x > innerWidth - 4 || y > bottomLimit) continue
        const el = document.elementFromPoint(x, y)
        if (!el || !el.closest) continue
        if (!el.closest('.pdf-page')) continue
        const glyph = !!el.closest('.textLayer span')
        if (glyph !== ${wantGlyph}) continue
        return JSON.stringify({ x, y, 命中: String(el.className || el.tagName), 字符: glyph }, null, 1)
      }
    }
    return 'NONE'
  })()`)
  return { point: parseObj(raw), raw }
}

/** 合成一次「鼠标按住拖动」：pointerdown 发给该点元素，move/up 发给 window（与真实实现一致） */
function dragMouse(x, y, dy, opts = {}) {
  /* 终点坐标先在 Node 侧算好：模板里不能嵌套 ${} */
  const yMid = y - 60
  const yEnd = y + dy
  const alt = opts.alt === true ? 'true' : 'false'
  return cdp(`(() => {
    const t = document.elementFromPoint(${x}, ${y})
    if (!t) return 'NO_TARGET'
    const mk = (type, cx, cy, buttons) => new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      pointerId: 21, pointerType: 'mouse', isPrimary: true,
      clientX: cx, clientY: cy, button: 0, buttons, altKey: ${alt}
    })
    t.dispatchEvent(mk('pointerdown', ${x}, ${y}, 1))
    window.dispatchEvent(mk('pointermove', ${x}, ${yMid}, 1))
    window.dispatchEvent(mk('pointermove', ${x}, ${yEnd}, 1))
    window.dispatchEvent(mk('pointerup', ${x}, ${yEnd}, 0))
    return 'ok'
  })()`)
}

const fails = []
function check(ok, label, extra = '') {
  if (ok) {
    console.log(`  ✓ ${label}${extra ? `（${extra}）` : ''}`)
  } else {
    console.log(`  ✗ ${label}${extra ? `（${extra}）` : ''}`)
    fails.push(`${label}${extra ? `（${extra}）` : ''}`)
  }
}

console.log('=== 漫游工具验证 ===\n')

/* ---------- 0. 复位：回到漫游 + 缩放 2 倍（保证有可滚动的余量）+ 造一条笔迹 ---------- */
await cdp(`(async () => {
  const s = window.__store.getState()
  s.setRoam()
  s.setZoom(2)
  s.setPage(1)
  if (!s.annotations.some((a) => a.quote && a.quote.startsWith('[笔迹]'))) {
    await s.addAnnotation({
      page: 1,
      type: 'note',
      rects: [{ x: 120, y: 120, width: 240, height: 90 }],
      color: '#e5484d',
      quote: '[笔迹]' + JSON.stringify({ v: 2, w: 4, d: [[120, 130, 0, 0], [220, 190, 16, 0.3], [320, 200, 32, 0.4]] }),
      note: ''
    })
  }
  return 'ok'
})()`)
await sleep(500)
/* 把滚动位置挪到中间，这样上下拖动都有余量（也可判断「没动」） */
await cdp(`(() => { const sc = document.querySelector('.viewer-scroll'); sc.scrollTop = 160; return String(sc.scrollTop) })()`)
await sleep(200)

/* ---------- ① 三个工具都在，漫游是手形图标，旧的「退出绘画」彻底消失 ---------- */
console.log('① 工具条构成')
let s = snap()
const tools = s?.工具 ?? []
const roam = tools.find((t) => t.名称 === '漫游')
check(!!roam, '存在「漫游」按钮')
check(/lucide-hand/.test(roam?.图标 ?? ''), '漫游按钮图标是手形（lucide-hand）', roam?.图标 ?? '(无 svg)')
check(tools.some((t) => t.名称 === '画笔'), '画笔按钮仍在')
check(tools.some((t) => t.名称 === '橡皮'), '橡皮按钮仍在')
check(s?.有退出绘画 === false, '不再有「退出绘画」按钮')
check(s?.退出类数 === 0, '旧的 .drawbar__exit 节点已移除', `找到 ${s?.退出类数} 个`)

/* ---------- ② 复位后恰好一个工具激活，且是漫游 ---------- */
console.log('\n② 复位后的默认工具')
check(s?.激活数 === 1, '恰好一个工具处于激活', `激活数=${s?.激活数}`)
check(s?.激活工具 === '漫游', '默认激活的是漫游', `激活=${s?.激活工具}`)
check(s?.drawMode === false && s?.eraserMode === false, 'store：既没在画也没在擦')
check(/is-roaming/.test(s?.视口类 ?? ''), '视口带 is-roaming（抓手光标）')

/* ---------- ③ 画笔：点一次进入，再点一次**不退出** ---------- */
console.log('\n③ 画笔（再点不退出）')
check(clickTool('画笔') === 'ok', '点「画笔」')
await sleep(250)
s = snap()
check(s?.激活数 === 1 && s?.激活工具 === '画笔', '激活切到画笔', `激活=${s?.激活工具} 数=${s?.激活数}`)
check(s?.drawMode === true && s?.eraserMode === false, 'store：drawMode=true / eraserMode=false')
check(/is-drawing/.test(s?.视口类 ?? '') && !/is-roaming/.test(s?.视口类 ?? ''), '视口切到 is-drawing')

check(clickTool('画笔') === 'ok', '再点一次「画笔」')
await sleep(250)
s = snap()
check(s?.激活数 === 1 && s?.激活工具 === '画笔', '仍然停在画笔（不再退回谁都不激活）', `激活=${s?.激活工具} 数=${s?.激活数}`)
check(s?.drawMode === true, 'store 仍是 drawMode=true')

/* ---------- ④ 橡皮：同样点两次都停在橡皮 ---------- */
console.log('\n④ 橡皮（再点不退出）')
check(clickTool('橡皮') === 'ok', '点「橡皮」')
await sleep(250)
s = snap()
check(s?.激活数 === 1 && s?.激活工具 === '橡皮', '激活切到橡皮', `激活=${s?.激活工具} 数=${s?.激活数}`)
check(s?.drawMode === true && s?.eraserMode === true, 'store：drawMode=true / eraserMode=true')
check(/is-erasing/.test(s?.视口类 ?? ''), '视口切到 is-erasing')

check(clickTool('橡皮') === 'ok', '再点一次「橡皮」')
await sleep(250)
s = snap()
check(s?.激活数 === 1 && s?.激活工具 === '橡皮', '仍然停在橡皮', `激活=${s?.激活工具} 数=${s?.激活数}`)
check(s?.eraserMode === true, 'store 仍是 eraserMode=true')

/* ---------- ⑤ 漫游：唯一的出口，两个开关一起清 ---------- */
console.log('\n⑤ 漫游（出口）')
check(clickTool('漫游') === 'ok', '点「漫游」')
await sleep(250)
s = snap()
check(s?.激活数 === 1 && s?.激活工具 === '漫游', '激活切回漫游', `激活=${s?.激活工具} 数=${s?.激活数}`)
check(s?.drawMode === false && s?.eraserMode === false, 'store：两个开关一起清（不变式）')
check(!/is-drawing|is-erasing/.test(s?.视口类 ?? ''), '视口退出绘画/橡皮类名')

/* ---------- ⑥ 漫游拖动 = 平移（从字符之外按下） ---------- */
console.log('\n⑥ 漫游拖动平移')
const room = s?.可滚高 ?? 0
check(room >= 240, '视图有足够可滚动余量（缩放 2 倍）', `可滚高=${room}`)
const gap = findPoint(false)
if (!gap.point) {
  check(false, '找得到「不在字符上」的拖动起点', gap.raw.slice(0, 120))
} else {
  check(true, '找得到「不在字符上」的拖动起点', `(${gap.point.x},${gap.point.y}) → ${gap.point.命中}`)
  const before = snap()?.滚动上 ?? -1
  const r = dragMouse(gap.point.x, gap.point.y, -120)
  await sleep(200)
  const after = snap()?.滚动上 ?? -1
  const dy = after - before
  check(r === 'ok', '拖动事件已派发')
  /* 手往上拖 120px → 内容跟着上移 → scrollTop 增加约 120 */
  check(Math.abs(dy - 120) <= 24, 'scrollTop 跟着手走了约 120px', `${before} → ${after}（Δ=${dy}）`)
}

/* ---------- ⑦ 起点在文字字符上 = 照样平移（漫游只滑动，不碰文本） ---------- */
console.log('\n⑦ 文字字符上拖动也平移（漫游不选字）')
const glyph = findPoint(true)
if (!glyph.point) {
  check(false, '找得到「落在文字字符上」的起点', glyph.raw.slice(0, 120))
} else {
  check(true, '找得到「落在文字字符上」的起点', `(${glyph.point.x},${glyph.point.y}) → ${glyph.point.命中}`)
  /*
   * ★ 2026-10-17 需求变更：漫游工具**只滑动页面，不选字**。
   *   旧版这里断言「字符上拖动让给选字、页面不动」，与现在的产品行为相反；
   *   那版行为实际用起来很别扭 —— 手指按在字上就开始拉蓝框、页面纹丝不动，
   *   用户以为卡住了（见 DocumentView.startRoamPan 里的长注释）。
   *   选字走「选择」工具，由 tools/verify-touch-select.mjs 单独覆盖。
   */
  await cdp(`(() => { window.getSelection()?.removeAllRanges(); return 'ok' })()`)
  const before = snap()?.滚动上 ?? -1
  dragMouse(glyph.point.x, glyph.point.y, -120)
  await sleep(200)
  const after = snap()?.滚动上 ?? -1
  const dy = after - before
  check(dy > 60, '字符上拖动仍然平移页面（漫游只滑动、不碰文本）', `${before} → ${after}（Δ=${dy}）`)
  const selLen = Number(
    String(cdp(`(window.getSelection()?.toString() ?? '').length`)).replace(/[^\d-]/g, '')
  )
  check(selLen === 0, '而且不会顺手把文字选中（选字请用「选择」工具）', `选中 ${selLen} 字`)
}

/* ---------- ⑦b 按住 Alt 拖动 = 强制平移（整页都是文字时的出口） ---------- */
console.log('\n⑦b Alt+拖动强制平移')
if (!glyph.point) {
  check(false, 'Alt 项需要字符落点（上一项已失败）')
} else {
  const before = snap()?.滚动上 ?? -1
  const r = dragMouse(glyph.point.x, glyph.point.y, -120, { alt: true })
  await sleep(200)
  const after = snap()?.滚动上 ?? -1
  const dy = after - before
  check(r === 'ok', 'Alt 拖动事件已派发')
  check(Math.abs(dy - 120) <= 24, 'Alt 按住时即使起点在字上也会平移', `${before} → ${after}（Δ=${dy}）`)
}

/* ---------- ⑧ Esc 回到漫游 ---------- */
console.log('\n⑧ Esc 回到漫游')
check(clickTool('画笔') === 'ok', '先进入画笔')
await sleep(200)
await cdp(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 'ok' })()`)
await sleep(250)
s = snap()
check(s?.drawMode === false && s?.eraserMode === false, 'Esc 后 store 回到漫游态')
check(s?.激活数 === 1 && s?.激活工具 === '漫游', 'Esc 后界面上亮的是漫游', `激活=${s?.激活工具} 数=${s?.激活数}`)

/* ---------- ⑨ 不变式扫描：任何状态下都恰好一个激活 ---------- */
console.log('\n⑨ 不变式（三选一，永远有且只有一个）')
let invariantOk = true
const seen = []
for (const name of ['画笔', '橡皮', '漫游', '画笔', '漫游']) {
  clickTool(name)
  await sleep(180)
  const cur = snap()
  seen.push(`${name}→${cur?.激活工具}(${cur?.激活数})`)
  if (cur?.激活数 !== 1) invariantOk = false
  const expect = name === '画笔' ? '画笔' : name === '橡皮' ? '橡皮' : '漫游'
  if (cur?.激活工具 !== expect) invariantOk = false
}
check(invariantOk, '连续切换 5 次，每次都恰好一个激活且与点击一致', seen.join(' '))

/* 收尾：恢复常规视图，别把缩放留给后面的脚本 */
await cdp(`(() => {
  const s = window.__store.getState()
  s.setRoam()
  s.setZoom('fit-width')
  const sc = document.querySelector('.viewer-scroll')
  if (sc) sc.scrollTop = 0
  return 'ok'
})()`)

if (fails.length) {
  console.error(`\n=== 结果：未通过 ✗ ===\n  - ${fails.join('\n  - ')}`)
  process.exit(1)
}
console.log('\n=== 结果：全部通过 ✓ ===')
process.exit(0)
