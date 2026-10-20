// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 抓取页面的运行时错误、控制台错误与网络失败。
 *
 * 用途：页面白屏（#root 无子元素）时定位原因。
 *   常见原因：模块加载失败、preload 未注入、React 挂载时抛异常。
 *   这些在主进程日志里看不到，必须从渲染层的 CDP 事件里取。
 *
 * 用法：node scripts/cdp-errors.mjs <端口> [等待毫秒]
 */

const [port = '9223', waitRaw = '2500'] = process.argv.slice(2)
const waitMs = Number(waitRaw)

const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
const pages = list.filter((t) => t.type === 'page')

if (pages.length === 0) {
  console.error('没有页面目标')
  process.exit(1)
}

const target = pages[0]
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res)
  ws.addEventListener('error', () => rej(new Error('连接失败')))
})

const findings = []
let nextId = 0

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(String(event.data))

  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails
    findings.push({
      kind: '异常',
      text: d.exception?.description ?? d.text,
      where: d.url ? `${d.url}:${d.lineNumber}` : ''
    })
  }

  if (msg.method === 'Log.entryAdded') {
    const e = msg.params.entry
    if (e.level === 'error' || e.level === 'warning') {
      findings.push({ kind: `日志:${e.level}`, text: e.text, where: e.url ?? '' })
    }
  }

  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    findings.push({
      kind: 'console.error',
      text: msg.params.args.map((a) => a.description ?? String(a.value)).join(' '),
      where: ''
    })
  }
})

function send(method, params = {}) {
  const id = ++nextId
  ws.send(JSON.stringify({ id, method, params }))
}

send('Runtime.enable')
send('Log.enable')
await new Promise((r) => setTimeout(r, 250))

// 重载页面，把启动阶段的错误也抓进来
send('Page.enable')
send('Page.reload', { ignoreCache: true })

await new Promise((r) => setTimeout(r, waitMs))

ws.close()

console.log(`发现 ${findings.length} 条问题：`)
if (findings.length === 0) {
  console.log('  （无）')
} else {
  for (const f of findings) {
    console.log(`  [${f.kind}] ${String(f.text).slice(0, 600)}`)
    if (f.where) console.log(`      ${f.where}`)
  }
}
