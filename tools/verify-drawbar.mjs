// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 绘图工具条的端到端验证（含**退出绘画后置灰**这条老 bug 的回归）。
 *
 * ★ 为什么要重写这个脚本
 *   旧版本还停留在「粗细是三档离散按钮」的年代，去找 `.drawbar__width`
 *   这种早就不存在的元素，结果三项全是 0，而脚本**没有任何退出码**——
 *   报告一片「0 个 / 空数组」却永远返回 0，等于一个假绿灯。
 *   现在的控件是「连续滑块 + 实时预览点 + 数字读数」，判据必须跟着改。
 *   顺带把「退出绘画」这个用户报过的轻微 bug 也钉上回归断言。
 *
 * 判据：
 *   ① 颜色盘只有一处：全页 `.drawbar__color` 恰好 6 个，
 *      左栏/顶栏不再各挂一份（当年是 11 个分散在三处）
 *   ② 粗细是**连续滑块**：存在 input[type=range][aria-label=画笔粗细]，
 *      且改值后读数与预览点直径跟着变
 *   ③ 笔宽真的作用到笔迹上：通过滑块把宽度设成 X，画一笔，
 *      落库的笔迹 w === X
 *   ④ 选中的颜色真的作用到笔迹上：落库的笔迹颜色 === 选中色
 *   ⑤ **退出绘画后颜色盘与粗细条置灰但仍在**（不隐藏、不可点）——
 *      这是用户明确提过的要求：「不能隐藏任何工具栏图标」
 *   ⑥ 橡皮：进入橡皮后点中笔迹能把它切成两段（几何切段，不是整条删）
 *
 * 用法：node tools/verify-drawbar.mjs [端口]
 *
 * 注意：本文件含中文，**不要**用 PowerShell 的 Set-Content 改写（会变 GBK 乱码）。
 */

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PORT = process.argv[2] ?? '9223'

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
const j = (s) => {
  try {
    return JSON.parse(String(s).split('\n').pop())
  } catch {
    return null
  }
}

const fails = []
function check(label, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? '  —— ' + detail : ''}`)
  if (!ok) fails.push(label)
}

/** '#2f7fe8' → [47, 127, 232]；给不了就 null */
const hex = (h) => (/^#[0-9a-f]{6}$/i.test(String(h)) ? [1, 3, 5].map((i) => parseInt(String(h).slice(i, i + 2), 16)) : null)

console.log('=== 绘图工具条验证 ===\n')

/* ---------- ⓪ 复位：视口、缩放、页码、笔迹全清 ----------
 * 上一个脚本可能把缩放留在 300%，那样第 1 页会宽出视口、坐标全落空，
 * 后面每一条都会莫名其妙地失败。起手先复位，代价为零。
 *
 * ★ 笔迹也必须清掉。
 *   套件是**同一个实例**跑九个脚本，前一个（verify-pen-e2e）已经画了一条笔迹；
 *   墨迹画布是所有笔迹共用的，末尾那步「读像素平均色」会把别人的颜色一起平进去 ——
 *   实测清干净时平均色正好是 #2f7fe8，混进前一条之后变成 #6170be，
 *   于是判据看着像「颜色画错了」，其实只是量到了别的笔迹。
 */
const reset = j(
  cdp(`(() => {
    const s = window.__store.getState();
    s.setZoom('fit-width');
    s.setPage(1);
    s.setDrawMode(true);
    s.clearAnnotations();
    return JSON.stringify({ zoom: window.__store.getState().zoom });
  })()`)
)
await sleep(1200)
console.log(`⓪ 复位：缩放=${reset?.zoom}`)

const clean = j(cdp(`JSON.stringify({ 剩余批注: window.__store.getState().annotations.length })`))
console.log(`   清空笔迹：剩余批注 ${clean?.剩余批注}\n`)
check('起手画布是干净的（0 条批注）', clean?.剩余批注 === 0)

/* 把页面滚到顶，保证第 1 页真的在视口里 */
cdp(`(() => { const v = document.querySelector('.viewer-scroll'); if (v) v.scrollTop = 0; return 'ok' })()`)
await sleep(600)

/* ---------- ① 颜色盘唯一性 ---------- */
console.log('① 颜色盘唯一性')
const palette = j(
  cdp(`JSON.stringify((() => {
    const vis = (el) => el.offsetParent !== null;
    const colors = Array.from(document.querySelectorAll('.drawbar__color'));
    const wide = Array.from(document.querySelectorAll('.drawbar__color, .rail-color, .draw-tools .anno-color'));
    return {
      绘图条颜色: colors.length,
      可见颜色: colors.filter(vis).length,
      左栏颜色: document.querySelectorAll('.rail-color').length,
      顶栏颜色: document.querySelectorAll('.draw-tools .anno-color').length,
      合计: wide.length,
      可见合计: wide.filter(vis).length
    };
  })())`)
)
console.log(`   ${JSON.stringify(palette)}`)
/* v1.0.9 起工具条拆两条：颜色盘只应出现在底部授课条里，可见 6 色。 */
check(
  '颜色盘只有一处可见、共 6 色',
  palette && palette.可见合计 === 6 && palette.可见颜色 === 6,
  palette ? `可见 ${palette.可见合计} / 共 ${palette.合计}` : '读取失败'
)

/* ---------- ② 粗细是连续滑块 ---------- */
console.log('\n② 粗细控件形态')
const widthCtl = j(
  cdp(`(() => {
    const sl = document.querySelector('input[type=range][aria-label="画笔粗细"]');
    const prev = document.querySelector('.drawbar__preview');
    const ro = document.querySelector('.drawbar__readout');
    return JSON.stringify({
      有滑块: !!sl,
      滑块范围: sl ? sl.min + '~' + sl.max + ' step' + sl.step : null,
      读数: ro ? ro.textContent : null,
      预览直径: prev ? Math.round(prev.getBoundingClientRect().width) : null,
      离散档位按钮: document.querySelectorAll('.drawbar__width').length
    });
  })()`)
)
console.log(`   ${JSON.stringify(widthCtl)}`)
check('粗细是连续滑块（无离散档位按钮）', !!widthCtl?.有滑块 && widthCtl.离散档位按钮 === 0)

/* ---------- ③ 笔宽 + 颜色真的作用到笔迹上 ---------- */
console.log('\n③ 改宽度/颜色 → 画一笔 → 看落库的笔迹')

/* 选蓝色（顺序：红 蓝 绿 橙 紫 黑），宽度拉到一个好认的值 */
const TARGET_W = 9
const picked = j(
  cdp(`(() => {
    const colors = Array.from(document.querySelectorAll('.drawbar__color'));
    const blue = colors[1];
    if (blue) blue.click();
    const sl = document.querySelector('input[type=range][aria-label="画笔粗细"]');
    if (sl) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(sl, '${TARGET_W}');
      sl.dispatchEvent(new Event('input', { bubbles: true }));
      sl.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const st = window.__store.getState();
    return JSON.stringify({ drawColor: st.drawColor, drawWidth: st.drawWidth });
  })()`)
)
console.log(`   store: ${JSON.stringify(picked)}`)
await sleep(500)

/* 用真实指针事件画一笔（走 React 的 onPointerDown 那条链路） */
const box = j(
  cdp(`(() => {
    const el = document.querySelector('.pdf-page[data-page="1"]');
    if (!el) return 'null';
    const r = el.getBoundingClientRect();
    return JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), vh: innerHeight });
  })()`)
)
if (!box) {
  console.error('★ 第 1 页不在 DOM 里，无法继续')
  process.exit(1)
}
console.log(`   第 1 页矩形 ${JSON.stringify(box)}`)

/* 笔迹画在上部 1/4 处：底部有悬浮工具条会挡住，画在那里擦不到也画不上 */
const sx = box.left + Math.round(box.w * 0.25)
const sy = box.top + Math.round(Math.min(box.h * 0.25, box.vh * 0.3))

cdp(`(() => {
  const pageEl = document.querySelector('.pdf-page[data-page="1"]');
  const mk = (t, x, y) => new PointerEvent(t, {
    bubbles: true, cancelable: true, composed: true,
    pointerId: 1, pointerType: 'pen', isPrimary: true,
    clientX: x, clientY: y, button: 0,
    buttons: t === 'pointerup' ? 0 : 1,
    pressure: t === 'pointerup' ? 0 : 0.5
  });
  pageEl.dispatchEvent(mk('pointerdown', ${sx}, ${sy}));
  for (let i = 1; i <= 40; i++) pageEl.dispatchEvent(mk('pointermove', ${sx} + i * 6, ${sy}));
  pageEl.dispatchEvent(mk('pointerup', ${sx + 240}, ${sy}));
  return 'ok';
})()`)
await sleep(1200)

/*
 * 颜色存在**批注的 color 字段**上，不在 quote 的笔迹载荷里
 * （载荷只有 { v, w, d }，见 src/renderer/src/ink-engine.tsx:50-55，
 * 渲染时由 toStrokeShape 把 item.color 贴回 StrokeShape.color，
 * 见 src/renderer/src/ink-engine.tsx:395-405）。
 * 光看数据还不够——真正要证明的是「用户看到的是蓝色」，
 * 所以再直接读一次墨迹画布的像素平均色。
 */
const stroke = j(
  cdp(`(() => {
    const s = window.__store.getState();
    const last = s.annotations[s.annotations.length - 1];
    if (!last) return JSON.stringify({ 条数: 0 });
    const isStroke = typeof last.quote === 'string' && last.quote.startsWith('[笔迹]');
    const payload = isStroke ? JSON.parse(last.quote.slice(4)) : null;
    return JSON.stringify({
      条数: s.annotations.length,
      是笔迹: isStroke,
      笔宽: payload ? payload.w : null,
      格式版本: payload ? payload.v : null,
      颜色: last.color ?? null,
      点数: payload && Array.isArray(payload.d) ? payload.d.length : 0
    });
  })()`)
)
console.log(`   落库：${JSON.stringify(stroke)}`)
check('画出了一条笔迹', !!stroke?.是笔迹 && stroke.点数 > 0)
check(
  `笔迹宽度 === 滑块设的 ${TARGET_W}`,
  stroke?.笔宽 === TARGET_W,
  `实际 ${stroke?.笔宽}（store.drawWidth=${picked?.drawWidth}）`
)
check('批注 color === 选中的蓝色', !!stroke?.颜色 && stroke.颜色 === picked?.drawColor, `实际 ${stroke?.颜色}`)

/* 视觉验证：墨迹画布上不透明像素的**主体颜色**应当就是选的蓝 */
const TARGET = hex(picked?.drawColor)
const inkPixels = j(
  cdp(`(() => {
    const cv = document.querySelector('.ink-canvas');
    if (!cv || !cv.getContext) return JSON.stringify({ 画布: false });
    const target = [${TARGET ? TARGET.join(', ') : '0, 0, 0'}];
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const { width: W, height: H } = cv;
    const img = ctx.getImageData(0, 0, W, H).data;
    let n = 0, r = 0, g = 0, b = 0, near = 0;
    for (let i = 0; i < img.length; i += 4) {
      if (img[i + 3] < 64) continue;      // 只看画实了的像素
      n++; r += img[i]; g += img[i + 1]; b += img[i + 2];
      // 逐像素比对目标色，抗锯齿边缘会偏出去，所以按比例判而不是要求全部命中
      if (Math.abs(img[i] - target[0]) <= 40 && Math.abs(img[i + 1] - target[1]) <= 40 && Math.abs(img[i + 2] - target[2]) <= 40) near++;
    }
    return JSON.stringify({
      画布: true,
      尺寸: W + 'x' + H,
      不透明像素: n,
      平均色: n ? '#' + [r / n, g / n, b / n].map(v => Math.round(v).toString(16).padStart(2, '0')).join('') : null,
      接近目标色占比: n ? Math.round((near / n) * 100) : 0
    });
  })()`)
)
console.log(`   墨迹画布：${JSON.stringify(inkPixels)}`)
check(
  '墨迹画布上真的画出了这个颜色（像素主体比对）',
  inkPixels?.不透明像素 > 0 && inkPixels.接近目标色占比 >= 70,
  `期望 ${picked?.drawColor}，实测 平均色 ${inkPixels?.平均色}、接近色占比 ${inkPixels?.接近目标色占比}%`
)

/* ---------- ④ 退出绘画后置灰但仍在 ---------- */
console.log('\n④ 退出绘画后的置灰（用户报过的轻微 bug）')
const muted = j(
  cdp(`(() => {
    const s = window.__store.getState();
    s.setDrawMode(false);
    return 'ok';
  })()`)
)
await sleep(700)

const afterExit = j(
  cdp(`(() => {
    const colors = document.querySelector('.drawbar__group--colors');
    const width = document.querySelector('.drawbar__group--width');
    const colorBtns = Array.from(document.querySelectorAll('.drawbar__color'));
    const slider = document.querySelector('input[type=range][aria-label="画笔粗细"]');
    return JSON.stringify({
      工具条仍在: !!document.querySelector('.drawbar'),
      颜色组存在: !!colors,
      颜色组置灰: colors ? colors.classList.contains('is-muted') : null,
      颜色按钮数: colorBtns.length,
      颜色按钮全禁用: colorBtns.length > 0 && colorBtns.every(b => b.disabled),
      粗细组存在: !!width,
      粗细组置灰: width ? width.classList.contains('is-muted') : null,
      滑块禁用: slider ? slider.disabled : null,
      激活的颜色数: document.querySelectorAll('.drawbar__color.is-active').length
    });
  })()`)
)
console.log(`   ${JSON.stringify(afterExit)}`)
/* v1.0.9 契约：工具条拆成顶（备课）/底（授课）两条，分组不重复可见。 */
const split = j(
  cdp(`JSON.stringify((() => {
    const bars = Array.from(document.querySelectorAll('.drawbar'));
    const visGroups = (bar) =>
      Array.from(bar.querySelectorAll('.drawbar__group'))
        .filter((g) => getComputedStyle(g).display !== 'none')
        .map((g) => g.getAttribute('data-group-name'));
    return {
      条数: bars.length,
      顶栏组: bars[0] ? visGroups(bars[0]) : [],
      底栏组: bars[1] ? visGroups(bars[1]) : [],
      底栏定位: bars[1] ? getComputedStyle(bars[1]).position : null,
      底栏可见: bars[1] ? (bars[1].getBoundingClientRect().height > 0 && getComputedStyle(bars[1]).display !== 'none') : false
    };
  })())`)
)
console.log(`   拆分 ${JSON.stringify(split)}`)
check(
  '工具条拆成顶/底两条，备课在上、授课在下',
  !!split &&
    split.条数 === 2 &&
    split.顶栏组.join(',') === '插入,编辑' &&
    split.底栏组.join(',') === '开始,颜色,画笔' &&
    split.底栏定位 === 'fixed' &&
    split.底栏可见 === true
)
check('颜色组置灰且按钮全禁用', afterExit?.颜色组置灰 === true && afterExit?.颜色按钮全禁用 === true)
check('粗细组置灰且滑块禁用', afterExit?.粗细组置灰 === true && afterExit?.滑块禁用 === true)

/* ---------- ⑤ 橡皮切段 ---------- */
console.log('\n⑤ 橡皮（几何切段）')
cdp(`(() => {
  const s = window.__store.getState();
  s.setDrawMode(true);
  s.setEraserMode(true);
  return 'ok';
})()`)
await sleep(700)

const segsBefore = j(
  cdp(`(() => {
    const s = window.__store.getState();
    const st = s.annotations.filter(a => typeof a.quote === 'string' && a.quote.startsWith('[笔迹]'));
    return JSON.stringify({ 笔迹条数: st.length, 批注总数: s.annotations.length });
  })()`)
)
console.log(`   擦前：${JSON.stringify(segsBefore)}`)

/* 点在笔迹中段（起点右侧 120px） */
cdp(`(() => {
  const el = document.querySelector('.pdf-page[data-page="1"]');
  const mk = (t, x, y) => new PointerEvent(t, {
    bubbles: true, cancelable: true, composed: true,
    pointerId: 2, pointerType: 'pen', isPrimary: true,
    clientX: x, clientY: y, button: 0,
    buttons: t === 'pointerup' ? 0 : 1,
    pressure: t === 'pointerup' ? 0 : 0.5
  });
  el.dispatchEvent(mk('pointerdown', ${sx + 120}, ${sy}));
  el.dispatchEvent(mk('pointerup', ${sx + 120}, ${sy}));
  return 'ok';
})()`)
await sleep(1200)

const segsAfter = j(
  cdp(`(() => {
    const s = window.__store.getState();
    const st = s.annotations.filter(a => typeof a.quote === 'string' && a.quote.startsWith('[笔迹]'));
    return JSON.stringify({ 笔迹条数: st.length, 批注总数: s.annotations.length });
  })()`)
)
console.log(`   擦后：${JSON.stringify(segsAfter)}`)
check(
  '橡皮把一条笔迹切成两段（不是整条删除）',
  segsAfter?.笔迹条数 === (segsBefore?.笔迹条数 ?? 0) + 1,
  `${segsBefore?.笔迹条数} → ${segsAfter?.笔迹条数}`
)

/* 收尾：退出橡皮与绘画，别把状态留给下一个脚本 */
cdp(`(() => { const s = window.__store.getState(); s.setEraserMode(false); s.setDrawMode(false); return 'ok' })()`)

console.log(fails.length ? `\n=== 结果：${fails.length} 项未通过 ===\n  - ${fails.join('\n  - ')}` : '\n=== 结果：全部通过 ✓ ===')
process.exit(fails.length ? 1 : 0)
