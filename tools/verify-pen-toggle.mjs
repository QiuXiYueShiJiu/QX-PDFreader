// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 画笔切换与缩放状态检查。
 *
 * ⚠️ 已废弃（2026-10-16）：本脚本断言的是**旧行为** ——
 *   「点击笔进入绘画、再点一次退出到谁都不激活」+ 工具条上有 `.drawbar__exit` 按钮。
 *   用户已明确要求工具栏改成「画笔 / 橡皮 / 漫游 三选一，任何时刻恰好一个激活」，
 *   旧的「退出绘画」按钮已删除、再点画笔**不再退出**，所以本脚本的断言与产品相反。
 *   现行判据见 `tools/verify-roam.mjs`（32 条，已进套件）。
 *   保留本文件只为留档：旧的「退出」按钮长什么样、当时怎么测的。
 *
 * 原始用途（历史）：
 *   ① 「点击笔进入绘画，再点一次退出」——当时用户要求的行为
 *   ② 缩放倍数是否正常（此前观察到莫名停在 178%）
 *
 * 用法：node tools/verify-pen-toggle.mjs [端口]（**不要**再放进验证套件）
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

const STATE = `JSON.stringify({
  画布类名: document.querySelector('.viewer-scroll')?.className,
  画笔按钮激活: Array.from(document.querySelectorAll('.drawbar__tool')).some(b => b.classList.contains('is-active') && b.textContent.includes('画笔')),
  画笔按钮文字: (Array.from(document.querySelectorAll('.drawbar__tool')).find(b => b.textContent.includes('画笔') || b.textContent.includes('绘画中')) || {}).textContent,
  退出按钮可用: !(document.querySelector('.drawbar__exit')?.disabled ?? true),
  文字层可选: getComputedStyle(document.querySelector('.pdf-page__text')).userSelect,
  比例: document.querySelector('.rail__scale')?.textContent
})`

console.log('=== 画笔切换验证 ===\n')

console.log('初始:', await evaluate(STATE))

/* 第一次点击：进入绘画 */
await evaluate(`(() => {
  const btn = Array.from(document.querySelectorAll('.drawbar__tool')).find(b => b.textContent.includes('画笔'));
  if (btn) btn.click();
})()`)
await sleep(600)
console.log('点一次:', await evaluate(STATE))

/* 第二次点击：退出绘画 */
await evaluate(`(() => {
  // 按钮文字会变成「绘画中」，按两种文字都找一遍
  const btn = Array.from(document.querySelectorAll('.drawbar__tool')).find(b => /画笔|绘画中/.test(b.textContent));
  if (btn) btn.click();
})()`)
await sleep(600)
console.log('再点一次:', await evaluate(STATE))

/* 第三次点击：再次进入（确认可以反复切换） */
await evaluate(`(() => {
  const btn = Array.from(document.querySelectorAll('.drawbar__tool')).find(b => /画笔|绘画中/.test(b.textContent));
  if (btn) btn.click();
})()`)
await sleep(600)
console.log('第三次:', await evaluate(STATE))

/* 退出，回到可操作页面的状态 */
await evaluate(`(() => {
  const btn = Array.from(document.querySelectorAll('.drawbar__tool')).find(b => /画笔|绘画中/.test(b.textContent));
  if (btn && btn.classList.contains('is-active')) btn.click();
  const exit = document.querySelector('.drawbar__exit');
  if (exit && !exit.disabled) exit.click();
})()`)
await sleep(600)
console.log('退出后:', await evaluate(STATE))

/* 缩放详情：查清 178% 是怎么来的 */
console.log('\n=== 缩放详情 ===')
console.log(
  await evaluate(`(() => {
     const pageEl = document.querySelector('.pdf-page');
     const viewer = document.querySelector('.app__viewer');
     const pr = pageEl.getBoundingClientRect();
     const vr = viewer.getBoundingClientRect();
     return JSON.stringify({
       页面渲染宽: Math.round(pr.width),
       阅读区宽: Math.round(vr.width),
       阅读区高: Math.round(vr.height),
       缩放设置: document.querySelector('.zoom-select')?.value ?? '(无下拉)',
       显示比例: document.querySelector('.rail__scale')?.textContent
     });
   })()`)
)

ws.close()
