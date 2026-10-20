// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 金标准夹具自检：确认 tests/fixture/fixture.pdf 真的覆盖了所有测试需求。
 *
 * 为什么单独一支：夹具是**所有端到端用例的地基**。它一旦少页、缺图、
 * 丢掉书签，十几支用例会以各种奇怪的理由失败，排查成本极高。
 * 这一支专门回答「夹具本身对不对」，而且**不打开可见窗口**。
 *
 * 判据：
 *   ① 页数 = 20（夹具生成器声明的页数）
 *   ② 每页都能拿到 viewport（尺寸正确、可渲染）
 *   ③ 页面尺寸**不止一种**（覆盖缩放/适配类用例）
 *   ④ 存在旋转页（/Rotate 90 与 270）
 *   ⑤ 书签（大纲）条数 ≥ 4
 *   ⑥ 内嵌位图能取到（覆盖图片相关用例）
 *   ⑦ 文本内容为可提取的英文（覆盖选择/复制/内容编辑）
 *
 * 用法：node tools/verify-fixture.mjs <端口>
 *       由 run-verify-suite.mjs 在隐藏实例起来后调用。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixturePath } from '../scripts/packaging-paths.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PORT = process.argv[3] ?? process.argv[2] ?? '9290'
const PDF = fixturePath()

const fails = []
function check(label, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? '  —— ' + detail : ''}`)
  if (!ok) fails.push(label)
}

function cdp(expr, timeout = 60000) {
  const r = spawnSync('node', [join(root, 'scripts', 'cdp-eval.mjs'), String(PORT), expr], {
    cwd: root,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout
  })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
}

const j = (s) => {
  try {
    return JSON.parse(String(s).split('\n').pop())
  } catch {
    return null
  }
}

/**
 * 测试挂钩里读 pdf.js 文档对象。
 *
 * ★ 为什么要轮询：`window.__pdfDoc` 是在 App 的 useDocument 解析完成时才挂上的
 *   （见 src/renderer/src/components/DocumentView.tsx），比套件的 waitReady
 *   晚一点点。直接读会偶发拿到 null，然后用例报「夹具坏了」——那是假红。
 */
const docReady = `(() => {
  const d = window.__pdfDoc;
  if (!d || !d.numPages) return null;
  return d;
})()`

function withDoc(body, timeout = 120000) {
  return `(async () => {
     const wait = (ms) => new Promise(r => setTimeout(r, ms));
     let d = null;
     for (let i = 0; i < 200; i++) { d = ${docReady}; if (d) break; await wait(100); }
     if (!d) return JSON.stringify({ err: '拿不到 window.__pdfDoc（测试挂钩没开？）' });
     ${body}
   })()`
}

console.log('=== 金标准夹具自检 ===\n')
console.log(`夹具：${PDF}`)

/* ---------- 静态 ---------- */
check('夹具文件存在', existsSync(PDF))
if (!existsSync(PDF)) {
  console.log('\n=== 结果：✗ ===')
  process.exit(1)
}
const bytes = readFileSync(PDF)
check('文件头是 %PDF-', bytes.subarray(0, 5).toString('latin1') === '%PDF-')
check('文件尾有 %%EOF', bytes.subarray(-64).toString('latin1').includes('%%EOF'))
check('文件大小在合理区间（30KB ~ 2MB）', bytes.length > 30 * 1024 && bytes.length < 2 * 1024 * 1024, `${(bytes.length / 1024).toFixed(1)} KB`)
check('含内嵌位图（/Subtype /Image）', bytes.includes(Buffer.from('/Subtype /Image', 'latin1')))
/*
 * ★ 这两条静态判据只在「PDF 未压缩 / 对象没被装进对象流」时才会命中。
 *   pdf-lib 默认会把页对象与书签装进**对象流**（ObjStm）并压缩，
 *   于是原始字节里搜不到 `/Rotate` `/Outlines` —— 那是**编码差异**，
 *   不是夹具缺功能。真正可靠的是下面的运行时判据（读 pdf.js 解析结果）。
 *   这里保留静态检查但只作为「提示」：命中就报 ✓，不命中不判红。
 */
check(
  '含旋转页（静态搜 /Rotate；未命中属正常，见运行时判据）',
  bytes.includes(Buffer.from('/Rotate', 'latin1')) || true
)
check(
  '含大纲（静态搜 /Outlines；未命中属正常，见运行时判据）',
  bytes.includes(Buffer.from('/Outlines', 'latin1')) || true
)

/* ---------- 运行时：PDF 是否真能加载 ---------- */
console.log('\n— 运行时（隐藏实例内解析）—')

const st = j(
  cdp(`(() => {
     const s = window.__store.getState();
     return JSON.stringify({
       页数: s.pageCount,
       当前页: s.page,
       文件名: s.fileName,
       路径: s.filePath,
       缩放: s.zoom,
       加载错误: s.error || null
     });
   })()`)
)
console.log(`   ${JSON.stringify(st)}`)

/*
 * ★ 套件实例默认打开的就是夹具（run-verify-suite 把 PDF 参数传进去），
 *   所以这里直接读它已经加载好的文档，不再另开实例。
 */
check('已加载夹具本身（路径一致）', st?.路径 === PDF, `${st?.路径}`)
check('页数 = 20', st?.页数 === 20, `实际 ${st?.页数}`)
check('没有加载错误', !st?.加载错误, st?.加载错误 ?? '')

/* 逐页取 viewport：确认每页尺寸都能算出来且为正 */
const pages = j(
  cdp(withDoc(`const out = [];
     for (let i = 1; i <= d.numPages; i++) {
       const p = await d.getPage(i);
       const v = p.getViewport({ scale: 1 });
       out.push({ 页: i, 宽: Math.round(v.width), 高: Math.round(v.height), 旋转: p.rotate || 0 });
     }
     return JSON.stringify({ 页: out });`), 140000)
)
if (!pages || pages.err) {
  console.log(`   ⚠ ${pages?.err ?? '逐页读取失败'}`)
  check('逐页 viewport 可用', false, pages?.err ?? '未知')
} else {
  const list = pages.页
  check('逐页都拿到了 viewport', list.length === 20 && list.every((p) => p.宽 > 0 && p.高 > 0), `${list.length} 页`)
  const sizes = new Set(list.map((p) => `${p.宽}x${p.高}`))
  check('页面尺寸不止一种（覆盖缩放/适配）', sizes.size >= 6, `${sizes.size} 种：${[...sizes].join(' ')}`)
  const rotated = list.filter((p) => p.旋转 !== 0)
  check('存在旋转页（覆盖旋转用例）', rotated.length >= 2, rotated.map((p) => `第${p.页}页/${p.旋转}°`).join(' '))
  const big = list.filter((p) => p.宽 > 1000)
  check('存在超大版式页（覆盖放大到 300%）', big.length >= 1, big.map((p) => `第${p.页}页 ${p.宽}x${p.高}`).join(' '))
  const tall = list.filter((p) => p.高 > 1100)
  check('存在超长页（覆盖滚动/懒渲染）', tall.length >= 1, tall.map((p) => `第${p.页}页 ${p.宽}x${p.高}`).join(' '))
}

/* 书签 */
const outline = j(
  cdp(withDoc(`const o = await d.getOutline();
     return JSON.stringify({ 条数: o ? o.length : 0, 标题: o ? o.map(x => x.title) : [] });`), 60000)
)
check('有书签（覆盖左侧目录导航）', (outline?.条数 ?? 0) >= 4, `${outline?.条数 ?? 0} 条：${(outline?.标题 ?? []).join(' / ')}`)

/* 文字层可提取 */
const text = j(
  cdp(withDoc(`const p = await d.getPage(2);
     const tc = await p.getTextContent();
     const all = tc.items.map(i => i.str).join(' ');
     return JSON.stringify({ 片段数: tc.items.length, 样本: all.slice(0, 120), 含fox: all.includes('quick brown fox') });`), 60000)
)
check('第 2 页有可提取文字（覆盖选择/复制/内容编辑）', (text?.片段数 ?? 0) > 10, `${text?.片段数 ?? 0} 片段`)
check('文字内容符合预期（含 quick brown fox）', text?.含fox === true, text?.样本 ?? '')

/* 位图：端到端判据 —— 真把第 5 页渲染出来，统计彩色像素并求包围盒。
 *
 * ★ 为什么不查 `page.objs`：pdf.js 的 PDFObjects 是**懒加载**的，
 *   XObject 往往不在里面，实测 page.objs.objs 恒为空 → 判据永远假红。
 * ★ 为什么用 scale 0.4：scale=1 有 50 万像素，getImageData 的序列化会
 *   把主进程卡住甚至超时（前两版都是「彩色像素 = undefined」，
 *   看起来像判据写错，实际是取像素那一步没跑完）。
 *   图像占 360x240 pt，缩到 0.4 仍有 144x96，足够判定。
 * ★ 一定包 try/catch：渲染或取像素失败时要能看到真实原因，
 *   不能让脚本「静默地什么都没测」。
 */
const img = j(
  cdp(withDoc(`try {
     const p = await d.getPage(5);
     const vp = p.getViewport({ scale: 0.4 });
     const canvas = document.createElement('canvas');
     canvas.width = Math.round(vp.width);
     canvas.height = Math.round(vp.height);
     const ctx = canvas.getContext('2d', { willReadFrequently: true });
     ctx.fillStyle = '#ffffff';
     ctx.fillRect(0, 0, canvas.width, canvas.height);
     await p.render({ canvasContext: ctx, viewport: vp }).promise;
     const full = ctx.getImageData(0, 0, canvas.width, canvas.height);
     const px = full.data;
     let colored = 0, nonWhite = 0, total = 0;
     let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
     const W = canvas.width;
     for (let y = 0; y < canvas.height; y++) {
       for (let x = 0; x < W; x++) {
         const i = (y * W + x) * 4;
         const r = px[i], g = px[i+1], b = px[i+2];
         total++;
         if (r < 245 || g < 245 || b < 245) nonWhite++;
         if (Math.max(r,g,b) - Math.min(r,g,b) > 40) {
           colored++;
           if (x < minX) minX = x;
           if (y < minY) minY = y;
           if (x > maxX) maxX = x;
           if (y > maxY) maxY = y;
         }
       }
     }
     return JSON.stringify({
       画布: [canvas.width, canvas.height],
       总像素: total,
       非白像素: nonWhite,
       彩色像素: colored,
       彩色包围盒: maxX >= 0 ? [minX, minY, maxX - minX + 1, maxY - minY + 1] : null
     });
   } catch (e) { return JSON.stringify({ 异常: String(e && e.message || e) }); }`), 180000)
)
if (img?.异常) console.log(`   ⚠ 渲染取像素时出错：${img.异常}`)
check(
  '第 5 页真渲染出彩色图像（覆盖图片/导出像素路径）',
  (img?.彩色像素 ?? 0) > 500,
  `彩色像素 ${img?.彩色像素 ?? 0} / ${img?.总像素 ?? 0}，非白 ${img?.非白像素 ?? 0}，画布 ${JSON.stringify(img?.画布)}，包围盒 ${JSON.stringify(img?.彩色包围盒)}`
)

console.log(`\n=== 结果：${fails.length ? `${fails.length} 项未通过 ✗` : '全部通过 ✓'} ===`)
if (fails.length) {
  for (const f of fails) console.log('  - ' + f)
  process.exit(1)
}
process.exit(0)
