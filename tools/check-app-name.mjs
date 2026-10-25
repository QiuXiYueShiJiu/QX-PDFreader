// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 检查 package.json 里应用名的字符是否正确（防止改名时写错字）。
 *
 * ── 为什么专门查这个 ────────────────────────────────────────
 *   改名脚本是批量替换，一旦替换串里有一个字不对，
 *   界面上会显示错的名字，而且散落在多处不易发现。
 *   NSIS 构建日志里的中文在控制台是乱码，不能作为依据，
 *   必须直接读 package.json 的原始字符并打印码点来核对。
 */

import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

/** 期望的名字（逐字写出来，便于人工核对） */
const EXPECT = '秋夕-PDF阅读器'

function dump(label, value) {
  const ok = value === EXPECT
  console.log(`  ${ok ? '✓' : '★'} ${label} = ${JSON.stringify(value)}`)
  if (!ok) {
    console.log(`      期望 = ${JSON.stringify(EXPECT)}`)
    console.log(`      实际码点 = ${[...value].map((c) => c.codePointAt(0).toString(16)).join(' ')}`)
    console.log(`      期望码点 = ${[...EXPECT].map((c) => c.codePointAt(0).toString(16)).join(' ')}`)
  }
}

console.log('=== 应用名核对 ===\n')
dump('productName          ', pkg.productName)
dump('nsis.shortcutName    ', pkg.build?.nsis?.shortcutName)
console.log(`  · executableName     = ${JSON.stringify(pkg.build?.executableName)}  （英文，不参与核对）`)
console.log(`  · appId              = ${JSON.stringify(pkg.build?.appId)}`)

/* 顺带确认源码里的显示名也一致 */
const SOURCES = [
  'src/main/index.ts',
  'src/renderer/index.html',
  'src/renderer/src/components/TitleBar.tsx',
  'src/renderer/src/components/SettingsPanel.tsx'
]
console.log('\n=== 源码中的显示名 ===')
for (const path of SOURCES) {
  const text = readFileSync(path, 'utf8')
  const count = text.split(EXPECT).length - 1
  const stale = text.includes('智慧黑板')
  console.log(
    `  ${stale ? '★ 仍含旧名' : '✓'} ${path}  （正确名出现 ${count} 次）`
  )
}
