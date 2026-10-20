// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 单次内联探针：在同一段 JS 里完成「开诊断 → 派发 → 读结果」。
 *
 * 为什么不复用 sb-console.mjs：
 *   它需要三次独立 CDP 连接（起监听、开开关、派发），
 *   每一步都可能因为页面还在忙而失败或漏日志，
 *   排查时反而制造了新的不确定性。
 *   这里一次 eval 全做完，并直接返回中间态。
 *
 * 关键中间态：
 *   __sbLivePoints —— 组件内部那个接收笔迹点的数组（诊断模式下暴露）。
 *   有了它就能区分：
 *     · 点没进数组        → 移动事件处理有问题
 *     · 进了数组但没落库  → 结算或入库有问题
 *
 * 用法：node tools/probe-draw-once.mjs [端口]
 */

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PORT = process.argv[2] ?? '9228'

const expr = `(() => {
  const out = {};
  window.__sbDebugDraw = true;
  /* 诊断轨迹：由组件在处理函数各分支写入，同步读回不受控制台连接时机影响 */
  window.__sbDrawTrace = [];
  const store = window.__store.getState();
  store.setDrawMode(true);
  out.drawMode = window.__store.getState().drawMode;

  const pageEl = document.querySelector('.pdf-page[data-page="1"]');
  if (!pageEl) return JSON.stringify({ 错误: '没有第 1 页' });

  /* 确认组件是否因 drawMode 变化而重渲染：viewer-scroll 的类名会带上 is-drawing */
  const scrollEl = document.querySelector('.viewer-scroll');
  out.滚动容器类名 = scrollEl ? scrollEl.className : null;
  out.是否已标记绘画态 = scrollEl ? scrollEl.classList.contains('is-drawing') : null;

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

  out.派发前批注数 = window.__store.getState().annotations.length;

  pageEl.dispatchEvent(mk('pointerdown', x0, y0));
  out.起笔后livePoints长度 = window.__sbLivePoints ? window.__sbLivePoints.length : null;

  for (let i = 1; i <= 20; i++) pageEl.dispatchEvent(mk('pointermove', x0 + i * 6, y0));
  out.移动后livePoints长度 = window.__sbLivePoints ? window.__sbLivePoints.length : null;

  pageEl.dispatchEvent(mk('pointerup', x0 + 120, y0));
  out.收笔后livePoints长度 = window.__sbLivePoints ? window.__sbLivePoints.length : null;
  out.收笔后批注数 = window.__store.getState().annotations.length;
  out.批注新增 = out.收笔后批注数 - out.派发前批注数;
  out.诊断轨迹 = window.__sbDrawTrace;

  return JSON.stringify(out, null, 1);
})()`

const r = spawnSync('node', [join(root, 'scripts', 'cdp-eval.mjs'), PORT, expr], {
  cwd: root,
  windowsHide: true,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  timeout: 60000
})

console.log(`${r.stdout ?? ''}${r.stderr ?? ''}`.trim())
