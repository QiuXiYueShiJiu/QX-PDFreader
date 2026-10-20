// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 高压测试：连续小步滚动，让多页**同时**进入视口。
 *
 * ★ 为什么之前那个「逐页 setPage」测不出问题
 *   setPage 每次只把一页滚进视口，任何时刻最多一两页需要渲染，
 *   并发压力几乎为零。真正会把渲染管线压垮的是**连续滚动** ——
 *   滚动过程中视口里同时有好几页，观察器把相邻页一并激活，
 *   十几个光栅化挤在一起，这才是用户「快速高压测试」时的场景。
 *
 * 本脚本做三件事：
 *   ① 用真实 wheel 事件连续滚动（而不是 setPage 跳跃）
 *   ② 全程轮询「有多少页正处于 queued / rendering」，
 *      用来验证并发闸门确实把同时在跑的渲染压在了上限内
 *   ③ 滚动结束后逐页复查像素，区分「全黑」与「全白」两种失败
 *
 * 用法：node tools/verify-scroll-pressure.mjs [端口] [每步毫秒]
 */

import { spawnSync, spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixturePath } from '../scripts/packaging-paths.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PORT = process.argv[2] ?? '9228'
const STEP_MS = Number(process.argv[3] ?? 90)
const PDF = fixturePath()

function cdp(expr, timeout = 30000) {
  const r = spawnSync('node', [join(root, 'scripts', 'cdp-eval.mjs'), PORT, expr], {
    cwd: root,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout
  })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 当前有多少页停在 queued / rendering —— 用来观察闸门 */
const GATE = `(() => {
  let queued = 0, rendering = 0, retry = 0;
  document.querySelectorAll('.pdf-page__cwrap').forEach((w) => {
    const s = w.dataset.stage || '';
    if (s === 'queued' || s === 'starting') queued++;
    else if (s === 'rendering' || s === 'slot-acquired' || s.indexOf('viewport') === 0) rendering++;
    if (s.indexOf('blank-') === 0) retry++;
  });
  return JSON.stringify({ q: queued, r: rendering, retry });
})()`

/** 逐页像素体检 */
const AUDIT = `(() => {
  const out = [];
  document.querySelectorAll('.pdf-page').forEach((el) => {
    const cv = el.querySelector('canvas.pdf-page__canvas');
    if (!cv || !cv.width) { out.push({ 页: Number(el.dataset.page), 判定: '没有canvas' }); return }
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let bright = 0, dark = 0, n = 0;
    for (let y = 0; y < cv.height; y += 37) {
      for (let x = 0; x < cv.width; x += 31) {
        const i = (y * cv.width + x) * 4;
        const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
        if (v > 200) bright++;
        if (v < 60) dark++;
        n++;
      }
    }
    const bp = bright / n * 100, dp = dark / n * 100;
    let 判定 = '有内容';
    if (dp > 95) 判定 = '★全黑';
    else if (bp > 99.5) 判定 = '★全白';
    out.push({ 页: Number(el.dataset.page), 亮点: Number(bp.toFixed(1)), 暗点: Number(dp.toFixed(1)), 判定 });
  });
  return JSON.stringify(out);
})()`

console.log(`=== 冷启动高压滚动测试（每步 ${STEP_MS}ms）===`)
spawnSync(
  'powershell',
  ['-NoProfile', '-Command', "Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"],
  { windowsHide: true }
)
await sleep(3500)
spawn(
  join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
  ['.', '--hidden', '--test-hooks', `--remote-debugging-port=${PORT}`, PDF],
  { cwd: root, detached: true, stdio: 'ignore', windowsHide: true }
).unref()

for (let i = 0; i < 40; i++) {
  await sleep(500)
  const s = cdp(`(() => { try { return String(window.__store.getState().pageCount) } catch (e) { return '0' } })()`, 8000)
  if (s.trim() && s.trim() !== '0') {
    console.log(`  store 就绪（${((i + 1) * 0.5).toFixed(1)}s），共 ${s.trim()} 页`)
    break
  }
}

/*
 * 连续滚动：直接在滚动容器上改 scrollTop，一次一屏的三分之一。
 * 用 scrollTop 而不是 wheel 事件，是因为 wheel 需要精确的指针位置，
 * 在隐藏窗口里坐标系统不可靠；scrollTop 走的是同一条滚动路径
 * （都会触发容器 scroll → 观察器回调 → 页面 active 变化）。
 */
console.log('\n--- 连续滚动（下行 20 步，上行 20 步）---')
let maxConcurrent = 0
let sawRetry = 0

const scrollTo = (top) =>
  cdp(
    `(() => { const r = document.querySelector('.viewer-scroll'); if (!r) return 'no-scroll'; r.scrollTop = ${top}; return String(Math.round(r.scrollTop)); })()`,
    8000
  )

const total = Number(
  cdp(`(() => { const r = document.querySelector('.viewer-scroll'); return String(r ? Math.round(r.scrollHeight) : 0) })()`, 8000)
)
console.log(`  内容总高 ${total}px`)

const step = Math.max(200, Math.round(total / 20))

for (let i = 0; i <= 20; i++) {
  scrollTo(i * step)
  await sleep(STEP_MS)
  const g = cdp(GATE, 8000)
  try {
    const o = JSON.parse(g)
    const busy = o.q + o.r
    if (busy > maxConcurrent) maxConcurrent = busy
    if (o.retry > sawRetry) sawRetry = o.retry
  } catch {
    /* 偶尔读不到就跳过这一次采样 */
  }
}

for (let i = 20; i >= 0; i--) {
  scrollTo(i * step)
  await sleep(STEP_MS)
  const g = cdp(GATE, 8000)
  try {
    const o = JSON.parse(g)
    const busy = o.q + o.r
    if (busy > maxConcurrent) maxConcurrent = busy
    if (o.retry > sawRetry) sawRetry = o.retry
  } catch {
    /* 同上 */
  }
}

console.log(`  滚动期间观察到的最大「同时在渲染+排队」页数：${maxConcurrent}`)
console.log(`  发生空白重试的页数：${sawRetry}`)

/* 等一会儿让排队的页画完，再逐页体检 */
console.log('\n--- 静置 6 秒后逐页体检 ---')
await sleep(6000)
const rows = JSON.parse(cdp(AUDIT, 60000) || '[]')
rows.forEach((r) => console.log('  ' + JSON.stringify(r)))

const bad = rows.filter((r) => String(r.判定).includes('★') || r.判定 === '没有canvas')
console.log(`\n=== 结论：${rows.length} 页，${bad.length} 页异常 ===`)
process.exit(bad.length === 0 ? 0 : 1)
