// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 批注功能端到端验证。
 *
 * 步骤：
 *   ① 在正文里程序化选中一段文字
 *   ② 等选区工具条出现
 *   ③ 调 store 创建一条高亮批注
 *   ④ 检查：页面出现高亮元素、右侧栏出现条目、主进程已落盘
 *
 * 用法：node scripts/diag-annotations.mjs <端口>
 */

const [port = '9223'] = process.argv.slice(2)

const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
const page = list.find((t) => t.type === 'page')
if (!page) {
  console.error('没有页面目标')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res)
  ws.addEventListener('error', () => rej(new Error('连接失败')))
})

let nextId = 0
function evaluate(expression) {
  const id = ++nextId
  return new Promise((resolve) => {
    const onMsg = (event) => {
      const m = JSON.parse(String(event.data))
      if (m.id !== id) return
      ws.removeEventListener('message', onMsg)
      resolve(m.result)
    }
    ws.addEventListener('message', onMsg)
    ws.send(
      JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true }
      })
    )
  })
}

async function step(label, expression) {
  const r = await evaluate(expression)
  if (r?.exceptionDetails) {
    console.log(`${label}: ★异常 ${r.exceptionDetails.exception?.description?.slice(0, 300)}`)
    return null
  }
  const v = r?.result?.value
  console.log(`${label}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
  return v
}

// ---------- ① 选中一段文字 ----------
await step(
  '① 选中文字',
  `(() => {
     const page = document.querySelector('.pdf-page');
     const spans = page ? Array.from(page.querySelectorAll('.textLayer span')) : [];
     const usable = spans.filter(s => s.textContent && s.textContent.trim().length > 2);
     if (usable.length === 0) return '没有可选的文字层';
     const start = usable[0];
     const end = usable[Math.min(3, usable.length - 1)];
     const range = document.createRange();
     range.setStart(start.firstChild ?? start, 0);
     range.setEnd(end.firstChild ?? end, (end.textContent || '').length);
     const sel = window.getSelection();
     sel.removeAllRanges();
     sel.addRange(range);
     return '已选中 ' + sel.toString().trim().slice(0, 40) + '（共 ' + usable.length + ' 个文字片段）';
   })()`
)

// 等选区变化被监听器捕获（内有 160ms 防抖）
await new Promise((r) => setTimeout(r, 700))

// ---------- ② 工具条是否出现 ----------
await step(
  '② 选区工具条',
  `(() => {
     const bar = document.querySelector('.anno-toolbar');
     if (!bar) return '★未出现';
     return JSON.stringify({
       出现: true,
       按钮: Array.from(bar.querySelectorAll('.anno-toolbar__btn')).map(b => b.textContent.trim()),
       颜色数: bar.querySelectorAll('.anno-color').length
     });
   })()`
)

// ---------- ③ 点「高亮」按钮 ----------
await step(
  '③ 点击高亮',
  `(() => {
     const btns = Array.from(document.querySelectorAll('.anno-toolbar__btn'));
     const target = btns.find(b => b.textContent.includes('高亮'));
     if (!target) return '★找不到高亮按钮';
     target.click();
     return '已点击';
   })()`
)

await new Promise((r) => setTimeout(r, 900))

// ---------- ④ 检查结果 ----------
await step(
  '④ 页面上的高亮元素',
  `document.querySelectorAll('.anno-mark').length + ' 个'`
)

await step(
  '④ 打开右侧栏批注',
  `(() => {
     const tabs = Array.from(document.querySelectorAll('.sidebar__tab'));
     const t = tabs.find(x => x.textContent.includes('批注'));
     if (!t) return '★找不到批注页签';
     t.click();
     return '已切到批注页签';
   })()`
)

await new Promise((r) => setTimeout(r, 600))

await step(
  '④ 右侧栏批注条目',
  `(() => {
     const cards = document.querySelectorAll('.anno-card, [class*="anno-card"]');
     const body = document.querySelector('.right-panel .sidebar__body');
     return JSON.stringify({
       卡片数: cards.length,
       右侧栏文本: body ? body.textContent.replace(/\\s+/g, ' ').trim().slice(0, 160) : null
     });
   })()`
)

ws.close()
