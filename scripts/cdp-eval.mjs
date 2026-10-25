// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 通过 CDP 在页面里执行一段表达式。
 *
 * 用法：node scripts/cdp-eval.mjs <端口> "<表达式>" [等待毫秒]
 *
 * 说明：PowerShell 内联传复杂 JS 会被引号转义搞坏，
 * 统一用这个脚本传参，避免转义问题。
 */

const [port = '9223', expression = '1', waitRaw = '0'] = process.argv.slice(2)
const waitMs = Number(waitRaw)

const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
const page = list.find((t) => t.type === 'page')

if (!page) {
  console.error('没有页面目标')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res)
  ws.addEventListener('error', () => rej(new Error('连接失败')))
})

if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs))

const result = await new Promise((resolve) => {
  const onMsg = (event) => {
    const msg = JSON.parse(String(event.data))
    if (msg.id !== 1) return
    ws.removeEventListener('message', onMsg)
    resolve(msg.result)
  }
  ws.addEventListener('message', onMsg)
  ws.send(
    JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true }
    })
  )
})

ws.close()

if (result?.exceptionDetails) {
  console.error('表达式异常：')
  console.error('  ' + (result.exceptionDetails.exception?.description ?? result.exceptionDetails.text))
  process.exit(1)
}

const value = result?.result?.value
console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
