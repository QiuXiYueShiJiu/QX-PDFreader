// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 鸿合 π6 完整交互测试（最终版）。
 *
 * ── 本脚本修正的三个致命问题 ────────────────────────────────
 *   ① **DSH 窗口会跑到前台把放映盖住** —— 之前所有「点了没反应」
 *      都是这个原因，不是坐标问题。现在每次点击前都强制激活放映窗口。
 *   ② **绝不能按 Esc** —— 会被 PowerPoint 当成「结束放映」，
 *      后面所有截图作废。关闭工具一律点击面板的 ✕。
 *   ③ 坐标用**逻辑像素**（click-at/send-click 用逻辑，
 *      crop-shot 出的是物理像素，差 1.5 倍）。
 *
 * ── 流程 ─────────────────────────────────────────────────────
 *   1. 激活 PowerPoint → F5 开始放映
 *   2. 逐个打开每个按钮 / 子菜单，每步「激活窗口 → 点击 → 截图」
 *   3. 最后清理：结束放映、关闭 PowerPoint、DSH 切回前台
 *
 * 用法：node tools/pi6-final-test.mjs
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outDir = join(root, 'test-results', 'pi6-final')
mkdirSync(outDir, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function run(file, args = []) {
  return spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', join(root, 'tools', file), ...args],
    { windowsHide: true, encoding: 'utf8' }
  )
}

/** 关键：每次点击前把放映窗口抢回前台，否则点击会落到别的窗口上 */
const focusSlideshow = () => run('focus-slideshow.ps1')

const click = (x, y) => run('send-click.ps1', ['-X', String(Math.round(x)), '-Y', String(Math.round(y))])
const shot = (name) => run('crop-shot.ps1', ['-Out', join(outDir, name)])

/** 激活放映 → 点击 → 等待 → 截图 */
async function tap(x, y, stepName, waitMs = 2600) {
  focusSlideshow()
  await sleep(500)
  click(x, y)
  await sleep(waitMs)
  focusSlideshow()
  await sleep(300)
  shot(`${stepName}.png`)
  console.log(`  ✓ ${stepName}`)
}

/* ============================================================
 * 坐标表（逻辑像素，从截图精确量取）
 * ============================================================ */

/** 左侧工具栏按钮（垂直排列） */
const RAIL = {
  batchu: { x: 16, y: 513 },     // 批注
  eraser: { x: 16, y: 585 },     // 橡皮
  tools: { x: 16, y: 662 },      // 工具
  apps: { x: 16, y: 737 },       // 应用
  switcher: { x: 16, y: 817 },   // 应用切换
  collapse: { x: 16, y: 890 },   // 《
  more: { x: 16, y: 928 }        // …
}

/** 工具面板里的工具（面板左上角约在 100,490，图标间距约 128×93） */
const CELL = { dx: 128, dy: 93, x0: 163, y0: 626 }

const TOOL_NAMES = [
  ['截图', '时钟', '放大镜', '聚光灯'],
  ['黑屏', '随机数', '骰子', '大转盘']
]

/** 尺规一行（在面板更下方） */
const RULER_NAMES = ['直尺', '等腰三角板', '直角三角板', '圆规', '量角器']

/* ============================================================
 * 执行
 * ============================================================ */

console.log('=== 鸿合 π6 完整交互测试（最终版）===\n')

/* ---------- 准备：启动放映 ---------- */
console.log('【准备】启动放映')

/* 若已在放映则跳过；否则激活 PowerPoint 并按 F5 */
let windows = run('list-windows.ps1').stdout || ''
if (!windows.includes('幻灯片放映')) {
  run('focus-window.ps1', ['-Title', 'PowerPoint', '-Maximize'])
  await sleep(2500)
  run('send-key.ps1', ['-Key', 'F5'])
  await sleep(9000)
}

focusSlideshow()
await sleep(1500)
shot('00-放映就绪.png')
console.log('  ✓ 00-放映就绪')

/* ---------- A. 左侧工具栏逐个按钮 ---------- */
console.log('\n【A】左侧工具栏按钮')

await tap(RAIL.batchu.x, RAIL.batchu.y, 'A1-批注')
await tap(RAIL.eraser.x, RAIL.eraser.y, 'A2-橡皮', 3200)
await tap(RAIL.eraser.x, RAIL.eraser.y, 'A3-橡皮(再点关闭)', 2000)
await tap(RAIL.apps.x, RAIL.apps.y, 'A4-应用', 3200)
await tap(RAIL.apps.x, RAIL.apps.y, 'A5-应用(再点关闭)', 2000)
await tap(RAIL.switcher.x, RAIL.switcher.y, 'A6-应用切换', 3200)
await tap(RAIL.switcher.x, RAIL.switcher.y, 'A7-应用切换(再点关闭)', 2000)
await tap(RAIL.more.x, RAIL.more.y, 'A8-更多菜单', 3000)
await tap(RAIL.collapse.x, RAIL.collapse.y, 'A9-折叠工具栏', 2500)
await tap(RAIL.collapse.x, RAIL.collapse.y, 'A10-展开工具栏', 2500)

/* ---------- B. 工具面板 + 教辅工具 ---------- */
console.log('\n【B】教辅工具（8 个）')

let n = 1
for (let row = 0; row < TOOL_NAMES.length; row++) {
  for (let col = 0; col < TOOL_NAMES[row].length; col++) {
    const name = TOOL_NAMES[row][col]

    /* 打开面板 */
    await tap(RAIL.tools.x, RAIL.tools.y, `B${n}-panel`, 2600)

    /* 点工具 */
    const tx = CELL.x0 + col * CELL.dx
    const ty = CELL.y0 + row * CELL.dy
    await tap(tx, ty, `B${n}-${name}`, 3600)

    /* 关闭：再点工具按钮（不用 Esc） */
    await tap(RAIL.tools.x, RAIL.tools.y, `B${n}-close`, 1800)

    n++
  }
}

/* ---------- C. 尺规 ---------- */
console.log('\n【C】尺规工具（5 个）')

for (let i = 0; i < RULER_NAMES.length; i++) {
  const name = RULER_NAMES[i]

  await tap(RAIL.tools.x, RAIL.tools.y, `C${i + 1}-panel`, 2600)
  /* 尺规在教辅工具下方一行 */
  await tap(CELL.x0 + i * CELL.dx, CELL.y0 + 2 * CELL.dy + 40, `C${i + 1}-${name}`, 3600)
  await tap(RAIL.tools.x, RAIL.tools.y, `C${i + 1}-close`, 1800)
}

/* ---------- 汇总 ---------- */
const readme = `# 鸿合 π6 完整交互测试记录

- 时间：${new Date().toLocaleString('zh-CN')}
- 方式：SendInput 真实输入注入 + 整屏截图（tools/pi6-final-test.mjs）
- 截图目录：test-results/pi6-final/

## 三个关键教训（都踩过）

1. **DSH 窗口会抢前台把放映盖住** —— 表现为「点了完全没反应」。
   每次点击前必须调用 focus-slideshow.ps1 把放映窗口抢回前台。
2. **放映时不要按 Esc** —— PowerPoint 会当作「结束放映」，
   演示退回编辑器，后续截图全部作废。关闭工具只能点面板 ✕。
3. **坐标两套单位**：点击用逻辑像素（2560×1440），
   截图是物理像素（3840×2160），相差 1.5 倍。
`

writeFileSync(join(outDir, 'README.md'), readme, 'utf8')

console.log('\n=== 测试完成 ===')
console.log(`截图目录: test-results/pi6-final/`)
