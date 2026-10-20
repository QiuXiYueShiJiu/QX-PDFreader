// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 验证「墨迹与底图永久对齐」。
 *
 * 判定标准：无论缩放到哪一档，墨迹 canvas 与底图 canvas 的
 *   屏幕矩形（left/top/width/height）必须完全重合。
 * 两者一旦有偏差，用户看到的笔迹就会整体偏移 ——
 * 这正是「位置不同步」的本质。
 *
 * 用法：node tools/verify-ink-align.mjs [端口]
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
function send(method, params = {}, timeoutMs = 15000) {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 量两层 canvas 的屏幕矩形与位图尺寸 */
const MEASURE = `(() => {
  const pg = document.querySelector('.pdf-page');
  const base = pg && pg.querySelector('.pdf-page__canvas');
  const ink = pg && pg.querySelector('.ink-canvas');
  if (!base || !ink) return JSON.stringify({ ok: false, base: !!base, ink: !!ink });
  const b = base.getBoundingClientRect();
  const i = ink.getBoundingClientRect();
  return JSON.stringify({
    ok: true,
    比例: document.querySelector('.rail__scale') ? document.querySelector('.rail__scale').textContent : '?',
    位图: ink.width + 'x' + ink.height,
    基线左: +b.left.toFixed(2), 基线顶: +b.top.toFixed(2),
    墨左: +i.left.toFixed(2), 墨顶: +i.top.toFixed(2),
    偏差左: +(i.left - b.left).toFixed(3),
    偏差顶: +(i.top - b.top).toFixed(3),
    偏差宽: +(i.width - b.width).toFixed(3),
    偏差高: +(i.height - b.height).toFixed(3)
  });
})()`

console.log('=== 墨迹与底图对齐验证 ===\n')

/* 先确保有笔迹（墨迹层只在有批注时渲染） */
const has = JSON.parse(await evaluate(MEASURE))
if (!has.ok) {
  console.log('无墨迹层，先画一笔…')
  await evaluate(`(() => {
    const btn = Array.from(document.querySelectorAll('.rail-btn')).find(b => b.textContent.includes('批注'));
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
  const sy = Math.round(box.top + box.height * 0.3)

  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: sx, y: sy, button: 'left', clickCount: 1, pointerType: 'mouse'
  })
  for (let i = 1; i <= 20; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: sx + i * 10, y: sy, button: 'left', buttons: 1, pointerType: 'mouse'
    })
  }
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: sx + 200, y: sy, button: 'left', clickCount: 1, pointerType: 'mouse'
  })
  await sleep(1200)
}

console.log('当前:', await evaluate(MEASURE))

/* 依次切换缩放，每档都量一次 */
console.log('\n--- 切换缩放后逐档检查 ---')
for (const op of ['放大', '放大', '缩小', '缩小', '缩小', '放大', '放大', '放大']) {
  await evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('.rail-btn')).find(x => x.textContent.trim() === '${op}');
    if (b) b.click();
  })()`)
  await sleep(2200)
  const m = JSON.parse(await evaluate(MEASURE))
  const maxDev = Math.max(
    Math.abs(m.偏差左 ?? 99),
    Math.abs(m.偏差顶 ?? 99),
    Math.abs(m.偏差宽 ?? 99),
    Math.abs(m.偏差高 ?? 99)
  )
  console.log(
    `  ${op} → ${m.比例}  偏差(左/顶/宽/高) = ${m.偏差左}/${m.偏差顶}/${m.偏差宽}/${m.偏差高}  ` +
      (maxDev < 1.5 ? '✓ 对齐' : '★ 错位!')
  )
}

console.log('\n=== 结论 ===')
console.log('  偏差全部 < 1.5px 表示两层始终重合，位置不会漂移。')

ws.close()
