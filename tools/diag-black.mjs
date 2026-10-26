// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 黑页现场取证：翻完之后把应用内部状态一次性 dump 出来。
 *
 * 为什么需要它：
 *   stress-flip 能判定「黑页」，但黑页有三种可能成因，处置完全不同：
 *     A. 该页从未被 IntersectionObserver 激活 → 根本没发起渲染
 *     B. 激活了但渲染任务被后续翻页取消/覆盖 → 任务丢了
 *     C. 渲染完成了但像素没落到 canvas 上 → 绘制/合成问题
 *   只看像素是分不出来的，必须读 visible 集合、canvas 尺寸、
 *   页面是否挂着渲染中的标记。
 *
 * 用法：node tools/diag-black.mjs [端口]
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
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60000
  })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
}

console.log(
  cdp(`(() => {
    const out = {};
    const st = window.__store.getState();
    out.当前页 = st.page;
    out.总页数 = st.pageCount;
    out.缩放 = st.zoom;

    const scroll = document.querySelector('.viewer-scroll');
    out.滚动条 = scroll
      ? { scrollTop: Math.round(scroll.scrollTop), scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight }
      : null;

    /*
     * 把所有已挂载的 .pdf-page 逐一列出。
     * 注意：DOM 里只有"当前渲染窗口"内的页会挂载，所以列表长度
     * 本身就说明有多少页被认为需要存在。
     */
    const pages = Array.from(document.querySelectorAll('.pdf-page'));
    out.挂载页数 = pages.length;
    out.页 = pages.map((el) => {
      const num = el.dataset.page;
      const cv = el.querySelector('canvas.pdf-page__canvas');
      let avg = null;
      if (cv && cv.width && cv.height) {
        try {
          const ctx = cv.getContext('2d', { willReadFrequently: true });
          const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
          let s = 0, n = 0;
          for (let y = 0; y < cv.height; y += 23) {
            for (let x = 0; x < cv.width; x += 19) {
              const i = (y * cv.width + x) * 4;
              s += (d[i] + d[i + 1] + d[i + 2]) / 3; n++;
            }
          }
          avg = Number((s / n).toFixed(1));
        } catch (e) { avg = 'err:' + e.message; }
      }
      const r = el.getBoundingClientRect();
      return {
        页: num,
        亮度: avg,
        canvas: cv ? cv.width + 'x' + cv.height : '无',
        渲染中标记: el.dataset.rendering ?? (el.querySelector('[data-rendering]') ? '子元素有' : '无'),
        占位层: el.querySelector('.pdf-page__ghost') ? '在' : '无',
        在视口内: r.bottom > 0 && r.top < innerHeight,
        距顶: Math.round(r.top)
      };
    });

    /* 缩略图与左侧导航状态，确认不是导航本身失灵 */
    out.当前高亮页 = document.querySelector('.pdf-thumb.is-active, .thumb.is-active')?.textContent?.trim() ?? '找不到';

    return JSON.stringify(out, null, 1);
  })()`)
)
