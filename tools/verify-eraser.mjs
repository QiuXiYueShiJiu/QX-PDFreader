// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 橡皮验证（位图墨迹版）。
 *
 * 背景：墨迹从 SVG path 改成位图 canvas 之后，
 * 命中判定从「elementsFromPoint 找 data-anno-id」
 * 变成「把点击点换算到页面坐标，算它到各条折线的距离」。
 * 这个脚本按新机制验证整条链路。
 *
 * ★ 顺序很重要：必须先打开橡皮再做命中检测。
 *   画笔模式下墨迹层的 pointer-events 是 none（这是对的，
 *   否则画笔模式会挡住文字选择），只有橡皮模式才打开。
 *
 * 用法：node tools/verify-eraser.mjs [端口]
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
function send(method, params = {}, timeoutMs = 10000) {
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
  if (r?.exceptionDetails) return `★异常 ${r.exceptionDetails.exception?.description?.slice(0, 180)}`
  const v = r.result?.value
  return typeof v === 'string' ? v : JSON.stringify(v)
}

async function step(label, expression) {
  const v = await evaluate(expression)
  console.log(`${label}: ${v}`)
  return v
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 统计墨迹位图的非透明像素（判断有没有笔迹） */
const INK_COUNT = `(() => {
  const ink = document.querySelector('.ink-canvas');
  if (!ink) return 0;
  const d = ink.getContext('2d').getImageData(0, 0, ink.width, ink.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 10) n++;
  return n;
})()`

/** 找出墨迹像素的包围盒并换算成页面坐标中点（用于精确点击） */
const INK_CENTER = `(() => {
  const ink = document.querySelector('.ink-canvas');
  const pageEl = document.querySelector('.pdf-page');
  if (!ink || !pageEl) return JSON.stringify({ ok: false });
  const { width: W, height: H } = ink;
  const d = ink.getContext('2d').getImageData(0, 0, W, H).data;
  let minX = W, maxX = -1, minY = H, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (d[(y * W + x) * 4 + 3] > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return JSON.stringify({ ok: false });
  const r = ink.getBoundingClientRect();
  // 位图像素 → 屏幕坐标
  const toScreenX = (px) => r.left + (px / W) * r.width;
  const toScreenY = (py) => r.top + (py / H) * r.height;
  return JSON.stringify({
    ok: true,
    x: Math.round(toScreenX((minX + maxX) / 2)),
    y: Math.round(toScreenY((minY + maxY) / 2))
  });
})()`

console.log('=== 橡皮验证（位图墨迹）===\n')

/* ---------- ① 准备一条笔迹 ---------- */
let inkPixels = await evaluate(INK_COUNT)
if (inkPixels < 100) {
  console.log('无笔迹，先画一条…')
  await evaluate(`(() => {
    const btn = Array.from(document.querySelectorAll('.drawbar__tool')).find(b => /画笔|绘画中/.test(b.textContent));
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
  for (let i = 1; i <= 30; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: sx + i * 10, y: sy, button: 'left', buttons: 1, pointerType: 'mouse'
    })
  }
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: sx + 300, y: sy, button: 'left', clickCount: 1, pointerType: 'mouse'
  })
  await sleep(1200)
  inkPixels = await evaluate(INK_COUNT)
}

await step('① 笔迹像素数', INK_COUNT)

/* ---------- ② 打开橡皮 ---------- */
await step(
  '② 打开橡皮',
  `(() => {
     const btn = Array.from(document.querySelectorAll('.drawbar__tool')).find(b => b.textContent.includes('橡皮'));
     if (!btn) return '★找不到橡皮按钮';
     if (btn.disabled) return '★橡皮按钮被禁用（说明没有批注）';
     if (!btn.classList.contains('is-active')) btn.click();
     return 'ok';
   })()`
)
await sleep(800)

await step(
  '② 橡皮状态',
  `JSON.stringify({
    橡皮激活: Array.from(document.querySelectorAll('.drawbar__tool')).some(b => b.classList.contains('is-active') && b.textContent.includes('橡皮')),
    滚动区类名: document.querySelector('.viewer-scroll')?.className,
    墨迹层pointerEvents: (() => {
      const ink = document.querySelector('.ink-canvas');
      return ink ? getComputedStyle(ink).pointerEvents : '(无墨迹层)';
    })()
  })`
)

/* ---------- ③ 点击墨迹中心，验证被擦除 ---------- */
const center = JSON.parse(await evaluate(INK_CENTER))
if (!center.ok) {
  console.error('★ 没有可点击的墨迹')
  ws.close()
  process.exit(1)
}
console.log(`   墨迹中心屏幕坐标: ${center.x},${center.y}`)

await send('Input.dispatchMouseEvent', {
  type: 'mousePressed', x: center.x, y: center.y, button: 'left', clickCount: 1, pointerType: 'mouse'
})
await send('Input.dispatchMouseEvent', {
  type: 'mouseReleased', x: center.x, y: center.y, button: 'left', clickCount: 1, pointerType: 'mouse'
})
await sleep(1200)

const after = await evaluate(INK_COUNT)
console.log(`③ 擦除后像素数: ${after}`)
console.log(`   结果: ${Number(after) < Number(inkPixels) * 0.5 ? '✓ 笔迹已擦除' : '★ 未被擦除'}`)

ws.close()
console.log('\n=== 验证结束 ===')
