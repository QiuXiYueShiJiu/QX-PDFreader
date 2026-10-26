// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 退出确认弹窗的几何体检。
 *
 * 用户报「弹窗里只有一个取消，右边完全没有第二个按钮」。
 * 代码里两个按钮都在 JSX 里、样式也都在，所以只能是**布局/可见性**问题。
 * 光看 CSS 猜不出真相（position: fixed 会被祖先的 transform 劫持、
 * 会被 overflow 裁掉、也可能只是被别的元素盖住），
 * 因此直接把两个按钮的实测矩形、可见性、层叠关系读出来。
 *
 * 判据：
 *   · 第二个按钮矩形宽高为 0        → 被压没了
 *   · 矩形超出弹窗/视口              → 被裁掉
 *   · elementFromPoint 取到的不是它  → 被别的元素盖住
 *
 * 用法：node tools/diag-exit-dialog.mjs [端口]
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

/* 打开确认框：点右栏最底部的「退出应用」 */
console.log('=== 打开退出确认框 ===')
console.log(
  cdp(`(() => {
    const btns = Array.from(document.querySelectorAll('.rail-btn'));
    const t = btns.find((b) => (b.textContent || '').includes('退出应用'));
    if (!t) return '找不到退出应用按钮，现有: ' + btns.map((b) => b.textContent.trim()).join('|');
    t.click();
    return '已点击';
  })()`)
)
await sleep(900)

console.log('\n=== 弹窗几何 ===')
console.log(
  cdp(`(() => {
    const dlg = document.querySelector('.exit-confirm');
    if (!dlg) return '弹窗没出现';
    const box = dlg.querySelector('.exit-confirm__box');
    const actions = dlg.querySelector('.exit-confirm__actions');
    const btns = Array.from(dlg.querySelectorAll('.exit-confirm__btn'));

    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { 左: Math.round(r.left), 上: Math.round(r.top), 宽: Math.round(r.width), 高: Math.round(r.height) };
    };

    /*
     * 检查祖先链上有没有「制造包含块」的属性。
     * transform / filter / backdrop-filter / will-change 任意一个存在，
     * 都会让内部 position:fixed 相对该祖先定位而不是视口 ——
     * 这正是「弹窗被挤到右栏里、第二个按钮跑出屏幕」最常见的成因。
     */
    const chain = [];
    for (let el = dlg.parentElement; el && el !== document.documentElement; el = el.parentElement) {
      const cs = getComputedStyle(el);
      const bad = [];
      if (cs.transform !== 'none') bad.push('transform=' + cs.transform);
      if (cs.filter !== 'none') bad.push('filter=' + cs.filter);
      if (cs.backdropFilter && cs.backdropFilter !== 'none') bad.push('backdrop-filter=' + cs.backdropFilter);
      if (cs.willChange !== 'auto') bad.push('will-change=' + cs.willChange);
      if (cs.contain && cs.contain !== 'none') bad.push('contain=' + cs.contain);
      if (cs.overflow !== 'visible') bad.push('overflow=' + cs.overflow);
      if (bad.length) chain.push({ 元素: el.className || el.tagName, 问题: bad });
    }

    return JSON.stringify({
      视口: { 宽: innerWidth, 高: innerHeight },
      弹窗: rect(dlg),
      弹窗样式: (() => { const cs = getComputedStyle(dlg); return { position: cs.position, display: cs.display, zIndex: cs.zIndex }; })(),
      卡片: rect(box),
      按钮行: rect(actions),
      按钮数: btns.length,
      按钮: btns.map((b) => {
        const r = b.getBoundingClientRect();
        const cx = Math.round(r.left + r.width / 2);
        const cy = Math.round(r.top + r.height / 2);
        const hit = document.elementFromPoint(cx, cy);
        return {
          文字: (b.textContent || '').trim(),
          矩形: rect(b),
          可见: getComputedStyle(b).visibility + '/' + getComputedStyle(b).opacity + '/display:' + getComputedStyle(b).display,
          中心命中: hit ? (hit.className || hit.tagName) : 'null',
          命中是自己: hit === b || (hit && b.contains(hit)) ? '是' : '★否',
          在视口内: r.right <= innerWidth && r.bottom <= innerHeight && r.left >= 0 && r.top >= 0 ? '是' : '★否'
        };
      }),
      祖先链问题: chain
    }, null, 1);
  })()`)
)

/* 收尾：点取消，别把弹窗留在屏幕上 */
cdp(`(() => {
  const b = Array.from(document.querySelectorAll('.exit-confirm__btn')).find((x) => (x.textContent || '').includes('取消'));
  if (b) b.click();
  return '已取消';
})()`)
