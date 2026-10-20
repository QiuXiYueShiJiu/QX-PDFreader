// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 诊断：验证 pdf-file:// URL 构造与协议读取是否正常。
 *
 * 背景：渲染层拿到的是正确的文件路径（open.path 返回 ok），
 * 但 pdf.js 报 "Invalid PDF url data"。需要分离判断是
 *   (a) URL 字符串构造有问题，还是
 *   (b) 协议没注册好导致 fetch 失败并抛出这个误导性错误。
 *
 * 用法：node scripts/diag-url.mjs <端口> "<pdf绝对路径>"
 */

const [port = '9223', filePath = ''] = process.argv.slice(2)

if (!filePath) {
  console.error('用法: node scripts/diag-url.mjs <端口> "<pdf绝对路径>"')
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
    const onMsg = (event) => {
      const msg = JSON.parse(String(event.data))
      if (msg.id !== id) return
      ws.removeEventListener('message', onMsg)
      resolve(msg.result)
    }
    ws.addEventListener('message', onMsg)
    ws.send(
      JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true }
      })
    )
  })
}

// 用 JSON.stringify 把路径安全嵌进表达式，避免引号与反斜杠转义问题
const pathLiteral = JSON.stringify(filePath)

// ① 复现渲染层里的 URL 构造逻辑
const buildExpr = `
(() => {
  const filePath = ${pathLiteral};
  const normalized = filePath.replace(/\\\\/g, '/');
  const encoded = normalized.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  return 'pdf-file:///' + encoded;
})()
`
const url = (await evaluate(buildExpr))?.result?.value
console.log('构造出的 URL:')
console.log('  ' + url)

// ② 直接 fetch 这个 URL，看协议是否工作
const fetchExpr = `
(async () => {
  try {
    const res = await fetch(${JSON.stringify(url)}, { headers: { Range: 'bytes=0-1023' } });
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf).slice(0, 8);
    const magic = Array.from(bytes).map((b) => String.fromCharCode(b)).join('');
    return JSON.stringify({ status: res.status, ok: res.ok, length: buf.byteLength, magic });
  } catch (e) {
    return JSON.stringify({ error: String(e && e.message ? e.message : e) });
  }
})()
`
const fetched = (await evaluate(fetchExpr))?.result?.value
console.log('直接 fetch 结果:')
console.log('  ' + fetched)

// ③ 检查 CSP 是否拦了连接
const csp = (await evaluate(`document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? '(无 CSP)'`))
  ?.result?.value
console.log('CSP:')
console.log('  ' + csp)

ws.close()
