// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 抓取渲染层控制台（含组件内的 __sbDebugDraw 日志）。
 *
 * 用途：verify-pen-e2e 显示「命中测试正常、事件也到了、但批注没落库」，
 * 说明卡在处理函数内部。组件的 onPointerDown 有一段诊断日志，
 * 开启 __sbDebugDraw 后会把 drawMode / button / buttons / target
 * 以及每个提前 return 的分支都打出来，看它就能定位到具体哪一句。
 *
 * 用法：node tools/sb-console.mjs [端口] [持续秒数]
 */

import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PORT = process.argv[2] ?? '9228'
const SECONDS = Number(process.argv[3] ?? 12)

const con = spawn('node', [join(root, 'scripts', 'cdp-console.mjs'), PORT], {
  cwd: root,
  windowsHide: true
})
let out = ''
con.stdout.on('data', (d) => (out += String(d)))
con.stderr.on('data', (d) => (out += String(d)))

await new Promise((r) => setTimeout(r, 2500))

/* 开开关 + 派发一笔，全部同步完成，不 await（避免 CDP 等 Promise） */
const probe = spawn(
  'node',
  [
    join(root, 'scripts', 'cdp-eval.mjs'),
    PORT,
    `(() => {
      window.__sbDebugDraw = true;
      const s = window.__store.getState();
      s.setDrawMode(true);
      return 'debug on';
    })()`
  ],
  { cwd: root, windowsHide: true }
)
probe.stdout.on('data', () => {})
await new Promise((r) => probe.on('close', r))

await new Promise((r) => setTimeout(r, 1200))

const dispatch = spawn(
  'node',
  [
    join(root, 'scripts', 'cdp-eval.mjs'),
    PORT,
    `(() => {
      const pageEl = document.querySelector('.pdf-page[data-page="1"]');
      const cv = pageEl.querySelector('canvas.pdf-page__canvas');
      const r = cv.getBoundingClientRect();
      const x0 = Math.round(r.left + 40);
      const y0 = Math.round(r.top + 120);
      const mk = (t, x, y) => new PointerEvent(t, {
        bubbles: true, cancelable: true, composed: true,
        pointerId: 1, pointerType: 'pen', isPrimary: true,
        clientX: x, clientY: y, button: 0,
        buttons: t === 'pointerup' ? 0 : 1,
        pressure: t === 'pointerup' ? 0 : 0.5
      });
      pageEl.dispatchEvent(mk('pointerdown', x0, y0));
      for (let i = 1; i <= 10; i++) pageEl.dispatchEvent(mk('pointermove', x0 + i * 6, y0));
      pageEl.dispatchEvent(mk('pointerup', x0 + 60, y0));
      return 'dispatched at ' + x0 + ',' + y0;
    })()`
  ],
  { cwd: root, windowsHide: true }
)
dispatch.stdout.on('data', (d) => (out += `[dispatch] ${String(d)}`))
await new Promise((r) => dispatch.on('close', r))

await new Promise((r) => setTimeout(r, SECONDS * 1000))
con.kill()

console.log(out.trim() || '(无输出)')
