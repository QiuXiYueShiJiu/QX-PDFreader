import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const roots = ['src', 'scripts', 'tools']
const publicDocs = ['README.github.md', '快速开始.txt', 'package.json', 'SOURCE.txt', 'NOTICE']
const exts = /\.(md|ts|tsx|mjs|js|json|txt|nsh|in|html|css)$/
const skip = /(^tools[\\/]_|tools[\\/]archive|check-privacy|packaging-paths|verify-quit-dialog)/
const files = [...publicDocs]
const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p) } else if (exts.test(e.name) && !skip.test(p)) files.push(p) } }
for (const r of roots) walk(r)
const bad = [
  [new RegExp('\u7279\u4f9b', 'g'), '\u7279\u4f9b'],
  [new RegExp('\u6cf0\u5b89\u4e8c\u4e2d', 'g'), '\u6821\u540d'],
  [/QX-6b2a/gi, '\u4ee4\u724c']
]
let fail = 0
for (const f of files) {
  let s; try { s = readFileSync(f, 'utf8') } catch { continue }
  const hits = []
  for (const [re, n] of bad) { const m = s.match(re); if (m) hits.push(`${n}×${m.length}`) }
  if (hits.length) { fail++; console.log(`✗ ${f}: ${hits.join(' ')}`) }
}
console.log(fail ? `FAIL ${fail}` : `OK ${files.length} 个公开文件干净`)
