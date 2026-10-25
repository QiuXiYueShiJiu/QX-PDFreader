// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 画笔管线探针（分两阶段，必须先设置后派发）。
 *
 * ★ 为什么必须分两次 CDP 调用、中间还要留出渲染时间：
 *   zustand 的 setState 与 React 的重渲染都是**异步**的。
 *   如果像早先那样在同一次 eval 里
 *       setDrawMode(true); dispatchEvent(pointerdown);
 *   那么 pointerdown 到达时组件还没重渲染，事件处理函数闭包里的
 *   drawMode 仍是 false，会在 `if (!drawMode) return` 处直接返回 ——
 *   表现出来就像「画笔完全不能用」，而其实是测试写法造成的假象。
 *   （这个坑真实存在：真实用户点「画笔」到落笔之间必然隔着若干帧，
 *     所以线上没问题，但自动化测试里必须显式等待。）
 *
 * 三个阶段：
 *   阶段一  打开诊断 + 进入绘画模式
 *   阶段二  轮询确认组件已按新模式重渲染（viewer-scroll 带 is-drawing）
 *   阶段三  派发一笔并读回中间态与结果
 *
 * 用法：node tools/probe-draw.mjs [端口]
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

/* ---------- 阶段一 ---------- */
console.log('① 进入绘画模式:')
console.log(
  cdp(`(() => {
    window.__sbDebugDraw = true;
    window.__sbDrawTrace = [];
    window.__store.getState().setDrawMode(true);
    return JSON.stringify({ drawMode: window.__store.getState().drawMode });
  })()`)
)

/* ---------- 阶段二：等组件真的重渲染 ---------- */
await sleep(1500)
const ready = cdp(`(() => {
  const el = document.querySelector('.viewer-scroll');
  return JSON.stringify({
    类名: el ? el.className.trim() : null,
    已进入绘画态: el ? el.classList.contains('is-drawing') : false
  });
})()`)
console.log('② 渲染状态:', ready)

/* ---------- 阶段三：派发 ---------- */
console.log('③ 派发一笔:')
console.log(
  cdp(`(() => {
    const out = {};
    const pageEl = document.querySelector('.pdf-page[data-page="1"]');
    if (!pageEl) return JSON.stringify({ 错误: '没有第 1 页' });
    const cv = pageEl.querySelector('canvas.pdf-page__canvas');
    const r = cv.getBoundingClientRect();
    const x0 = Math.round(r.left + 40);
    const y0 = Math.round(r.top + 120);
    out.起点 = [x0, y0];

    const mk = (t, x, y) => new PointerEvent(t, {
      bubbles: true, cancelable: true, composed: true,
      pointerId: 1, pointerType: 'pen', isPrimary: true,
      clientX: x, clientY: y, button: 0,
      buttons: t === 'pointerup' ? 0 : 1,
      pressure: t === 'pointerup' ? 0 : 0.5
    });

    const N = 40;
    out.派发前批注数 = window.__store.getState().annotations.length;

    pageEl.dispatchEvent(mk('pointerdown', x0, y0));
    out.起笔后点数 = window.__sbLivePoints ? window.__sbLivePoints.length : null;

    /*
     * 一批次全部塞进去。
     * 这正是旧实现会因为 React 批处理而丢点的场景，
     * 也是验证「绕过 React 的绘制管线」是否真的生效的关键。
     */
    for (let i = 1; i <= N; i++) pageEl.dispatchEvent(mk('pointermove', x0 + i * 6, y0));
    out.移动后点数 = window.__sbLivePoints ? window.__sbLivePoints.length : null;

    pageEl.dispatchEvent(mk('pointerup', x0 + N * 6, y0));
    out.收笔后批注数 = window.__store.getState().annotations.length;
    out.期望移动点数 = N;
    out.诊断轨迹 = window.__sbDrawTrace;

    const items = window.__store.getState().annotations;
    const last = items[items.length - 1];
    if (last && typeof last.quote === 'string' && last.quote.startsWith('[笔迹]')) {
      const stroke = JSON.parse(last.quote.slice(4));
      out.落库笔迹点数 = stroke.d.length;
      out.格式版本 = stroke.v;
      out.笔宽 = stroke.w;
    }

    return JSON.stringify(out, null, 1);
  })()`)
)
