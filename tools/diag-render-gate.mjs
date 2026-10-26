// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 读出每页当前停留的渲染阶段 + 并发闸门状态。
 *
 * 用途：确认「渲染并发闸门」真的在起作用。
 *   如果闸门生效，冷启动或连续滚动时应该能看到一部分页停在
 *   `queued`（在队列里等名额），而不是十几页一起 `rendering`。
 *
 * data-stage 的取值（写在 .pdf-page__cwrap 上）：
 *   queued / slot-acquired / starting / viewport WxH / rendering /
 *   painted / blank-retrying N / blank-given-up / cancelled-retrying /
 *   cancelled-unmounted / done-but-cancelled / failed …
 *
 * 用法：node tools/diag-render-gate.mjs [端口]
 */

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PORT = process.argv[2] ?? '9228'

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

const expr = `(() => {
  const out = [];
  document.querySelectorAll('.pdf-page').forEach((el) => {
    const wrap = el.querySelector('.pdf-page__cwrap');
    const cv = el.querySelector('canvas.pdf-page__canvas');
    out.push({
      页: Number(el.dataset.page),
      阶段: wrap ? (wrap.dataset.stage || '(未设置)') : '(无cwrap)',
      藏着: wrap ? (wrap.dataset.rendering === '1') : null,
      画布: cv ? cv.width + 'x' + cv.height : '无'
    });
  });
  const blank = out.filter((o) => String(o.阶段).startsWith('blank-'));
  const queued = out.filter((o) => o.阶段 === 'queued');
  return JSON.stringify({ 总页数: out.length, 排队中: queued.length, 空白重试过: blank.length, 明细: out }, null, 1);
})()`

console.log('=== 渲染阶段与并发闸门状态 ===')
console.log(cdp(expr))
