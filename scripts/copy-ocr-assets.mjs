// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 把 OCR 运行时资源复制到渲染层的 public 目录（v2.1.3）。
 *
 * 为什么要复制而不是直接从 node_modules 引用：
 *   `src/renderer/public/**` 会被 Vite 原样搬到 `out/renderer/**`，
 *   开发态（http://localhost）与打包态（file://…/app.asar/out/renderer）
 *   的相对路径完全一致 —— worker / core / 语言包都按同一个相对地址加载。
 *   直接 import 只会把 JS 打进 bundle，worker 脚本与 wasm 仍然要落在磁盘上。
 *
 * 语言包（chi_sim / eng）体积较大且来自 tessdata_fast（Apache-2.0），
 * 不在 npm 依赖里，必须已经放在 public/ocr/lang 下；缺失时这里只告警不失败，
 * 让构建继续（没有语言包时 OCR 会报错，但阅读器主体不受影响）。
 */

import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'src', 'renderer', 'public', 'ocr')
const langDir = join(outDir, 'lang')

const ASSETS = [
  /* worker 脚本：tesseract.js 会把它作为 Worker 入口加载 */
  ['node_modules/tesseract.js/dist/worker.min.js', 'worker.min.js'],
  /*
   * core（wasm 胶水）：优先 SIMD+LSTM；再留一份非 SIMD LSTM 兜底。
   * 选 LSTM 变体是因为我们用 OEM=1（只跑 LSTM 引擎），
   * 传统的 legacy 引擎用不上，能省一半体积。
   */
  ['node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'],
  ['node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm.js']
]

mkdirSync(langDir, { recursive: true })

let copied = 0
for (const [from, to] of ASSETS) {
  const src = join(root, from)
  if (!existsSync(src)) {
    console.warn(`  [ocr] 缺少资源：${from}`)
    continue
  }
  copyFileSync(src, join(outDir, to))
  copied++
  console.log(`  [ocr] ${to}  ${(statSync(join(outDir, to)).size / 1024).toFixed(0)} KB`)
}

for (const lang of ['chi_sim', 'eng']) {
  const file = join(langDir, `${lang}.traineddata`)
  if (!existsSync(file)) {
    console.warn(
      `  [ocr] 缺少语言包 ${lang}.traineddata（应放在 src/renderer/public/ocr/lang/）—— ` +
        `OCR 会不可用，但阅读器其他功能不受影响`
    )
  } else {
    console.log(`  [ocr] lang/${lang}.traineddata  ${(statSync(file).size / 1024 / 1024).toFixed(1)} MB`)
  }
}

console.log(`  [ocr] 已复制 ${copied} 个运行时资源 → src/renderer/public/ocr`)
