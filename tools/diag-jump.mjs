// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 跳页行为对照：单次跳 vs 批量跳之后是否能滚到位。
 *
 * 起因：冷启动后「连发 10 次 setPage」的模拟快翻，结束后
 * scrollTop 只停在 402，页面却停在第 10 页 —— 说明滚动同步在
 * 批量更新场景下失效了。这里把两种情形分开测，定位是
 * 「effect 没跑」还是「跑了但算错偏移」。
 *
 * 用文件而不是 -e 内联：表达式里含嵌套引号，经 PowerShell
 * 传递会被拆坏（实测报「表达式异常」）。
 *
 * 用法：node tools/diag-jump.mjs [端口]
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
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60000
  })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 读当前滚动位置与各页相对容器顶的距离 */
const SNAP = `(() => {
  const root = document.querySelector('.viewer-scroll');
  const st = window.__store.getState();
  const out = { 页: st.page, scrollTop: Math.round(root.scrollTop) };
  out.页顶 = {};
  for (const n of [1, 2, 3, 5, 7, 10]) {
    const el = document.querySelector('.pdf-page[data-page="' + n + '"]');
    out.页顶[n] = el ? Math.round(el.getBoundingClientRect().top - root.getBoundingClientRect().top) : null;
  }
  return JSON.stringify(out);
})()`

console.log('=== ① 单次跳页：setPage(1) ===')
cdp(`(() => { window.__store.getState().setPage(1); return 'ok'; })()`)
await sleep(2500)
console.log(cdp(SNAP))

console.log('\n=== ② 单次跳页：setPage(7) ===')
cdp(`(() => { window.__store.getState().setPage(7); return 'ok'; })()`)
await sleep(2500)
console.log(cdp(SNAP))

console.log('\n=== ③ 批量连跳（模拟狂翻）：1→10 一口气 ===')
cdp(`(() => {
  const st = window.__store.getState();
  for (let p = 1; p <= 10; p++) st.setPage(p);
  return 'ok';
})()`)
await sleep(3500)
console.log(cdp(SNAP))

console.log('\n=== ④ 批量之后再单独跳一次 setPage(5) ===')
cdp(`(() => { window.__store.getState().setPage(5); return 'ok'; })()`)
await sleep(2500)
console.log(cdp(SNAP))
