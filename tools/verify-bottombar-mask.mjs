// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 底部工具条合并 + 遮罩触屏适配 —— 隐藏窗口内的判据。
 *
 * ══════════════════════════════════════════════════════════════════
 * 对应两条用户需求（2026-10-16）
 * ══════════════════════════════════════════════════════════════════
 *  ①「选择等功能唤出的临时工具栏合并下栏」
 *     原先「选择 / 文字 / 图片 / 涂白 / 矩形 / 椭圆」的选项条是浮在
 *     阅读区**顶部**的 `.edit-bar`；现在并入底部唯一工具条的
 *     `.drawbar__editdock`，并且**内容随当前工具变化**：
 *       选择 → 复制/高亮/下划线（在选区小工具条上）
 *       文字 → 字号 6 档 + 颜色
 *       矩形 → 线宽 4 档 + 颜色
 *       图片 → 选图按钮
 *       涂白 → 不给调色板（颜色固定为白）
 *     判据必须同时覆盖「在不在下栏里」与「内容有没有跟着换」——
 *     只查前者会漏掉「永远是同一套按钮」这种假实现。
 *
 *  ②「聚光灯等功能不能很好适应触摸屏」
 *     原先只认 pointermove + 滚轮：一体机上没有 hover、没有滚轮，
 *     等于「光圈不动、也没法调大小」。现在支持单指拖动 / 双指捏合 /
 *     外缘圆点，退出按钮挪到屏幕最下方居中。
 *
 * 说明：全程连套件的隐藏实例（--hidden），不显示任何窗口、不动前台。
 *
 * 用法：node tools/verify-bottombar-mask.mjs [端口]
 */

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PORT = Number(process.argv[3] ?? process.argv[2] ?? 9290)

const fails = []
function check(label, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? '  —— ' + detail : ''}`)
  if (!ok) fails.push(label)
}

function cdp(expr, timeout = 40000) {
  const r = spawnSync('node', [join(root, 'scripts', 'cdp-eval.mjs'), String(PORT), expr], {
    cwd: root,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout
  })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
}

const j = (s) => {
  try {
    return JSON.parse(String(s).split('\n').pop())
  } catch {
    return null
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('=== 底部工具条合并 + 遮罩触屏适配 ===\n')

/* ═══════════════ ① 编辑功能区在下栏里，且内容随工具变化 ═══════════════ */
console.log('① 编辑功能区合并进下栏')

/**
 * 激活某个编辑工具并等一帧。
 *
 * 用 store 直接设：这条用例测的是**布局与内容**，
 * 走 DOM 点击会把「工具按钮能不能点」也搅进来（那是 verify-content-edit 的活）。
 */
async function activate(tool) {
  cdp(`(() => { window.__store.getState().setEditTool(${JSON.stringify(tool)}); return 'ok' })()`)
  await sleep(350)
}

/*
 * ★ 先激活「文字」再检测结构：`.drawbar__editdock` 与 `.edit-bar` 都是
 *   **条件渲染**的（没进编辑态就不该多占一行高度）。在激活之前查它们
 *   必然是 false —— 第一版就是这么误报的。
 */
await activate('text')

const structure = j(
  cdp(`(() => {
     const dock = document.querySelector('.drawbar__editdock');
     const bar = dock ? dock.querySelector('.edit-bar') : null;
     const drawbar = document.querySelector('.drawbar');
     const topLevelBar = document.querySelector('.app > .edit-bar, body > .edit-bar');
     const r = bar ? bar.getBoundingClientRect() : null;
     const dr = drawbar ? drawbar.getBoundingClientRect() : null;
     return JSON.stringify({
       有下栏: !!drawbar,
       有编辑槽: !!dock,
       槽在下栏内: !!(dock && drawbar && drawbar.contains(dock)),
       槽里有编辑条: !!bar,
       编辑条在下栏内: !!(bar && drawbar && drawbar.contains(bar)),
       顶层浮条: !!topLevelBar,
       编辑条矩形: r ? { 上: Math.round(r.top), 下: Math.round(r.bottom), 宽: Math.round(r.width) } : null,
       下栏矩形: dr ? { 上: Math.round(dr.top), 下: Math.round(dr.bottom) } : null,
       视口高: window.innerHeight
     });
   })()`)
)
const withText = j(
  cdp(`(() => {
     const dock = document.querySelector('.drawbar__editdock');
     const bar = dock ? dock.querySelector('.edit-bar') : null;
     const drawbar = document.querySelector('.drawbar');
     const r = bar ? bar.getBoundingClientRect() : null;
     const dr = drawbar ? drawbar.getBoundingClientRect() : null;
     return JSON.stringify({
       工具: bar ? bar.getAttribute('data-tool') : null,
       字号钮: document.querySelectorAll('[data-tb-id^="edit-fontsize-"]').length,
       线宽钮: document.querySelectorAll('[data-tb-id^="edit-strokewidth-"]').length,
       颜色钮: document.querySelectorAll('[data-tb-id^="edit-color-"]').length,
       导出钮: !!document.querySelector('[data-tb-id="edit-export"]'),
       完成钮: !!document.querySelector('[data-tb-id="edit-done"]'),
       条在下栏内: !!(bar && drawbar && drawbar.contains(bar)),
       条底: r ? Math.round(r.bottom) : null,
       栏底: dr ? Math.round(dr.bottom) : null,
       视口高: window.innerHeight
     });
   })()`)
)
console.log(`   文字工具：${JSON.stringify(withText)}`)
check('底部工具条存在', structure?.有下栏 === true)
check('下栏里有编辑功能区槽位', structure?.有编辑槽 === true)
check('槽位在下栏**内部**', structure?.槽在下栏内 === true)
check('编辑条渲染在下栏内部（不再浮在顶部）', withText?.条在下栏内 === true)
check('阅读区顶部不再有独立浮动的编辑条', structure?.顶层浮条 === false)
check('编辑条整体落在屏幕下半部（属于下栏）', (withText?.条底 ?? 0) > (withText?.视口高 ?? 0) / 2, `条底=${withText?.条底} 视口高=${withText?.视口高}`)
check('文字工具显示 6 档字号', withText?.字号钮 === 6, `实际 ${withText?.字号钮}`)
check('文字工具显示调色板', (withText?.颜色钮 ?? 0) >= 6, `实际 ${withText?.颜色钮}`)
check('文字工具不显示线宽档', withText?.线宽钮 === 0, `实际 ${withText?.线宽钮}`)
check('导出 / 完成按钮都在', withText?.导出钮 === true && withText?.完成钮 === true)

/* 切到矩形：内容应换成「线宽 + 颜色」 */
await activate('rect')
const withRect = j(
  cdp(`(() => {
     const bar = document.querySelector('.drawbar__editdock .edit-bar');
     return JSON.stringify({
       工具: bar ? bar.getAttribute('data-tool') : null,
       字号钮: document.querySelectorAll('[data-tb-id^="edit-fontsize-"]').length,
       线宽钮: document.querySelectorAll('[data-tb-id^="edit-strokewidth-"]').length,
       颜色钮: document.querySelectorAll('[data-tb-id^="edit-color-"]').length
     });
   })()`)
)
console.log(`   矩形工具：${JSON.stringify(withRect)}`)
check('切到矩形后 data-tool 跟着变', withRect?.工具 === 'rect', `实际 ${withRect?.工具}`)
check('矩形显示 4 档线宽', withRect?.线宽钮 === 4, `实际 ${withRect?.线宽钮}`)
check('矩形显示调色板', (withRect?.颜色钮 ?? 0) >= 6)
check('矩形**不再**显示字号（内容真的换过）', withRect?.字号钮 === 0, `实际 ${withRect?.字号钮}`)

/* 切到涂白：不管颜色 */
await activate('whiteout')
const withWhiteout = j(
  cdp(`(() => {
     const bar = document.querySelector('.drawbar__editdock .edit-bar');
     return JSON.stringify({
       工具: bar ? bar.getAttribute('data-tool') : null,
       颜色钮: document.querySelectorAll('[data-tb-id^="edit-color-"]').length,
       字号钮: document.querySelectorAll('[data-tb-id^="edit-fontsize-"]').length,
       线宽钮: document.querySelectorAll('[data-tb-id^="edit-strokewidth-"]').length
     });
   })()`)
)
console.log(`   涂白工具：${JSON.stringify(withWhiteout)}`)
check('涂白不显示调色板（颜色固定为白）', withWhiteout?.颜色钮 === 0, `实际 ${withWhiteout?.颜色钮}`)
check('涂白不显示字号/线宽', withWhiteout?.字号钮 === 0 && withWhiteout?.线宽钮 === 0)

/* 切到图片：出现选图按钮 */
await activate('image')
const withImage = j(
  cdp(`(() => {
     const bar = document.querySelector('.drawbar__editdock .edit-bar');
     return JSON.stringify({
       工具: bar ? bar.getAttribute('data-tool') : null,
       选图钮: !!document.querySelector('[data-tb-id="edit-pick-image"]'),
       隐藏input: !!document.querySelector('[data-edit-file="1"]')
     });
   })()`)
)
console.log(`   图片工具：${JSON.stringify(withImage)}`)
check('图片工具出现「选择图片」按钮', withImage?.选图钮 === true)
check('隐藏的 file input 仍在（触屏能唤起相册）', withImage?.隐藏input === true)

/*
 * 先把「未导出的内容编辑」清干净。
 * 1.0.6.x 起：只要还有没导出的内容编辑，编辑条就常驻（提示用户导出），
 * 这是有意设计；但脏实例上「退出编辑后整行消失」这条判据会误报。
 * 截图脚本、别的用例留下脏状态时就会踩到，所以这里显式复位。
 */
await cdp(`(() => {
  const s = window.__store.getState();
  const anns = s.annotations ?? [];
  const keep = anns.filter((a) => !['whiteout', 'rect', 'ellipse', 'text', 'image'].includes(a.type));
  if (keep.length !== anns.length) s.setAnnotations?.(keep);
  s.setExportDirty?.(false);
  return 'cleaned';
})()`, 20000)
await sleep(400)

/* 退出编辑：这一行应整体消失，不留空行 */
cdp(`(() => { window.__store.getState().setEditTool('none'); return 'ok' })()`)
await sleep(350)
const afterExit = j(
  cdp(`(() => {
     const dock = document.querySelector('.drawbar__editdock');
     const bar = document.querySelector('.drawbar .edit-bar');
     return JSON.stringify({ 有槽: !!dock, 有编辑条: !!bar, 导出钮: !!document.querySelector('[data-tb-id="edit-export"]') });
   })()`)
)
console.log(`   退出编辑：${JSON.stringify(afterExit)}`)
check('退出编辑后编辑条整行消失（不留空行）', afterExit?.有编辑条 === false && afterExit?.有槽 === false)

/* 底部那行工具按钮始终都在（合并不能把工具选择挤掉） */
const toolsStillThere = j(
  cdp(`JSON.stringify({
     漫游: !!Array.from(document.querySelectorAll('.drawbar__tool')).find(b => (b.textContent||'').includes('漫游')),
     画笔: !!Array.from(document.querySelectorAll('.drawbar__tool')).find(b => (b.textContent||'').includes('画笔')),
     六个编辑工具: document.querySelectorAll('.drawbar__group--edit .drawbar__tool--edit').length
   })`)
)
console.log(`   工具行：${JSON.stringify(toolsStillThere)}`)
check('底部工具行仍有漫游 / 画笔', toolsStillThere?.漫游 === true && toolsStillThere?.画笔 === true)
check('六个内容编辑工具仍在底部工具行里', toolsStillThere?.六个编辑工具 === 6, `实际 ${toolsStillThere?.六个编辑工具}`)

/* ═══════════════ ② 遮罩的触屏适配 ═══════════════ */
console.log('\n② 遮罩触屏适配')

/* 打开聚光灯 */
cdp(`(() => { window.__store.getState().setMaskMode('spotlight'); return 'ok' })()`)
await sleep(600)

const maskBase = j(
  cdp(`(() => {
     const root = document.querySelector('.screen-mask');
     const canvas = document.querySelector('.screen-mask__canvas');
     const exit = document.querySelector('[data-tb-id="mask-exit"]');
     const bottom = document.querySelector('.screen-mask__bottom');
     const hint = document.querySelector('.screen-mask__hint');
     const er = exit ? exit.getBoundingClientRect() : null;
     const br = bottom ? bottom.getBoundingClientRect() : null;
     const hr = hint ? hint.getBoundingClientRect() : null;
     const state = window.__maskState || null;
     return JSON.stringify({
       有遮罩: !!root,
       有画布: !!canvas,
       遮罩touchAction: root ? getComputedStyle(root).touchAction : null,
       画布touchAction: canvas ? getComputedStyle(canvas).touchAction : null,
       有退出钮: !!exit,
       退出钮文字: exit ? (exit.textContent||'').trim() : null,
       退出钮矩形: er ? { 左: Math.round(er.left), 右: Math.round(er.right), 上: Math.round(er.top), 下: Math.round(er.bottom), 宽: Math.round(er.width), 高: Math.round(er.height) } : null,
       底部条矩形: br ? { 左: Math.round(br.left), 右: Math.round(br.right), 下: Math.round(br.bottom) } : null,
       提示条矩形: hr ? { 上: Math.round(hr.top) } : null,
       底层可点: exit ? getComputedStyle(exit.closest('.screen-mask__bottom')).pointerEvents : null,
       光圈: state,
       视口: { 宽: window.innerWidth, 高: window.innerHeight }
     });
   })()`)
)
console.log(`   ${JSON.stringify(maskBase)}`)
check('遮罩已打开', maskBase?.有遮罩 === true)
check('遮罩禁用浏览器手势（touch-action: none）', maskBase?.遮罩touchAction === 'none' && maskBase?.画布touchAction === 'none', `root=${maskBase?.遮罩touchAction} canvas=${maskBase?.画布touchAction}`)
check('退出按钮存在', maskBase?.有退出钮 === true)
check('退出按钮在屏幕**下半部**', (maskBase?.退出钮矩形?.上 ?? 0) > (maskBase?.视口?.高 ?? 0) / 2, `上=${maskBase?.退出钮矩形?.上} / 视口高=${maskBase?.视口?.高}`)
check(
  '退出按钮**水平居中**',
  Math.abs(((maskBase?.退出钮矩形?.左 ?? 0) + (maskBase?.退出钮矩形?.右 ?? 0)) / 2 - (maskBase?.视口?.宽 ?? 0) / 2) < 12,
  `按钮中心=${Math.round(((maskBase?.退出钮矩形?.左 ?? 0) + (maskBase?.退出钮矩形?.右 ?? 0)) / 2)} 视口中心=${Math.round((maskBase?.视口?.宽 ?? 0) / 2)}`
)
check('退出按钮点击区够大（触屏友好，≥44px 高）', (maskBase?.退出钮矩形?.高 ?? 0) >= 44, `高=${maskBase?.退出钮矩形?.高}`)
check('提示条仍在顶部', (maskBase?.提示条矩形?.上 ?? 999) < 120, `上=${maskBase?.提示条矩形?.上}`)
check('底部退出条可以接收点击', maskBase?.底层可点 === 'auto', `pointer-events=${maskBase?.底层可点}`)

/* 单指拖动：光圈必须跟着走，且页面不能跟着滚 */
/*
 * ★ 事件要派发到 **elementFromPoint 命中的元素**（真实手指的 target），
 *   不能派发到 window 上。1.0.6.0 的事故就是这样漏掉的：
 *   吞事件的监听器挂在 window 捕获阶段并 stopPropagation，
 *   真实触摸（target 在页面里）会把遮罩自己的冒泡监听器一起拦掉，
 *   而用例把事件直接派发到 window（target 就是 window，同一节点的监听器
 *   不会被 stopPropagation 掐断），于是「用例全绿、用户完全拖不动」。
 *   这条教训写进判据：必须是真实 target + 断言页面没有滚动。
 */
const dragResult = j(
  cdp(`(async () => {
     const wait = (ms) => new Promise(r => setTimeout(r, ms));
     const before = window.__maskState;
     if (!before) return JSON.stringify({ err: '没有 __maskState（测试挂钩没开）' });
     const target = { x: Math.round(window.innerWidth * 0.3), y: Math.round(window.innerHeight * 0.35) };
     const el = document.elementFromPoint(target.x, target.y);
     if (!el) return JSON.stringify({ err: 'elementFromPoint 拿不到元素' });
     const scroll = document.querySelector('.viewer-scroll');
     const scroll0 = Math.round(scroll?.scrollTop ?? 0);
     const opts = { pointerId: 1, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true, clientX: target.x, clientY: target.y, buttons: 1 };
     const mk = (k, x, y) => new PointerEvent(k, { ...opts, clientX: x, clientY: y });
     el.dispatchEvent(mk('pointerdown', target.x, target.y));
     await wait(120);
     el.dispatchEvent(mk('pointermove', target.x + 40, target.y + 30));
     await wait(120);
     const during = window.__maskState;
     el.dispatchEvent(mk('pointerup', target.x + 40, target.y + 30));
     await wait(120);
     return JSON.stringify({ 拖动前: before, 落点: target, 拖动后: during, 命中: el.className || el.tagName, 滚动前: scroll0, 滚动后: Math.round(scroll?.scrollTop ?? 0) });
   })()`, 60000)
)
console.log(`   单指拖动：${JSON.stringify(dragResult)}`)
check(
  '单指按下立即把光圈移到手指处（触屏关键行为·真实 target）',
  dragResult?.拖动后 && Math.abs(dragResult.拖动后.x - dragResult.拖动前.x) > 20,
  `前 x=${dragResult?.拖动前?.x} → 后 x=${dragResult?.拖动后?.x}（命中 ${dragResult?.命中}）`
)
check(
  '光圈位置贴近落点（跟随手指，不是自己乱跑）',
  dragResult?.拖动后 && Math.abs(dragResult.拖动后.x - (dragResult?.落点?.x ?? 0) - 40) < 40,
  `光圈 x=${dragResult?.拖动后?.x} 期望≈${(dragResult?.落点?.x ?? 0) + 40}`
)
check(
  '拖光圈时页面不跟着滚（遮罩独占这次触摸）',
  dragResult?.滚动前 === dragResult?.滚动后,
  `滚动 ${dragResult?.滚动前} → ${dragResult?.滚动后}`
)

/* 双指捏合：半径必须变 */
const pinchResult = j(
  cdp(`(async () => {
     const wait = (ms) => new Promise(r => setTimeout(r, ms));
     window.__setMaskRadius(150);
     await wait(80);
     const r0 = window.__maskState.r;
     const base = { pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true };
     window.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 11, clientX: 400, clientY: 400 }));
     await wait(60);
     window.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 12, isPrimary: false, clientX: 600, clientY: 400 }));
     await wait(80);
     const afterDown = window.__maskState;
     /* 两指从相距 200 拉到相距 300 → 半径应放大约 1.5 倍 */
     window.dispatchEvent(new PointerEvent('pointermove', { ...base, pointerId: 11, clientX: 350, clientY: 400 }));
     await wait(60);
     const 移1后 = window.__maskState;
     window.dispatchEvent(new PointerEvent('pointermove', { ...base, pointerId: 12, clientX: 650, clientY: 400 }));
     await wait(150);
     const 移2后 = window.__maskState;
     const r1 = window.__maskState.r;
     window.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerId: 11, clientX: 350, clientY: 400 }));
     window.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerId: 12, clientX: 650, clientY: 400 }));
     return JSON.stringify({ 捏合前半径: r0, 捏合后半径: r1, 双指按下后: afterDown, 移1后, 移2后 });
   })()`, 60000)
)
console.log(`   双指捏合：${JSON.stringify(pinchResult)}`)
check('双指捏合能放大光圈（触屏调大小）', (pinchResult?.捏合后半径 ?? 0) > (pinchResult?.捏合前半径 ?? 0) + 20, `${pinchResult?.捏合前半径} → ${pinchResult?.捏合后半径}`)

/* 外缘圆点拖动：半径必须变 */
const handleResult = j(
  cdp(`(async () => {
     const wait = (ms) => new Promise(r => setTimeout(r, ms));
     window.__setMaskRadius(150);
     await wait(80);
     const st = window.__maskState;
     const hx = st.x + st.r, hy = st.y;   // 手柄在光圈右侧外缘
     const base = { pointerId: 21, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true };
     window.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: hx, clientY: hy }));
     await wait(80);
     window.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: hx + 70, clientY: hy }));
     await wait(150);
     const r1 = window.__maskState.r;
     window.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: hx + 70, clientY: hy }));
     return JSON.stringify({ 起始半径: st.r, 拖后半径: r1 });
   })()`, 60000)
)
console.log(`   外缘圆点：${JSON.stringify(handleResult)}`)
check('拖动外缘圆点能改光圈大小', (handleResult?.拖后半径 ?? 0) > (handleResult?.起始半径 ?? 0) + 30, `${handleResult?.起始半径} → ${handleResult?.拖后半径}`)

/*
 * 放大镜 + 触屏（用户 2026-10-23：「聚光和放大镜功能对于触屏还是有适配问题」）。
 *
 * 三条判据对应三种真实的坏法：
 *   ① 切到放大镜后拖不动（只认 hover/pointermove 的老代码就这表现）；
 *   ② 拖到页面边缘抛异常/黑屏——镜头取源越界，drawImage 会失败；
 *   ③ 遮罩上的拖动把底下的 PDF 一起滚了——触摸事件没被吞掉。
 */
cdp(`(() => { window.__store.getState().setMaskMode('magnifier'); return 'ok' })()`)
await sleep(450)
const magResult = j(
  cdp(`(async () => {
     const wait = (ms) => new Promise(r => setTimeout(r, ms));
     const scroller = document.querySelector('.viewer-scroll');
     const scrollBefore = scroller ? scroller.scrollTop : -1;
     const before = window.__maskState;
     if (!before) return JSON.stringify({ err: '没有 __maskState' });
     const base = { pointerId: 31, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true };
     const startX = Math.max(40, Math.round(window.innerWidth * 0.25));
     const startY = Math.max(40, Math.round(window.innerHeight * 0.2));
     window.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: startX, clientY: startY }));
     await wait(100);
     for (const d of [[-30, -30], [-90, -80], [-160, -140]]) {
       window.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: startX + d[0], clientY: startY + d[1] }));
       await wait(90);
     }
     const during = window.__maskState;
     window.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: startX - 160, clientY: startY - 140 }));
     await wait(150);
     const scrollAfter = scroller ? scroller.scrollTop : -1;
     return JSON.stringify({
       模式: during?.mode,
       前: { x: before.x, y: before.y },
       后: { x: during?.x, y: during?.y },
       放大绘制: during?.放大绘制,
       滚动: { before: scrollBefore, after: scrollAfter }
     });
   })()`, 60000)
)
console.log(`   放大镜拖动：${JSON.stringify(magResult)}`)
check(
  '放大镜模式下单指拖动，光圈跟着走（触屏适配）',
  magResult?.模式 === 'magnifier' &&
    magResult?.后 &&
    (Math.abs(magResult.后.x - (magResult?.前?.x ?? 0)) > 20 ||
      Math.abs(magResult.后.y - (magResult?.前?.y ?? 0)) > 20),
  `(${magResult?.前?.x},${magResult?.前?.y}) → (${magResult?.后?.x},${magResult?.后?.y})`
)
check(
  '遮罩上的触摸不会把底下的 PDF 滚走（事件被吞掉）',
  (magResult?.滚动?.before ?? -1) === (magResult?.滚动?.after ?? -2),
  `scrollTop ${magResult?.滚动?.before} → ${magResult?.滚动?.after}`
)

/* 黑屏也要有底部退出按钮（黑屏时最需要它） */
cdp(`(() => { window.__store.getState().setMaskMode('black'); return 'ok' })()`)
await sleep(450)
const blackState = j(
  cdp(`(() => {
     const exit = document.querySelector('[data-tb-id="mask-exit"]');
     const er = exit ? exit.getBoundingClientRect() : null;
     return JSON.stringify({ 有退出钮: !!exit, 上: er ? Math.round(er.top) : null, 视口高: window.innerHeight });
   })()`)
)
console.log(`   黑屏：${JSON.stringify(blackState)}`)
check('黑屏模式下底部退出按钮仍在（黑屏时最需要）', blackState?.有退出钮 === true && (blackState?.上 ?? 0) > (blackState?.视口高 ?? 0) / 2)

/* 点退出按钮：遮罩必须关掉 */
const exitClick = j(
  cdp(`(async () => {
     const wait = (ms) => new Promise(r => setTimeout(r, ms));
     const btn = document.querySelector('[data-tb-id="mask-exit"]');
     if (!btn) return JSON.stringify({ err: '没有退出按钮' });
     btn.click();
     await wait(400);
     return JSON.stringify({
       遮罩还在: !!document.querySelector('.screen-mask'),
       store模式: window.__store.getState().maskMode
     });
   })()`, 40000)
)
console.log(`   点退出：${JSON.stringify(exitClick)}`)
check('点底部退出按钮能关掉遮罩', exitClick?.遮罩还在 === false && exitClick?.store模式 === 'off', JSON.stringify(exitClick))

/* 收尾：确保遮罩关闭、编辑态归零，避免影响后面的用例 */
cdp(`(() => { const s = window.__store.getState(); s.setMaskMode('off'); s.setEditTool('none'); return 'ok' })()`)
await sleep(200)

console.log(`\n=== 结果：${fails.length ? `${fails.length} 项未通过 ✗` : '全部通过 ✓'} ===`)
if (fails.length) {
  for (const f of fails) console.log('  - ' + f)
  process.exit(1)
}
process.exit(0)
