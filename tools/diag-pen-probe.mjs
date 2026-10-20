// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 诊断「画笔测试没有产生笔迹」的原因。
 *
 * 背景：tools/verify-pen-smooth.mjs 里直接向 .ink-canvas 派发 pointer 事件，
 * 但 store 里一条笔迹都没新增。需要区分几种可能：
 *   ① drawMode 没开 → onPointerDown 在 `!drawMode` 处提前 return
 *   ② .ink-canvas 没渲染出来 / pointer-events 为 none → 事件根本没到 React 处理函数
 *   ③ 事件到了但 pointToPage 返回 null（指针不在 .pdf-page 内）
 *   ④ 事件到了、也起了笔，但收笔时点被抽稀抽没了
 *
 * 做法：打开组件内的 __sbDebugDraw 开关（它会在 pointerdown 打印
 * drawMode/button/buttons/target），同时从 CDP 收 Console API 事件，
 * 把现场真实日志取回来。
 *
 * 用法：node tools/diag-pen-probe.mjs [端口]
 */

import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PORT = process.argv[2] ?? '9228'

const ws = spawn(
  'node',
  [join(root, 'scripts', 'cdp-console.mjs'), PORT],
  { cwd: root, windowsHide: true }
)

let out = ''
ws.stdout.on('data', (d) => {
  out += String(d)
})
ws.stderr.on('data', (d) => {
  out += `[stderr] ${String(d)}`
})

/* 给它两秒连上，再触发一次绘制 */
setTimeout(() => {
  const probe = spawn(
    'node',
    [
      join(root, 'scripts', 'cdp-eval.mjs'),
      PORT,
      `(async () => {
        window.__sbDebugDraw = true;
        const s = window.__store.getState();
        s.setZoom(1);
        s.setPage(1);
        await new Promise(r => setTimeout(r, 2000));

        const pageEl = document.querySelector('.pdf-page[data-page="1"]');
        const cv = pageEl.querySelector('canvas.pdf-page__canvas');
        const ink = pageEl.querySelector('.ink-canvas');
        const rect = cv.getBoundingClientRect();
        const cs = ink ? getComputedStyle(ink) : null;

        const info = {
          drawMode: window.__store.getState().drawMode,
          有ink: !!ink,
          ink的pointerEvents: cs ? cs.pointerEvents : null,
          ink类名: ink ? ink.className : null,
          底图矩形: { left: Math.round(rect.left), top: Math.round(rect.top), w: Math.round(rect.width) }
        };

        const target = ink || pageEl;
        const x0 = Math.round(rect.left + 40);
        const y0 = Math.round(rect.top + 120);
        const mk = (type, x, y) => new PointerEvent(type, {
          bubbles: true, cancelable: true, composed: true,
          pointerId: 1, pointerType: 'pen', isPrimary: true,
          clientX: x, clientY: y,
          buttons: type === 'pointerup' ? 0 : 1,
          pressure: type === 'pointerup' ? 0 : 0.5
        });

        target.dispatchEvent(mk('pointerdown', x0, y0));
        for (let i = 1; i <= 20; i++) target.dispatchEvent(mk('pointermove', x0 + i * 6, y0));
        target.dispatchEvent(mk('pointerup', x0 + 120, y0));

        await new Promise(r => setTimeout(r, 800));
        info.派发后批注数 = window.__store.getState().annotations.length;
        info.派发目标 = target.className;
        return JSON.stringify(info, null, 1);
      })()`
    ],
    { cwd: root, windowsHide: true }
  )

  let evalOut = ''
  probe.stdout.on('data', (d) => {
    evalOut += String(d)
  })
  probe.on('close', () => {
    setTimeout(() => {
      ws.kill()
      console.log('=== 探测结果 ===')
      console.log(evalOut.trim())
      console.log('\n=== 控制台日志 ===')
      console.log(out.trim() || '(无日志)')
    }, 1200)
  })
}, 2000)
