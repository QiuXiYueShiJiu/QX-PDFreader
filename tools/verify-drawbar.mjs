// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 画笔控件的端到端验证（单条 Office 功能区契约，含**退出绘画后置灰**的回归）。
 *
 * ★ 为什么要重写这个脚本
 *   旧版本停留在「工具条拆成顶/底两条」的年代，去找 `.drawbar__color`、
 *   `.drawbar__group--colors`、`.drawbar__group--width` 这些 1.0.9.x 已经不存在的元素，
 *   而且断言里还写着「工具条拆成两条，备课在上、授课在下」—— 这与用户回退后的
 *   **单条功能区**正好相反，属于契约性假红。
 *
 *   现在的画笔控件在功能区的「开始」页里，选择器是 `[data-tb-id^="pen-color-"]`
 *   （六个色块）与 `input.ribbon__slider[aria-label="画笔粗细"]`（连续滑块），
 *   置灰钩子也换成了 `.ribbon__width.is-muted` + 按钮 `disabled`。
 *
 * 判据：
 *   ① 颜色盘只有一处：功能区「开始」页恰好 6 个可见色块，
 *      左栏/旧顶栏不再各挂一份（当年是 11 个分散在三处）
 *   ② 粗细是**连续滑块**：存在 input[type=range][aria-label=画笔粗细]，
 *      改值后读数与预览点直径跟着变
 *   ③ 笔宽真的作用到笔迹上：通过滑块把宽度设成 X，画一笔，落库的笔迹 w === X
 *   ④ 选中的颜色真的作用到笔迹上：落库的批注 color === 选中色，且墨迹画布像素主体同色
 *   ⑤ **退出绘画后颜色块与粗细条置灰但仍在**（不隐藏、不可点）——
 *      这是用户明确提过的要求：「不能隐藏任何工具栏图标」
 *   ⑥ 版面契约：画笔控件在**唯一一条**功能区里（不存在 .drawbar），
 *      「开始」页分组顺序是 工具 / 插入 / 颜色 / 画笔粗细 / 编辑
 *   ⑦ 橡皮：进入橡皮后点中笔迹能把它切成两段（几何切段，不是整条删）
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

const BLUE = 'pen-color-2f7fe8'

console.log('=== 画笔控件验证（单条功能区）===\n')

/* ---------- ⓪ 复位：页签、视口、缩放、页码、笔迹全清 ----------
 * 上一个脚本可能把缩放留在 300%，那样第 1 页会宽出视口、坐标全落空，
 * 后面每一条都会莫名其妙地失败。起手先复位，代价为零。
 *
 * ★ 笔迹也必须清掉。
 *   套件是**同一个实例**跑九个脚本，前一个（verify-pen-e2e）已经画了一条笔迹；
 *   墨迹画布是所有笔迹共用的，末尾那步「读像素平均色」会把别人的颜色一起平进去 ——
 *   实测清干净时平均色正好是 #2f7fe8，混进前一条之后变成 #6170be，
 *   于是判据看着像「颜色画错了」，其实只是量到了别的笔迹。
 *
 * ★ 还必须先点开「开始」页签：功能区只渲染当前页签的按钮，
 *   上一支脚本可能停在「工具」或「视图」页，那样色块与滑块根本不在 DOM 里。
 */
const reset = j(
  cdp(`(() => {
    const tab = document.querySelector('[data-tb-id="ribbon-tab-home"]');
    if (tab) tab.click();
    const s = window.__store.getState();
    s.setZoom('fit-width');
    s.setPage(1);
    s.setDrawMode(true);
    s.setEraserMode(false);
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
    const colors = Array.from(document.querySelectorAll('[data-tb-id^="pen-color-"]'));
    const wide = Array.from(document.querySelectorAll('[data-tb-id^="pen-color-"], .rail-color, .draw-tools .anno-color'));
    return {
      功能区颜色: colors.length,
      可见颜色: colors.filter(vis).length,
      左栏颜色: document.querySelectorAll('.rail-color').length,
      旧顶栏颜色: document.querySelectorAll('.draw-tools .anno-color').length,
      合计: wide.length,
      可见合计: wide.filter(vis).length
    };
  })())`)
)
console.log(`   ${JSON.stringify(palette)}`)
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
    const prev = document.querySelector('.ribbon__preview');
    const ro = document.querySelector('.ribbon__readout');
    return JSON.stringify({
      有滑块: !!sl,
      滑块范围: sl ? sl.min + '~' + sl.max + ' step' + sl.step : null,
      读数: ro ? ro.textContent.trim() : null,
      预览直径: prev ? Math.round(prev.getBoundingClientRect().width) : null,
      离散档位按钮: document.querySelectorAll('.drawbar__width').length
    });
  })()`)
)
console.log(`   ${JSON.stringify(widthCtl)}`)
check('粗细是连续滑块（无离散档位按钮）', !!widthCtl?.有滑块 && widthCtl.离散档位按钮 === 0)

/* ---------- ③ 笔宽 + 颜色真的作用到笔迹上 ---------- */
console.log('\n③ 改宽度/颜色 → 画一笔 → 看落库的笔迹')

/* 选蓝色（data-tb-id 固定为 pen-color-2f7fe8），宽度拉到一个好认的值 */
const TARGET_W = 9
const picked = j(
  cdp(`(() => {
    const blue = document.querySelector('[data-tb-id="${BLUE}"]');
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
  inkPixels?.不透明像素 > 0 && inkPixels?.接近目标色占比 >= 70,
  `期望 ${picked?.drawColor}，实测 平均色 ${inkPixels?.平均色}、接近色占比 ${inkPixels?.接近目标色占比}%`
)

/* ---------- ④ 退出绘画后置灰但仍在 ---------- */
console.log('\n④ 退出绘画后的置灰（用户报过的轻微 bug）')
cdp(`(() => { window.__store.getState().setDrawMode(false); return 'ok' })()`)
await sleep(700)

const afterExit = j(
  cdp(`(() => {
    const width = document.querySelector('.ribbon__width');
    const colorBtns = Array.from(document.querySelectorAll('[data-tb-id^="pen-color-"]'));
    const slider = document.querySelector('input[type=range][aria-label="画笔粗细"]');
    return JSON.stringify({
      功能区仍在: !!document.querySelector('.ribbon'),
      粗细组存在: !!width,
      粗细组可见: width ? (width.offsetParent !== null && getComputedStyle(width).display !== 'none') : false,
      粗细组置灰: width ? width.classList.contains('is-muted') : null,
      颜色按钮数: colorBtns.length,
      颜色按钮全禁用: colorBtns.length > 0 && colorBtns.every(b => b.disabled),
      颜色块仍可见: colorBtns.filter(b => b.offsetParent !== null).length,
      滑块禁用: slider ? slider.disabled : null
    });
  })()`)
)
console.log(`   ${JSON.stringify(afterExit)}`)
check('颜色块置灰但仍在（不隐藏）', afterExit?.颜色按钮全禁用 === true && afterExit?.颜色块仍可见 === 6)
check(
  '粗细组置灰但仍在（不隐藏）',
  afterExit?.粗细组置灰 === true && afterExit?.滑块禁用 === true && afterExit?.粗细组可见 === true
)

/* ---------- ⑥ 版面契约：上栏功能区 + 下栏悬浮画笔条 ---------- */
console.log('\n⑥ 版面契约（上栏功能区 + 下栏悬浮画笔条）')
const layout = j(
  cdp(`JSON.stringify((() => {
    const ribbons = Array.from(document.querySelectorAll('.ribbon'));
    const dock = document.querySelector('.dock');
    const labels = ribbons[0]
      ? Array.from(ribbons[0].querySelectorAll('.ribbon__group-label'))
          .filter((el) => el.offsetParent !== null)
          .map((el) => (el.textContent || '').trim())
      : [];
    const dockIds = dock
      ? Array.from(dock.querySelectorAll('[data-tb-id]')).map((el) => el.dataset.tbId)
      : [];
    const rect = dock ? dock.getBoundingClientRect() : null;
    return {
      功能区条数: ribbons.length,
      开始页分组: labels,
      画笔条条数: dock ? 1 : 0,
      画笔条按钮: dockIds.length,
      画笔条贴底: rect ? rect.bottom <= window.innerHeight - 20 : false,
      画笔条位置: rect ? getComputedStyle(dock).position : null,
      旧画笔条: document.querySelectorAll('.drawbar').length,
      display: ribbons[0] ? getComputedStyle(ribbons[0]).display : null
    };
  })())`)
)
console.log(`   ${JSON.stringify(layout)}`)
check(
  '上栏只剩插入/编辑两组，画笔控件都在下栏悬浮条里（旧的 .drawbar 已下线）',
  layout &&
    layout.功能区条数 === 1 &&
    layout.旧画笔条 === 0 &&
    layout.display === 'flex' &&
    /* 用户 2026-10-27 要求：画笔/橡皮/调色盘/粗细/清屏放底部悬浮栏，
       上栏只留文档级操作（插入类 + 撤销重做）。 */
    layout.开始页分组.join(',') === '插入,编辑' &&
    layout.画笔条条数 === 1 &&
    layout.画笔条位置 === 'fixed' &&
    layout.画笔条贴底 === true &&
    /* 漫游/画笔/橡皮 + 六个颜色 + 滑块 + 清屏都在条里 */
    layout.画笔条按钮 >= 9,
  layout
    ? `上栏分组=[${layout.开始页分组.join(', ')}]、悬浮条按钮=${layout.画笔条按钮}、position=${layout.画笔条位置}、贴底=${layout.画笔条贴底}、.drawbar=${layout.旧画笔条}`
    : '读取失败'
)

/* ---------- ⑦ 橡皮切段 ---------- */
console.log('\n⑦ 橡皮（几何切段）')
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
