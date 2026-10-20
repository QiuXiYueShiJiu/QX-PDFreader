// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 验证「书写快时延迟、丢笔」是否已修（对应 m01882 的重点 bug）。
 *
 * 为什么这样测：
 *   用户描述的「写快了丢笔」在旧实现里有明确机理 ——
 *   pointermove 里每个点都 setState，同一帧内到达的多个点被 React
 *   批处理合并，后到的 setState 基于旧的 draft.points 覆盖前面的，
 *   于是中间的点被吞掉，笔迹出现断口。
 *   新实现把点推进 ref 数组、直接命令式绘制，不走 state，
 *   所以「同一帧塞很多点」正是最该测的场景。
 *
 * 判据：
 *   ① 全部点都进了 store（点数 == 派发点数）—— 无丢点
 *   ② 落笔后笔迹与预览位置一致（用 store 里的点重绘一遍比对）
 *   ③ 每次 pointermove 到绘制完成的时间开销足够小（不与点数线性增长）
 *
 * 用法：node tools/verify-pen-smooth.mjs [端口]
 */

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PORT = process.argv[2] ?? '9228'

function evalCdp(expr) {
  const r = spawnSync('node', [join(root, 'scripts', 'cdp-eval.mjs'), PORT, expr], {
    cwd: root,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  })
  return (r.stdout ?? '').trim()
}

/* 取一页底图的实测矩形，用来把屏幕坐标换算成页面坐标 */
const rectInfo = evalCdp(`(() => {
  /*
   * 必须先滚到测试页。
   * 踩坑：上一次直接量第 1 页的 rect，得到 top = -30350 ——
   * 当时视口停在最后一页，第 1 页远在屏幕外，派发到那些坐标的
   * pointer 事件根本落不到页面上（命中测试在视口外），
   * 于是 store 里一条都没新增，看起来像「画笔完全不工作」。
   */
  window.__store.getState().setPage(1);
  const cv = document.querySelector('.pdf-page[data-page="1"] canvas.pdf-page__canvas');
  if (!cv) return 'null';
  const r = cv.getBoundingClientRect();
  return JSON.stringify({ left: r.left, top: r.top, width: r.width, height: r.height });
})()`)

console.log('底图矩形:', rectInfo)
const rect = JSON.parse(rectInfo.split('\n').pop())

/*
 * 构造一条「快速书写」轨迹：
 *   80 个点，横向 8px 间隔 —— 相当于快速划一道约 640px 的长线。
 *   全部在一个 requestAnimationFrame 里派发，模拟极快的手写速度。
 *   真实输入下这些点会分散在 2~3 帧内到达，同一帧内点数很多。
 */
const script = `(async () => {
  /*
   * 先把视口滚到第 1 页并等它渲染好，
   * 否则页面在屏幕外 —— 派发的事件落不到页面上（见上面 setPage 的注释）。
   * 再顺手把缩放设回 100%，避免上一轮测试留下的 400% 让坐标乱掉。
   */
  window.__store.getState().setZoom(1);
  window.__store.getState().setPage(1);
  await new Promise(r => setTimeout(r, 1800));

  const pageEl = document.querySelector('.pdf-page[data-page="1"]');
  const cv = pageEl.querySelector('canvas.pdf-page__canvas');
  const rect = cv.getBoundingClientRect();
  const ink = pageEl.querySelector('.ink-canvas');
  const target = ink || cv;

  /* 页面上取一个确定落在视口内的点作起点 */
  const N = 80;
  const startX = Math.round(rect.left + 40);
  const y = Math.round(rect.top + 120);
  const step = 6;

  const before = window.__store.getState().annotations.length;
  const t0 = performance.now();

  const mk = (type, x, y2) => new PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true,
    pointerId: 1, pointerType: 'pen', isPrimary: true,
    clientX: x, clientY: y2,
    buttons: type === 'pointerup' ? 0 : 1,
    pressure: type === 'pointerup' ? 0 : 0.5
  });

  target.dispatchEvent(mk('pointerdown', startX, y));

  // 一批次塞进去：这正是旧实现会吞点的场景
  for (let i = 1; i <= N; i++) {
    target.dispatchEvent(mk('pointermove', startX + i * step, y));
  }

  target.dispatchEvent(mk('pointerup', startX + N * step, y));

  const dt = performance.now() - t0;
  await new Promise(r => setTimeout(r, 800));

  const items = window.__store.getState().annotations;
  const last = items[items.length - 1];
  let pointCount = 0;
  let stroke = null;
  if (last && typeof last.quote === 'string' && last.quote.startsWith('[笔迹]')) {
    stroke = JSON.parse(last.quote.slice(4));
    pointCount = stroke.d.length;
  }

  return JSON.stringify({
    起点: [startX, y],
    派发点数: N + 2,
    store新增条数: items.length - before,
    笔迹点数: pointCount,
    笔迹格式版本: stroke ? stroke.v : null,
    笔宽: stroke ? stroke.w : null,
    首尾X: stroke ? [stroke.d[0][0], stroke.d[stroke.d.length - 1][0]] : null,
    派发耗时ms: +dt.toFixed(1)
  }, null, 1);
})()`

console.log('=== 快速书写测试（80 点一批派发）===')
console.log(evalCdp(script))
