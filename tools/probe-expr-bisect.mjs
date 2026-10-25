// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 二分定位：verify-sample-fn.mjs 的表达式为什么在渲染进程里报
 * "SyntaxError: Invalid or unexpected token"。逐段投喂，找出第一段炸的。
 *
 * 用法：node tools/probe-expr-bisect.mjs [端口]
 */

const PORT = Number(process.argv[2] || 9239)

async function cdp(expression, timeoutMs = 30000) {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('没有找到可调试的页面')
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    const timer = setTimeout(() => { try { ws.close() } catch {} ; reject(new Error('CDP 超时')) }, timeoutMs)
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
      clearTimeout(timer); ws.close()
      if (msg.result?.exceptionDetails) reject(new Error(msg.result.exceptionDetails.exception?.description || '表达式异常'))
      else resolve(msg.result?.result?.value)
    }
    ws.onerror = (e) => { clearTimeout(timer); reject(new Error(`WebSocket 错误: ${e.message || e}`)) }
  })
}

/* 逐段加长，找出第一段炸掉的 */
const PIECES = [
  ['只有 IIFE', `(() => { return 'a' })()`],
  ['带对象字面量', `(() => { const o = {}; o.a = 1; return JSON.stringify(o) })()`],
  ['中文属性名', `(() => { const o = {}; o.①纯黑画布 = 1; return JSON.stringify(o) })()`],
  ['中文属性名带圈号', `(() => { const o = {}; o.①b纯白画布 = 1; o.④原画布中心50x50通道范围 = 2; return JSON.stringify(o) })()`],
  ['函数声明', `(() => { function sample(c) { return c } return String(sample(1)) })()`],
  ['函数里建 canvas', `(() => { function s(c) { const p = document.createElement('canvas'); p.width = 24; p.height = 24; const x = p.getContext('2d', { willReadFrequently: true }); x.drawImage(c, 0, 0, 24, 24); return x.getImageData(0, 0, 24, 24).data.length } const c = document.createElement('canvas'); c.width = 100; c.height = 100; return String(s(c)) })()`],
  ['for 循环带 i += 4', `(() => { let n = 0; const d = new Uint8ClampedArray(16); for (let i = 0; i < d.length; i += 4) { n++ } return String(n) })()`],
  ['三元与 Math.min', `(() => { let m = 255; m = Math.min(m, 3, 4, 5); return String(m) })()`]
]

console.log(`=== 表达式分段投喂（端口 ${PORT}）===`)
for (const [name, expr] of PIECES) {
  try {
    const v = await cdp(expr)
    console.log(`  ✅ ${name} → ${String(v).slice(0, 60)}`)
  } catch (e) {
    console.log(`  ❌ ${name} → ${e.message.slice(0, 200)}`)
  }
}
