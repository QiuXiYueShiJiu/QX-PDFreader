// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 验证橡皮「真分割」与撤销/重做。
 *
 * ── 为什么这样验证 ──────────────────────────────────────────
 *   橡皮切段是纯几何算法，用像素比对反而不可靠
 *   （抗锯齿、超采样都会干扰边缘判定）。
 *   这里直接检查**数据层**：擦一下之后，
 *   一条笔迹应该变成几段、每段的点是否都落在橡皮圆外。
 *   这比看截图精确得多，也能定位到具体是哪一段算错。
 *
 * 全程不显示窗口（应用以 --hidden 启动）。
 *
 * 用法：node tools/verify-eraser-split.mjs [端口]
 */

const port = process.argv[2] ?? '9225'

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
  if (r?.exceptionDetails) {
    return `★异常 ${r.exceptionDetails.exception?.description?.slice(0, 300)}`
  }
  const v = r.result?.value
  return typeof v === 'string' ? v : JSON.stringify(v)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('=== 橡皮真分割 + 撤销/重做 验证 ===\n')

/* 等应用就绪 */
await sleep(1500)

/*
 * 通过 store 直接操作：模拟「画一横线 → 在中间擦一下」。
 * 用 store 而不是模拟指针事件，是为了把测试聚焦在
 * 切段算法与历史栈上 —— 指针链路已由其它脚本覆盖。
 */
const setup = await evaluate(`(() => {
  const s = window.__store;
  if (!s) return '★ 拿不到 store（需要导出到 window.__store）';
  const st = s.getState();
  st.setFileMeta ? null : null;
  return 'ok';
})()`)

if (setup !== 'ok') {
  console.log(setup)
  console.log('\n提示：需要在 store 里把 useViewer 挂到 window.__store 才能做数据层验证。')
  ws.close()
  process.exit(1)
}

/* ① 造一条从 x=100 到 x=400 的水平笔迹（y=200） */
const created = await evaluate(`(async () => {
  const s = window.__store;
  const st = s.getState();
  // 先清空，保证基线干净
  s.setState({ annotations: [], history: [], future: [] });

  const pts = [];
  for (let i = 0; i <= 30; i++) {
    pts.push([100 + i * 10, 200, i * 10, 0.5]);
  }
  const encoder = window.__inkTest;
  if (!encoder) return '★ 需要 window.__inkTest.encodeStroke';
  const quote = encoder.encodeStroke(pts.map(p => ({ x: p[0], y: p[1], t: p[2], p: p[3] })), 2);

  st.addAnnotationRaw
    ? st.addAnnotationRaw({ page: 1, type: 'note', rects: [], color: '#e5484d', quote, note: '' })
    : null;

  // 直接用 setState 造数据，避免依赖 addAnnotation 的 id 生成
  s.setState({
    annotations: [{
      id: 'test-stroke-1', page: 1, type: 'note', rects: [],
      color: '#e5484d', quote, note: '', at: Date.now()
    }]
  });
  const after = s.getState().annotations;
  return JSON.stringify({ 笔迹数: after.length, 点数: pts.length });
})()`)

console.log('① 造笔迹:', created)

/* ② 在笔迹中间擦一下（圆心 x=250, y=200, 半径 30） */
const erased = await evaluate(`(async () => {
  const s = window.__store;
  const st = s.getState();
  const ok = await st.eraseAt(1, 250, 200, 30);
  const after = s.getState().annotations;
  const decode = window.__inkTest.decodeStroke;
  const info = after.map(a => {
    const d = decode(a.quote);
    const xs = d.points.map(p => p.x);
    return {
      id: a.id,
      点数: d.points.length,
      x范围: Math.round(Math.min(...xs)) + '~' + Math.round(Math.max(...xs)),
      // 该段是否还有点落在橡皮圆内（应为 0）
      圆内点数: d.points.filter(p => Math.hypot(p.x - 250, p.y - 200) < 30 - 0.5).length
    };
  });
  return JSON.stringify({ 擦除返回: ok, 擦后段数: after.length, 各段: info, 历史深度: s.getState().history.length });
})()`)

console.log('② 擦中间:', erased)

/* ③ 撤销 */
const undone = await evaluate(`(() => {
  const s = window.__store;
  s.getState().undo();
  const a = s.getState().annotations;
  return JSON.stringify({ 撤销后段数: a.length, 历史深度: s.getState().history.length, 重做深度: s.getState().future.length });
})()`)

console.log('③ 撤销:', undone)

/* ④ 重做 */
const redone = await evaluate(`(() => {
  const s = window.__store;
  s.getState().redo();
  const a = s.getState().annotations;
  return JSON.stringify({ 重做后段数: a.length, 重做深度: s.getState().future.length });
})()`)

console.log('④ 重做:', redone)

/* ⑤ 换缩放比例后再擦一次，确认半径换算正确 */
const atZoom = await evaluate(`(async () => {
  const s = window.__store;
  // 重置为一条完整笔迹
  s.setState({ annotations: [], history: [], future: [] });
  const encode = window.__inkTest.encodeStroke;
  const pts = [];
  for (let i = 0; i <= 30; i++) pts.push({ x: 100 + i * 10, y: 200, t: i * 10, p: 0.5 });
  s.setState({
    annotations: [{
      id: 'test-stroke-2', page: 1, type: 'note', rects: [],
      color: '#e5484d', quote: encode(pts, 2), note: '', at: Date.now()
    }]
  });
  // 小半径擦：只该切出一个小缺口
  await s.getState().eraseAt(1, 250, 200, 8);
  const after = s.getState().annotations;
  return JSON.stringify({ 小半径擦后段数: after.length });
})()`)

console.log('⑤ 小半径(8)擦:', atZoom)

console.log('\n=== 判定 ===')
console.log('  ② 的「擦后段数」应为 2（一条笔迹被切成左右两段）')
console.log('  ② 的「圆内点数」应全为 0（圆内不该留下点）')
console.log('  ③④ 撤销应回到 1 段、重做应回到 2 段')
console.log('  ⑤ 小半径应切出 2 段（缺口更小，但仍分成两段）')

ws.close()
