// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 手绘批注端到端验证。
 *
 * 用 CDP 派发真实指针事件序列（pointerdown → pointermove → pointerup），
 * 走完整链路：绘制 → 落成批注 → 页面出现笔迹 → 右侧栏出现条目。
 *
 * 之所以不用「直接调 store」，是因为那样跳过事件绑定，
 * 无法验证指针交互本身是否接对了。
 *
 * 用法：node scripts/diag-draw.mjs <端口>
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
  if (r?.exceptionDetails) {
    return `★异常 ${r.exceptionDetails.exception?.description?.slice(0, 200)}`
  }
  const v = r.result?.value
  return typeof v === 'string' ? v : JSON.stringify(v)
}

async function step(label, expression) {
  const v = await evaluate(expression)
  console.log(`${label}: ${v}`)
  return v
}

// ① 开启手绘模式
await step(
  '① 开启手绘',
  `(async () => {
     const store = window.__sbStore;
     if (store) { store.getState().setDrawMode(true); return '通过 store 开启'; }
     // 没有暴露 store 时点工具栏按钮
     const btns = Array.from(document.querySelectorAll('.tb'));
     const pen = btns.find(b => b.textContent.includes('手绘'));
     if (!pen) return '★找不到手绘按钮';
     pen.click();
     return '已点击手绘按钮';
   })()`
)

await new Promise((r) => setTimeout(r, 500))

await step('① 手绘模式状态', `JSON.stringify({ 工具栏按钮激活: !!document.querySelector('.tb[aria-pressed="true"]'), 画笔工具条: !!document.querySelector('.draw-tools'), 滚动区类名: document.querySelector('.viewer-scroll')?.className })`)

// ② 取页面位置，用于派发指针事件
const boxJson = await step(
  '② 页面位置',
  `(() => {
     const pageEl = document.querySelector('.pdf-page');
     if (!pageEl) return '★没有页面';
     const r = pageEl.getBoundingClientRect();
     return JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) });
   })()`
)

let box = null
try {
  box = JSON.parse(boxJson)
} catch {
  console.error('无法解析页面位置，终止')
  ws.close()
  process.exit(1)
}

// ③ 用 Input 域派发真实指针事件（比合成 PointerEvent 更接近真实输入）
const startX = box.left + Math.round(box.width * 0.3)
const startY = box.top + Math.round(box.height * 0.3)

await send('Input.dispatchMouseEvent', {
  type: 'mousePressed',
  x: startX,
  y: startY,
  button: 'left',
  clickCount: 1,
  pointerType: 'mouse'
})

for (let i = 1; i <= 12; i++) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: startX + i * 14,
    y: startY + Math.round(Math.sin(i / 2) * 20),
    button: 'left',
    buttons: 1,
    pointerType: 'mouse'
  })
}

await send('Input.dispatchMouseEvent', {
  type: 'mouseReleased',
  x: startX + 12 * 14,
  y: startY,
  button: 'left',
  clickCount: 1,
  pointerType: 'mouse'
})

console.log(`③ 已派发笔迹（${startX},${startY} 起，12 段）`)

await new Promise((r) => setTimeout(r, 1200))

// ④ 检查结果
await step('④ 页面上的批注元素', `document.querySelectorAll('.anno-mark, .anno-note').length + ' 个'`)
await step('④ 页面上的笔迹预览层', `document.querySelectorAll('.draw-preview').length + ' 个（绘制结束后应为 0）'`)

await step(
  '④ 切到批注页签',
  `(() => {
     const tabs = Array.from(document.querySelectorAll('.sidebar__tab'));
     const t = tabs.find(x => x.textContent.includes('批注'));
     if (!t) return '★找不到批注页签';
     t.click();
     return '已切换';
   })()`
)

await new Promise((r) => setTimeout(r, 700))

await step(
  '④ 右侧栏内容',
  `(() => {
     const body = document.querySelector('.right-panel .sidebar__body');
     if (!body) return '★右侧栏不可见（可能被关闭）';
     const cards = document.querySelectorAll('.annotations-card');
     return JSON.stringify({
       卡片数: cards.length,
       文本: body.textContent.replace(/\\s+/g, ' ').trim().slice(0, 200)
     });
   })()`
)

ws.close()
