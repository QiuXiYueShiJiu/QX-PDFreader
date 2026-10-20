// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 检查 .viewer-scroll 上实际注册了哪些事件监听。
 *
 * 用 CDP 的 DOMDebugger.getEventListeners —— 这是运行时真实注册的监听器，
 * 比读源码可靠（能看到条件分支是否真的执行了）。
 *
 * 用法：node tools/diag-listeners.mjs [端口]
 */

const port = process.argv[2] ?? '9225'

const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
const page = list.find((t) => t.type === 'page')
if (!page) {
  console.error('★ 没有页面目标')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res)
  ws.addEventListener('error', () => rej(new Error('连接失败')))
})

let nextId = 0
function send(method, params = {}, timeoutMs = 20000) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} 超时`)), timeoutMs)
    const onMsg = (event) => {
      const m = JSON.parse(String(event.data))
      if (m.id !== id) return
      clearTimeout(timer)
      ws.removeEventListener('message', onMsg)
      resolve(m.result)
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/*
 * 必须先 enable DOM 域并拿到节点的 objectId，
 * getEventListeners 需要的是 RemoteObjectId 而不是选择器。
 */
await send('DOM.enable')
await send('Runtime.enable')

async function listenersOf(selector) {
  const doc = await send('DOM.getDocument', { depth: -1 })
  let nodeId
  try {
    const q = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector })
    nodeId = q.nodeId
  } catch {
    return `★ 查询失败: ${selector}`
  }
  if (!nodeId) return `★ 未找到: ${selector}`

  const ro = await send('DOM.resolveNode', { nodeId })
  const objectId = ro.object?.objectId
  if (!objectId) return `★ 无法解析节点: ${selector}`

  const res = await send('DOMDebugger.getEventListeners', { objectId })
  const list = (res.listeners || []).map((l) => ({
    type: l.type,
    useCapture: l.useCapture,
    passive: l.passive,
    once: l.once,
    // 只取函数名，够判断是不是我们挂的
    handler: l.handler?.description?.split('\n')[0]?.slice(0, 70) ?? '(匿名)'
  }))
  return list
}

console.log('=== 运行时事件监听器 ===\n')

for (const sel of ['.viewer-scroll', '.pdf-page', '.ink-canvas', 'body']) {
  const ls = await listenersOf(sel)
  if (typeof ls === 'string') {
    console.log(`${sel}: ${ls}`)
    continue
  }
  const relevant = ls.filter((l) =>
    ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'click', 'touchstart', 'wheel'].includes(l.type)
  )
  console.log(`${sel}  （共 ${ls.length} 个监听，其中指针相关 ${relevant.length} 个）`)
  for (const l of relevant) {
    console.log(`   ${l.type.padEnd(12)} capture=${String(l.useCapture).padEnd(5)} ${l.handler}`)
  }
  if (relevant.length === 0) console.log('   （无指针相关监听）')
  console.log('')
}

console.log('=== 判读 ===')
console.log('  .viewer-scroll 上应有 pointerdown（React 的合成事件会挂到根容器，')
console.log('  但如果为空，说明 React 根本没把 onPointerDown 接上 → 组件没渲染出这个分支）')

ws.close()
