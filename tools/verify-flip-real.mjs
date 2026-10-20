// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 真实场景的快翻测试：逐页翻过去，每页短暂停留。
 *
 * ★ 为什么不能只测「1 跳到 10」
 *   直接 setPage(10) 是一次跳跃，中间 8 页从未出现在视口里，
 *   它们没渲染是**正确**行为，拿它当 bug 会误导修法。
 *   用户的「快速翻页」是**逐页翻**：每页都真的显示过一瞬，
 *   然后马上翻走。这才是有意义的判据 —— 用户看过的页不该是黑的。
 *
 * 判据：
 *   · 翻完全程后，停下来的那一页必须有内容
 *   · 沿途停留过的页，允许因为翻走而没画完，但**回访时必须能画出来**
 *     （即翻回去再看时不能是黑的）—— 这一条专治「永久黑、不自愈」
 *
 * 用法：node tools/verify-flip-real.mjs [端口] [每页停留毫秒]
 */

import { spawnSync, spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixturePath } from '../scripts/packaging-paths.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PORT = process.argv[2] ?? '9228'
const DWELL = Number(process.argv[3] ?? 350)
const PDF = fixturePath()
const N = 10

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

/**
 * 当前视口内页面的像素构成（只测用户真正看到的那一页）。
 *
 * ★ 为什么要同时统计「全黑」和「全白」
 *   加了「渲染前先铺白底」的兜底之后，失败的表现从「黑页」变成了
 *   「白页」—— 只看亮点占比的话，白页的亮点占比是 100%，
 *   会被判成「有内容」，故障反而被掩盖过去。
 *   所以这里把两种极端都算作失败：
 *     · 全黑 = 画布被清空后没画上（没有白底兜底时的老症状）
 *     · 全白 = 铺了白底但内容始终没画上（有白底兜底之后的新症状）
 *   正常页面（有文字、有图）两种都远不会触发。
 *
 * ★ 顺带记录诊断字段（画布尺寸 / 渲染阶段 / 退出原因）
 *   出问题时只知道「全黑」没用 —— 必须分清是
 *   「这一页从没渲染过」「渲染了但被判空跳过」还是「渲染完又被清空」。
 *   这三个字段就是为此存在的，正常时读着也不碍事。
 */
const CURRENT = `(() => {
  const st = window.__store.getState();
  const el = document.querySelector('.pdf-page[data-page="' + st.page + '"]');
  if (!el) return JSON.stringify({ 页: st.page, 判定: '节点不存在' });
  const cv = el.querySelector('canvas.pdf-page__canvas');
  if (!cv || !cv.width) return JSON.stringify({ 页: st.page, 判定: '没有canvas' });
  const wrap = el.querySelector('.pdf-page__cwrap');

  /*
   * ★ 先分清「没画完」和「画坏了」。
   *
   *   冷启动那一瞬间，DOM 里挂的是 React 建的那张 300×150 空画布，
   *   它的像素全是 0。而 0 既可能是「透明」也可能是「不透明黑」——
   *   光看像素数组分不出来。
   *
   *   实测这两者可以精确区分：
   *     · 没被 getContext 碰过的空画布，getImageData 读出来 alpha = 0
   *       （透明，用户看到的是底下垫的白纸，完全正常）；
   *     · 真正画黑的画布，alpha = 255、RGB = 0。
   *   所以判据要带上 alpha —— 只看 RGB 会把「正在加载」误报成故障，
   *   这正是上一轮反复修 CSS 却不见效的原因：量错了对象。
   *
   *   加载中不算故障（用户看到的是白纸，不是黑板），如实报「加载中」。
   */
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  let bright = 0, dark = 0, opaqueDark = 0, n = 0;
  for (let y = 0; y < cv.height; y += 29) {
    for (let x = 0; x < cv.width; x += 23) {
      const i = (y * cv.width + x) * 4;
      const a = d[i + 3];
      const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
      if (a > 8 && v > 200) bright++;
      if (a > 8 && v < 60) dark++;
      /* 真正会显形的黑：既不透明又很暗 */
      if (a > 200 && v < 60) opaqueDark++;
      n++;
    }
  }
  const bp = bright / n * 100, dp = dark / n * 100, od = opaqueDark / n * 100;
  let 判定 = '有内容';
  if (od > 95) 判定 = '★全黑';
  else if (bp > 99.5) 判定 = '★全白';
  else if (dp > 95) 判定 = '加载中';
  /*
   * ★ 全零画布必须单独报出来。
   *   亮/暗/不透光暗全是 0，说明这张画布**一个像素都没画**——
   *   用户看到的是底下的白纸（不是黑板，所以不算故障），
   *   但它也绝不能算「有内容」：这正是之前判据的漏洞，
   *   会把「根本没渲染」的页判成通过，故障就这么漏过去了。
   */
  const 全零 = bp === 0 && dp === 0 && od === 0;
  if (全零) 判定 = '空画布';
  const out = {
    页: st.page,
    亮点占比: Number(bp.toFixed(1)),
    暗点占比: Number(dp.toFixed(1)),
    不透光暗点: Number(od.toFixed(1)),
    判定
  };
  if (判定 === '★全黑' || 判定 === '★全白') {
    out.画布 = cv.width + 'x' + cv.height;
    out.dpr = window.devicePixelRatio;
    out.阶段 = wrap ? wrap.dataset.stage : null;
    out.退出原因 = wrap ? wrap.dataset.dbgWhy : null;
    out.渲染输入 = wrap ? wrap.dataset.dbg : null;
    out.尺寸输入 = wrap ? wrap.dataset.dbgSize : null;
    out.同页画布数 = wrap ? wrap.querySelectorAll('canvas.pdf-page__canvas').length : -1;
  }
  return JSON.stringify(out);
})()`

console.log(`=== 冷启动，每页停留 ${DWELL}ms 逐页快翻 ===`)
spawnSync(
  'powershell',
  ['-NoProfile', '-Command', "Get-Process electron,'秋夕-PDF阅读器' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"],
  { windowsHide: true }
)
await sleep(3500)
/*
 * ★ 用 PDF_READER_EXE 环境变量可以改测「已安装版」。
 *   默认仍然是 out/ 那份（dev 版 electron + 项目目录），
 *   因为这条用例要验的是渲染层逻辑本身；但交付前得再拿安装版跑一遍，
 *   否则「打包漏文件」这类问题会被 dev 版的全绿掩盖过去。
 */
const INSTALLED_EXE = process.env.PDF_READER_EXE
const exe = INSTALLED_EXE ?? join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const exeArgs = INSTALLED_EXE
  ? ['--hidden', '--test-hooks', `--remote-debugging-port=${PORT}`, PDF]
  : ['.', '--hidden', '--test-hooks', `--remote-debugging-port=${PORT}`, PDF]
if (INSTALLED_EXE) console.log(`  目标：已安装版 ${INSTALLED_EXE}`)
spawn(exe, exeArgs, {
  cwd: INSTALLED_EXE ? dirname(INSTALLED_EXE) : root,
  detached: true,
  stdio: 'ignore',
  windowsHide: true
}).unref()

for (let i = 0; i < 40; i++) {
  await sleep(500)
  const s = cdp(`(() => { try { return String(window.__store.getState().pageCount) } catch (e) { return '0' } })()`, 8000)
  if (s.trim() && s.trim() !== '0') {
    console.log(`  store 就绪（${((i + 1) * 0.5).toFixed(1)}s），共 ${s.trim()} 页`)
    break
  }
}

/* 逐页翻过去 —— 这就是用户按住 PageDown 的真实节奏 */
console.log('\n--- 正向逐页翻 ---')
const forward = []
for (let p = 1; p <= N; p++) {
  cdp(`(() => { window.__store.getState().setPage(${p}); return 'ok'; })()`)
  await sleep(DWELL)
  forward.push(cdp(CURRENT))
}
forward.forEach((r) => console.log('  ' + r))

/* 立刻回访前几页：专治「翻走就永久黑、不会自愈」 */
console.log('\n--- 回到第 1 页，再快速回访 1→5 ---')
const back = []
for (let p = 1; p <= 5; p++) {
  cdp(`(() => { window.__store.getState().setPage(${p}); return 'ok'; })()`)
  await sleep(600)
  back.push(cdp(CURRENT))
}
back.forEach((r) => console.log('  ' + r))

/*
 * ③ 停手后必须自愈。
 *
 *   「空画布」在快翻途中是允许的（每页只停 350ms，页还没轮到渲染），
 *   但**停手之后不能还是空的** —— 那就成了「永久空白、不自愈」，
 *   是真正的故障。所以这里给足 8 秒，再回头看一遍刚访问过的 1→5：
 *   只要有一页始终没画出来，就算失败。
 */
console.log('\n--- 停手静置，等 8 秒后复查 1→5（必须全部画出来）---')
await sleep(8000)
const settled = []
for (let p = 1; p <= 5; p++) {
  cdp(`(() => { window.__store.getState().setPage(${p}); return 'ok'; })()`)
  await sleep(900)
  settled.push(cdp(CURRENT))
}
settled.forEach((r) => console.log('  ' + r))

const all = [...forward, ...back, ...settled]
const bad = all.filter((r) => r.includes('★') || r.includes('不存在') || r.includes('没有canvas'))
const blank = all.filter((r) => r.includes('空画布'))
const stuck = settled.filter((r) => !r.includes('有内容'))
const loading = all.filter((r) => r.includes('加载中'))
console.log(
  `\n=== 结论：${all.length} 次取样，${bad.length} 次异常（全黑/全白/缺节点），` +
  `${blank.length} 次空画布（快翻途中允许），静置后仍有内容 ${settled.length - stuck.length}/${settled.length} ===`
)
if (blank.length) {
  console.log('  （空画布 = 一个像素都没画，用户看到白纸，不算故障；但停手后若仍是空画布则算失败）')
}
if (loading.length) {
  console.log('  （加载中 = 画布像素还是透明的，用户看到的是白纸，不算故障）')
}
if (stuck.length) {
  console.log(`  ✗ 静置 8 秒后仍未画出内容：${stuck.map((r) => JSON.parse(r).页).join(', ')} 页`)
  process.exit(1)
}
process.exit(bad.length ? 1 : 0)
