// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 画笔管线端到端验证（唯一入口）。
 *
 * 为什么要单独一个脚本、不用命令行传表达式：
 *   PowerShell 对多行 JS 里的引号与换行处理极不可靠，
 *   反复出现「表达式异常」「Unexpected end of input」；
 *   用 PowerShell 的 Set-Content 改写本文件更会把中文编码搞坏
 *   （实测被写成 GBK 乱码，Node 直接 SyntaxError）。
 *   所以修改这个文件一律用编辑工具，不要用 PowerShell 重写。
 *
 * 验证内容（对应 m01882 的重点 bug「书写快时延迟、丢笔」）：
 *   ① drawMode 开启后 pointerdown 能否起笔
 *   ② 派发坐标是否真的落在页面上（elementFromPoint 命中测试）
 *   ③ 一批次塞入大量 pointermove 是否全部保留（不因 React 批处理丢点）
 *   ④ 收笔后是否落成一条批注、点数是否等于输入点数
 *
 * 用法：node tools/verify-pen-e2e.mjs [端口]
 */

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PORT = process.argv[2] ?? '9228'

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

/**
 * 从 cdp() 的输出里抠出 JSON 对象。
 *
 * 本脚本的诊断都是 `JSON.stringify(obj, null, 1)` 打印的（多行），
 * 不能像单行那样取最后一行 —— 这里直接取第一个 `{` 到最后一个 `}`。
 */
function parseObj(text) {
  const s = String(text)
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    return JSON.parse(s.slice(a, b + 1))
  } catch {
    return null
  }
}

/* ---------- ① 准备环境 ---------- */
/*
 * ★ 起手必须**复位视口与缩放**。
 *
 *   套件里前一个脚本可能把缩放留在 300%、把视口压到 520px，
 *   那样第 1 页会宽出视口（实测 left=-580），本脚本量到的坐标
 *   全在页面之外 —— 事件是直接 dispatch 到 .pdf-page 上的，
 *   照样能落库、照样「✓ 无丢点」，但**命中测试那一节永远是 null**，
 *   等于绕过了 pointer-events / 遮挡这类真实问题。
 *   复位之后坐标才真的落在页面上，测的才是用户那条链路。
 */
console.log('① 准备环境…')
console.log(
  cdp(`(() => {
    window.__sbDebugDraw = true;
    const s = window.__store.getState();
    s.setDrawMode(true);
    s.setPage(1);
    s.setZoom('fit-width');
    const v = document.querySelector('.viewer-scroll');
    if (v) v.scrollTop = 0;
    return JSON.stringify({ drawMode: window.__store.getState().drawMode, page: window.__store.getState().page, zoom: window.__store.getState().zoom });
  })()`)
)
await sleep(2200)

/* ---------- ② 量第 1 页底图矩形 ---------- */
const rectRaw = cdp(`(() => {
  const el = document.querySelector('.pdf-page[data-page="1"]');
  if (!el) return 'null';
  const cv = el.querySelector('canvas.pdf-page__canvas');
  const r = cv.getBoundingClientRect();
  return JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
})()`)
console.log('② 第 1 页底图矩形:', rectRaw)
const rect = JSON.parse(rectRaw.split('\n').pop())
if (!rect) {
  console.error('页面不可见，终止')
  process.exit(1)
}

const x0 = rect.left + 40
const y0 = rect.top + 120
const N = 60

/* ---------- ③ 命中测试：这个坐标上究竟是谁 ---------- */
/*
 * 批注迟迟不落库时，最容易被忽略的原因是「坐标其实不在页面上」：
 * 页面可能因为前面 setPage/滚动而位移，量到的矩形已经过期，
 * 派发的点落在滚动容器的空白处 —— 事件照样冒泡、window 上的
 * 诊断监听器照样收到，但 React 的 onPointerDown 挂在 .pdf-page 上，
 * 命中测试根本没选中它。
 * 用 elementFromPoint 直接问浏览器，一步就能排除或坐实。
 *
 * 这一节同时是**前置条件**：不在页面上就说明坐标没意义，
 * 结尾直接判失败，不再让脚本以「✓ 无丢点」蒙混过去。
 */
console.log('③ 命中测试:')
const hitRaw = cdp(`(() => {
    const el = document.elementFromPoint(${x0}, ${y0});
    const chain = [];
    let n = el;
    while (n && chain.length < 7) { chain.push(n.className || n.tagName); n = n.parentElement; }
    return JSON.stringify({
      命中: el ? (el.className || el.tagName) : null,
      在pdfPage内: el ? !!el.closest('.pdf-page') : false,
      哪一页: el && el.closest('.pdf-page') ? el.closest('.pdf-page').dataset.page : null,
      命中元素pointerEvents: el ? getComputedStyle(el).pointerEvents : null,
      祖先链: chain
    }, null, 1);
  })()`)
console.log(hitRaw)
const hit = parseObj(hitRaw)
const hitOk = !!hit && hit.在pdfPage内 === true

/* ---------- ④ 派发整条笔迹 ---------- */
console.log(`④ 从 (${x0}, ${y0}) 派发 ${N} 个移动点（一批次塞入）…`)
console.log(
  cdp(`(() => {
    const pageEl = document.querySelector('.pdf-page[data-page="1"]');
    const mk = (t, x, y) => new PointerEvent(t, {
      bubbles: true, cancelable: true, composed: true,
      pointerId: 1, pointerType: 'pen', isPrimary: true,
      clientX: x, clientY: y, button: 0,
      buttons: t === 'pointerup' ? 0 : 1,
      pressure: t === 'pointerup' ? 0 : 0.5
    });
    window.__penBefore = window.__store.getState().annotations.length;
    pageEl.dispatchEvent(mk('pointerdown', ${x0}, ${y0}));
    for (let i = 1; i <= ${N}; i++) pageEl.dispatchEvent(mk('pointermove', ${x0} + i * 6, ${y0}));
    pageEl.dispatchEvent(mk('pointerup', ${x0 + N * 6}, ${y0}));
    return '派发完成';
  })()`)
)
await sleep(1200)

/* ---------- ⑤ 读结果 ---------- */
console.log('⑤ 结果:')
const resultRaw = cdp(`(() => {
    const s = window.__store.getState();
    const added = s.annotations.length - window.__penBefore;
    const last = s.annotations[s.annotations.length - 1];
    let stroke = null;
    if (last && typeof last.quote === 'string' && last.quote.startsWith('[笔迹]')) {
      stroke = JSON.parse(last.quote.slice(4));
    }
    const n = stroke ? stroke.d.length : 0;
    return JSON.stringify({
      批注新增: added,
      笔迹点数: n,
      期望点数: ${N} + 1,
      格式版本: stroke ? stroke.v : null,
      笔宽: stroke ? stroke.w : null,
      起点: stroke ? [Math.round(stroke.d[0][0]), Math.round(stroke.d[0][1])] : null,
      终点X: stroke ? Math.round(stroke.d[n - 1][0]) : null,
      判定: n >= ${N} ? '✓ 无丢点' : n > 0 ? '△ 有丢点' : '★ 未落库'
    }, null, 1);
  })()`)
console.log(resultRaw)

/* ---------- ⑥ 判据与退出码 ---------- */
/*
 * 这个脚本以前**没有退出码**：无论丢点还是没落库，套件都显示 ✓。
 * 打印得很详细，但绿灯是假的。现在把三件事钉成硬判据：
 *   ① 坐标真的落在页面上（否则这次测量没有意义）
 *   ② 恰好新增 1 条批注
 *   ③ 点数一个不少（pointermove 的批处理没有吞点）
 */
const res = parseObj(resultRaw)
const fails = []
if (!hitOk) fails.push(`起点 (${x0}, ${y0}) 不在页面上（命中 ${hit ? hit.命中 : 'null'}）`)
if (!res || res.批注新增 !== 1) fails.push(`应新增 1 条批注，实际 ${res ? res.批注新增 : '?'}`)
if (!res || res.笔迹点数 !== N + 1) fails.push(`应有 ${N + 1} 个点，实际 ${res ? res.笔迹点数 : '?'}`)

if (fails.length) {
  console.error('\n=== 结果：未通过 ✗ ===\n  - ' + fails.join('\n  - '))
  process.exit(1)
}
console.log('\n=== 结果：全部通过 ✓（命中在页面上、新增 1 条、点数无丢失）===')
process.exit(0)
