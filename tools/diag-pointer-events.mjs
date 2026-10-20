// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 验证 CDP 派发的鼠标事件是否会触发 pointer 事件。
 *
 * ── 为什么需要这个自检 ──────────────────────────────────────
 *   上一个诊断脚本显示「pointerdown 一次都没到达」，
 *   但这可能是**测试方法本身的问题**：CDP 的
 *   Input.dispatchMouseEvent 在部分版本里只发 mouse 事件、
 *   不发 pointer 事件。若不先排除这一点，就会把
 *   「测不出来」误判成「功能坏了」，白改一通代码。
 *
 * 做法：在 window 上同时监听 pointerdown / mousedown，
 * 派发一次点击，看两者各收到几次。
 *
 * 用法：node tools/diag-pointer-events.mjs [端口]
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

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r?.exceptionDetails) return `★异常 ${r.exceptionDetails.exception?.description?.slice(0, 300)}`
  const v = r.result?.value
  return typeof v === 'string' ? v : JSON.stringify(v)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('=== CDP 事件类型自检 ===\n')

await evaluate(`(() => {
  window.__evt = { pointerdown: 0, mousedown: 0, pointermove: 0, touchstart: 0 };
  for (const k of Object.keys(window.__evt)) {
    window.addEventListener(k, () => { window.__evt[k]++; }, true);
  }
  return 'listening';
})()`)

/* 取页面中一个确定有内容的坐标 */
const pt = JSON.parse(
  await evaluate(`(() => {
    const r = document.querySelector('.pdf-page').getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) });
  })()`)
)
console.log(`点击坐标: (${pt.x}, ${pt.y})`)

/* 方式一：dispatchMouseEvent + pointerType */
await send('Input.dispatchMouseEvent', {
  type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse'
})
await sleep(80)
await send('Input.dispatchMouseEvent', {
  type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, pointerType: 'mouse'
})
await sleep(500)

console.log('① dispatchMouseEvent 结果:', await evaluate(`JSON.stringify(window.__evt)`))

/* 方式二：加一个移动事件，看 pointermove 是否触发 */
await evaluate(`window.__evt = { pointerdown: 0, mousedown: 0, pointermove: 0, touchstart: 0 }`)
await send('Input.dispatchMouseEvent', {
  type: 'mouseMoved', x: pt.x + 30, y: pt.y + 30, button: 'none', buttons: 0, pointerType: 'mouse'
})
await sleep(400)
console.log('② 仅 mouseMoved:', await evaluate(`JSON.stringify(window.__evt)`))

console.log('\n=== 判读 ===')
console.log('  pointerdown/mousedown 都 > 0 → CDP 能触发 pointer 事件，之前的诊断有效')
console.log('  pointerdown == 0 而 mousedown > 0 → CDP 不发 pointer 事件，')
console.log('      说明「橡皮擦不了」的结论不成立，需要用别的方式测（或直接看界面）')

ws.close()
