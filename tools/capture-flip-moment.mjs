// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 手动工具：抓「翻页那一瞬间」的连续截图。
 *
 * ── 为什么需要它 ────────────────────────────────────────────
 *   翻页相关的抱怨（跳页、闪白、页码先跳后回、双栏错位）都是**一瞬**的事，
 *   用例里的布尔断言看不出来，事后问「当时长什么样」也没法复原。
 *   这个脚本按 60ms 连拍 12 帧，把翻页前后的画面留下来对着看。
 *
 * ── 会动前台吗 ──────────────────────────────────────────────
 *   截图走 CDP 的 Page.captureScreenshot，隐藏窗口也拍得到，**不需要**把窗口
 *   显示出来。但为了防「有人把这一步改成 show 窗口」，仍然加了同一套门禁：
 *   没有显式设置 PDF_READER_ALLOW_FOREGROUND=1 就拒绝执行。
 *
 * 用法：
 *   node tools/capture-flip-moment.mjs [端口] [-n 帧数] [-i 间隔ms]
 *   默认端口 9280、12 帧、60ms；输出到 test-results/flip-moment/<时间戳>/
 *
 * 前置：一个带 --remote-debugging-port=<端口> 的实例（套件起的或手动起的都行）。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

if (process.env.PDF_READER_ALLOW_FOREGROUND !== '1') {
  console.error('[前台门禁] 已拒绝执行：本脚本属于「会动窗口」的一类工具。')
  console.error("  确实需要时先授权：$env:PDF_READER_ALLOW_FOREGROUND = '1'")
  process.exit(97)
}

const args = process.argv.slice(2)
const PORT = Number(args.find((a) => /^\d+$/.test(a)) ?? 9280)
const frames = Number(args[args.indexOf('-n') + 1] > 0 ? args[args.indexOf('-n') + 1] : 12)
const interval = Number(args[args.indexOf('-i') + 1] > 0 ? args[args.indexOf('-i') + 1] : 60)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error(`端口 ${PORT} 上没有可用的 page 目标`)

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('CDP 连接失败'))
  })

  let seq = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
    }
  }
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq
      pending.set(id, { res, rej })
      ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          rej(new Error(`${method} 超时`))
        }
      }, 20000)
    })

  await send('Page.enable')
  await send('Runtime.enable')

  const out = join(root, 'test-results', 'flip-moment', new Date().toISOString().replace(/[:.]/g, '-'))
  mkdirSync(out, { recursive: true })

  /* 触发翻页：先按一次 PageDown，然后立刻连拍 */
  const flip = send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'PageDown',
    code: 'PageDown',
    windowsVirtualKeyCode: 34,
    nativeVirtualKeyCode: 34
  })
  let shot = 0
  for (let i = 0; i < frames; i++) {
    try {
      const { data } = await send('Page.captureScreenshot', { format: 'png' })
      const file = join(out, `frame-${String(i).padStart(2, '0')}.png`)
      writeFileSync(file, Buffer.from(data, 'base64'))
      shot++
    } catch (err) {
      console.warn(`  第 ${i} 帧失败：${err.message}`)
    }
    await sleep(interval)
  }
  await flip.catch(() => {})
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'PageDown',
    code: 'PageDown',
    windowsVirtualKeyCode: 34,
    nativeVirtualKeyCode: 34
  }).catch(() => {})

  ws.close()
  console.log(`已抓 ${shot}/${frames} 帧 → ${out}`)
}

main().catch((err) => {
  console.error(`抓帧失败：${err.message}`)
  process.exit(1)
})
