// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 抓取渲染层控制台全部输出（含 log / warn / error）。
 *
 * 与 cdp-errors.mjs 的区别：那个只看错误，这个把所有 console 调用都打出来，
 * 便于定位「代码有没有执行到某处」这类问题。
 *
 * 用法：node scripts/cdp-console.mjs <端口> [等待毫秒] [是否重载 true/false]
 */

const [port = '9223', waitRaw = '2500', reloadRaw = 'true'] = process.argv.slice(2)
const waitMs = Number(waitRaw)
const reload = reloadRaw !== 'false'

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

const lines = []
let nextId = 0

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(String(event.data))

  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = msg.params.args
      .map((a) => {
        if (a.type === 'string') return a.value
        if (a.value !== undefined) return JSON.stringify(a.value)
        return a.description ?? `[${a.type}]`
      })
      .join(' ')
    lines.push(`[${msg.params.type}] ${text}`)
  }

  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails
    lines.push(`[异常] ${d.exception?.description ?? d.text}`)
  }
})

function send(method, params = {}) {
  ws.send(JSON.stringify({ id: ++nextId, method, params }))
}

send('Runtime.enable')
await new Promise((r) => setTimeout(r, 200))

if (reload) {
  send('Page.enable')
  send('Page.reload', { ignoreCache: true })
}

await new Promise((r) => setTimeout(r, waitMs))

ws.close()

console.log(`渲染层控制台输出（${lines.length} 条）：`)
for (const l of lines) console.log('  ' + l.slice(0, 400))
