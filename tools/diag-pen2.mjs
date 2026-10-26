// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 画笔管线诊断：一次跑完并直接打印结果。
 *
 * 目的：搞清楚「向 .ink-canvas 派发 pointer 事件后 store 里没有笔迹」卡在哪一步。
 * 逐项检查：模式是否开启 / 墨迹层是否存在且可接收事件 /
 * 事件是否真的到了 React 处理函数 / 起笔后 draft 是否建立 / 收笔后是否落库。
 *
 * 用法：node tools/diag-pen2.mjs [端口]
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
    maxBuffer: 64 * 1024 * 1024
  })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
}

/* 把探针写成独立文件再由 page 载入，避开 PowerShell 的引号/换行转义地狱 */
const expr = `
(async () => {
  const log = [];
  const s = window.__store;

  /* 画笔必须先开启 —— onPointerDown 在 !drawMode 时直接 return */
  s.getState().setDrawMode(true);
  s.getState().setPage(1);
  await new Promise(r => setTimeout(r, 1400));

  const pageEl = document.querySelector('.pdf-page[data-page="1"]');
  if (!pageEl) return JSON.stringify({ 错误: '找不到第 1 页节点' });

  const cv = pageEl.querySelector('canvas.pdf-page__canvas');
  const ink = pageEl.querySelector('.ink-canvas');
  const rect = cv.getBoundingClientRect();

  log.push({ 步骤: '环境', drawMode: s.getState().drawMode, 有ink: !!ink,
             ink类: ink ? ink.className : null,
             ink指针事件: ink ? getComputedStyle(ink).pointerEvents : null,
             页矩形: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)] });

  // 直接监听，确认事件到底到了哪一层
  const seen = { down: 0, move: 0, up: 0 };
  const rec = (e) => { if (e.type === 'pointerdown') seen.down++; if (e.type === 'pointermove') seen.move++; if (e.type === 'pointerup') seen.up++; };
  pageEl.addEventListener('pointerdown', rec, true);
  pageEl.addEventListener('pointermove', rec, true);
  pageEl.addEventListener('pointerup', rec, true);

  const x0 = Math.round(rect.left + 40);
  const y0 = Math.round(rect.top + 120);
  const mk = (type, x, y) => new PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true,
    pointerId: 1, pointerType: 'pen', isPrimary: true,
    clientX: x, clientY: y,
    button: type === 'pointerup' ? 0 : 0,
    buttons: type === 'pointerup' ? 0 : 1,
    pressure: type === 'pointerup' ? 0 : 0.5
  });

  // 目标选页面本身：墨迹层在画笔模式下是 pointer-events:none，
  // 事件本来就是由 .pdf-page 上的 React 处理函数接的
  const target = pageEl;
  const before = s.getState().annotations.length;

  target.dispatchEvent(mk('pointerdown', x0, y0));
  for (let i = 1; i <= 20; i++) target.dispatchEvent(mk('pointermove', x0 + i * 6, y0));
  target.dispatchEvent(mk('pointerup', x0 + 120, y0));

  await new Promise(r => setTimeout(r, 800));

  const after = s.getState().annotations.length;
  const last = s.getState().annotations[after - 1];
  log.push({ 步骤: '派发后', 监听器收到: { ...seen }, 批注数: after - before,
             末条类型: last ? last.type : null,
             末条开头: last && last.quote ? last.quote.slice(0, 24) : null });

  /*
   * 补一次真实事件序列（不带合成标记），用于区分
   * 「合成事件被某个判断挡掉」与「整条管线本身坏了」。
   * 用 MouseEvent 之外的方式不可行，所以改用元素自身的
   * onpointerdown 属性探测是否有 React 合成处理函数挂上。
   */
  const reactKeys = Object.keys(pageEl).filter((k) => k.startsWith('__react'));
  log.push({ 步骤: 'React 内部键', 键: reactKeys });

  /* pageEl 上是否有 React 的 onPointerDown 处理器 */
  let hasHandler = false;
  for (const k of reactKeys) {
    const v = pageEl[k];
    if (v && v.props && typeof v.props.onPointerDown === 'function') hasHandler = true;
  }
  log.push({ 步骤: 'React onPointerDown 已挂载', 结果: hasHandler });

  pageEl.removeEventListener('pointerdown', rec, true);
  pageEl.removeEventListener('pointermove', rec, true);
  pageEl.removeEventListener('pointerup', rec, true);

  return JSON.stringify(log, null, 1);
})()
`

console.log(cdp(expr))
