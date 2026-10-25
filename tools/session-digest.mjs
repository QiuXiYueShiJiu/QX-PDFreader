// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

// Summarize a DSH session transcript (plain JSONL, decoded from .jsonl.zstd) into a compact digest.
// Usage: node tools/session-digest.mjs <session.jsonl> <out.md> [--users N] [--text N] [--tools N] [--tailMs N]
import { createReadStream, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const src = process.argv[2]
const dest = process.argv[3] || 'session-digest.md'
const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? Number(process.argv[i + 1]) : dflt
}
const MAX_USERS = argOf('--users', 60)
const MAX_TEXT = argOf('--text', 80)
const MAX_TOOLS = argOf('--tools', 30)
const TEXT_CHARS = argOf('--chars', 1500)
const TAIL_MS = argOf('--tailMs', 0)

const rl = createInterface({ input: createReadStream(src), crlfDelay: Infinity })

const users = []
const texts = []
const tools = []
const goals = []
const todos = []
let lastTime = 0
let n = 0

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => {
      if (typeof c === 'string') return c
      if (!c || typeof c !== 'object') return ''
      if (typeof c.text === 'string') return c.type === 'reasoning' ? '' : c.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

for await (const line of rl) {
  if (!line.trim()) continue
  n++
  let o
  try {
    o = JSON.parse(line)
  } catch {
    continue
  }
  if (typeof o.time === 'number') lastTime = o.time
  const d = o.data || {}
  switch (o.type) {
    case 'user/message': {
      const t = textOf(d.content)
      if (t.trim()) users.push({ seq: o.seq, time: o.time, t })
      break
    }
    case 'assistant/message': {
      const t = textOf(d.message?.content)
      if (t.trim()) texts.push({ seq: o.seq, time: o.time, t })
      break
    }
    case 'tool/call': {
      tools.push({ seq: o.seq, time: o.time, t: `${d.name || d.toolName || '?'} ${JSON.stringify(d.arguments ?? d.args ?? {}).slice(0, 300)}` })
      break
    }
    case 'goal/change':
      goals.push({ seq: o.seq, time: o.time, t: JSON.stringify(d).slice(0, 500) })
      break
    case 'todo/write':
      todos.push({ seq: o.seq, time: o.time, t: JSON.stringify(d).slice(0, 1500) })
      break
    default:
      break
  }
}

const cutoff = TAIL_MS > 0 ? lastTime - TAIL_MS : 0
const inTail = (x) => x.time >= cutoff
const stamp = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19)

const out = []
out.push(`# session digest: ${src}`)
out.push(`lines=${n} lastTime=${stamp(lastTime)} users=${users.length} assistantTexts=${texts.length} toolCalls=${tools.length} windowStart=${cutoff ? stamp(cutoff) : 'ALL'}`)

if (goals.length) {
  out.push(`\n## GOAL CHANGES (${goals.length})`)
  for (const g of goals) out.push(`- [${stamp(g.time)}] seq${g.seq} ${g.t}`)
}

out.push(`\n## USER MESSAGES (${users.filter(inTail).length} in window)`)
for (const u of users.filter(inTail).slice(-MAX_USERS)) out.push(`\n--- ${stamp(u.time)} seq${u.seq} ---\n${u.t.slice(0, 4000)}`)

out.push(`\n## ASSISTANT TEXT (${texts.filter(inTail).length} in window, last ${MAX_TEXT})`)
for (const a of texts.filter(inTail).slice(-MAX_TEXT)) out.push(`\n--- ${stamp(a.time)} seq${a.seq} ---\n${a.t.slice(0, TEXT_CHARS)}`)

out.push(`\n## TOOL CALLS (last ${MAX_TOOLS} of ${tools.filter(inTail).length})`)
for (const t of tools.filter(inTail).slice(-MAX_TOOLS)) out.push(`- [${stamp(t.time)}] seq${t.seq} ${t.t}`)

out.push(`\n## TODO WRITES (last 12 of ${todos.length})`)
for (const t of todos.slice(-12)) out.push(`\n--- ${stamp(t.time)} seq${t.seq} ---\n${t.t}`)

writeFileSync(dest, out.join('\n'), 'utf8')
console.log(`wrote ${dest}; users=${users.length} texts=${texts.length} tools=${tools.length} lines=${n}`)
