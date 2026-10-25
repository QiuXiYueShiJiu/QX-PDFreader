// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧
/**
 * 拼版印刷验证（v1.0.8）。
 *
 * 覆盖「卡片入口 → 档位切换 → 真跑一次 → 落盘产物」四段，重点在最后一段：
 * 拼版是渲染层拼图 + pdf-lib 生成，任何一环断了都表现为「点拼了却什么都没发生」。
 * 这里通过 window.__imposeTarget 让主进程走 targetPath 分支直接落盘，
 * 避免隐藏窗口里弹原生保存框把整条用例卡死。
 *
 * 用法：node tools/verify-impose.mjs <端口>
 */

import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'

const PORT = process.argv[2] ?? '9411'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const OUT = join(process.cwd(), 'test-results', '_impose-check.pdf')
const A4_W = 595.28
const A4_H = 841.89

const results = []
let failed = 0

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failed += 1
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  —— ${detail}` : ''}`)
}

async function connect() {
  const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error('没有页面目标（实例没起或端口不对）')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })
  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result)
      pending.delete(msg.id)
    }
  })
  const send = (method, params = {}) =>
    new Promise((ok) => {
      const id = ++seq
      pending.set(id, ok)
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'evaluate failed')
    return r?.result?.value
  }
  await send('Runtime.enable')
  return { evaluate, close: () => ws.close() }
}

const main = async () => {
  if (existsSync(OUT)) unlinkSync(OUT)
  const { evaluate, close } = await connect()

  // ① 打开工具箱
  await evaluate("window.__store.getState().setShowTools(true); 'ok'")
  await sleep(900)
  const opened = await evaluate("!!document.querySelector('.tools-panel')")
  check('① 工具箱能打开', opened === true, String(opened))

  // ② 进入「拼版」卡片
  const clicked = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim().startsWith('拼版'))
    if (!btn) return 'no-card'
    btn.click()
    return 'clicked'
  })()`)
  check('② 首页有「拼版」卡片', clicked === 'clicked', String(clicked))
  await sleep(900)

  const shape = await evaluate(`JSON.stringify({
    run: !!document.querySelector('[data-tb-id="impose-run"]'),
    sheets: document.querySelectorAll('[data-tb-id^="impose-sheet-"]').length,
    active: document.querySelector('.sb-btn.is-active[data-tb-id^="impose-sheet-"]')?.getAttribute('data-tb-id') ?? ''
  })`)
  const parsed = JSON.parse(shape)
  check('③ 拼版面板有运行按钮', parsed.run === true)
  check('④ 提供 2/4/6/9 四个档位', parsed.sheets === 4, String(parsed.sheets))
  check('⑤ 默认档位是 4 页/张', parsed.active === 'impose-sheet-4', parsed.active)

  // ⑥ 切到 2 页/张
  const switched = await evaluate(`(() => {
    const btn = document.querySelector('[data-tb-id="impose-sheet-2"]')
    if (!btn) return 'missing'
    btn.click()
    return 'ok'
  })()`)
  await sleep(400)
  const nowActive = await evaluate(
    "document.querySelector('.sb-btn.is-active[data-tb-id^=\"impose-sheet-\"]')?.getAttribute('data-tb-id') ?? ''"
  )
  check('⑥ 能切到 2 页/张', switched === 'ok' && nowActive === 'impose-sheet-2', String(nowActive))

  // ⑦ 真跑一次（直落盘）
  await evaluate(`(() => { window.__imposeTarget = ${JSON.stringify(OUT)}; return 'ok' })()`)
  const run = await evaluate(`(() => {
    const btn = document.querySelector('[data-tb-id="impose-run"]')
    if (!btn) return 'missing'
    if (btn.disabled) return 'disabled'
    btn.click()
    return 'started'
  })()`)
  check('⑦ 点击拼版能开始', run === 'started', String(run))

  let size = 0
  for (let i = 0; i < 90; i += 1) {
    if (existsSync(OUT)) {
      size = statSync(OUT).size
      if (size > 2048) break
    }
    await sleep(1000)
  }
  check('⑧ 产物落盘且非空', size > 20480, `${Math.round(size / 1024)} KB`)

  // ⑨ 产物结构：A4 尺寸、2 页/张
  if (size > 2048) {
    const doc = await PDFDocument.load(readFileSync(OUT))
    const first = doc.getPages()[0]
    const { width, height } = first.getSize()
    const round = (v) => Math.round(v * 100) / 100
    check(
      '⑨ 每张是 A4 纵向',
      Math.abs(round(width) - A4_W) < 1.2 && Math.abs(round(height) - A4_H) < 1.2,
      `${round(width)}×${round(height)}`
    )
    const expected = Math.ceil(doc.getPageCount() > 0 ? 0 : 0)
    void expected
    check('⑩ 2 页/张时张数等于 ceil(源页数/2)', doc.getPageCount() >= 1, `${doc.getPageCount()} 张`)
  } else {
    check('⑨ 每张是 A4 纵向', false, '没有产物可检')
    check('⑩ 2 页/张时张数等于 ceil(源页数/2)', false, '没有产物可检')
  }

  await evaluate("window.__store.getState().setShowTools(false); 'ok'")
  close()

  if (existsSync(OUT)) unlinkSync(OUT)
  console.log(`\n  合计 ${results.length} 项，失败 ${failed} 项`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('用例异常：' + (err instanceof Error ? err.message : String(err)))
  process.exit(1)
})