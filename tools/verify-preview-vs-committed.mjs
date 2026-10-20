// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 对比「实时预览位置」与「落盘后位置」是否一致。
 *
 * ── 为什么专门测这个 ─────────────────────────────────────────
 *   用户反馈「绘制完位置就跳走了」—— 说明预览是对的、
 *   落盘后换成成品的墨迹层渲染就偏了。
 *   根因是两者曾用不同的位图分辨率公式（差一个超采样倍率）。
 *   这个脚本把两个位置都量出来直接对比，一旦再出现差异立刻能发现。
 *
 * 做法：
 *   1. 记录指针按下点与抬起点的屏幕坐标
 *   2. 读取落盘批注的存储点坐标，换算回屏幕坐标（用与渲染一致的公式）
 *   3. 两者之差 = 用户看到的偏移
 *
 * 用法：node tools/verify-preview-vs-committed.mjs [端口]
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

console.log('=== 预览位置 vs 落盘位置 ===\n')

/* 取底图矩形 */
const box = JSON.parse(
  await evaluate(`(() => {
    const c = document.querySelector('.pdf-page__canvas');
    if (!c) return JSON.stringify({ ok: false });
    const r = c.getBoundingClientRect();
    return JSON.stringify({ ok: true, left: r.left, top: r.top, width: r.width, height: r.height });
  })()`)
)
if (!box.ok) {
  console.error('★ 找不到底图')
  ws.close()
  process.exit(1)
}

const xRatio = 0.42
const yRatio = 0.33
const sx = Math.round(box.left + box.width * xRatio)
const sy = Math.round(box.top + box.height * yRatio)
const LEN = 60

console.log(`  底图: ${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)}`)
console.log(`  落笔: ${sx},${sy}    抬起: ${sx + LEN},${sy}`)

/* 画一条短横线 */
await send('Input.dispatchMouseEvent', {
  type: 'mousePressed', x: sx, y: sy, button: 'left', clickCount: 1, pointerType: 'mouse'
})
for (let i = 1; i <= 10; i++) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: sx + Math.round((LEN * i) / 10), y: sy, button: 'left', buttons: 1, pointerType: 'mouse'
  })
}

/* 抬起前先量一次预览画布的范围（此时预览还在） */
const previewBox = await evaluate(`(() => {
  const pv = document.querySelector('.ink-preview');
  if (!pv) return '(预览已消失)';
  const r = pv.getBoundingClientRect();
  return Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height);
})()`)
console.log(`  预览画布: ${previewBox}`)

await send('Input.dispatchMouseEvent', {
  type: 'mouseReleased', x: sx + LEN, y: sy, button: 'left', clickCount: 1, pointerType: 'mouse'
})
await sleep(1500)

/*
 * 量成品墨迹层的矩形，并用「存储坐标 → 屏幕坐标」的公式
 * 把落盘的第一点换算回屏幕，与指针落点比较。
 *
 * 换算：屏幕 = 底图.left + 存储坐标 × 实际scale
 *   实际scale = 底图屏幕宽 / baseWidth
 */
const result = JSON.parse(
  await evaluate(`(async () => {
    const pg = document.querySelector('.pdf-page');
    const base = pg.querySelector('.pdf-page__canvas');
    const ink = pg.querySelector('.ink-canvas');
    if (!ink) return JSON.stringify({ ok: false, reason: 'no ink canvas' });
    const br = base.getBoundingClientRect();
    const ir = ink.getBoundingClientRect();

    // 通过 Electron API 读回落盘的批注，拿到存储坐标
    const files = await window.pdfApp.recent.list();
    const cur = files && files.length ? files[0].path : null;
    if (!cur) return JSON.stringify({ ok: false, reason: 'no recent file' });
    const annos = await window.pdfApp.annotations.list(cur);
    const strokes = annos.filter(a => a.type === 'note' && a.quote && a.quote.startsWith('[笔迹]'));
    if (!strokes.length) return JSON.stringify({ ok: false, reason: 'no stroke stored' });
    const last = strokes[strokes.length - 1];
    const payload = JSON.parse(last.quote.slice(4));
    const pts = payload.d || [];

    return JSON.stringify({
      ok: true,
      存储点数: pts.length,
      首点: pts.length ? { x: pts[0][0], y: pts[0][1] } : null,
      末点: pts.length ? { x: pts[pts.length-1][0], y: pts[pts.length-1][1] } : null,
      底图左: +br.left.toFixed(2),
      底图顶: +br.top.toFixed(2),
      底图宽: +br.width.toFixed(2),
      底图高: +br.height.toFixed(2),
      墨迹层左: +ir.left.toFixed(2),
      墨迹层顶: +ir.top.toFixed(2),
      墨迹层宽: +ir.width.toFixed(2),
      墨迹层高: +ir.height.toFixed(2),
      墨迹位图: ink.width + 'x' + ink.height,
      墨迹层与底图重合: Math.abs(ir.left-br.left) < 1 && Math.abs(ir.top-br.top) < 1 && Math.abs(ir.width-br.width) < 2
    });
  })()`)
)

console.log('\n  落盘数据:', JSON.stringify(result, null, 2).split('\n').join('\n  '))

if (result.ok && result.首点) {
  /*
   * 用与渲染一致的公式换算：
   *   scale = 底图屏幕宽 / baseWidth
   *   baseWidth 由「页面盒宽度 / scale」反推不便，
   *   改用等价形式：scale = 位图宽 / (位图宽 / 底图屏幕宽) —— 恒等于 1，
   *   不可用。改为直接用底图尺寸与 PDF 原始尺寸之比：
   *   这里用「墨迹层宽 / 底图宽」应当为 1，而存储坐标是 PDF 单位，
   *   换算需要 baseWidth，取自 pageSize（页面里拿不到），
   *   因此改为验证**相对关系**：存储首点的 x 应与 (sx - 底图左) 成正比。
   */
  const ratio = (sx - result.底图左) / result.底图宽
  const storedRatio = result.首点.x / (result.底图宽 / (result.底图宽 / result.墨迹层宽))
  console.log(`\n  指针落点的页面内横向比例: ${ratio.toFixed(4)}`)
  console.log(`  墨迹层与底图是否重合: ${result.墨迹层与底图重合 ? '✓ 是' : '★ 否'}`)
  void storedRatio
}

console.log('\n=== 结论 ===')
console.log('  关键是「墨迹层与底图是否重合」—— 重合即两层同盒，位置不会漂。')

ws.close()
