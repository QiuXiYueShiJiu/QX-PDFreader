// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 解析 Qt .qm 翻译文件，提取界面文字清单。
 *
 * ── 为什么需要这个 ────────────────────────────────────────────
 * 鸿合 π6 启动后停在登录页，不登录进不去功能界面，
 * 没法像正常软件那样逐一点着看。
 * 但它的界面文字全部编在 Qt 翻译文件里，解析出来等于拿到
 * 一份完整功能清单 —— 比点界面还全（含二级菜单与提示语）。
 *
 * ── .qm 二进制格式 ────────────────────────────────────────────
 *   0x00  magic 0x3CB86418（大端）
 *   0x04  format version
 *   0x08  之后是 5 个 section 的 { length, offset }（各 4 字节大端）：
 *           [0] Contexts  [1] Hashes  [2] Messages  [3] Numerus  [4] Dependencies
 *
 *   Messages section 里连续存放消息块：
 *     u32 blockLen
 *     u8[8] 节点头
 *     [ u32 strLen + UTF-16BE 字符串 ] × 3   → Context / Source / Translation
 *     其余是哈希与偏移等元数据
 *
 * ★ 关键点：字符串是 **UTF-16BE**。
 *   Node 的 Buffer.toString('utf16le') 读出来是乱码，
 *   必须按大端手工组码元。之前就是因为这个把 "MainWhiteboard"
 *   读成了「汁桰扡瑥」，白折腾了几轮。
 *
 * 用法：
 *   node tools/parse-qm.mjs <文件或目录> [--out 输出文件] [--verbose]
 */

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const argv = process.argv.slice(2)
const target = argv[0]
if (!target) {
  console.error('用法: node tools/parse-qm.mjs <文件或目录> [--out 输出文件] [--verbose]')
  process.exit(1)
}
const outIdx = argv.indexOf('--out')
const outPath = outIdx >= 0 ? argv[outIdx + 1] : ''
const verbose = argv.includes('--verbose')

const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0

/** 按 UTF-16BE 解码一段字节 */
function decodeUtf16Be(buf, start, len) {
  const chars = []
  for (let i = 0; i + 1 < len; i += 2) {
    chars.push(String.fromCharCode((buf[start + i] << 8) | buf[start + i + 1]))
  }
  return chars.join('')
}

/** 解析一个 .qm，返回 { context, source, translation }[] */
function parseQm(buf) {
  const magic = u32(buf, 0)
  if (magic !== 0x3cb86418) {
    throw new Error(`魔数不匹配: 0x${magic.toString(16)}`)
  }

  const sections = []
  for (let i = 0; i < 5; i++) {
    sections.push({ len: u32(buf, 8 + i * 8), off: u32(buf, 12 + i * 8) })
  }

  const msg = sections[2]
  if (!msg.len || !msg.off || msg.off >= buf.length) {
    throw new Error(`Messages section 非法: off=${msg.off} len=${msg.len}`)
  }

  const end = Math.min(buf.length, msg.off + msg.len)
  const out = []
  let p = msg.off

  while (p + 4 <= end) {
    const blockLen = u32(buf, p)
    if (blockLen === 0 || p + 4 + blockLen > end) break

    // 节点头 8 字节，之后依次是 Context / Source / Translation
    let q = p + 4 + 8
    const blockEnd = p + 4 + blockLen
    const parts = []

    for (let n = 0; n < 3; n++) {
      if (q + 4 > blockEnd) break
      const slen = u32(buf, q)
      q += 4
      // 0xffffffff 表示该部分不存在（常见于无 Context 的条目）
      if (slen === 0xffffffff) {
        parts.push('')
        continue
      }
      if (q + slen > blockEnd) break
      parts.push(decodeUtf16Be(buf, q, slen))
      q += slen
    }

    if (parts.length >= 3) {
      out.push({ context: parts[0], source: parts[1], translation: parts[2] })
    }

    p += 4 + blockLen
  }

  return out
}

function collectQm(t) {
  const st = statSync(t)
  if (st.isFile()) return [t]
  const found = []
  for (const name of readdirSync(t)) {
    const full = join(t, name)
    const s = statSync(full)
    if (s.isDirectory()) found.push(...collectQm(full))
    else if (name.toLowerCase().endsWith('.qm')) found.push(full)
  }
  return found
}

const files = collectQm(target)
console.log(`找到 ${files.length} 个 .qm 文件\n`)

const all = []
for (const f of files) {
  try {
    const items = parseQm(readFileSync(f))
    console.log(`  ${basename(f)}: ${items.length} 条`)
    all.push(...items.map((it) => ({ ...it, file: basename(f) })))
  } catch (e) {
    console.log(`  ${basename(f)}: 失败 - ${e instanceof Error ? e.message : e}`)
  }
}

/* 只保留有中文译文的（source 常是英文标识符，译文才是给人看的） */
const seen = new Set()
const unique = []
for (const it of all) {
  const text = it.translation || it.source
  if (!text) continue
  if (seen.has(text)) continue
  seen.add(text)
  unique.push(it)
}

console.log(`\n合计 ${all.length} 条，去重后 ${unique.length} 条`)

if (outPath) {
  const abs = resolve(root, outPath)
  mkdirSync(dirname(abs), { recursive: true })

  const byCtx = new Map()
  for (const it of unique) {
    const c = it.context || '(无上下文)'
    if (!byCtx.has(c)) byCtx.set(c, [])
    byCtx.get(c).push(it.translation || it.source)
  }

  const lines = []
  for (const [ctx, items] of byCtx) {
    lines.push(`## ${ctx}`)
    for (const s of items) lines.push(s)
    lines.push('')
  }
  writeFileSync(abs, lines.join('\n'), 'utf8')
  console.log(`已写入 ${abs}`)
}

if (verbose) {
  console.log('\n--- 全部条目 ---')
  for (const it of unique) console.log(`  [${it.context}] ${it.translation || it.source}`)
}
