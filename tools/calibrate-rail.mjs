// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 坐标校准：在「工具」按钮附近扫描候选点，找出真正能打开面板的坐标。
 *
 * 为什么要校准：
 *   逻辑坐标（click-at 用的 2560×1440）与物理坐标（crop-shot 出的
 *   3840×2160）差 1.5 倍，靠肉眼量图容易差十来个像素，
 *   而 Rail 按钮只有约 30px 高，差一点就点到隔壁（实测点「工具」
 *   结果选中了「批注」）。
 *   与其反复猜，不如让脚本把候选点挨个试一遍、每个都截图，
 *   一眼就能看出哪个点是对的。
 *
 * 判定成功的标志：截图里出现「工具」面板（白底、含截图/时钟等图标）。
 *
 * 用法：node tools/calibrate-rail.mjs
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outDir = join(root, 'test-results', 'calib')
mkdirSync(outDir, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function run(file, args) {
  return spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', join(root, 'tools', file), ...args],
    { windowsHide: true, encoding: 'utf8' }
  )
}

const click = (x, y) => run('click-at.ps1', ['-X', String(x), '-Y', String(y)])

/* 候选点：x 固定在工具栏中心，y 在「工具」字样附近上下扫 */
const CANDIDATES = [
  { x: 16, y: 620 },
  { x: 16, y: 628 },
  { x: 16, y: 636 },
  { x: 16, y: 644 },
  { x: 20, y: 636 },
  { x: 12, y: 636 },
  { x: 16, y: 652 }
]

console.log('=== 工具栏坐标校准 ===')
console.log('每点一次截一张图，看哪张出现了「工具」面板\n')

for (let i = 0; i < CANDIDATES.length; i++) {
  const c = CANDIDATES[i]
  const tag = `${String(i + 1).padStart(2, '0')}-x${c.x}-y${c.y}`

  /* 先点一下空白处收起已有面板，再点候选点 */
  click(1200, 1200)
  await sleep(1200)

  click(c.x, c.y)
  await sleep(2600)

  run('crop-shot.ps1', ['-Out', join(outDir, `calib-${tag}.png`)])
  console.log(`  已测: (${c.x}, ${c.y})  →  calib-${tag}.png`)
}

console.log('\n=== 校准完成，查看 test-results/calib/ 里的截图 ===')
