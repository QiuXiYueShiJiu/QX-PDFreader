// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 用 CDP 的 Emulation.setDeviceMetricsOverride 把**视口**收窄，
 * 再看退出确认框里第二个按钮是否还在视口内。
 *
 * 为什么需要它：
 *   用户报「弹窗里只有一个取消，右边完全没有第二个按钮」，
 *   但在 1440×940 视口下两个按钮都正常。
 *   差异只可能在窗口宽度 —— 卡片宽 min(420px, calc(100vw - 48px))，
 *   而两个按钮 min-width 各 88px + 左右 padding，
 *   视口一窄，按钮行就会溢出、把右边那个挤出可视区。
 *   这里直接把视口设成若干窄尺寸，逐个测量。
 *
 * 用法：node tools/diag-exit-viewport.mjs [端口]
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PORT = process.argv[2] ?? '9228'

/** 直接连 CDP，因为要发非 Runtime 域的命令 */
async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('找不到页面目标')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  let id = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
  const send = (method, params = {}) =>
    new Promise((res) => {
      const myId = ++id
      pending.set(myId, res)
      ws.send(JSON.stringify({ id: myId, method, params }))
    })
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    return r.result?.result?.value ?? JSON.stringify(r.result?.exceptionDetails ?? r.result)
  }
  return { send, evaluate, close: () => ws.close() }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const cdp = await connect()

/* 先把弹窗打开 */
await cdp.evaluate(`(() => {
  const b = Array.from(document.querySelectorAll('.rail-btn')).find((x) => (x.textContent || '').includes('退出应用'));
  if (b) b.click();
  return 'ok';
})()`)
await sleep(700)

console.log('=== 不同视口宽度下，退出按钮是否可见（不带缩放覆盖）===')
for (const w of [1440, 1100, 900, 760, 640, 560, 480, 400]) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: w,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await sleep(260)

  const r = await cdp.evaluate(`(() => {
    const dlg = document.querySelector('.exit-confirm');
    if (!dlg) return '弹窗不在';
    const btns = Array.from(dlg.querySelectorAll('.exit-confirm__btn'));
    const box = dlg.querySelector('.exit-confirm__box').getBoundingClientRect();
    return JSON.stringify({
      视口宽: innerWidth,
      卡片: Math.round(box.width) + 'px',
      按钮: btns.map((b) => {
        const r = b.getBoundingClientRect();
        const cx = Math.round(r.left + r.width / 2);
        const cy = Math.round(r.top + r.height / 2);
        const hit = document.elementFromPoint(cx, cy);
        return {
          文字: (b.textContent || '').trim(),
          右边界: Math.round(r.right),
          宽: Math.round(r.width),
          在视口内: r.right <= innerWidth + 0.5 && r.left >= -0.5 ? '是' : '★否',
          可点中: hit === b || (hit && b.contains(hit)) ? '是' : '★否'
        };
      })
    });
  })()`)
  console.log('  ' + r)
}

/* 复位视口，避免影响后续测试 */
await cdp.send('Emulation.clearDeviceMetricsOverride')
await cdp.evaluate(`(() => {
  const b = Array.from(document.querySelectorAll('.exit-confirm__btn')).find((x) => (x.textContent || '').includes('取消'));
  if (b) b.click();
  return 'ok';
})()`)
cdp.close()
