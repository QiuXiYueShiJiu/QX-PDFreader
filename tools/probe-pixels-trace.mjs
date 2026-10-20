// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 冷启动 → 立刻切缩放 → 同时读出像素与事件序列。
 *
 * 背景：缩放回归在**冷启动后的第一轮**失败 3/11（0.75/0.9/1 全黑），
 *       而同一实例再跑一次就 11/11 通过。差异只在「这是不是冷启动后的第一轮」，
 *       所以必须复刻冷启动这个前提，再把事件序列一次性读出来 ——
 *       否则永远看不到第一轮那条时间线。
 *
 * 用法：node tools/probe-pixels-trace.mjs [端口] [缩放]
 */

const PORT = Number(process.argv[2] || 9253)
const RAW = process.argv[3] || '0.9'
const ZOOM = isNaN(Number(RAW)) ? RAW : Number(RAW)

async function cdp(expression, timeoutMs = 60000) {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('没有找到可调试的页面')
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    const timer = setTimeout(() => {
      try { ws.close() } catch {}
      reject(new Error('CDP 超时'))
    }, timeoutMs)
    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true }
      }))
    }
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id !== 1) return
      clearTimeout(timer)
      ws.close()
      if (msg.result?.exceptionDetails) {
        reject(new Error(msg.result.exceptionDetails.exception?.description || '表达式异常'))
      } else {
        resolve(msg.result?.result?.value)
      }
    }
    ws.onerror = (e) => { clearTimeout(timer); reject(new Error(`WebSocket 错误: ${e.message || e}`)) }
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log(`=== 冷启动后切缩放 ${ZOOM}（端口 ${PORT}）===\n`)

await cdp(`(() => {
  window.__sbInkTrace = [];
  window.__store.getState().setZoom(${JSON.stringify(ZOOM)});
  return 'ok';
})()`)

for (let i = 1; i <= 5; i++) {
  await sleep(1000)
  const s = await cdp(`(() => window.__sbSampleCanvas ? window.__sbSampleCanvas(1) : 'no-hook')()`)
  console.log(`  t=${i}s  ${s}`)
}

console.log('\n--- 第 1 页事件序列 ---')
console.log(await cdp(`JSON.stringify((window.__sbInkTrace || []).filter(l => l.startsWith('p1 ')), null, 1)`))
