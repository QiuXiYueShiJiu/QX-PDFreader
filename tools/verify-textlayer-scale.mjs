/**
 * 文字层选字质量 + 漫游不选字（**全程隐藏窗口**）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 覆盖的两个缺陷（用户 2026-10-17 报）
 * ══════════════════════════════════════════════════════════════════
 *   ① 「选择一串文字就有可能选择一大串」
 *      根因：项目从未定义 CSS 变量 `--scale-factor`，而 pdf.js 的 TextLayer
 *      全靠它换算每个 span 的字号与宽度：
 *        fontSize      = calc(<PDF 字号对应的 px> * var(--scale-factor))
 *        letterSpacing = calc(<advance 宽度> * var(--scale-factor) - 1ch)
 *      变量缺失 → 整条 calc() 失效 → 字号回退到容器默认（约 16px），
 *      与真实字形不符 → span 宽度错 → 选中高亮盖住整行甚至跨行。
 *
 *   ② 「漫游只需要滑动屏幕，不需要操作文本」
 *      根因：startRoamPan 里有一段「起点落在文字字符上就让给选字」。
 *
 * 判据
 *   · `--scale-factor` 有值
 *   · span 字号是有效数值、且中等宽度 span 没有横跨整页
 *   · 漫游工具下在文字上拖动**不产生选区**
 *   · 选择工具下文字层仍可选中
 *
 * 用法（与其它 verify-*.mjs 一致，实例由套件负责起）：
 *   node tools/run-verify-suite.mjs --dev 9295 verify-textlayer-scale.mjs
 */

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PORT = Number(process.argv[2] ?? process.env.PDF_READER_PORT ?? 9295)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let fails = 0
let checks = 0
const check = (ok, label, detail = '') => {
  checks += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  —— ${detail}` : ''}`)
  if (!ok) fails += 1
}

/** 经 scripts/cdp-eval.mjs 求值（与其它用例同一套通道） */
function cdp(expr, timeout = 120000) {
  const r = spawnSync('node', [join(root, 'scripts', 'cdp-eval.mjs'), String(PORT), expr], {
    cwd: root,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout
  })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
}

console.log('文字层选字质量 + 漫游不选字（隐藏窗口）')
console.log(`  端口 ${PORT}\n`)

/* 等首页文本层渲染出来 */
let spanCount = 0
for (let i = 0; i < 40; i++) {
  const n = cdp(`document.querySelectorAll('.textLayer span').length`, 30000)
  spanCount = Number(n)
  if (spanCount > 0) break
  await sleep(500)
}
check(spanCount > 0, '文本层已渲染出 span', `${spanCount} 个`)

const raw = cdp(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const s = window.__store;
  const out = {};

  const pickLayer = () => {
    /*
     * ★ 不能直接 document.querySelector('.textLayer')：
     *   连续滚动模式下所有挂载页都有自己的文本层，
     *   第一个往往是还没渲染的空层（实测就是这么踩的）。
     *   这里在所有文本层里挑「在视口内、且 span 最多」的那个。
     */
    const all = [...document.querySelectorAll('.textLayer')];
    let best = null;
    let bestScore = -1;
    for (const l of all) {
      const r = l.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
      const n = l.querySelectorAll('span').length;
      const score = (visible ? 1e6 : 0) + n;
      if (score > bestScore) { bestScore = score; best = l; }
    }
    return best;
  };

  /* ---------- ① --scale-factor 与 span 尺寸 ---------- */
  const layer = pickLayer();
  if (!layer) return JSON.stringify({ error: 'no textLayer' });
  out.scaleFactor = getComputedStyle(layer).getPropertyValue('--scale-factor').trim() || '(未设置)';

  const spans = [...layer.querySelectorAll('span')].filter(x => x.textContent.trim().length > 0);
  out.spanCount = spans.length;
  const page = layer.closest('.pdf-page');
  const canvas = page && page.querySelector('.pdf-page__canvas');
  out.canvasWidth = canvas ? Math.round(canvas.getBoundingClientRect().width) : null;

  const withRect = spans
    .map(x => ({ el: x, r: x.getBoundingClientRect(), t: x.textContent.trim() }))
    .filter(x => x.r.width > 1);
  withRect.sort((a, b) => a.r.width - b.r.width);
  const mid = withRect[Math.floor(withRect.length / 2)];
  if (mid) {
    const st = getComputedStyle(mid.el);
    out.midSpan = {
      文本: mid.t.slice(0, 30),
      字号: st.fontSize,
      字距: st.letterSpacing,
      宽: Math.round(mid.r.width),
      高: Math.round(mid.r.height),
      每字符宽: +(mid.r.width / Math.max(1, mid.t.length)).toFixed(2)
    };
  }

  /* ---------- ② 漫游下按在文字上拖动不应产生选区 ---------- */
  const before = window.getSelection();
  before && before.removeAllRanges();
  s.getState().setRoam && s.getState().setRoam();
  await w(400);
  out.漫游_class = document.querySelector('.viewer-scroll').className;

  const target = mid ? mid.el : layer;
  const r = target.getBoundingClientRect();
  const cx = r.left + Math.min(4, Math.max(1, r.width / 2));
  const cy = r.top + r.height / 2;
  const fire = (type, extra = {}) =>
    target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      clientX: cx, clientY: cy, button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      pointerId: 1, pointerType: 'mouse', isPrimary: true, ...extra
    }));
  fire('pointerdown');
  fire('pointermove', { clientX: cx + 80, clientY: cy + 8 });
  fire('pointerup');
  await w(250);
  const sel = window.getSelection();
  out.漫游_选中字符数 = sel ? sel.toString().length : -1;
  sel && sel.removeAllRanges();

  /* ---------- ③ 选择工具下文字层仍可选 ---------- */
  s.getState().setEditTool && s.getState().setEditTool('select');
  await w(400);
  const layer2 = pickLayer();
  const cs2 = layer2 ? getComputedStyle(layer2) : null;
  out.选择_userSelect = cs2 ? cs2.userSelect : null;
  out.选择_pointerEvents = cs2 ? cs2.pointerEvents : null;
  s.getState().setEditTool && s.getState().setEditTool('none');

  return JSON.stringify(out, null, 1);
})()`)

console.log(raw)

let data = null
try {
  data = JSON.parse(raw.slice(raw.indexOf('{')))
} catch {
  console.error('✗ 探针返回无法解析')
  process.exit(1)
}

console.log('\n=== 判据 ===')
check(data.scaleFactor && data.scaleFactor !== '(未设置)', '① `.textLayer` 定义了 --scale-factor', data.scaleFactor)
check(
  data.midSpan && Number.parseFloat(data.midSpan.字号) > 0,
  '① span 字号是有效数值（不是回退成容器默认值）',
  data.midSpan ? data.midSpan.字号 : '(无)'
)
check(
  data.midSpan && data.canvasWidth && data.midSpan.宽 < data.canvasWidth * 0.98,
  '① 中等 span 没有横跨整页（错位时会跨整行）',
  data.midSpan ? `span 宽 ${data.midSpan.宽} / 画布宽 ${data.canvasWidth}，每字符 ${data.midSpan.每字符宽}px` : ''
)
check(data.漫游_选中字符数 === 0, '② 漫游工具下在文字上拖动**不产生选区**', `选中 ${data.漫游_选中字符数} 个字符`)
check(data.选择_userSelect === 'text', '③ 选择工具下文字层可选中（user-select=text）', String(data.选择_userSelect))

console.log(`\n=== 结果：${checks} 项检查，${fails} 项失败 ===`)
process.exit(fails > 0 ? 1 : 0)
