#!/usr/bin/env node
/* README 自检（发布前必跑）
 *
 * 这两条 2026-10-24 都踩过：
 *   1. 版本发了 1.0.7.0，README 徽章/安装包名还写着 1.0.6.3；
 *   2. 新拍的 28/29 两张图没被 README 引用 —— 不引用等于白拍。
 *
 * 判据：
 *   ① README 里出现的版本号与 package.json 的 buildVersion 一致（徽章 + 安装包文件名）
 *   ② docs/screenshots 里每张图都被引用（无多余），README 引用的图都存在（无缺失）
 *   ③ 没有过期的档位文案（9 档 / 九档）
 *
 * 用法：node tools/check-readme.mjs [README路径]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const readmePath = process.argv[2] ?? join(ROOT, 'README.md')

let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${name}${detail ? ` —— ${detail}` : ''}`)
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`) }
}

if (!existsSync(readmePath)) {
  console.error(`找不到 ${readmePath}`)
  process.exit(1)
}
const readme = readFileSync(readmePath, 'utf8')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const buildVersion = String(pkg.buildVersion ?? '')
const semver = String(pkg.version ?? '')

/* ① 版本号 */
const badge = (readme.match(/version-([\d.]+)-/) || [])[1] ?? ''
check('① README 徽章版本 = package.json buildVersion', badge === buildVersion, `徽章 ${badge || '无'} / buildVersion ${buildVersion}`)

const installerNames = [...new Set([...readme.matchAll(/秋夕-PDF阅读器-([\d.]+)-安装程序\.exe/g)].map((m) => m[1]))]
check('① 安装包文件名里的版本一致', installerNames.every((v) => v === buildVersion), `出现 ${installerNames.join(', ') || '无'}`)

check('① README 含 semver 行（vX.Y.Z）', readme.includes(`v${semver}`) || readme.includes(buildVersion), `semver ${semver}`)

/* ② 截图引用 */
const dir = join(ROOT, 'docs/screenshots')
const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^\d{2}-.+\.png$/.test(f)) : []
const refs = [...new Set([...readme.matchAll(/docs\/screenshots\/([\w.-]+\.png)/g)].map((m) => m[1]))]
const missing = refs.filter((f) => !files.includes(f))
const unused = files.filter((f) => !refs.includes(f))
check('② README 引用的截图都存在', missing.length === 0, missing.length ? `缺 ${missing.join(', ')}` : `引用 ${refs.length} 张`)
check('② 每张截图都被引用（没有白拍的）', unused.length === 0, unused.length ? `未引用 ${unused.join(', ')}` : '全部被引用')

/* ③ 过期文案 */
const stale = /9 档配色|九档配色|9 档内置/.test(readme)
check('③ 没有过期的「9 档」文案', !stale, stale ? '仍出现过期档位' : '干净')

console.log(fail === 0 ? '\n✓ README 自检通过' : `\n✗ README 自检失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
