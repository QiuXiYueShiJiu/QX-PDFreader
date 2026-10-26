// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 检测「画完笔迹后多久才能命中」的时序问题。
 *
 * 背景：静态检测（笔迹画好一段时间后再取点）能稳定命中 path，
 * 但橡皮验证脚本里刚画完就取点却命中不了。
 * 怀疑是渲染与命中测试之间的时序差 —— 这个脚本把时间轴打出来。
 *
 * 用法：node tools/diag-erase-timing.mjs [端口]
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
function send(method, params = {}, timeoutMs = 8000) {
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
  if (r?.exceptionDetails) return `★异常 ${r.exceptionDetails.exception?.description?.slice(0, 150)}`
  const v = r.result?.value
  return typeof v === 'string' ? v : JSON.stringify(v)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 读回笔迹范围并在中点做命中检测 */
const PROBE = `(() => {
  const paths = Array.from(document.querySelectorAll('.stroke-layer path'));
  if (!paths.length) return JSON.stringify({ 段数: 0 });
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (const p of paths) {
    const b = p.getBoundingClientRect();
    minX = Math.min(minX, b.left); maxX = Math.max(maxX, b.right);
    minY = Math.min(minY, b.top);  maxY = Math.max(maxY, b.bottom);
  }
  const mx = Math.round((minX + maxX) / 2);
  const my = Math.round((minY + maxY) / 2);
  const stack = document.elementsFromPoint(mx, my);
  const hit = stack.find(el => el.dataset && el.dataset.annoId);
  return JSON.stringify({
    段数: paths.length,
    宽: Math.round(maxX - minX),
    取点: mx + ',' + my,
    命中: hit ? hit.tagName : '无',
    顶层: stack[0] ? stack[0].tagName : '?'
  });
})()`

/* 确保在绘画模式 */
await evaluate(`(() => {
  const btn = Array.from(document.querySelectorAll('.drawbar__tool')).find(b => b.textContent.includes('画笔'));
  if (btn && !btn.classList.contains('is-active')) btn.click();
})()`)
await sleep(700)

const box = JSON.parse(
  await evaluate(`(() => {
    const p = document.querySelector('.pdf-page').getBoundingClientRect();
    return JSON.stringify({ left: p.left, top: p.top, width: p.width, height: p.height });
  })()`)
)

const sx = Math.round(box.left + box.width * 0.3)
const sy = Math.round(box.top + box.height * 0.5)
console.log(`画线起点: ${sx},${sy}`)

/* 画一条长线：25 段 × 12px = 300px */
await send('Input.dispatchMouseEvent', {
  type: 'mousePressed', x: sx, y: sy, button: 'left', clickCount: 1, pointerType: 'mouse'
})
for (let i = 1; i <= 25; i++) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: sx + i * 12, y: sy, button: 'left', buttons: 1, pointerType: 'mouse'
  })
}
await send('Input.dispatchMouseEvent', {
  type: 'mouseReleased', x: sx + 300, y: sy, button: 'left', clickCount: 1, pointerType: 'mouse'
})

console.log('\n--- 松手后的时间轴 ---')
let elapsed = 0
for (const step of [0, 100, 300, 700, 1500]) {
  if (step > elapsed) {
    await sleep(step - elapsed)
    elapsed = step
  }
  console.log(`  +${elapsed}ms  ${await evaluate(PROBE)}`)
}

/* 再测一次「打开橡皮后立即取点」 */
await evaluate(`(() => {
  const btn = Array.from(document.querySelectorAll('.drawbar__tool')).find(b => b.textContent.includes('橡皮'));
  if (btn && !btn.disabled) btn.click();
})()`)
console.log('\n--- 打开橡皮后 ---')
await sleep(600)
console.log(`  ${await evaluate(PROBE)}`)

ws.close()
