// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 鸿合 π6 完整交互测试 —— 逐个打开每一个按钮与子菜单并截图。
 *
 * ── 为什么必须自动化 ─────────────────────────────────────────
 * 要测的交互点有 30+ 个（每个按钮 + 每个子面板里的每一项），
 * 每次「点击 → 等待 → 截图 → 关闭」四步。手动发既慢又容易漏，
 * 而且不可复现。脚本跑一遍就能拿到完整截图集。
 *
 * ── 关于 Esc（重要教训）─────────────────────────────────────
 *   放映模式下 **Esc 会被 PowerPoint 当成「结束放映」**，
 *   整个演示退回编辑器，后面所有截图作废（第一次跑就栽在这）。
 *   因此本脚本**绝不使用 Esc**：关闭一律点面板自带的 ✕
 *   或再次点击同一个工具按钮。
 *
 * ── 坐标 ─────────────────────────────────────────────────────
 *   click-at.ps1 用**逻辑像素**（2560×1440）
 *   crop-shot.ps1 出的是**物理像素**（3840×2160），差 1.5 倍
 *   这里所有坐标都是逻辑像素，从实际截图上量取。
 *
 * 用法：node tools/pi6-full-test.mjs
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outDir = join(root, 'test-results', 'pi6-full')
mkdirSync(outDir, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function run(file, args) {
  return spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', join(root, 'tools', file), ...args],
    { windowsHide: true, encoding: 'utf8' }
  )
}

const click = (x, y) => run('click-at.ps1', ['-X', String(Math.round(x)), '-Y', String(Math.round(y))])
const dblclick = (x, y) => run('click-at.ps1', ['-X', String(Math.round(x)), '-Y', String(Math.round(y)), '-DoubleClick'])
const shot = (name) => run('crop-shot.ps1', ['-Out', join(outDir, name)])

/* ============================================================
 * 坐标表（逻辑像素，从实际截图量取）
 * ============================================================ */

/** 左侧工具栏按钮 */
const RAIL = {
  batchu: { x: 16, y: 447 },    // 批注
  eraser: { x: 16, y: 553 },    // 橡皮
  tools: { x: 16, y: 605 },     // 工具
  apps: { x: 16, y: 670 },      // 应用
  switcher: { x: 16, y: 765 },  // 应用切换
  collapse: { x: 16, y: 862 },  // 《 折叠
  more: { x: 16, y: 908 }       // … 更多
}

/** 工具栏右侧的展开箭头（半圆形按钮） */
const RAIL_EXPAND = { x: 47, y: 447 }

/** 「工具」面板 */
const PANEL = {
  close: { x: 452, y: 522 }
}

/** 「工具」面板内各工具 */
const TOOLS = [
  { name: '01截图', x: 163, y: 626 },
  { name: '02时钟', x: 292, y: 626 },
  { name: '03放大镜', x: 420, y: 626 },
  { name: '04聚光灯', x: 551, y: 626 },
  { name: '05黑屏', x: 163, y: 737 },
  { name: '06随机数', x: 292, y: 737 },
  { name: '07骰子', x: 420, y: 737 },
  { name: '08大转盘', x: 551, y: 737 }
]

/** 「尺规」分组的五个工具（面板下半部分） */
const RULERS = [
  { name: '09直尺', x: 163, y: 960 },
  { name: '10等腰三角板', x: 292, y: 960 },
  { name: '11直角三角板', x: 420, y: 960 },
  { name: '12圆规', x: 551, y: 960 },
  { name: '13量角器', x: 680, y: 960 }
]

/** 「语言」标签（面板里的分组切换） */
const LANG_TAB = { x: 245, y: 890 }

/* ============================================================
 * 测试步骤
 * ============================================================ */

const log = []

async function capture(step, name, waitBefore = 2000) {
  await sleep(waitBefore)
  shot(name)
  log.push(`${step}  →  ${name}`)
  console.log(`  ${step}  →  ${name}`)
}

console.log('=== 鸿合 π6 完整交互测试 ===')
console.log(`截图目录: test-results/pi6-full/\n`)

/* ---------- A. 左侧工具栏顶层按钮 ---------- */
console.log('【A】左侧工具栏按钮')

await capture('A1 初始状态（放映中）', 'A1-初始.png', 500)

click(RAIL.batchu.x, RAIL.batchu.y)
await capture('A2 点「批注」', 'A2-批注.png', 3000)

click(RAIL.eraser.x, RAIL.eraser.y)
await capture('A3 点「橡皮」', 'A3-橡皮.png', 3000)

click(RAIL.apps.x, RAIL.apps.y)
await capture('A4 点「应用」', 'A4-应用.png', 3000)

click(RAIL.switcher.x, RAIL.switcher.y)
await capture('A5 点「应用切换」', 'A5-应用切换.png', 3000)

click(RAIL.more.x, RAIL.more.y)
await capture('A6 点「…」更多菜单', 'A6-更多.png', 3000)

click(RAIL.collapse.x, RAIL.collapse.y)
await capture('A7 点「《」折叠工具栏', 'A7-折叠.png', 2500)

/* 展开回来 */
click(RAIL_EXPAND.x, RAIL_EXPAND.y)
await capture('A8 点展开箭头恢复', 'A8-展开恢复.png', 2500)

/* ---------- B. 「工具」面板 ---------- */
console.log('\n【B】工具面板')

click(RAIL.tools.x, RAIL.tools.y)
await capture('B1 打开工具面板', 'B1-工具面板.png', 3000)

/* ---------- C. 教辅工具（逐个） ---------- */
console.log('\n【C】教辅工具（8 个）')

for (const t of TOOLS) {
  /* 面板可能已被上一个工具关掉，先确保打开 */
  click(RAIL.tools.x, RAIL.tools.y)
  await sleep(1800)
  click(t.x, t.y)
  await capture(`C-${t.name}`, `C-${t.name}.png`, 3500)

  /* 关闭：点工具按钮收起 + 点面板 ✕，都用点击，绝不按 Esc */
  click(RAIL.tools.x, RAIL.tools.y)
  await sleep(1200)
  click(PANEL.close.x, PANEL.close.y)
  await sleep(1800)
}

/* ---------- D. 尺规工具（逐个） ---------- */
console.log('\n【D】尺规工具（5 个）')

for (const r of RULERS) {
  click(RAIL.tools.x, RAIL.tools.y)
  await sleep(1800)
  click(r.x, r.y)
  await capture(`D-${r.name}`, `D-${r.name}.png`, 3500)

  click(RAIL.tools.x, RAIL.tools.y)
  await sleep(1200)
  click(PANEL.close.x, PANEL.close.y)
  await sleep(1800)
}

/* ---------- E. 语言分组 ---------- */
console.log('\n【E】语言分组')

click(RAIL.tools.x, RAIL.tools.y)
await sleep(2000)
click(LANG_TAB.x, LANG_TAB.y)
await capture('E1 语言分组', 'E1-语言分组.png', 3000)
click(PANEL.close.x, PANEL.close.y)
await sleep(1500)

/* ---------- 汇总 ---------- */
const summary = `# 鸿合 π6 完整交互测试记录

测试时间：${new Date().toLocaleString('zh-CN')}
测试方式：自动化点击 + 整屏截图（脚本 tools/pi6-full-test.mjs）
截图目录：test-results/pi6-full/

## 测试项清单

| 序号 | 测试项 | 截图 |
|---|---|---|
${log.map((l) => {
  const [step, file] = l.split('  →  ')
  return `| ${step} | ${step.replace(/^[A-Z]-?/, '')} | ${file} |`
}).join('\n')}

## 坐标说明

- 点击用**逻辑像素**（2560×1440）
- 截图是**物理像素**（3840×2160）
- 两者相差 1.5 倍（系统 150% 缩放）

## 重要教训

**放映模式下不要按 Esc** —— 会被 PowerPoint 当作「结束放映」，
演示直接退回编辑器，后续截图全部作废。
关闭工具一律点面板的 ✕ 或再次点工具按钮。
`

writeFileSync(join(outDir, 'README.md'), summary, 'utf8')

console.log('\n=== 测试完成 ===')
console.log(`共 ${log.length} 项，截图在 test-results/pi6-full/`)
