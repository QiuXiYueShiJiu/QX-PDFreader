// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 复现「主画布变黑」：把窗口缩到比页面还窄。
 *
 * 现象来源：把正式版窗口从默认的 2160×1410 拖到 1400×900 之后，
 * 第 1 页主画布变成一整块纯黑（左侧缩略图仍正常）。
 *
 * 怀疑链条：
 *   窗口变窄 → 适宽模式算出的页面宽度趋近 0（甚至为负，被 clamp 到 0）
 *   → 渲染 effect 用 width 反推 scale → 得到 0 或极小的 viewport
 *   → canvas 属性尺寸被设成 1×1 之类的退化值
 *   → 之后无论怎么重算，画布都停在「已被清空」的黑状态。
 *
 * 本脚本逐步缩小窗口，每一步都记录页面宽度、画布尺寸与渲染阶段，
 * 用来定位「哪一步开始画布变得不正常」。
 *
 * 用法：node tools/repro-narrow-black.mjs [端口]
 */

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PORT = process.argv[2] ?? '9231'

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

/** 把窗口设到指定大小（物理像素，经 Win32 SetWindowPos） */
function resizeWindow(w, h) {
  const ps = `
Add-Type -TypeDefinition @'
using System;using System.Text;using System.Runtime.InteropServices;
public class RZ {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EP cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  static RZ(){ SetProcessDPIAware(); }
  public static void Run(string key, int x, int y, int cx, int cy){
    EnumWindows(delegate(IntPtr h, IntPtr l){
      var t=new StringBuilder(512); GetWindowTextW(h,t,512);
      if(t.ToString().IndexOf(key, StringComparison.OrdinalIgnoreCase)<0 || !IsWindowVisible(h)) return true;
      SetWindowPos(h, IntPtr.Zero, x, y, cx, cy, 0x0040);
      return false; }, IntPtr.Zero); }
}
'@
[RZ]::Run('PDF阅读器', 20, 20, ${w}, ${h})
`
  spawnSync('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true, encoding: 'utf8' })
}

const PROBE = `(() => {
  const el = document.querySelector('.pdf-page[data-page="1"]');
  if (!el) return JSON.stringify({ 判定: '第1页节点不存在' });
  const wrap = el.querySelector('.pdf-page__cwrap');
  const cv = el.querySelector('canvas.pdf-page__canvas');
  const r = el.getBoundingClientRect();
  const o = { 页面显示宽: Math.round(r.width), 页面显示高: Math.round(r.height) };
  o.阶段 = wrap ? (wrap.dataset.stage || '(未设置)') : '(无cwrap)';
  o.藏着 = wrap ? (wrap.dataset.rendering === '1') : null;
  o.画布属性 = cv ? cv.width + 'x' + cv.height : '无';
  o.画布CSS = cv ? Math.round(cv.getBoundingClientRect().width) + 'x' + Math.round(cv.getBoundingClientRect().height) : '无';
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
  const st = window.__store.getState();
  o.缩放 = st.zoom;
  o.视口宽 = window.innerWidth;
  return JSON.stringify(o);
})()`

console.log('=== 逐步缩小窗口，观察主画布 ===')
const sizes = [
  [2160, 1410],
  [1600, 1000],
  [1400, 900],
  [1100, 800],
  [900, 700],
  [700, 600]
]

for (const [w, h] of sizes) {
  resizeWindow(w, h)
  await sleep(2500)
  console.log(`  窗口 ${w}x${h} → ${cdp(PROBE, 30000)}`)
}

console.log('\n=== 恢复默认尺寸 ===')
resizeWindow(2160, 1410)
await sleep(2500)
console.log('  ' + cdp(PROBE, 30000))
