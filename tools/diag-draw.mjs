// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 手绘批注专项诊断。
 *
 * 目的：确认「指针事件有没有到达 React 处理器」，
 *   以及 Draft 状态是否建立（预览层是否出现）。
 *
 * 方法：打开主进程里的诊断开关 window.__sbDebugDraw，
 *   然后派发指针事件并读取控制台输出。
 *
 * 用法：node tools/diag-draw.mjs [端口]
 */

const port = process.argv[2] ?? '9223'

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
const consoleLines = []

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(String(event.data))
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
    consoleLines.push(`[${msg.params.type}] ${text}`)
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleLines.push(`[异常] ${msg.params.exceptionDetails.exception?.description ?? ''}`)
  }
})

function send(method, params = {}) {
  const id = ++nextId
  return new Promise((resolve) => {
    const onMsg = (event) => {
      const m = JSON.parse(String(event.data))
      if (m.id !== id) return
      ws.removeEventListener('message', onMsg)
      resolve(m.result)
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r?.exceptionDetails) return `★异常 ${r.exceptionDetails.exception?.description?.slice(0, 200)}`
  const v = r.result?.value
  return typeof v === 'string' ? v : JSON.stringify(v)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await send('Runtime.enable')

console.log('=== 手绘诊断 ===\n')

// 打开诊断开关
await evaluate('window.__sbDebugDraw = true')
console.log('已打开诊断开关 window.__sbDebugDraw')

// 开启手绘模式
console.log(
  '开启手绘:',
  await evaluate(`(() => {
    const btns = Array.from(document.querySelectorAll('.tb'));
    const pen = btns.find(b => b.textContent.includes('手绘'));
    if (!pen) return '★找不到按钮';
    if (pen.getAttribute('aria-pressed') !== 'true') pen.click();
    return 'ok';
  })()`)
)
await sleep(400)

// 确认 store 状态
console.log(
  '滚动区状态:',
  await evaluate(`document.querySelector('.viewer-scroll')?.className`)
)

// 取页面位置
const box = JSON.parse(
  await evaluate(`(() => {
    const p = document.querySelector('.pdf-page');
    const r = p.getBoundingClientRect();
    return JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) });
  })()`)
)
console.log('页面位置:', JSON.stringify(box))

const sx = box.left + Math.round(box.width * 0.35)
const sy = box.top + Math.round(box.height * 0.35)

consoleLines.length = 0

// 派发指针事件
await send('Input.dispatchMouseEvent', {
  type: 'mousePressed', x: sx, y: sy, button: 'left', clickCount: 1, pointerType: 'mouse'
})
for (let i = 1; i <= 10; i++) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: sx + i * 14,
    y: sy + Math.round(Math.sin(i / 2) * 18),
    button: 'left',
    buttons: 1,
    pointerType: 'mouse'
  })
}
await send('Input.dispatchMouseEvent', {
  type: 'mouseReleased', x: sx + 140, y: sy, button: 'left', clickCount: 1, pointerType: 'mouse'
})

await sleep(1200)

console.log('\n--- 派发事件后的控制台输出 ---')
if (consoleLines.length === 0) {
  console.log('  （无输出 → 指针事件没有到达 React 处理器）')
} else {
  for (const l of consoleLines) console.log('  ' + l.slice(0, 200))
}

console.log('\n--- 结果 ---')
console.log(
  '  批注元素:',
  await evaluate(`document.querySelectorAll('.anno-mark, .anno-note').length`)
)
console.log(
  '  预览层:',
  await evaluate(`document.querySelectorAll('.draw-preview').length`)
)

ws.close()
