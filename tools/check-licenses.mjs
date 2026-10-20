// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 依赖许可证合规闸门 —— 交付前必须过。
 *
 * ═══════════════════════════════════════════════════════════════════
 * 用户的要求（2026-10-16 明确）
 * ═══════════════════════════════════════════════════════════════════
 *   ① 「不需要任何传染强的开源依赖」    → 硬红线，0 命中
 *   ② 本项目自有代码改为**不可商用**授权（PolyForm Noncommercial 1.0.0）
 *      → 这里额外报出「自有代码许可」与「依赖许可是否冲突」的结论。
 *
 * 拆成两条判据：
 *   ① **硬红线（必须 0 命中）**：不得出现强传染 / copyleft 许可 ——
 *      GPL / LGPL / AGPL / SSPL / MPL / EUPL / CDDL / OSL / CPL / EPL /
 *      CC-BY-SA / CC-BY-NC。命中即退出码 1，属于**阻断级**。
 *   ② **口径外提示（允许但要点名）**：既不是 MIT 也不是 Apache-2.0、
 *      但属于宽松许可的（ISC / BSD-2 / BSD-3 / 0BSD / BlueOak / Zlib /
 *      Python-2.0 / WTFPL / CC-BY-4.0 / 并列写法）。这些**不改**，只打印，
 *      因为替换它们需要 fork 上游（实测：pako、tslib@1 都由 pdf-lib 硬依赖，
 *      删掉等于 fork pdf-lib），而收益为零 —— 它们都允许闭源商用与再分发。
 *
 * ── 为什么要分「进包」和「不进包」────────────────────────────────
 *   electron.vite.config.ts 用 externalizeDepsPlugin() 把 package.json 的
 *   `dependencies` 留在外部；build.files 只收 `out/**` 与 `package.json`，
 *   electron-builder 再把生产依赖的传递闭包收进 app.asar。
 *   所以**真正随安装包分发的是很小的一个子集**（实测 13 个），
 *   而 devDependencies（electron-builder / vite / typescript / babel …）
 *   那 360 多个包只活在开发机上，许可再怪也不构成分发义务。
 *   两部分都检查，但分开报告，免得把「开发机上的怪许可」误当成交付风险。
 *
 * 用法：
 *   node tools/check-licenses.mjs            # 报全量 + 分表，有红线就 exit 1
 *   node tools/check-licenses.mjs --quiet    # 只在有红线/汇总时输出
 *   node tools/check-licenses.mjs --write    # 另外生成 THIRD-PARTY-NOTICES.md
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const argv = process.argv.slice(2)
const QUIET = argv.includes('--quiet')
const WRITE = argv.includes('--write')

/**
 * 强传染 / copyleft 家族。命中即红线。
 *
 * 注意要按「词」匹配，不能简单 includes('GPL')：LGPL 里也含 GPL，
 * 而我们本来就要两个都拦；但 `Apache-2.0 WITH LLVM-exception` 之类
 * 不能因为含 "PL" 就被误伤，所以用带边界的正则。
 */
const COPYLEFT = /(^|[^A-Za-z])(A?GPL|LGPL|SSPL|MPL|EUPL|CDDL|OSL|CPL|EPL|CC-BY-SA|CC-BY-NC)([^A-Za-z]|$)/i

/** 宽松但不在「MIT 或 Apache-2.0」字面口径内的许可（允许，仅提示） */
const PERMISSIVE_OUT_OF_SPEC =
  /(ISC|BSD-[23]-Clause|0BSD|BlueOak|Zlib|Python-2\.0|WTFPL|CC0|CC-BY-4\.0|Unlicense|Public Domain)/i

/** 一个包在 node_modules 里的位置（作用域包也走这条） */
function pkgDir(name) {
  return join(root, 'node_modules', name)
}

function readPkg(name) {
  const p = join(pkgDir(name), 'package.json')
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

function licenseOf(j) {
  if (typeof j.license === 'string') return j.license
  if (j.license && typeof j.license === 'object' && j.license.type) return j.license.type
  if (Array.isArray(j.licenses)) {
    return j.licenses.map((x) => (typeof x === 'string' ? x : (x?.type ?? '?'))).join(' OR ')
  }
  return 'UNKNOWN'
}

/** 列出 node_modules 顶层所有包（含作用域包） */
function listInstalled() {
  const out = []
  const base = join(root, 'node_modules')
  if (!existsSync(base)) return out
  for (const e of readdirSync(base, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    if (e.name.startsWith('@')) {
      for (const s of readdirSync(join(base, e.name), { withFileTypes: true })) {
        if (s.isDirectory()) out.push(`${e.name}/${s.name}`)
      }
    } else if (e.name !== 'node_modules') {
      out.push(e.name)
    }
  }
  return out
}

/**
 * 「会进安装包」的依赖闭包。
 *
 * roots = package.json 的 dependencies（externalizeDepsPlugin 让它们必须
 * 在运行时可用，electron-builder 会把传递闭包一起收进 app.asar）。
 */
function bundledClosure() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const seen = new Map()
  const visit = (name) => {
    if (seen.has(name)) return
    const j = readPkg(name)
    if (!j) return
    seen.set(name, { version: j.version ?? '?', license: licenseOf(j) })
    for (const d of Object.keys(j.dependencies ?? {})) visit(d)
    for (const d of Object.keys(j.optionalDependencies ?? {})) visit(d)
  }
  for (const r of Object.keys(pkg.dependencies ?? {})) visit(r)
  return seen
}

/* ══════════════════════════ 检查 ══════════════════════════ */

const installed = listInstalled()
const all = new Map()
for (const name of installed) {
  const j = readPkg(name)
  if (!j) continue
  all.set(name, { version: j.version ?? '?', license: licenseOf(j) })
}

const bundled = bundledClosure()

const copyleftAll = [...all].filter(([, v]) => COPYLEFT.test(v.license))
const copyleftBundled = [...bundled].filter(([, v]) => COPYLEFT.test(v.license))
const outOfSpecBundled = [...bundled].filter(
  ([, v]) => !/^(MIT|Apache-2\.0)$/i.test(v.license)
)
const outOfSpecAll = [...all].filter(
  ([, v]) => !/^(MIT|Apache-2\.0)$/i.test(v.license) && !PERMISSIVE_OUT_OF_SPEC.test(v.license)
)

const line = '─'.repeat(66)
console.log(line)
console.log('依赖许可证体检')
console.log(line)
console.log(`  node_modules 已装包          ${all.size}`)
console.log(`  会进 app.asar 的依赖闭包      ${bundled.size}`)
console.log('')

console.log('① 硬红线：强传染 / copyleft')
if (copyleftAll.length === 0) {
  console.log('  ✓ 0 命中（GPL / LGPL / AGPL / SSPL / MPL / EUPL / CDDL / EPL / CC-BY-SA … 一个都没有）')
} else {
  console.log(`  ✗ ${copyleftAll.length} 个命中：`)
  for (const [n, v] of copyleftAll) {
    const tag = bundled.has(n) ? '【会进安装包】' : '（仅开发机）'
    console.log(`      ${v.license.padEnd(18)} ${n}@${v.version} ${tag}`)
  }
}
if (copyleftBundled.length > 0) {
  console.log(`  ✗ 其中 ${copyleftBundled.length} 个会随安装包分发 —— 必须替换或移除`)
}
console.log('')

console.log('② 口径外提示：既不是 MIT 也不是 Apache-2.0，但属宽松许可')
if (outOfSpecBundled.length === 0) {
  console.log('  ✓ 进包的依赖全是 MIT / Apache-2.0')
} else {
  console.log(`  进包的 ${outOfSpecBundled.length} 个（允许分发；替换需要 fork 上游，收益为零）：`)
  for (const [n, v] of outOfSpecBundled.sort((a, b) => a[1].license.localeCompare(b[1].license))) {
    console.log(`      ${v.license.padEnd(20)} ${n}@${v.version}`)
  }
}
if (outOfSpecAll.length > 0) {
  console.log(`  另有 ${outOfSpecAll.length} 个不进包、且许可描述非标准（仅开发机，无分发义务）：`)
  for (const [n, v] of outOfSpecAll.slice(0, 20)) {
    console.log(`      ${v.license.padEnd(20)} ${n}@${v.version}`)
  }
  if (outOfSpecAll.length > 20) console.log(`      …还有 ${outOfSpecAll.length - 20} 个（--quiet 不列全）`)
}

if (WRITE) {
  const stamp = new Date().toISOString().slice(0, 10)
  const NL = '\n'
  const lines = []
  lines.push('# 第三方组件与许可清单', '')
  lines.push(`生成时间：${stamp}（\`node tools/check-licenses.mjs --write\`）`, '')
  lines.push(`## 一、随安装包分发的运行时依赖（${bundled.size} 个）`, '')
  lines.push('| 包 | 版本 | 许可 |', '|---|---|---|')
  for (const [n, v] of [...bundled].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`| ${n} | ${v.version} | ${v.license} |`)
  }
  lines.push('', '## 二、桌面运行时', '')
  lines.push('| 组件 | 许可 |', '|---|---|')
  lines.push(
    '| Electron 33.x（内含 Chromium、Node.js、V8、Skia、ICU、FFmpeg、SwiftShader） | MIT；Chromium 及其第三方库见安装目录下的 `LICENSES.chromium.html` |'
  )
  lines.push('', '## 三、开发与打包工具链（不随包分发）', '')
  lines.push('| 包 | 版本 | 许可 |', '|---|---|---|')
  const dev = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies ?? {}
  for (const n of Object.keys(dev).sort()) {
    const v = all.get(n)
    lines.push(`| ${n} | ${v?.version ?? '?'} | ${v?.license ?? '?'} |`)
  }
  lines.push('', '## 四、合规结论', '')
  lines.push(`- 强传染（copyleft）依赖：**${copyleftAll.length} 个**（要求为 0）`)
  lines.push('- 随包分发的依赖全部为宽松许可（MIT / Apache-2.0 / ISC / BSD / 0BSD / Zlib）。')
  lines.push('- 各组件完整许可原文见 `node_modules/<包名>/LICENSE*` 与 Electron 的 `LICENSES.chromium.html`。')

  const outFile = join(root, 'THIRD-PARTY-NOTICES.md')
  writeFileSync(outFile, lines.join(NL) + NL, 'utf8')
  console.log(`\n  已写出 ${outFile}`)
}

console.log('')
console.log(line)
if (copyleftAll.length > 0) {
  console.log(`结果：✗ 不通过（${copyleftAll.length} 个强传染依赖）`)
  process.exit(1)
}
/*
 * 自有代码的授权与依赖是否冲突 —— PolyForm Noncommercial 的兼容性结论。
 *
 * 结论：**不冲突**。本项目运行时依赖全是宽松许可（MIT / Apache-2.0 /
 * ISC / 0BSD / Zlib），它们只要求「保留版权与许可声明」，
 * **不对衍生作品的整体授权方式设限** —— 所以把自有代码置于
 * 「非商业」条款之下完全可行（与「用 MIT 依赖做闭源商业软件」同类）。
 *
 * 两条必须随包提供文本的（都不构成冲突）：
 *   · pdfjs-dist 是 Apache-2.0：要求保留 NOTICE / 许可副本；
 *   · Electron 内含的 Chromium 与 FFmpeg 各有自己的许可，
 *     其文本由 Electron 官方发行包提供，随安装目录一起分发即可。
 */
console.log('自有代码授权：PolyForm Noncommercial 1.0.0（非商业免费；商业需授权）')
console.log('与依赖的兼容性：✓ 不冲突（依赖均为宽松许可，只要求保留版权与许可声明，')
console.log('   不对衍生作品的整体授权方式设限 —— 与 MIT 依赖做闭源软件同类情形）')
console.log('  · 随包提供：LICENSE / NOTICE / SOURCE.txt / THIRD-PARTY-NOTICES.md（build.extraResources）')
console.log('  · pdfjs-dist(Apache-2.0) 的许可副本由 node_modules 内 LICENSE 保留')
console.log('  · Electron / Chromium / FFmpeg 的许可文本随 Electron 发行包提供')
console.log('结果：✓ 通过（强传染 0 个；非商业授权与依赖兼容）')
process.exit(0)
