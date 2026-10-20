// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 从可执行文件里提取界面文字（逆向功能清单）。
 *
 * 为什么用这个办法：
 *   鸿合 π6 启动后停在登录页，不登录进不去功能界面，
 *   没法像正常软件那样点着看。
 *   但它是 Qt 程序，Qt 用 tr() / QStringLiteral 把界面文字
 *   以 **UTF-16LE** 形式编在二进制里 ——
 *   把这些字符串抽出来，等于拿到了一份完整的功能清单，
 *   比点界面还全面（能覆盖二级菜单、提示语等没机会点到的地方）。
 *
 * 提取策略：
 *   扫描 UTF-16LE 序列，挑出「连续的可打印字符」且长度 >= 2 的片段，
 *   再按需过滤（中文、含关键字的、长度合理的）。
 *
 * 用法：
 *   node tools/extract-ui-strings.mjs <exe路径> [--out 文件] [--filter 关键字]
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const argv = process.argv.slice(2)
const exePath = argv[0]
if (!exePath) {
  console.error('用法: node tools/extract-ui-strings.mjs <exe路径> [--out 文件] [--filter 关键字]')
  process.exit(1)
}

function opt(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const outPath = opt('out', '')
const filterWord = opt('filter', '')

const buf = readFileSync(exePath)
console.log(`读取 ${exePath}（${(buf.length / 1024 / 1024).toFixed(1)} MB）`)

/**
 * 从二进制里抽 UTF-16LE 字符串。
 *
 * 判定「可打印」的范围放宽到：
 *   基本拉丁、拉丁补充、CJK 统一表意文字、CJK 标点、全角字符、常用符号。
 *   太严会漏掉大量中文，太松会把二进制垃圾也当成字符串。
 */
function isPrintable(code) {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return true
  if (code >= 0x20 && code <= 0x7e) return true // ASCII 可打印
  if (code >= 0xa0 && code <= 0x24f) return true // 拉丁扩展
  if (code >= 0x2000 && code <= 0x206f) return true // 常用标点
  if (code >= 0x3000 && code <= 0x303f) return true // CJK 标点
  if (code >= 0x4e00 && code <= 0x9fff) return true // CJK 汉字
  if (code >= 0xff00 && code <= 0xffef) return true // 全角
  if (code >= 0x2100 && code <= 0x21ff) return true // 字母式符号
  if (code >= 0x2460 && code <= 0x24ff) return true // 带圈字符
  return false
}

const found = []
let current = []

for (let i = 0; i + 1 < buf.length; i += 2) {
  const code = buf.readUInt16LE(i)
  if (isPrintable(code) && code !== 0) {
    current.push(code)
  } else {
    if (current.length >= 2) {
      found.push(String.fromCharCode(...current))
    }
    current = []
  }
}
if (current.length >= 2) found.push(String.fromCharCode(...current))

console.log(`初步抽出 ${found.length} 条字符串`)

/* ---------- 过滤 ---------- */

/** 至少含一个汉字 */
const hasCJK = (s) => /[\u4e00-\u9fff]/.test(s)

/**
 * 像界面文字的字符串。
 *
 * 排除纯符号、纯数字、像路径或 GUID 的 ——
 * 那些是资源标识，不是给人看的按钮文字。
 */
function looksLikeUI(s) {
  const t = s.trim()
  if (t.length < 2 || t.length > 40) return false
  if (!hasCJK(t) && !/^[A-Z][a-zA-Z ]{2,}$/.test(t)) return false
  if (/^[\\/]/.test(t)) return false
  if (/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(t)) return false
  if (/^[\d\s.,:;()（）\-—_=+*/\\|<>[\]{}#@!?~`'"%&^$]+$/.test(t)) return false
  if (/\.(dll|exe|png|jpg|svg|json|ini|xml|dat|db|ttf|qml|js|css)$/i.test(t)) return false
  return true
}

const uiStrings = [...new Set(found.map((s) => s.trim()).filter(looksLikeUI))]
console.log(`过滤后剩 ${uiStrings.length} 条界面文字`)

const result = filterWord ? uiStrings.filter((s) => s.includes(filterWord)) : uiStrings

if (outPath) {
  const abs = resolve(root, outPath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, result.join('\n'), 'utf8')
  console.log(`已写入 ${abs}（${result.length} 条）`)
}

/* 按长度排序输出，短的更像按钮标签 */
console.log('\n--- 前 80 条（按长度升序，短的通常是按钮文字）---')
for (const s of [...result].sort((a, b) => a.length - b.length).slice(0, 80)) {
  console.log('  ' + s)
}
