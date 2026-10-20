// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 诊断两个问题：
 *   ① 画笔按钮的 is-active 类为什么没生效
 *   ② 「适应宽度」算出的比例为什么偏大（页面宽 > 阅读区宽）
 *
 * 用法：node tools/diag-toolbar.mjs [端口]
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
  if (r?.exceptionDetails) return `★异常 ${r.exceptionDetails.exception?.description?.slice(0, 200)}`
  const v = r.result?.value
  return typeof v === 'string' ? v : JSON.stringify(v)
}

console.log('=== ① 工具条按钮状态 ===')
console.log(
  await evaluate(`(() => {
     const tools = Array.from(document.querySelectorAll('.drawbar__tool'));
     return JSON.stringify(tools.map(b => ({
       文字: b.textContent.trim(),
       class: b.className,
       有isActive: b.classList.contains('is-active'),
       ariaPressed: b.getAttribute('aria-pressed'),
       背景色: getComputedStyle(b).backgroundColor
     })));
   })()`)
)

console.log('\n=== ② 缩放计算相关元素 ===')
console.log(
  await evaluate(`(() => {
     const viewer = document.querySelector('.app__viewer');
     const pages = document.querySelector('.viewer-pages');
     const pageEl = document.querySelector('.pdf-page');
     const scroll = document.querySelector('.viewer-scroll');
     const vr = viewer.getBoundingClientRect();
     const pr = pageEl.getBoundingClientRect();
     const sr = scroll.getBoundingClientRect();
     const cs = getComputedStyle(scroll);
     const vs = getComputedStyle(viewer);
     return JSON.stringify({
       阅读区: Math.round(vr.width) + 'x' + Math.round(vr.height),
       阅读区内边距: vs.padding,
       滚动区: Math.round(sr.width) + 'x' + Math.round(sr.height),
       滚动区内边距: cs.padding,
       滚动区滚动条宽: scroll.offsetWidth - scroll.clientWidth,
       页面: Math.round(pr.width) + 'x' + Math.round(pr.height),
       页面容器类: pages ? pages.className : '(无)',
       页面容器宽: pages ? Math.round(pages.getBoundingClientRect().width) : 0,
       pages样式: pages ? (getComputedStyle(pages).padding + ' / gap=' + getComputedStyle(pages).gap) : ''
     });
   })()`)
)

ws.close()
