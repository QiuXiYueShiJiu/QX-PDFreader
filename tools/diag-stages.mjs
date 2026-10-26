// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 渲染阶段诊断：每页渲染走到了哪一步 + 是否处于「隐藏画布」状态。
 *
 * 要回答的问题：
 *   黑页到底是「从没开始渲染」「渲染被取消」还是「渲染完了但被藏起来」？
 *   这三者的修法完全不同，必须先把它们分开。
 *   DocumentView 的 PdfPage 在渲染流程各关键点把阶段名写到
 *   .pdf-page__cwrap 的 data-stage 上，这里一次性读出来。
 *
 * 用法：node tools/diag-stages.mjs [端口]
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

console.log(
  cdp(`(() => {
    const rows = [];
    for (const el of document.querySelectorAll('.pdf-page')) {
      const wrap = el.querySelector('.pdf-page__cwrap');
      const cv = el.querySelector('canvas.pdf-page__canvas');
      let bright = '—';
      if (cv && cv.width > 400) {
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
        let b = 0, n = 0;
        for (let y = 0; y < cv.height; y += 41) {
          for (let x = 0; x < cv.width; x += 37) {
            const i = (y * cv.width + x) * 4;
            if ((d[i] + d[i + 1] + d[i + 2]) / 3 > 200) b++;
            n++;
          }
        }
        bright = Math.round(b / n * 100) + '%';
      }
      rows.push({
        页: el.dataset.page,
        阶段: wrap ? (wrap.dataset.stage ?? '(未设置)') : '无wrap',
        藏画布: wrap ? (wrap.dataset.rendering === '1' ? '★藏着' : '显示') : '—',
        canvas: cv ? cv.width + 'x' + cv.height : '无',
        亮点: bright,
        占位层: el.querySelector('.pdf-page__ghost') ? '在' : '无'
      });
    }
    return JSON.stringify({ 当前页: window.__store.getState().page, 页: rows }, null, 1);
  })()`)
)
