// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 验证「缩放白屏」是否修复。
 *
 * 判定方法：切换缩放后，立刻采样 PDF 画布的非白像素比例。
 *   白屏时画布内容为空 → 几乎全是白色（alpha 区域无内容）。
 *   修复后画布上会先有「拉伸的旧画面」→ 非白像素比例保持较高。
 *
 * 注意：canvas 用 alpha:false 创建，空白区域是黑色还是白色取决于
 * 背景填充，因此这里统计「非纯白」像素的比例，而不是看 alpha 通道。
 *
 * 用法：node tools/verify-zoom-flash.mjs [端口]
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
  if (r?.exceptionDetails) return `★异常 ${r.exceptionDetails.exception?.description?.slice(0, 180)}`
  const v = r.result?.value
  return typeof v === 'string' ? v : JSON.stringify(v)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 采样 PDF 画布：统计「非纯白」像素占比（白屏时接近 0） */
const SAMPLE = `(() => {
  const c = document.querySelector('.pdf-page__canvas');
  if (!c || c.width < 2) return JSON.stringify({ ok: false, reason: 'no canvas' });
  const ctx = c.getContext('2d', { alpha: false });
  if (!ctx) return JSON.stringify({ ok: false, reason: 'no ctx' });
  // 只采中间一条横带，避免整张图 getImageData 太慢
  const y = Math.floor(c.height / 2);
  const h = Math.min(40, c.height - y);
  const d = ctx.getImageData(0, y, c.width, h).data;
  let nonWhite = 0, total = 0;
  for (let i = 0; i < d.length; i += 4) {
    total++;
    // 阈值放宽到 240：纸质底色（#f5f1e8 之类）也算"有内容"
    if (d[i] < 240 || d[i+1] < 240 || d[i+2] < 240) nonWhite++;
  }
  return JSON.stringify({
    ok: true,
    画布: c.width + 'x' + c.height,
    非白占比: +(nonWhite / total).toFixed(4)
  });
})()`

console.log('=== 缩放白屏验证 ===\n')

console.log('初始状态:', await evaluate(SAMPLE))

/*
 * ★ 采样必须在**浏览器绘制帧内**做。
 *   之前在缩放后等固定毫秒再采样，抓到的是「命令往返之后」的状态，
 *   已经错过了真正会被画到屏幕上的那一帧（实测第一次采样 0、后两次 0.2，
 *   数值随机，说明测的是时序抖动而不是真实白屏）。
 *   改成用 requestAnimationFrame 在下一帧回调里采样 ——
 *   这正是用户眼睛会看到的那一帧。
 */
const SAMPLE_NEXT_FRAME = `(async () => {
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  ${SAMPLE.replace(/^\(\(\) => \{/, '').replace(/\}\)\(\)$/, '')}
})()`

for (const z of ['0.75', '1.5', '2', 'fit-width']) {
  const result = await evaluate(`(async () => {
    const s = document.querySelector('.zoom-select');
    if (s) { s.value = '${z}'; s.dispatchEvent(new Event('change', { bubbles: true })); }
    // 等两帧：第一帧是尺寸变更生效，第二帧是绘制完成
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    ${SAMPLE.replace('(() => {', '').replace(/\}\)\(\)$/, '').replace(/^/, 'return (function(){').concat('})()')}
  })()`)

  console.log(`  切到 ${z} 后第 2 帧:`, result)
}

console.log('\n=== 结论 ===')
console.log('  第 2 帧若仍有内容（非白占比 > 0），说明缩放瞬间画布不为空，白屏已消除。')

ws.close()

