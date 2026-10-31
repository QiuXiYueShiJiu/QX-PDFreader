// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 图片放大后能否把**左侧**拖出来看（Issue #2 回归用例）。
 *
 * ══════════════════════════════════════════════════════════════
 * 用户报的问题（GitHub Issue #2）
 * ══════════════════════════════════════════════════════════════
 *   「v2.0.0.0 图片放大后无法向右拖拽查看左侧内容」
 *   图片放大到 >100% 后往右拖，拖到某处就卡住，图片左边缘始终进不了
 *   可视区；隐藏左侧边栏、窗口最大化都不能解决。
 *
 * ── 根因（不是 JS 钳制，是 CSS 居中）────────────────────────
 *   图片是「先转成一页 PDF」再走通用页面管线的（main/index.ts:1289），
 *   所以它和 PDF 页面共用同一套容器：
 *     .viewer-scroll  overflow: auto   ← 滚动容器
 *     .viewer-pages   display: flex; flex-direction: column;
 *                     align-items: center          ← 元凶
 *   `align-items: center` 在内容比容器宽时，把溢出**平均分到左右两侧**。
 *   右侧靠 scrollLeft 增大可以看到，左侧那半却对应**负的 scrollLeft** ——
 *   滚动容器最小只能是 0，于是左边永远滚不到。
 *
 *   修法：`.viewer-pages` 改 `align-items: flex-start`、
 *        `.viewer-row` 改 `justify-content: flex-start` + `margin-inline: auto`
 *        （auto 外边距在放不下时解析为 0，不产生不可达的负溢出）。
 *
 * ══════════════════════════════════════════════════════════════
 * 判据设计
 * ══════════════════════════════════════════════════════════════
 *   最直接的一条：**scrollLeft = 0 时，页面左缘必须落在视口内**。
 *     · 修好后：左缘 ≈ 视口左边 + padding（≥ 0）
 *     · 修之前：页面被居中，左缘是**负数**（被裁到视口左边之外），
 *               而且 scrollLeft 无法再减小，所以永远看不到
 *   这条判据不依赖任何实现细节，只问「用户能不能看到左边缘」。
 *
 * 用法：node tools/run-verify-suite.mjs --dev 9294 verify-image-zoom-pan.mjs
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = process.argv[2] ?? '9229'
/** 用仓库里现成的截图当图片输入：任意 PNG 都能复现，这里只要一张真实位图 */
const IMAGE = join(root, 'docs', 'screenshots', '01-main.png')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let fails = 0
let checks = 0

const check = (ok, label, detail = '') => {
  checks += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  —— ${detail}` : ''}`)
  if (!ok) fails += 1
}

/** 调一次 CDP 表达式（走项目统一的 scripts/cdp-eval.mjs） */
function cdp(expr) {
  const r = spawnSync('node', [join(root, 'scripts', 'cdp-eval.mjs'), PORT, expr], {
    cwd: root,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 90000
  })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
}

/** 页面里统一返回 JSON.stringify(...)；取出第一个 { 到最后一个 } 再解析 */
function parseObj(text) {
  const a = text.indexOf('{')
  const b = text.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    return JSON.parse(text.slice(a, b + 1))
  } catch {
    return null
  }
}

console.log('图片放大后左侧可达性（Issue #2）')
console.log(`  端口 ${PORT}`)
console.log(`  图片 ${IMAGE}\n`)

/* ---------- ① 打开图片（主进程会先转成一页 PDF）---------- */
const opened = cdp(
  `(async () => {
     try {
       const r = await window.pdfApp.open.path(${JSON.stringify(IMAGE)})
       return JSON.stringify({ ok: !!(r && r.ok), pages: (r && r.pages) || 0, title: (r && r.title) || '' })
     } catch (e) {
       return JSON.stringify({ ok: false, error: String(e) })
     }
   })()`
)
const openInfo = parseObj(opened)
check(!!openInfo?.ok, '① 图片能打开（主进程转成一页 PDF）', opened.slice(-120))

/* 等文档真正挂上（open.path 是往返 IPC，渲染层还要走 openFile） */
let ready = null
for (let i = 0; i < 40; i++) {
  await sleep(400)
  ready = parseObj(
    cdp(`JSON.stringify({
      pageCount: window.__store.getState().pageCount,
      fileName: window.__store.getState().fileName,
      pages: document.querySelectorAll('.pdf-page').length
    })`)
  )
  if (ready && ready.pageCount === 1 && ready.pages === 1) break
}
check(!!ready && ready.pageCount === 1, '① 文档已就绪且为 1 页', JSON.stringify(ready))
check(
  !!ready && /\.png$/i.test(ready.fileName || ''),
  '① 标题显示的是原图片名',
  ready?.fileName
)

/* ---------- ② fit-width 下不该横向溢出（基线）---------- */
const fit = parseObj(
  cdp(
    `(async () => {
       const w = (ms) => new Promise(r => setTimeout(r, ms));
       window.__store.getState().setZoom('fit-width');
       await w(700);
       const s = document.querySelector('.viewer-scroll');
       const page = document.querySelector('.pdf-page');
       if (!s || !page) return JSON.stringify({ error: 'no dom' });
       return JSON.stringify({
         over: s.scrollWidth - s.clientWidth,
         scale: +window.__store.getState().actualScale.toFixed(3),
         pageW: Math.round(page.getBoundingClientRect().width)
       });
     })()`
  )
)
check(!!fit && !fit.error, '② 取到滚动容器与页面', JSON.stringify(fit))
check(
  !!fit && fit.over <= 2,
  '② 适应宽度时不产生横向溢出（基线正常）',
  fit ? `溢出 ${fit.over}px，缩放 ${fit.scale}，页宽 ${fit.pageW}` : ''
)

/* ---------- ③ 放大到 200%，必须横向溢出 ---------- */
const zoomed = parseObj(
  cdp(
    `(async () => {
       const w = (ms) => new Promise(r => setTimeout(r, ms));
       window.__store.getState().setZoom(2);
       await w(1200);
       const s = document.querySelector('.viewer-scroll');
       const page = document.querySelector('.pdf-page');
       const vp = s.getBoundingClientRect();

       /* ★ 核心测量：把横向滚动归零，看页面左缘落在哪 */
       s.scrollLeft = 0;
       await w(120);
       const pr = page.getBoundingClientRect();
       const pageLeftAtZero = Math.round(pr.left - vp.left);

       /* 还能不能往右滚（右边缘可见性） */
       const maxScroll = s.scrollWidth - s.clientWidth;
       s.scrollLeft = maxScroll;
       await w(120);
       const pr2 = page.getBoundingClientRect();
       const pageRightAtMax = Math.round(pr2.right - vp.right);

       s.scrollLeft = 0;
       await w(120);

       return JSON.stringify({
         over: maxScroll,
         scale: +window.__store.getState().actualScale.toFixed(3),
         pageW: Math.round(pr.width),
         vpW: Math.round(vp.width),
         pageLeftAtZero,
         pageRightAtMax,
         /* 左侧无法到达的像素数：正值越大问题越严重 */
         unreachableLeft: Math.max(0, -pageLeftAtZero)
       });
     })()`
  )
)
check(!!zoomed && !zoomed.error, '③ 200% 后取到几何数据', JSON.stringify(zoomed))
check(
  !!zoomed && zoomed.over > 20,
  '③ 200% 后确实产生了横向溢出（前提成立）',
  zoomed ? `溢出 ${zoomed.over}px，页宽 ${zoomed.pageW} vs 视口 ${zoomed.vpW}` : ''
)

/* ---------- ④ ★ 决定性判据：左侧可达 ---------- */
check(
  !!zoomed && zoomed.unreachableLeft <= 1,
  '④ ★ scrollLeft=0 时页面左缘在视口内（左侧可达）',
  zoomed
    ? `左缘偏移 ${zoomed.pageLeftAtZero}px，左侧不可达 ${zoomed.unreachableLeft}px`
    : ''
)
check(
  !!zoomed && zoomed.pageRightAtMax <= 1,
  '④ 滚到最右时页面右缘没有超出视口（右侧也完整可见）',
  zoomed ? `右缘偏移 ${zoomed.pageRightAtMax}px（≤0 表示在视口内）` : ''
)

/* ---------- ⑤ 收尾：恢复 fit-width，别影响后续用例 ---------- */
cdp(
  `(async () => {
     window.__store.getState().setZoom('fit-width');
     const s = document.querySelector('.viewer-scroll');
     if (s) s.scrollLeft = 0;
     return 'ok';
   })()`
)
await sleep(300)

console.log(`\n=== 结果：${checks} 项检查，${fails} 项失败 ===`)
process.exit(fails > 0 ? 1 : 0)
