// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 「快翻黑页」端到端验证。
 *
 * 修了三处之后必须验的是**最终结果**，而不是中间机制：
 *   ① pageRefs 之前从未被写入 → 两页都观察不到 → visible 恒为初始值
 *   ② IntersectionObserver 只加不减 → 滚过的页永远 active → pdf.js 任务堆积
 *   ③ 没有占位 → 未渲染时 canvas 透明（alpha:false → 黑）
 * 这三条中任意一条还在，症状都是「翻到的页是黑的」。
 *
 * 判据：逐页翻过去，等渲染稳定后读每页 canvas 的像素统计 ——
 *   · 全黑（平均亮度 < 20 且无白色像素）→ 黑页，失败
 *   · 有内容（白底纸面 → 大量亮像素）→ 通过
 * 用 canvas 内部像素而不是截图，是为了不受窗口遮挡/DPI 影响。
 *
 * 用法：node tools/verify-black-pages.mjs [端口] [页数]
 */

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PORT = process.argv[2] ?? '9228'
const PAGES = Number(process.argv[3] ?? 10)

function cdp(expr) {
  const r = spawnSync('node', [join(root, 'scripts', 'cdp-eval.mjs'), PORT, expr], {
    cwd: root,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60000
  })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/*
 * 先把缩放归到适宽，避免 400% 那种画布爆炸把渲染线程打满
 * —— 上一次把缩放设到 4 就直接把应用搞到卡死。
 */
cdp(`(() => { window.__store.getState().setZoom(1); return 'ok'; })()`)
await sleep(1500)

const rows = []
for (let p = 1; p <= PAGES; p++) {
  /* 翻页 —— 和用户点「下一页」是同一条路径 */
  cdp(`(() => { window.__store.getState().setPage(${p}); return 'ok'; })()`)

  /*
   * 只等很短的时间就取样：这正是「快速翻页」的真实节奏，
   * 如果实现依赖「慢慢渲染完」，快翻就会露馅。
   */
  await sleep(700)

  const r = cdp(`(() => {
    const el = document.querySelector('.pdf-page[data-page="${p}"]');
    if (!el) return JSON.stringify({ 页: ${p}, 状态: '节点不存在' });
    const cv = el.querySelector('canvas.pdf-page__canvas');
    if (!cv) return JSON.stringify({ 页: ${p}, 状态: '没有 canvas' });
    if (!cv.width || !cv.height) return JSON.stringify({ 页: ${p}, 状态: 'canvas 尺寸为 0' });

    const ctx = cv.getContext('2d', { willReadFrequently: true });
    let sum = 0, bright = 0, dark = 0, n = 0;
    /* 抽样扫描：整幅读像素太慢，隔 17 行 13 列取一点足够判断黑白 */
    const img = ctx.getImageData(0, 0, cv.width, cv.height);
    const d = img.data;
    for (let y = 0; y < cv.height; y += 17) {
      for (let x = 0; x < cv.width; x += 13) {
        const i = (y * cv.width + x) * 4;
        const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
        sum += v; n++;
        if (v > 200) bright++;
        if (v < 20) dark++;
      }
    }
    const avg = sum / n;
    return JSON.stringify({
      页: ${p},
      尺寸: cv.width + 'x' + cv.height,
      平均亮度: Number(avg.toFixed(1)),
      亮点占比: Number((bright / n * 100).toFixed(1)),
      黑点占比: Number((dark / n * 100).toFixed(1)),
      判定: avg < 20 && bright === 0 ? '★黑页' : '有内容'
    });
  })()`)
  rows.push(r)
  console.log(r)
}

const bad = rows.filter((r) => r.includes('黑页') || r.includes('不存在') || r.includes('没有 canvas'))
console.log(`\n=== 结论：${PAGES} 页中 ${bad.length} 页异常 ===`)
