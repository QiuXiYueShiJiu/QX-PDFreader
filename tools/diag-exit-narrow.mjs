// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 窄窗口下退出确认框的体检。
 *
 * 前面在 1440×940 视口下测出两个按钮都正常，
 * 但用户明确说「右边完全没有第二个按钮」—— 说明和窗口宽度有关。
 * 卡片宽度是 min(420px, calc(100vw - 48px))，窗口一窄就被压缩，
 * 而两个按钮各有 min-width: 88px + 左右 padding，压缩到一定程度
 * 就会溢出卡片、被挤出可视区。
 *
 * 这里用 CDP 直接把视口收窄，逐个宽度测量按钮是否还在视口内。
 *
 * 用法：node tools/diag-exit-narrow.mjs [端口]
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

/*
 * 用 Electron 的窗口 API 改宽度不现实（渲染层拿不到），
 * 改用 CSS 的 zoom 缩小来模拟「更窄的视口」不够准确 ——
 * 直接改 #root 的宽度也不行，因为 position:fixed 相对视口。
 * 因此这里只测「按钮行是否溢出卡片」这件事：
 * 把卡片宽度手动设成几个典型值，看按钮有没有跑出卡片右边界。
 */
console.log('=== 不同卡片宽度下，按钮是否溢出 ===')
console.log(
  cdp(`(() => {
    const dlg = document.querySelector('.exit-confirm');
    if (!dlg) return '弹窗不在，先运行 diag-exit-dialog.mjs 打开它';
    const box = dlg.querySelector('.exit-confirm__box');
    const row = dlg.querySelector('.exit-confirm__actions');
    const btns = Array.from(dlg.querySelectorAll('.exit-confirm__btn'));

    const saved = box.style.width;
    const out = [];
    for (const w of [420, 380, 340, 300, 260, 220, 180]) {
      box.style.width = w + 'px';
      const br = box.getBoundingClientRect();
      const rr = row.getBoundingClientRect();
      const items = btns.map((b) => {
        const r = b.getBoundingClientRect();
        return { 文字: (b.textContent || '').trim(), 宽: Math.round(r.width), 右: Math.round(r.right), 溢出卡片: r.right > br.right + 1 ? '★是' : '否' };
      });
      out.push({ 卡片宽: w, 卡片实宽: Math.round(br.width), 按钮行宽: Math.round(rr.width), 按钮: items });
    }
    box.style.width = saved;
    return JSON.stringify(out, null, 1);
  })()`)
)
