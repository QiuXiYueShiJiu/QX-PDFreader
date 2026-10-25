// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 极限快翻压力测试（**冷启动版**）。
 *
 * ★ 为什么必须冷启动：
 *   最初这脚本在「已经翻过一遍」的应用里跑，10 页的像素统计与
 *   上一轮 verify-black-pages 完全一致（236.6/89.0、243.7/93.3 …）。
 *   原因是 pdf.js 把渲染好的页缓存在内存里，翻回去时命中缓存、
 *   根本不重渲染 —— 于是「0 页异常」是假通过，什么都没测到。
 *   只有冷启动（新进程、缓存为空）后立刻狂翻，才会真正触发
 *   并发渲染排队，才可能复现用户报的「卡成黑色页面」。
 *
 * 判据同 verify-black-pages：抽样读每页 canvas 像素，全黑即失败。
 *
 * 用法：node tools/stress-flip.mjs [端口] [页数] [PDF路径]
 */

import { spawnSync, spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixturePath } from '../scripts/packaging-paths.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PORT = process.argv[2] ?? '9228'
const PAGES = Number(process.argv[3] ?? 10)
const PDF =
  process.argv[4] ?? fixturePath()

function cdp(expr, timeout = 60000) {
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

/* 冷启动：杀掉旧进程，等新的起来，确保渲染缓存为空 */
console.log('=== 冷启动应用 ===')
spawnSync('powershell', ['-NoProfile', '-Command', "Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"], { windowsHide: true })
await sleep(3500)

spawn(
  join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
  ['.', '--test-hooks', `--remote-debugging-port=${PORT}`, PDF],
  { cwd: root, detached: true, stdio: 'ignore', windowsHide: true }
).unref()

/* 等 CDP 端口与首页渲染就绪（首页必须先渲染完，否则后面测的是首页没出来） */
let ready = false
for (let i = 0; i < 40; i++) {
  await sleep(1000)
  const s = cdp(`(() => {
    const el = document.querySelector('.pdf-page[data-page="1"] canvas.pdf-page__canvas');
    return JSON.stringify({ 页数: window.__store ? window.__store.getState().pageCount : 0, 首页canvas: !!el });
  })()`, 15000)
  if (s.includes('"首页canvas":true') && !s.includes('"页数":0')) {
    console.log(`  就绪（等待 ${i + 1}s）: ${s}`)
    ready = true
    break
  }
}
if (!ready) {
  console.log('  ✗ 应用未就绪，中止')
  process.exit(1)
}

/* 一口气把所有翻页指令塞进去，中间不留任何等待 —— 这就是「狂按翻页」 */
console.log(`=== 极限快翻：连续下发 ${PAGES} 次翻页，不等待渲染 ===`)
cdp(`(() => {
  const st = window.__store.getState();
  for (let p = 1; p <= ${PAGES}; p++) st.setPage(p);
  return 'ok';
})()`)

/* 回稳时间：用户看到「卡成黑页」是停下之后仍然黑的状态 */
await sleep(4000)

const rows = []
for (let p = 1; p <= PAGES; p++) {
  const r = cdp(`(() => {
    const el = document.querySelector('.pdf-page[data-page="${p}"]');
    if (!el) return JSON.stringify({ 页: ${p}, 判定: '节点不存在' });
    const cv = el.querySelector('canvas.pdf-page__canvas');
    if (!cv) return JSON.stringify({ 页: ${p}, 判定: '没有 canvas' });
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, cv.width, cv.height);
    const d = img.data;
    let sum = 0, bright = 0, n = 0;
    for (let y = 0; y < cv.height; y += 17) {
      for (let x = 0; x < cv.width; x += 13) {
        const i = (y * cv.width + x) * 4;
        const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
        sum += v; n++;
        if (v > 200) bright++;
      }
    }
    const avg = sum / n;
    /* 还挂着的占位层说明这一页迟迟没渲染完 */
    const ghost = el.querySelector('.pdf-page__ghost');
    return JSON.stringify({
      页: ${p},
      平均亮度: Number(avg.toFixed(1)),
      亮点占比: Number((bright / n * 100).toFixed(1)),
      占位层: ghost ? (getComputedStyle(ghost).opacity === '1' ? '仍在显示' : '已隐藏') : '无',
      判定: avg < 20 && bright === 0 ? '★黑页' : '有内容'
    });
  })()`)
  rows.push(r)
  console.log(r)
}

const bad = rows.filter((r) => r.includes('黑页') || r.includes('不存在') || r.includes('没有 canvas'))
console.log(`\n=== 结论：极限快翻后 ${PAGES} 页中 ${bad.length} 页异常 ===`)
