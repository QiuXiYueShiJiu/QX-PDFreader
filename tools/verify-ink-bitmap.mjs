// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 验证「墨迹随页面变化」—— 位图墨迹的核心特性。
 *
 * 要证明两件事：
 *   ① 缩放时墨迹跟着页面一起缩放，位置不漂移（墨迹「长」在页面上）
 *   ② 墨迹是位图：分辨率固定，放大后被拉伸（而不是重新矢量化变清晰）
 *
 * 做法：在页面 bbox 内计算墨迹像素的归一化位置，
 * 缩放前后应当基本一致；同时位图像素尺寸应保持不变。
 *
 * 用法：node tools/verify-ink-bitmap.mjs [端口]
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 在墨迹位图里找出所有非透明像素的包围盒，
 * 再换算成「相对页面显示尺寸的归一化位置」。
 */
const MEASURE = `(() => {
  const ink = document.querySelector('.ink-canvas');
  const pageEl = document.querySelector('.pdf-page');
  if (!ink || !pageEl) return JSON.stringify({ ok: false, reason: ink ? '无页面' : '无墨迹层' });

  const ctx = ink.getContext('2d');
  const { width: W, height: H } = ink;
  const data = ctx.getImageData(0, 0, W, H).data;

  let minX = W, maxX = -1, minY = H, maxY = -1, count = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3] > 10) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const pr = pageEl.getBoundingClientRect();
  return JSON.stringify({
    ok: true,
    位图尺寸: W + 'x' + H,
    页面显示宽: Math.round(pr.width),
    墨迹像素数: count,
    // 归一化：0~1 表示墨迹在页面上的相对位置
    归一化左: count ? +(minX / W).toFixed(4) : null,
    归一化上: count ? +(minY / H).toFixed(4) : null,
    归一化右: count ? +(maxX / W).toFixed(4) : null,
    归一化下: count ? +(maxY / H).toFixed(4) : null
  });
})()`

console.log('=== 位图墨迹：随页面缩放验证 ===\n')

/* 确保有笔迹：没有就画一条 */
const hasInk = JSON.parse(await evaluate(MEASURE))
if (!hasInk.ok || hasInk.墨迹像素数 === 0) {
  console.log('当前无墨迹，先画一笔…')
  await evaluate(`(() => {
    const btn = Array.from(document.querySelectorAll('.drawbar__tool')).find(b => /画笔|绘画中/.test(b.textContent));
    if (btn && !btn.classList.contains('is-active')) btn.click();
  })()`)
  await sleep(600)

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
      type: 'mouseMoved', x: sx + i * 12, y: sy + Math.round(Math.sin(i / 3) * 20),
      button: 'left', buttons: 1, pointerType: 'mouse'
    })
  }
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: sx + 360, y: sy, button: 'left', clickCount: 1, pointerType: 'mouse'
  })
  await sleep(1200)
}

console.log('【缩放前】')
const before = JSON.parse(await evaluate(MEASURE))
console.log('  ' + JSON.stringify(before))

/* 换一档缩放 */
console.log('\n切换到「适应整页」（缩小）…')
await evaluate(`(() => {
  const s = document.querySelector('.zoom-select');
  if (s) { s.value = 'fit-page'; s.dispatchEvent(new Event('change', { bubbles: true })); }
})()`)
await sleep(2500)

console.log('【缩放后】')
const after = JSON.parse(await evaluate(MEASURE))
console.log('  ' + JSON.stringify(after))

/* 结论 */
console.log('\n=== 结论 ===')
if (before.ok && after.ok) {
  const posDrift =
    Math.abs(before.归一化左 - after.归一化左) +
    Math.abs(before.归一化上 - after.归一化上) +
    Math.abs(before.归一化右 - after.归一化右) +
    Math.abs(before.归一化下 - after.归一化下)

  console.log(`  位图尺寸是否固定: ${before.位图尺寸 === after.位图尺寸 ? '是 ✓（位图不重算）' : '否 ★（被重新光栅化了）'}`)
  console.log(`  页面显示宽变化: ${before.页面显示宽} → ${after.页面显示宽}`)
  console.log(`  归一化位置漂移: ${posDrift.toFixed(4)} ${posDrift < 0.02 ? '✓（墨迹跟着页面走）' : '★（墨迹跑位了）'}`)
}

ws.close()
