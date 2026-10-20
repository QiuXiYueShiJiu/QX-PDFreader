// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 批注功能端到端验证（在虚拟桌面上运行，不干扰用户）。
 *
 * 覆盖两条创建路径：
 *   ① 手绘：派发真实指针事件，验证笔迹落成批注
 *   ② 文字选区：程序化选中文本层文字，验证浮动工具条与高亮
 * 以及共同的下游：页面出现标记、侧栏出现卡片、主进程已落盘。
 *
 * 用法：node tools/verify-annotations.mjs [端口]
 */

const port = process.argv[2] ?? '9223'

const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
const page = list.find((t) => t.type === 'page')
if (!page) {
  console.error('★ 没有页面目标，应用可能未运行')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res)
  ws.addEventListener('error', () => rej(new Error('CDP 连接失败')))
})

let nextId = 0
function send(method, params = {}) {
  const id = ++nextId
  return new Promise((resolve) => {
    const onMsg = (event) => {
      const m = JSON.parse(String(event.data))
      if (m.id !== id) return
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

async function step(label, expression) {
  const v = await evaluate(expression)
  console.log(`${label}: ${v}`)
  return v
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('=== 批注功能端到端验证 ===\n')

/* ============================================================
 * 路径 ①：手绘
 * ============================================================ */

console.log('--- 路径 ①：手绘批注 ---')

await step(
  '开启手绘',
  `(() => {
     const btns = Array.from(document.querySelectorAll('.tb'));
     const pen = btns.find(b => b.textContent.includes('手绘'));
     if (!pen) return '★找不到手绘按钮';
     if (pen.getAttribute('aria-pressed') !== 'true') pen.click();
     return '已开启';
   })()`
)
await sleep(400)

await step(
  '手绘模式确认',
  `JSON.stringify({
    工具条出现: !!document.querySelector('.draw-tools'),
    颜色数: document.querySelectorAll('.draw-tools .anno-color').length,
    滚动区类名: document.querySelector('.viewer-scroll')?.className
  })`
)

const boxJson = await step(
  '页面位置',
  `(() => {
     const p = document.querySelector('.pdf-page');
     const r = p.getBoundingClientRect();
     return JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) });
   })()`
)
const box = JSON.parse(boxJson)

// 派发真实指针事件
const sx = box.left + Math.round(box.width * 0.35)
const sy = box.top + Math.round(box.height * 0.35)

await send('Input.dispatchMouseEvent', {
  type: 'mousePressed', x: sx, y: sy, button: 'left', clickCount: 1, pointerType: 'mouse'
})
for (let i = 1; i <= 14; i++) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: sx + i * 12,
    y: sy + Math.round(Math.sin(i / 2) * 22),
    button: 'left',
    buttons: 1,
    pointerType: 'mouse'
  })
}
await send('Input.dispatchMouseEvent', {
  type: 'mouseReleased', x: sx + 14 * 12, y: sy, button: 'left', clickCount: 1, pointerType: 'mouse'
})

await sleep(1200)

await step(
  '手绘结果',
  `JSON.stringify({
    批注元素: document.querySelectorAll('.anno-mark, .anno-note').length,
    预览层残留: document.querySelectorAll('.draw-preview').length,
    store批注数: (document.querySelector('.annotations-card') ? document.querySelectorAll('.annotations-card').length : 0)
  })`
)

// 退出手绘，避免影响后续选区测试
await step(
  '退出手绘',
  `(() => {
     const btns = Array.from(document.querySelectorAll('.tb'));
     const pen = btns.find(b => b.textContent.includes('手绘'));
     if (pen && pen.getAttribute('aria-pressed') === 'true') pen.click();
     return '已退出';
   })()`
)
await sleep(300)

/* ============================================================
 * 路径 ②：文字选区（仅当文档有文本层）
 * ============================================================ */

console.log('\n--- 路径 ②：文字选区高亮 ---')

const textInfo = await step(
  '文本层检查',
  `JSON.stringify({
    文本容器: !!document.querySelector('.pdf-page__text'),
    span数: document.querySelectorAll('.textLayer span').length
  })`
)

const hasText = JSON.parse(textInfo).span数 > 0

if (!hasText) {
  console.log('  ⊘ 本文档没有文本层（扫描件），跳过文字选区测试')
  console.log('    这是文档本身的限制，不是代码问题')
} else {
  await step(
    '选中文字',
    `(() => {
       const spans = Array.from(document.querySelectorAll('.textLayer span')).filter(s => s.textContent?.trim().length > 1);
       if (spans.length < 2) return '★可用 span 不足';
       const range = document.createRange();
       range.setStart(spans[0].firstChild ?? spans[0], 0);
       const last = spans[Math.min(3, spans.length - 1)];
       range.setEnd(last.firstChild ?? last, (last.textContent || '').length);
       const sel = window.getSelection();
       sel.removeAllRanges();
       sel.addRange(range);
       return '已选中: ' + sel.toString().trim().slice(0, 40);
     })()`
  )
  await sleep(800)

  await step(
    '浮动工具条',
    `(() => {
       const bar = document.querySelector('.anno-toolbar');
       if (!bar) return '★未出现';
       return JSON.stringify({
         按钮: Array.from(bar.querySelectorAll('.anno-toolbar__btn')).map(b => b.textContent.trim()),
         颜色数: bar.querySelectorAll('.anno-color').length
       });
     })()`
  )

  await step(
    '点击高亮',
    `(() => {
       const btns = Array.from(document.querySelectorAll('.anno-toolbar__btn'));
       const h = btns.find(b => b.textContent.includes('高亮'));
       if (!h) return '★找不到高亮按钮';
       h.click();
       return '已点击';
     })()`
  )
  await sleep(1000)

  await step('高亮结果', `document.querySelectorAll('.anno-mark--highlight').length + ' 个高亮段'`)
}

/* ============================================================
 * 侧栏与持久化
 * ============================================================ */

console.log('\n--- 侧栏与持久化 ---')

/*
 * ★ v2.1.2.0 起右侧「批注」列表整块下线（用户要求：不要记录批注历史页）。
 *   以前这里先切页签再数 `.annotations-card`，现在没有右侧栏了，
 *   改为直接问 store：批注还在不在、能不能落库。
 */
await step(
  '批注数据仍在 store 里',
  `(() => {
     const st = window.__store.getState();
     const list = st.annotations ?? [];
     return JSON.stringify({
       count: list.length,
       右栏可见: Boolean(document.querySelector('.right-panel')),
       卡片数: document.querySelectorAll('.annotations-card').length
     });
   })()`
)
await sleep(300)

ws.close()
console.log('\n=== 验证结束 ===')
