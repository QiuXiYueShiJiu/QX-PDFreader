// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 把 pdf.js 的 worker 文件复制到渲染层的 public 目录。
 *
 * 为什么需要这一步：
 *   pdf.js 必须靠 Worker 解析文档（否则大文件解析会卡死界面）。
 *   Vite 不会自动处理 node_modules 里这个 .mjs worker，
 *   而运行时用 CDN 或相对路径又不可靠（打包后路径会变）。
 *   最稳的做法是在构建前把它复制进 public/，运行时用绝对路径
 *   `/pdf.worker.min.mjs` 加载 —— 开发态与打包态路径一致。
 *
 * 由 package.json 的 prebuild 钩子调用。
 */

import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const candidates = [
  join(root, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs'),
  join(root, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.mjs')
]

const target = join(root, 'src', 'renderer', 'public', 'pdf.worker.min.mjs')

const source = candidates.find((p) => existsSync(p))

if (!source) {
  console.error('未找到 pdf.js worker 文件，请先执行 npm install')
  console.error('已尝试：')
  for (const c of candidates) console.error('  ' + c)
  process.exit(1)
}

mkdirSync(dirname(target), { recursive: true })
copyFileSync(source, target)

const kb = Math.round(statSync(target).size / 1024)
console.log(`  [worker] 已复制 pdf.js worker → src/renderer/public/pdf.worker.min.mjs (${kb} KB)`)
