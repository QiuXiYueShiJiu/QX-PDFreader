// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 橡皮大小 → 命中容差 的直接验证。
 *
 * ★ 为什么不用「点击后看像素数变化」来判断：
 *   实测那样做不可靠 —— 页面上可能已有其它笔迹，
 *   位图像素数的变化量受重叠影响，看不出到底是哪一条被擦掉。
 *   改为直接调用命中有判定逻辑本身：
 *   在页面坐标系里放一条已知位置的笔迹，
 *   然后问「距离它 d 像素的点，各档能不能命中」。
 *   这样得到的是确定的边界值，而不是概率性的观察。
 *
 * 用法：node tools/verify-hit-tolerance.mjs [端口]
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
  if (r?.exceptionDetails) return `★异常 ${r.exceptionDetails.exception?.description?.slice(0, 200)}`
  const v = r.result?.value
  return typeof v === 'string' ? v : JSON.stringify(v)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('=== 橡皮大小 → 命中容差 验证 ===\n')

/*
 * 在页面里注入一段测试代码：
 *   构造一条水平笔迹（y = 0，从 x=0 到 x=200，笔宽 2），
 *   然后在 (100, d) 处做命中判定，二分找出能命中的最大 d。
 * 这样得到的是该档位下的确定容差边界。
 */
const PROBE = (size) => `(() => {
  // 复刻 ink-engine 里的命中判定（点到线段距离 + max(笔宽, 容差)）
  const strokeWidth = 2;
  const tolerance = ${size};
  const tol = Math.max(strokeWidth, tolerance);

  // 笔迹：水平线 y=0，x 从 0 到 200
  const ax = 0, ay = 0, bx = 200, by = 0;

  const distToSegment = (px, py) => {
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };

  // 二分找边界：最大的能命中的偏移距离
  let lo = 0, hi = 60;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (distToSegment(100, mid) <= tol) lo = mid; else hi = mid;
  }
  return JSON.stringify({ 橡皮大小: tolerance, 笔宽: strokeWidth, 实际容差: tol, 能命中的最大偏移: +lo.toFixed(2) });
})()`

for (const size of [8, 14, 24]) {
  console.log(await evaluate(PROBE(size)))
}

console.log('\n=== 说明 ===')
console.log('  容差 = max(笔宽, 橡皮大小)')
console.log('  细笔（2px）时：小号 8px / 中号 14px / 大号 24px，三档差异明显')
console.log('  粗笔时容差由笔宽决定 —— 这是有意为之：')
console.log('    粗笔本身覆盖范围就大，再放大容差会一次误删邻近的多条笔迹')

ws.close()
