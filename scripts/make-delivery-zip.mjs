/**
 * 打「交付包」zip。
 *
 * 用法：node scripts\make-delivery-zip.mjs
 *
 * 结构（与历次交付包一致）：
 *   秋夕-PDF阅读器-<版本>-交付包\
 *     ├─ 安装包\            标准版 / 快速版 / 静默部署版（静默部署版不得公开分发）
 *     ├─ src\ tools\ scripts\ docs\ build\tests\ out\
 *     └─ 根文档 + package.json / package-lock.json / 配置 / 授权文件
 *
 * 排除：node_modules、test-results、dist、.git、临时探针（tools\_*.mjs）。
 * 条目分隔符是反斜杠（用 .NET 的 ZipFile.CreateFromDirectory 生成，与 12.zip 一致，
 * Explorer / Expand-Archive 都能正确解压）。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const buildVersion = pkg.buildVersion ?? `${pkg.version}.0`
const name = `秋夕-PDF阅读器-${buildVersion}-交付包`
const stageRoot = join(root, 'dist-delivery')
const stage = join(stageRoot, name)
const outZip = join(root, '..', `${name}.zip`)

const ROOT_FILES = [
  '.gitignore',
  '.npmrc',
  'electron.vite.config.ts',
  'LICENSE',
  'NOTICE',
  'SOURCE.txt',
  'THIRD-PARTY-NOTICES.md',
  'README.md',
  'package.json',
  'package-lock.json',
  'tsconfig.node.json',
  'tsconfig.web.json',
  `项目文档-${buildVersion}.md`,
  `交接说明-${buildVersion}.md`,
  `交付报告-${buildVersion}.md`,
  '快速开始.txt'
]

const DIRS = ['src', 'tools', 'scripts', 'docs', 'build', 'tests', 'out']
const SKIP_DIRS = new Set(['node_modules', 'test-results', '.git', 'dist', 'dist-delivery', 'win-unpacked'])

/** 交付包里不要的临时/探针文件 */
const skipFile = (rel) => {
  const base = rel.split(/[\\/]/).pop() ?? ''
  return base.startsWith('_') || base.endsWith('.tsbuildinfo')
}

const copyTree = (from, to) => {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const src = join(from, entry.name)
    const dst = join(to, entry.name)
    if (entry.isDirectory()) copyTree(src, dst)
    else if (!skipFile(relative(root, src))) writeFileSync(dst, readFileSync(src))
  }
}

rmSync(stageRoot, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

for (const f of ROOT_FILES) {
  const p = join(root, f)
  if (!existsSync(p)) {
    console.log(`  [warn] 缺文件：${f}`)
    continue
  }
  writeFileSync(join(stage, f), readFileSync(p))
}
for (const d of DIRS) {
  const p = join(root, d)
  if (!existsSync(p)) {
    console.log(`  [warn] 缺目录：${d}`)
    continue
  }
  copyTree(p, join(stage, d))
}

/* 安装包 */
const releaseDir = 'D:\\DSH_Workstation\\PDFrelease'
mkdirSync(join(stage, '安装包'), { recursive: true })
for (const f of [
  `秋夕-PDF阅读器-${buildVersion}-安装程序.exe`,
  'PDF阅读器-学校快速安装.exe',
  /* 静默部署版：带单位声明与内置校验值，只随内部交付走，绝不上公开仓库 */
  `秋夕-PDF阅读器-${buildVersion}-静默部署版安装程序.exe`
]) {
  const p = join(releaseDir, f)
  if (!existsSync(p)) {
    console.log(`  [warn] 缺安装包：${f}`)
    continue
  }
  writeFileSync(join(stage, '安装包', f), readFileSync(p))
  console.log(`  安装包：${f}（${statSync(p).size} 字节）`)
}

/* 用 .NET 打包：条目分隔符为反斜杠，与历次交付包一致 */
rmSync(outZip, { force: true })
execFileSync(
  'powershell',
  [
    '-NoProfile',
    '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory('${stageRoot}', '${outZip}', [IO.Compression.CompressionLevel]::Optimal, $false)`
  ],
  { stdio: 'inherit' }
)

const bytes = statSync(outZip).size
const hash = createHash('sha256').update(readFileSync(outZip)).digest('hex').toUpperCase()
writeFileSync(outZip.replace(/\.zip$/i, '.sha256'), `${hash}  ${name}.zip\r\n`)
rmSync(stageRoot, { recursive: true, force: true })
console.log(`\n交付包：${outZip}`)
console.log(`  ${bytes} 字节 / ${(bytes / 1048576).toFixed(2)} MB`)
console.log(`  SHA256 ${hash}`)
