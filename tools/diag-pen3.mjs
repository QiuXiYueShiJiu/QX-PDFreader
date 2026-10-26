// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 画笔诊断（带控制台回传）。
 *
 * 与 diag-pen2.mjs 的区别：这里同时打开组件内的 __sbDebugDraw 开关
 * 并抓取渲染层控制台，从而能区分
 *   「事件没到处理函数」 vs 「到了但被某个判断提前 return」。
 *
 * 之前实测现象：页面元素上的监听器确实收到 pointerdown/move/up
 * （1/20/1），drawMode 也是 true，但批注数始终为 0 ——
 * 说明卡在处理函数内部，必须看它的诊断日志才能定位。
 *
 * 用法：node tools/diag-pen3.mjs [端口]
 */

import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PORT = process.argv[2] ?? '9228'

/* 先起控制台监听 */
const con = spawn('node', [join(root, 'scripts', 'cdp-console.mjs'), PORT], {
  cwd: root,
  windowsHide: true
})
let consoleOut = ''
con.stdout.on('data', (d) => (consoleOut += String(d)))
con.stderr.on('data', (d) => (consoleOut += String(d)))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await sleep(2500)

/* 再触发一次绘制 */
const probe = spawn(
  'node',
  [
    join(root, 'scripts', 'cdp-eval.mjs'),
    PORT,
    `(async () => {
      window.__sbDebugDraw = true;
      const s = window.__store;
      s.getState().setDrawMode(true);
      s.getState().setPage(1);
      await new Promise(r => setTimeout(r, 1500));

      const pageEl = document.querySelector('.pdf-page[data-page="1"]');
      const cv = pageEl.querySelector('canvas.pdf-page__canvas');
      const rect = cv.getBoundingClientRect();
      const x0 = Math.round(rect.left + 40);
      const y0 = Math.round(rect.top + 120);
      const mk = (t, x, y) => new PointerEvent(t, {
        bubbles: true, cancelable: true, composed: true,
        pointerId: 1, pointerType: 'pen', isPrimary: true,
        clientX: x, clientY: y, button: 0,
        buttons: t === 'pointerup' ? 0 : 1,
        pressure: t === 'pointerup' ? 0 : 0.5
      });
      const before = s.getState().annotations.length;
      pageEl.dispatchEvent(mk('pointerdown', x0, y0));
      for (let i = 1; i <= 20; i++) pageEl.dispatchEvent(mk('pointermove', x0 + i * 6, y0));
      pageEl.dispatchEvent(mk('pointerup', x0 + 120, y0));
      await new Promise(r => setTimeout(r, 900));
      return JSON.stringify({
        起点: [x0, y0],
        批注新增: s.getState().annotations.length - before,
        草稿: String(document.querySelector('.preview-ink') ? '预览层存在' : '无预览层')
      });
    })()`
  ],
  { cwd: root, windowsHide: true }
)

let evalOut = ''
probe.stdout.on('data', (d) => (evalOut += String(d)))

probe.on('close', async () => {
  await sleep(1500)
  con.kill()
  console.log('=== 派发结果 ===')
  console.log(evalOut.trim())
  console.log('\n=== 渲染层控制台 ===')
  console.log(consoleOut.trim() || '(无)')
})
