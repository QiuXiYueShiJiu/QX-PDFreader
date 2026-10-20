// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 验证自定义协议 URL 在不同写法下的解析与读取结果。
 *
 * 背景：pdf.js 内部会对 url 做 new URL() 规范化，
 * 盘符可能被降为小写并丢掉冒号（pdf-file://c/Users/...）。
 * 需要确认主进程的解析逻辑能否接住这种形态。
 *
 * 用法：node scripts/diag-proto.mjs <端口> "<pdf绝对路径>"
 */

const [port = '9223', filePath = ''] = process.argv.slice(2)

if (!filePath) {
  console.error('用法: node scripts/diag-proto.mjs <端口> "<pdf绝对路径>"')
  process.exit(1)
}

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

let nextId = 0
function evaluate(expression) {
  const id = ++nextId
  return new Promise((resolve) => {
    const msg = { id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }
    const onMsg = (event) => {
      const m = JSON.parse(String(event.data))
      if (m.id !== id) return
      ws.removeEventListener('message', onMsg)
      resolve(m.result)
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify(msg))
  })
}

// 用 base64 传递路径，彻底绕开转义问题
const b64 = Buffer.from(filePath, 'utf8').toString('base64')

const expr = `
(async () => {
  const filePath = decodeURIComponent(escape(atob(${JSON.stringify(b64)})));
  const normalized = filePath.replace(/\\\\/g, '/');
  // 与 DocumentView 完全一致的构造逻辑
  const encoded = normalized.split('/')
    .map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ':'))
    .join('/');
  const url = 'pdf-file:///' + encoded;

  const out = { filePath, url };

  // 各种变体都试一遍，看哪种能被 fetch 接受
  const variants = {
    原样: url,
    '盘符小写且去冒号': url.replace(':///C:', '://c'),
    '盘符小写保留冒号': url.replace(':///C:', ':///c:')
  };

  out.results = {};
  for (const [name, u] of Object.entries(variants)) {
    try {
      const res = await fetch(u, { headers: { Range: 'bytes=0-7' } });
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const magic = String.fromCharCode(...bytes.slice(0, 5));
      out.results[name] = { url: u, status: res.status, ok: res.ok, len: buf.byteLength, magic };
    } catch (e) {
      out.results[name] = { url: u, error: String(e && e.message ? e.message : e) };
    }
  }

  return JSON.stringify(out, null, 2);
})()
`

const result = await evaluate(expr)
ws.close()

if (result?.exceptionDetails) {
  console.error('异常：', result.exceptionDetails.exception?.description)
  process.exit(1)
}

console.log(result?.result?.value ?? JSON.stringify(result))
