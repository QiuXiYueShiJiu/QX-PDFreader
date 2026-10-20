// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 列出当前渲染出的 .pdf-page 节点与关键状态。
 *
 * 用途：诊断「找不到第 1 页节点」这类问题 ——
 * 到底是页面没渲染、页码属性对不上，还是滚动位置不在那一页。
 *
 * 用法：node tools/diag-dom.mjs [端口]
 */

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PORT = process.argv[2] ?? '9228'

const r = spawnSync(
  'node',
  [
    join(root, 'scripts', 'cdp-eval.mjs'),
    PORT,
    `(() => {
      const s = window.__store ? window.__store.getState() : null;
      const pages = [...document.querySelectorAll('.pdf-page')];
      const root = document.querySelector('.viewer-scroll');
      const rr = root ? root.getBoundingClientRect() : null;
      return JSON.stringify({
        store存在: !!s,
        页: s ? s.page : null,
        总页数: s ? s.pageCount : null,
        缩放: s ? s.zoom : null,
        drawMode: s ? s.drawMode : null,
        page节点数: pages.length,
        page属性: pages.map(e => e.dataset.page),
        滚动位置: root ? Math.round(root.scrollTop) : null,
        滚动高度: root ? root.scrollHeight : null,
        视口高度: root ? root.clientHeight : null,
        viewer_pages子节点数: document.querySelectorAll('.viewer-pages > *').length,
        批注数: s ? s.annotations.length : null
      }, null, 1);
    })()`
  ],
  { cwd: root, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
)

console.log(`${r.stdout ?? ''}${r.stderr ?? ''}`.trim())
