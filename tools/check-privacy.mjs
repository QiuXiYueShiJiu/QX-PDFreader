// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 公开仓库隐私闸门：发版前跑一遍，命中即失败。
 *
 * 用法：
 *   node tools/check-privacy.mjs                 # 扫默认范围
 *   node tools/check-privacy.mjs src tools       # 只扫指定目录
 *
 * 判据三类（都不写具体名字，避免闸门自己成为泄漏源）：
 *   1. 绝对路径：`D:\…`、`C:\Users\…`、`/home/…`、`/root/…`；
 *   2. 机器/账户痕迹：`Administrator`、`DSH_`；
 *   3. 私有部署标记：`PRIVACY_PATTERNS` 环境变量里的条目（逗号分隔，只在本地运行时提供）。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const roots = process.argv.slice(2).length ? process.argv.slice(2) : ['src', 'scripts', 'tools']
const publicDocs = ['README.md', 'README.github.md', '快速开始.txt', 'package.json', 'SOURCE.txt', 'NOTICE']
const exts = /\.(md|ts|tsx|mjs|js|json|txt|nsh|in|html|css)$/
const skip = /(^tools[\\/]_|tools[\\/]archive|check-privacy|make-github-package)/
const files = [...publicDocs]

const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') walk(p)
    } else if (exts.test(e.name) && !skip.test(p)) files.push(p)
  }
}
for (const r of roots) walk(r)

// 绝对路径只查「像本机开发目录」的写法，不误伤文档里举例用的 <安装目录>
const bad = [
  [/[A-Za-z]:[\\/]{1,2}(?:Users|Documents|Desktop|Projects)[\\/]/g, '绝对路径'],
  [/[A-Za-z]:[\\/]{1,2}[A-Za-z0-9_.-]+[\\/]{1,2}[A-Za-z0-9_.-]+[\\/]{1,2}(?:src|scripts|tools)[\\/]/g, '绝对路径'],
  [/(?:^|[^\w])\/(?:home|root|www)\/[A-Za-z0-9_.-]+\//g, '绝对路径'],
  [/Administrator/g, '账户名'],
  [/DSH_[A-Za-z]+/g, '账户名'],
  ...String(process.env.PRIVACY_PATTERNS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => [new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '私有标记'])
]

let fail = 0
for (const f of files) {
  let s
  try {
    s = readFileSync(f, 'utf8')
  } catch {
    continue
  }
  const hits = []
  for (const [re, name] of bad) {
    const m = s.match(re)
    if (m) hits.push(`${name}×${m.length}`)
  }
  if (hits.length) {
    fail += 1
    console.log(`✗ ${f}: ${hits.join(' ')}`)
  }
}
console.log(fail ? `FAIL ${fail}` : `OK ${files.length} 个公开文件干净`)
process.exit(fail ? 1 : 0)
