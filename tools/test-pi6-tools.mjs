// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 批量测试鸿合 π6「教辅工具」面板里的全部工具。
 *
 * 为什么用脚本批量跑：
 *   面板上 7 个工具，每个都要「开面板 → 点工具 → 截图 → 关闭」四步。
 *   手动一条条发容易漏、也不可复现；脚本跑完直接得到一组带名字的截图。
 *
 * ★ 血泪教训：**绝对不要在放映模式下按 Esc**。
 *   Esc 会被 PowerPoint 解释为「结束放映」，整个演示直接退回编辑器，
 *   后面所有截图都会拍成编辑器界面而白白作废（第一次跑就栽在这）。
 *   关闭工具一律只用面板自带的 ✕ 按钮，或工具自己的关闭钮。
 *
 * 坐标（逻辑像素；crop-shot 截出的是物理像素，两者差 1.5 倍）：
 *   全部从实际截图上量取，见每项注释。
 *
 * 用法：node tools/test-pi6-tools.mjs
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outDir = join(root, 'test-results', 'pi6-tools')
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
const shot = (name) => run('crop-shot.ps1', ['-Out', join(outDir, name)])

/* 左侧工具栏「工具」按钮中心（从截图上量得） */
const TOOLS_BTN = { x: 16, y: 605 }

/* 「工具」面板右上角的关闭 ✕（从 demo-06 截图上量得，逻辑坐标） */
const PANEL_CLOSE = { x: 452, y: 522 }

/* 「工具」面板里各工具的图标中心 */
const TOOLS = [
  { name: '截图', x: 163, y: 626 },
  { name: '时钟', x: 292, y: 626 },
  { name: '放大镜', x: 420, y: 626 },
  { name: '黑屏', x: 163, y: 737 },
  { name: '随机数', x: 292, y: 737 },
  { name: '骰子', x: 420, y: 737 },
  { name: '大转盘', x: 551, y: 737 }
]

console.log('=== 鸿合 π6 教辅工具批量测试 ===')
console.log('截图目录: test-results/pi6-tools/')
console.log('提示：全程不使用 Esc（会退出放映）\n')

for (const tool of TOOLS) {
  process.stdout.write(`  ${tool.name} …`)

  /* 1. 打开工具面板 */
  click(TOOLS_BTN.x, TOOLS_BTN.y)
  await sleep(2200)

  /* 2. 点该工具 */
  click(tool.x, tool.y)
  await sleep(3500)

  /* 3. 截图 */
  shot(`tool-${tool.name}.png`)
  process.stdout.write(' 已截图')

  /*
   * 4. 关闭该工具。
   *    多数工具点「工具」按钮本身即可收起；
   *    先点工具按钮，再点面板 ✕，双保险且都不会退出放映。
   */
  click(TOOLS_BTN.x, TOOLS_BTN.y)
  await sleep(1500)
  click(PANEL_CLOSE.x, PANEL_CLOSE.y)
  await sleep(1800)

  console.log(' 已关闭')
}

console.log('\n=== 测试完成 ===')

