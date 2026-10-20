// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 验证缩放白屏是否消除（轻量采样版）。
 *
 * 为什么不全量扫描：
 *   超采样后墨迹位图有 2678×3789 ≈ 1000 万像素，
 *   getImageData + 遍历会超时。
 *   这里只采 PDF 底图的一小块区域（几百像素），足够判断"是否有内容"。
 *
 * 判定：切换缩放后，在**下一帧**采样底图。
 *   有内容（非白占比 > 0）→ 快照回填生效，无白屏。
 *   接近 0 → 仍是白屏。
 *
 * 用法：node tools/verify-zoom-flash2.mjs [端口]
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
function send(method, params = {}, timeoutMs = 20000) {
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

/** 采样底图中心一小块：返回非白像素占比 */
const PROBE = `
  const c = document.querySelector('.pdf-page__canvas');
  if (!c || c.width < 4) return 'no-canvas';
  const s = 60;
  const x = Math.floor(c.width / 2) - s;
  const y = Math.floor(c.height / 2) - s;
  const d = c.getContext('2d', { alpha: false }).getImageData(x, y, s * 2, s * 2).data;
  let nw = 0, total = 0;
  for (let i = 0; i < d.length; i += 4) { total++; if (d[i] < 240 || d[i+1] < 240 || d[i+2] < 240) nw++; }
  return (nw / total).toFixed(3) + ' | 画布 ' + c.width + 'x' + c.height;
`

console.log('=== 缩放白屏验证（下一帧采样）===\n')

console.log('初始:', await evaluate(`(() => { ${PROBE} })()`))

for (const op of ['放大', '放大', '缩小', '缩小', '缩小', '放大', '放大']) {
  const r = await evaluate(`(async () => {
    const b = Array.from(document.querySelectorAll('.rail-btn')).find(x => x.textContent.trim() === '${op}');
    if (b) b.click();
    // 等两帧：第一帧应用尺寸变更、第二帧完成绘制
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    ${PROBE}
  })()`)
  console.log(`  ${op} 后第 2 帧: ${r}`)
}

console.log('\n=== 结论 ===')
console.log('  非白占比若明显大于 0，说明缩放瞬间底图上有内容（快照回填生效），无白屏。')

ws.close()
