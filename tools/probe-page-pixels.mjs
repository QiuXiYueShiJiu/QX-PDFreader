// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 单页像素体检：读第 N 页主画布的尺寸、渲染阶段与亮度分布。
 *
 * 为什么单独做一个脚本：
 *   这段表达式里同时有模板字符串、嵌套引号和属性选择器，
 *   直接在 PowerShell 命令行里拼会反复踩引号转义的坑
 *   （实测报「表达式异常 / SyntaxError: Unexpected end of input」）。
 *   写进文件一次就再也不用管转义。
 *
 * 用法：node tools/probe-page-pixels.mjs [端口] [页码]
 */

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PORT = process.argv[2] ?? '9231'
const PAGE = Number(process.argv[3] ?? 1)

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
  const el = document.querySelector('.pdf-page[data-page="${PAGE}"]');
  if (!el) return JSON.stringify({ 判定: '第' + ${PAGE} + '页节点不存在' });
  const wrap = el.querySelector('.pdf-page__cwrap');
  const cv = el.querySelector('canvas.pdf-page__canvas');
  const st = window.__store.getState();
  const o = {
    页码: ${PAGE},
    缩放: st.zoom,
    视口宽: window.innerWidth,
    视口高: window.innerHeight,
    阶段: wrap ? (wrap.dataset.stage || '(未设置)') : '(无cwrap)',
    藏着: wrap ? wrap.dataset.rendering === '1' : null,
    画布属性: cv ? cv.width + 'x' + cv.height : '无',
    页面显示宽: Math.round(el.getBoundingClientRect().width)
  };
  if (wrap) {
    o.容器背景 = (getComputedStyle(wrap).backgroundImage || 'none').slice(0, 40);
    /* 渲染 effect 最后一次运行时看到的输入量（诊断用） */
    try { o.渲染输入 = JSON.parse(wrap.dataset.dbg || 'null') } catch (e) { o.渲染输入 = wrap.dataset.dbg }
    /* 撑尺寸 effect 最后一次运行时的输入与结果（诊断用） */
    try { o.尺寸输入 = JSON.parse(wrap.dataset.dbgSize || 'null') } catch (e) { o.尺寸输入 = wrap.dataset.dbgSize }
    /* 渲染 effect 最后一次「为什么退出」（诊断用） */
    try { o.退出原因 = JSON.parse(wrap.dataset.dbgWhy || 'null') } catch (e) { o.退出原因 = wrap.dataset.dbgWhy }
  }
  if (cv) {
    o.画布CSS尺寸 = Math.round(cv.getBoundingClientRect().width) + 'x' + Math.round(cv.getBoundingClientRect().height);
  }
  if (cv && cv.width > 1) {
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
    o.亮点 = Number((bright / n * 100).toFixed(1));
    o.暗点 = Number((dark / n * 100).toFixed(1));
  }
  return JSON.stringify(o, null, 1);
})()`

console.log(`=== 第 ${PAGE} 页像素体检（端口 ${PORT}）===`)
console.log(cdp(expr, 60000))
