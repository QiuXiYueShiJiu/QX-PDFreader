// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 验证「构建产物里真的有这次要交付的东西」——纯静态、不用起实例，1 秒内跑完。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────
 * v2.0.0.0 的教训：`verify-touch-zoom-guard.mjs` 第一次跑出 4 条红，
 * 不是功能没修，而是实例加载的还是 09:59 的旧产物（源码 12:25 才改）。
 * 结果就是「用例红了 → 以为没修好 → 白查一轮」。
 * 这类事故的共同点是：**源码改了但没重新 build**，而所有端到端用例都只看得见产物。
 * 所以这里把「产物里必须有哪些标记」写成一条独立用例：
 *   源码 → 产物 的断层，1 秒内当场报出来，不必等 30 秒的端到端用例。
 *
 * ── 判据 ──────────────────────────────────────────────────────
 * ① 主进程 out/main/index.js：v2.0 新增的四组 IPC 与对话框文案、pdf-lib 真的被打进去、
 *    userData 钉在老名字上（改名不改数据目录）、显示名是新名；
 * ② 预加载 out/preload/index.cjs：渲染层要用的三个通道名都在；
 * ③ 渲染层首屏 HTML：默认主题是米色（data-theme，防首屏白闪）；
 * ④ 主包 out/renderer/assets/index-*.js：左四按钮的四个视图模式、内容编辑六个工具、
 *    标签栏类名、未导出提示、新显示名；
 * ⑤ 懒分包 out/renderer/assets/anno-export-*.js：导出实现真的被分出去了（证明懒加载没退化，
 *    主包不该背 pdf-lib 那几秒的解析）；
 * ⑥ 样式 out/renderer/assets/index-*.css：标签栏 / 编辑层 / 主题选择器的类都在。
 *
 * ── 说明 ──────────────────────────────────────────────────────
 * - 没有产物（还没 build）时打印提示并 **退出码 0**：套件在装好的版本上跑时，
 *   仓库里可能确实没有 out/，这条用例应该跳过而不是把整套拖红。
 * - 只看「标记在不在」，不校验行为；行为由端到端用例负责。
 * - 判据里的中文标记按字面匹配（esbuild 保留 UTF-8 原文，不转义成 \uXXXX）。
 *
 * 用法：node tools/verify-bundle-markers.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outDir = join(root, 'out')

const failures = []
const notes = []
let count = 0

function check(ok, label) {
  count += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures.push(label)
}

function readText(path) {
  return readFileSync(path, 'utf8')
}

function pick(dir, pattern) {
  if (!existsSync(dir)) return null
  const hit = readdirSync(dir).find((name) => pattern.test(name))
  return hit ? join(dir, hit) : null
}

/**
 * 取匹配里**最大**的那个文件。
 *
 * 为什么需要（v2.1.3 踩的坑）：OCR 引入 tesseract.js 之后，渲染层产物被
 * 拆成了两个 index-*.js —— 主包 index-XXXX.js（~1.2MB）和一个几 KB 的
 * 小 chunk。pick() 用 readdirSync().find() 拿的是「目录顺序第一个」，
 * 于是检查跑到小 chunk 上，主包里明明有的标记全被判「缺」。
 * 主包的判据就是「体积最大的那个 js」，与文件名哈希无关。
 */
function pickLargest(dir, pattern) {
  if (!existsSync(dir)) return null
  const hits = readdirSync(dir)
    .filter((name) => pattern.test(name))
    .map((name) => ({ name, size: statSync(join(dir, name)).size }))
    .sort((a, b) => b.size - a.size)
  return hits.length ? join(dir, hits[0].name) : null
}

function hasAll(text, needles) {
  return needles.filter((n) => !text.includes(n))
}

function report(path, text, needles) {
  const missing = hasAll(text, needles)
  check(
    missing.length === 0,
    `${path}：${needles.length} 个标记${missing.length ? `（缺 ${missing.join('、')}）` : ''}`
  )
}

/* ── 没有产物就跳过 ─────────────────────────────────────────── */
if (!existsSync(outDir)) {
  console.log('\n  ⚠ 没有 out/ 目录（还没构建），这条用例跳过；构建后再跑。\n')
  process.exit(0)
}

console.log(`\n  产物目录：${outDir}`)

/* ── ① 主进程 ───────────────────────────────────────────────── */
const mainJs = join(outDir, 'main', 'index.js')
if (!existsSync(mainJs)) {
  check(false, 'out/main/index.js 存在（先跑 electron-vite build）')
} else {
  report('out/main/index.js', readText(mainJs), [
    'pdf:export',
    'doc:confirm-unsaved',
    'app:quit-now',
    'win:quit-request',
    'win:close-request',
    'PDFDocument',
    '保存为 PDF',
    '不保存',
    '秋夕月拾旧-PDF阅读器', // userData 钉在老名字上（改名不搬数据）
    '秋夕-PDF阅读器' // 显示名
  ])
}

/* ── ② 预加载 ───────────────────────────────────────────────── */
const preloadJs = join(outDir, 'preload', 'index.cjs')
if (!existsSync(preloadJs)) {
  check(false, 'out/preload/index.cjs 存在')
} else {
  report('out/preload/index.cjs', readText(preloadJs), [
    'win:close-request',
    'win:quit-request',
    'pdf:export',
    'doc:confirm-unsaved',
    'app:info'
  ])
}

/* ── ③ 首屏 HTML ────────────────────────────────────────────── */
const html = join(outDir, 'renderer', 'index.html')
if (!existsSync(html)) {
  check(false, 'out/renderer/index.html 存在')
} else {
  report('out/renderer/index.html', readText(html), ['data-theme'])
}

const assets = join(outDir, 'renderer', 'assets')

/* ── ④ 渲染层主包 ───────────────────────────────────────────── */
const mainChunk = pickLargest(assets, /^index-.*\.js$/)
if (!mainChunk) {
  check(false, 'out/renderer/assets/index-*.js 存在')
} else {
  report(`out/renderer/assets/${mainChunk.split(/[\\/]/).pop()}`, readText(mainChunk), [
    'viewmode-single',
    '适应宽度',
    '连续滚动',
    '双栏滚动',
    '涂白',
    '矩形',
    '椭圆',
    '图片',
    'tabbar',
    '未导出的编辑',
    '秋夕-PDF阅读器'
  ])
}

/* ── ⑤ 懒分包（导出实现） ───────────────────────────────────── */
const exportChunk = pick(assets, /^anno-export-.*\.js$/)
if (!exportChunk) {
  check(false, 'out/renderer/assets/anno-export-*.js 存在（导出实现应被懒加载分包）')
} else {
  report(`out/renderer/assets/${exportChunk.split(/[\\/]/).pop()}`, readText(exportChunk), [
    'exportPdf',
    'markExported',
    'EXPORT_SCALE'
  ])
}

/* ── ⑥ 样式 ─────────────────────────────────────────────────── */
const cssFile = pickLargest(assets, /^index-.*\.css$/)
if (!cssFile) {
  check(false, 'out/renderer/assets/index-*.css 存在')
} else {
  report(`out/renderer/assets/${cssFile.split(/[\\/]/).pop()}`, readText(cssFile), [
    '.tabbar',
    '.edit-layer',
    '.edit-bar',
    'data-theme'
  ])
}

/* ── 汇总 ───────────────────────────────────────────────────── */
notes.push('源码改了但没重新 build 时，这条用例会先红——这正是它的用处（v2.0 那次端到端用例白红了一轮）')
for (const n of notes) console.log(`  · ${n}`)
console.log(
  failures.length
    ? `\n✗ ${failures.length}/${count} 项未通过：\n   - ${failures.join('\n   - ')}`
    : `\n✓ 全部通过（${count} 项）：产物里 v2.0 的标记齐全`
)
process.exit(failures.length ? 1 : 0)
