// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 诊断：检查协议是否真的被 pdf.js 调用，以及页面当前状态。
 *
 * 用法：node scripts/diag-full.mjs <端口>
 */

const [port = '9223'] = process.argv.slice(2)

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
      const m = JSON.parse(String(event.data))
      if (m.id !== id) return
      ws.removeEventListener('message', onMsg)
      resolve(m.result)
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

async function show(label, expression) {
  const r = await evaluate(expression)
  const v = r?.result?.value
  console.log(`${label}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
}

// 主动触发一次打开，并观察协议请求
await show(
  '打开文件',
  `window.pdfApp.open.path(${JSON.stringify(process.env.PDF_READER_OPEN_FILE ?? '')})
     .then(r => JSON.stringify(r)).catch(e => 'ERR ' + e.message)`
)

await new Promise((r) => setTimeout(r, 3000))

await show(
  '页面状态',
  `JSON.stringify({
     empty: document.querySelector('.empty__text')?.textContent ?? null,
     pages: document.querySelectorAll('.pdf-page').length,
     canvas: document.querySelectorAll('.pdf-page__canvas').length,
     status: document.querySelector('.statusbar__loading')?.textContent ?? null,
     file: document.querySelector('.statusbar__file')?.textContent ?? null
   })`
)

// 直接 fetch 协议，确认协议处理器是否工作
await show(
  '协议 fetch',
  `(async () => {
     try {
       const res = await fetch('pdf-file:///<FIXTURE_URL>', { headers: { Range: 'bytes=0-7' } });
       const buf = await res.arrayBuffer();
       return JSON.stringify({ status: res.status, len: buf.byteLength, magic: String.fromCharCode(...new Uint8Array(buf).slice(0,5)) });
     } catch (e) { return 'ERR ' + (e && e.message ? e.message : e); }
   })()`
)

ws.close()
