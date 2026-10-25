// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 打「GitHub 首发包」：干净、可公开的源码 + 一张 README + 截图 + 示例 PDF + 公开版安装包。
 *
 * ── 为什么单独一个脚本 ──────────────────────────────────────
 * 交付包（make-delivery-zip.mjs）是给「接手这个工程的人」的，里面有内部文档、
 * 交付报告、三个安装包（含静默部署版）。这些**不能**上公开仓库：
 *   · `build/packaging.json` 里是单位名、本地安装目录、静默部署版校验值；
 *   · `tools/archive/` 是历史脚本，写着旧的内部路径；
 *   · 静默部署版安装包带内置校验值，公开分发等于把校验值撒出去。
 * 所以这里用白名单 + 文本脱敏，最后跑一遍关键词自检，命中就**不产出 zip**。
 *
 * 用法：node scripts\make-github-package.mjs
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = process.env.REPO_ROOT ?? process.cwd()
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const buildVersion = pkg.buildVersion ?? pkg.version
const NAME = `秋夕-PDF阅读器-${buildVersion}-GitHub首发包`
const OUT_ROOT = process.env.GH_PKG_DIR ?? join(ROOT, '..', '_ghpkg')
const STAGE = join(OUT_ROOT, NAME)

/* ---------- 白名单：公开仓库里该有什么 ---------- */
const ROOT_FILES = [
  '.gitignore',
  '.npmrc',
  'LICENSE',
  'NOTICE',
  'SOURCE.txt',
  'THIRD-PARTY-NOTICES.md',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.node.json',
  'tsconfig.web.json',
  'electron.vite.config.ts'
]

/** tools 里给贡献者用的：验证套件 + CDP 小工具 + 夹具生成 */
const TOOL_KEEP = [
  /^verify-.*\.mjs$/,
  /^run-verify-suite\.mjs$/,
  /^bundle-markers\.mjs$/,
  /^check-licenses\.mjs$/,
  /^keep-frames\.mjs$/,
  /^cdp-.*\.mjs$/,
  /^foreground-snapshot\.ps1$/,
  /^_guard-foreground\.ps1$/,
  /^mk-fixture.*\.mjs$/
]

/** scripts 里给贡献者用的：构建、版本、资源拷贝、打包 */
const SCRIPT_KEEP = [
  /^build-installers\.mjs$/,
  /^build-setup\.mjs$/,
  /^after-pack\.mjs$/,
  /^set-version\.mjs$/,
  /^copy-pdf-worker\.mjs$/,
  /^copy-ocr-assets\.mjs$/,
  /^inject-dpi-manifest\.mjs$/,
  /^packaging-paths\.mjs$/,
  /^make-delivery-zip\.mjs$/,
  /^rename-app\.mjs$/
]

/** 文本脱敏：内部路径 / 单位名 / 用户名 / 私有输出目录 */
const REPLACEMENTS = [
  [/学校/g, '示例单位'],
  /*
   * 反斜杠与正斜杠两种写法都算，且允许出现「双反斜杠」（JS 字符串里常见），
   * 所以分隔符写成 [\\/]{1,2}，否则会漏掉一半路径。
   */
  [/[A-Za-z]:[\\/]{1,2}Program Files[\\/]{1,2}QiuXiPDFReader/gi, '<install-dir>'],
  [/[A-Za-z]:[\\/]{1,2}(?:Users)[\\/]{1,2}[^"'\s)]*/gi, '~'],
  [/[A-Za-z]:[\\/]{1,2}[^"'\s)]*[\\/]{1,2}(?:dist-installer|release)[\\/]{1,2}/gi, '<dist>\\'],
  [/Administrator/gi, 'user'],
  [/QX-[0-9a-f]{32}/g, 'QX-REPLACE-ME']
]

const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|json|md|txt|css|html|yml|yaml|nsh|in|ps1)$/i

function sanitize(file) {
  if (!TEXT_EXT.test(file)) return
  const before = readFileSync(file, 'utf8')
  let after = before
  for (const [re, to] of REPLACEMENTS) after = after.replace(re, to)
  if (after !== before) writeFileSync(file, after, 'utf8')
}

function copyTree(from, to, filter, skipDirs = []) {
  if (!existsSync(from)) return
  mkdirSync(to, { recursive: true })
  for (const name of readdirSync(from)) {
    const src = join(from, name)
    const dst = join(to, name)
    const st = statSync(src)
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'test-results' || name === '.git') continue
      if (skipDirs.includes(name)) continue
      copyTree(src, dst, filter, skipDirs)
      continue
    }
    if (filter && !filter(name)) continue
    mkdirSync(dirname(dst), { recursive: true })
    cpSync(src, dst)
    sanitize(dst)
  }
}

/* ---------- 1. 清空 staging ---------- */
rmSync(STAGE, { recursive: true, force: true })
mkdirSync(STAGE, { recursive: true })

/* ---------- 2. 根文件 ---------- */
for (const f of ROOT_FILES) {
  const src = join(ROOT, f)
  if (!existsSync(src)) {
    console.log(`  [warn] 缺根文件：${f}`)
    continue
  }
  cpSync(src, join(STAGE, f))
  sanitize(join(STAGE, f))
}

/* README：公开仓库首页用 GitHub 版；发布指引改名去掉「GitHub」后缀 */
cpSync(join(ROOT, 'README.github.md'), join(STAGE, 'README.md'))
sanitize(join(STAGE, 'README.md'))
cpSync(join(ROOT, '发布指引-GitHub.md'), join(STAGE, '发布指引.md'))
sanitize(join(STAGE, '发布指引.md'))

/* ---------- 3. 源码 / 夹具 / 工具 / 脚本 ---------- */
copyTree(join(ROOT, 'src'), join(STAGE, 'src'))
copyTree(join(ROOT, 'tests'), join(STAGE, 'tests'))
copyTree(join(ROOT, 'tools'), join(STAGE, 'tools'), (n) => TOOL_KEEP.some((re) => re.test(n)), ['archive'])
copyTree(join(ROOT, 'scripts'), join(STAGE, 'scripts'), (n) => SCRIPT_KEEP.some((re) => re.test(n)))

/* ---------- 4. build：图标 + 中性交付参数 ---------- */
mkdirSync(join(STAGE, 'build'), { recursive: true })
for (const f of ['icon.ico', 'pdf-file.ico', 'installer.nsh.in']) {
  const src = join(ROOT, 'build', f)
  if (existsSync(src)) {
    cpSync(src, join(STAGE, 'build', f))
    sanitize(join(STAGE, 'build', f))
  }
}
writeFileSync(
  join(STAGE, 'build', 'packaging.json'),
  `${JSON.stringify(
    {
      _comment: '公开仓库里的中性示例：单位/目录/包名请按需改。真实交付值不要提交。',
      installDir: 'C:\\Program Files\\QiuXiPDFReader',
      legacyInstallDirs: [],
      quickArtifactName: 'PDF阅读器-快速安装.${ext}',
      artifactName: '秋夕-PDF阅读器-${buildVersion}-安装程序.${ext}',
      legal: {
        site: '秋夕月拾旧.top',
        publisher: '秋夕月拾旧',
        notice:
          '本项目以 PolyForm Noncommercial License 1.0.0 授权：非商业用途免费；商业用途需另行授权。',
        standard: { org: '', usageScope: '', support: '' },
        quick: { org: '', usageScope: '', support: '' },
        special: { org: '', usageScope: '', support: '' }
      }
    },
    null,
    2
  )}\n`,
  'utf8'
)

/* ---------- 5. 文档：截图 + 示例 PDF（不带内部项目文档） ---------- */
copyTree(join(ROOT, 'docs', 'screenshots'), join(STAGE, 'docs', 'screenshots'))
const samplePdf = join(ROOT, 'docs', '示例文档.pdf')
if (existsSync(samplePdf)) {
  mkdirSync(join(STAGE, 'docs'), { recursive: true })
  cpSync(samplePdf, join(STAGE, 'docs', '示例文档.pdf'))
}

/* ---------- 6. 安装包：只放公开标准版 ---------- */
const setup = `秋夕-PDF阅读器-${buildVersion}-安装程序.exe`
const releaseDir = process.env.PDF_RELEASE_DIR ?? pkg.build?.directories?.output ?? 'dist-installer'
const setupPath = join(releaseDir, setup)
mkdirSync(join(STAGE, '安装包'), { recursive: true })
if (existsSync(setupPath)) {
  cpSync(setupPath, join(STAGE, '安装包', setup))
  console.log(`  安装包：${setup}（${statSync(setupPath).size} 字节）`)
} else {
  console.log(`  [warn] 缺标准版安装包：${setup}`)
}

/* ---------- 7. 隐私自检 ---------- */
const FORBIDDEN = [/[A-Za-z]:[\\/]{1,2}(?:Users|Program Files)/, /Administrator/, /QX-[0-9a-f]{32}/]
const hits = []
function scan(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      scan(p)
      continue
    }
    if (!TEXT_EXT.test(p)) continue
    const text = readFileSync(p, 'utf8')
    for (const re of FORBIDDEN) {
      const m = text.match(re)
      if (m) hits.push(`${relative(STAGE, p)} → ${m[0]}`)
    }
  }
}
scan(STAGE)
if (hits.length) {
  console.error(`★ 隐私自检失败：${hits.length} 处命中`)
  for (const h of hits.slice(0, 20)) console.error(`   ${h}`)
  process.exit(1)
}

/* ---------- 8. 打 zip（条目用反斜杠，与历史交付包一致） ---------- */
const zip = join(OUT_ROOT, `${NAME}.zip`)
rmSync(zip, { force: true })
execFileSync(
  'powershell',
  [
    '-NoProfile',
    '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory('${STAGE.replace(/\//g, '\\')}','${zip.replace(/\//g, '\\')}',[IO.Compression.CompressionLevel]::Optimal,$false)`
  ],
  { stdio: 'inherit' }
)

const hash = execFileSync(
  'powershell',
  [
    '-NoProfile',
    '-Command',
    `(Get-FileHash -LiteralPath '${zip.replace(/\//g, '\\')}' -Algorithm SHA256).Hash`
  ],
  { encoding: 'utf8' }
).trim()
writeFileSync(`${zip}.sha256`, `${hash}  ${NAME}.zip\n`, 'utf8')

console.log(`\nGitHub 首发包：${zip}`)
console.log(`${statSync(zip).size} 字节 / ${(statSync(zip).size / 1024 / 1024).toFixed(2)} MB`)
console.log(`SHA256 ${hash}`)
