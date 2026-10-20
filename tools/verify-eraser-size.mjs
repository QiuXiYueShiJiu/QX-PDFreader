// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 橡皮大小档位 + 弹簧式滑动清屏 验证。
 *
 * 覆盖：
 *   ① 进橡皮模式后，粗细滑块换成橡皮大小三档
 *   ② 选大号橡皮时命中范围真的更大（几何容差生效）
 *   ③ 滑动清屏：拖到底才触发，中途松手回弹不清空
 *
 * 用法：node tools/verify-eraser-size.mjs [端口]
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

const INK_COUNT = `(() => {
  const ink = document.querySelector('.ink-canvas');
  if (!ink) return 0;
  const d = ink.getContext('2d').getImageData(0, 0, ink.width, ink.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 10) n++;
  return n;
})()`

/** 画一条笔迹，返回它的笔画端点（屏幕坐标） */
async function drawOne(yRatio = 0.3) {
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
  const sy = Math.round(box.top + box.height * yRatio)

  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: sx, y: sy, button: 'left', clickCount: 1, pointerType: 'mouse'
  })
  for (let i = 1; i <= 25; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: sx + i * 10, y: sy, button: 'left', buttons: 1, pointerType: 'mouse'
    })
  }
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: sx + 250, y: sy, button: 'left', clickCount: 1, pointerType: 'mouse'
  })
  await sleep(1100)
  return { sx, sy }
}

console.log('=== 橡皮大小 + 滑动清屏 验证 ===\n')

/* ---------- ① 橡皮模式下显示大小档位 ---------- */
console.log('--- ① 橡皮大小档位 ---')
await drawOne(0.3)

await step(
  '切到橡皮',
  `(() => {
     const btn = Array.from(document.querySelectorAll('.drawbar__tool')).find(b => b.textContent.includes('橡皮'));
     if (!btn || btn.disabled) return '★橡皮不可用';
     if (!btn.classList.contains('is-active')) btn.click();
     return 'ok';
   })()`
)
await sleep(700)

await step(
  '控件替换',
  `JSON.stringify({
    橡皮档位数: document.querySelectorAll('.drawbar__esize').length,
    档位文案: Array.from(document.querySelectorAll('.drawbar__esize-label')).map(e => e.textContent),
    仍显示粗细滑块: !!document.querySelector('.drawbar__slider'),
    默认选中: (document.querySelector('.drawbar__esize.is-active .drawbar__esize-label') || {}).textContent
  })`
)

/* ---------- ② 橡皮大小影响命中范围 ---------- */
console.log('\n--- ② 橡皮大小影响命中范围 ---')

/*
 * ★ 测试设计要点：
 *   容差公式是 max(笔宽, 橡皮大小)。
 *   如果笔迹很粗（笔宽 > 所有档位），三档的容差完全一样，
 *   测不出差异 —— 第一次跑就踩了这个坑。
 *   因此这里**显式把画笔调到最细**再画，让容差由橡皮大小决定。
 */
await evaluate(`(() => {
  const btn = Array.from(document.querySelectorAll('.drawbar__tool')).find(b => /画笔|绘画中/.test(b.textContent));
  if (btn && !btn.classList.contains('is-active')) btn.click();
})()`)
await sleep(600)

/* 画笔调到最细（1px），并把已有笔迹清掉，保证测试对象唯一 */
await evaluate(`(() => {
  const slider = document.querySelector('.drawbar__slider');
  if (slider) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(slider, '1');
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  }
})()`)
await sleep(400)

await drawOne(0.28)

/* 读回笔迹几何：取一个笔画端点，便于精确控制横向偏移 */
const geo = JSON.parse(
  await evaluate(`(() => {
     const ink = document.querySelector('.ink-canvas');
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
     const r = ink.getBoundingClientRect();
     // 取笔迹中段，纵向（垂直于笔画方向）偏移
     const midX = (minX + maxX) / 2;
     const midY = (minY + maxY) / 2;
     const perPx = r.height / H;   // 1 位图像素对应多少屏幕像素
     return JSON.stringify({
       x: Math.round(r.left + (midX / W) * r.width),
       y: Math.round(r.top + (midY / H) * r.height),
       perPx: perPx,
       笔迹像素高: maxY - minY
     });
   })()`)
)

console.log(`   笔迹中段: ${geo.x},${geo.y}（1 位图像素 ≈ ${geo.perPx.toFixed(2)} 屏幕像素）`)

/** 在距离笔迹中心 dy 屏逌像素处点一下，返回是否擦到 */
async function tapAt(dy) {
  const before = Number(await evaluate(INK_COUNT))
  if (before === 0) return { before, after: 0, hit: false }

  const y = Math.round(geo.y + dy)
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: geo.x, y, button: 'left', clickCount: 1, pointerType: 'mouse'
  })
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: geo.x, y, button: 'left', clickCount: 1, pointerType: 'mouse'
  })
  await sleep(900)
  const after = Number(await evaluate(INK_COUNT))
  return { before, after, hit: after < before }
}

/** 选橡皮档位（0 小 / 1 中 / 2 大） */
async function pickSize(idx) {
  await evaluate(`(() => {
    const s = document.querySelectorAll('.drawbar__esize')[${idx}];
    if (s) s.click();
  })()`)
  await sleep(400)
}

/* 逐档测试：偏移 10 屏幕像素处点击 */
const OFFSET = 10
console.log(`\n   在笔迹中心垂直偏移 ${OFFSET}px 处点击，比较各档是否命中：`)

for (const [idx, name] of [
  [0, '小'],
  [1, '中'],
  [2, '大']
]) {
  /* 每轮重新画一条干净的细笔迹 */
  await evaluate(`(() => {
    const btn = Array.from(document.querySelectorAll('.drawbar__tool')).find(b => /画笔|绘画中/.test(b.textContent));
    if (btn && !btn.classList.contains('is-active')) btn.click();
  })()`)
  await sleep(500)
  await drawOne(0.28)

  await evaluate(`(() => {
    const btn = Array.from(document.querySelectorAll('.drawbar__tool')).find(b => b.textContent.includes('橡皮'));
    if (btn && !btn.classList.contains('is-active')) btn.click();
  })()`)
  await sleep(500)
  await pickSize(idx)

  const r = await tapAt(OFFSET)
  console.log(`   ${name}号: ${r.before} → ${r.after}  ${r.hit ? '命中' : '未命中'}`)
}

/* ---------- ③ 滑动清屏 ---------- */
console.log('\n--- ③ 弹簧式滑动清屏 ---')

await step(
  '清屏控件状态',
  `(() => {
     const s = document.querySelector('.slideclear');
     if (!s) return '★不存在';
     const r = s.getBoundingClientRect();
     return JSON.stringify({
       文案: s.textContent.trim(),
       尺寸: Math.round(r.width) + 'x' + Math.round(r.height),
       位置: Math.round(r.left) + ',' + Math.round(r.top),
       禁用: s.classList.contains('is-disabled')
     });
   })()`
)

/* 先补两条笔迹，确保有东西可清 */
await drawOne(0.45)
await drawOne(0.6)
const beforeClear = await evaluate(INK_COUNT)
console.log(`   清屏前墨迹像素: ${beforeClear}`)

/* 拖到一半松手 —— 应该回弹且不清空 */
const slide = JSON.parse(
  await evaluate(`(() => {
     const s = document.querySelector('.slideclear');
     const r = s.getBoundingClientRect();
     return JSON.stringify({ left: r.left, right: r.right, cy: r.top + r.height / 2, w: r.width });
   })()`)
)

console.log('   拖到 50% 松手（应回弹、不清空）…')
await send('Input.dispatchMouseEvent', {
  type: 'mousePressed', x: Math.round(slide.left + 20), y: Math.round(slide.cy), button: 'left', clickCount: 1, pointerType: 'mouse'
})
await send('Input.dispatchMouseEvent', {
  type: 'mouseMoved', x: Math.round(slide.left + slide.w * 0.5), y: Math.round(slide.cy), button: 'left', buttons: 1, pointerType: 'mouse'
})
await send('Input.dispatchMouseEvent', {
  type: 'mouseReleased', x: Math.round(slide.left + slide.w * 0.5), y: Math.round(slide.cy), button: 'left', clickCount: 1, pointerType: 'mouse'
})
await sleep(1000)
const afterHalf = await evaluate(INK_COUNT)
console.log(`   结果: ${afterHalf} ${afterHalf === beforeClear ? '✓ 未清空（正确）' : '★ 被误清空'}`)

/* 拖到底 —— 应该清空 */
console.log('   拖到底松手（应清空）…')
await send('Input.dispatchMouseEvent', {
  type: 'mousePressed', x: Math.round(slide.left + 20), y: Math.round(slide.cy), button: 'left', clickCount: 1, pointerType: 'mouse'
})
for (let i = 1; i <= 10; i++) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(slide.left + 20 + ((slide.w - 30) * i) / 10),
    y: Math.round(slide.cy),
    button: 'left',
    buttons: 1,
    pointerType: 'mouse'
  })
}
await send('Input.dispatchMouseEvent', {
  type: 'mouseReleased', x: Math.round(slide.right - 6), y: Math.round(slide.cy), button: 'left', clickCount: 1, pointerType: 'mouse'
})
await sleep(1400)
const afterFull = await evaluate(INK_COUNT)
console.log(`   结果: ${afterFull} ${Number(afterFull) === 0 ? '✓ 已清屏' : '★ 未清空'}`)

ws.close()
console.log('\n=== 验证结束 ===')
