// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 冷启动黑页复现 + 随时间恢复的观察。
 *
 * 之前的困惑：同一份代码，第一次冷启动测出 8 页黑页，
 * 之后在同一进程里再测就全绿。差别只在**时间** ——
 * 前两次取样时应用才刚启动 2 秒，pdf.js 还在解析文档结构。
 *
 * 于是这个脚本做两件事：
 *   1. 冷启动后立刻狂翻，取样（复现用户看到的黑页）
 *   2. 什么都不做，等若干秒后再取样（看它是否自行恢复）
 * 两次数值一比，就能分清是「永久的黑」还是「启动期的暂态」。
 * 两者的修法完全不同：前者要改渲染调度，后者只需一个加载态。
 *
 * 用法：node tools/repro-black.mjs [端口]
 */

import { spawnSync, spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixturePath } from '../scripts/packaging-paths.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PORT = process.argv[2] ?? '9228'
const PAGES = 10
const PDF = fixturePath()

function cdp(expr, timeout = 30000) {
  const r = spawnSync('node', [join(root, 'scripts', 'cdp-eval.mjs'), PORT, expr], {
    cwd: root,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout
  })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 全页亮度快照：返回 {页: 亮度} 的紧凑形式 */
const SNAP = `(() => {
  const out = {};
  for (const el of document.querySelectorAll('.pdf-page')) {
    const n = el.dataset.page;
    const cv = el.querySelector('canvas.pdf-page__canvas');
    if (!cv) { out[n] = '无canvas'; continue; }
    if (cv.width < 400) { out[n] = '尺寸' + cv.width + 'x' + cv.height; continue; }
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let s = 0, c = 0;
    for (let y = 0; y < cv.height; y += 29) {
      for (let x = 0; x < cv.width; x += 23) {
        const i = (y * cv.width + x) * 4;
        s += (d[i] + d[i + 1] + d[i + 2]) / 3; c++;
      }
    }
    out[n] = Math.round(s / c);
  }
  const root = document.querySelector('.viewer-scroll');
  return JSON.stringify({ 页: window.__store.getState().page, scrollTop: Math.round(root.scrollTop), 亮度: out });
})()`

console.log('=== 冷启动（确保渲染缓存为空）===')
spawnSync(
  'powershell',
  ['-NoProfile', '-Command', "Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"],
  { windowsHide: true }
)
await sleep(3500)

spawn(
  join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
  ['.', '--test-hooks', `--remote-debugging-port=${PORT}`, PDF],
  { cwd: root, detached: true, stdio: 'ignore', windowsHide: true }
).unref()

/* 尽早连上：不等首页渲染完，只等 store 可用 —— 这正是用户双击打开后的瞬间 */
let t0 = 0
for (let i = 0; i < 40; i++) {
  await sleep(500)
  const s = cdp(`(() => { try { return String(window.__store.getState().pageCount) } catch (e) { return '0' } })()`, 8000)
  if (s.trim() !== '0' && s.trim() !== '') {
    t0 = (i + 1) * 0.5
    console.log(`  store 可用，用时 ${t0}s，总页数=${s.trim()}`)
    break
  }
}

console.log('\n=== ① 立刻狂翻 10 页（不等渲染）===')
cdp(`(() => { const st = window.__store.getState(); for (let p = 1; p <= ${PAGES}; p++) st.setPage(p); return 'ok'; })()`)
await sleep(1000)
console.log('  翻完 1 秒后:', cdp(SNAP))

console.log('\n=== ② 等 5 秒（不做任何操作）===')
await sleep(5000)
console.log('  5 秒后:  ', cdp(SNAP))

console.log('\n=== ③ 再等 10 秒 ===')
await sleep(10000)
console.log('  15 秒后: ', cdp(SNAP))
