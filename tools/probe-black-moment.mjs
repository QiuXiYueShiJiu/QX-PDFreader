// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 捕捉「画布从有内容变成全黑」的那一瞬间。
 *
 * 为什么需要这个脚本：
 *   反复出现这种情况 —— 渲染 effect 里的 guard 判定「尺寸相符且像素有内容，跳过」，
 *   可片刻之后同一张画布全图采样是 0~0（纯黑）。
 *   事后快照永远看不到「它曾经有内容」这个事实，所以此前的所有证据
 *   都指向了错误的方向（去查尺寸、去查 guard 逻辑，其实都对）。
 *
 *   本脚本在页面里挂一个 requestAnimationFrame 轮询，每帧采样一次画布，
 *   一旦读数从「有内容」变成「全黑」就把**前后两次读数连同时间戳**记下来，
 *   并且同时记录那一刻的 canvas 尺寸与容器背景，从而定位到是谁动的手。
 *
 * 用法：node tools/probe-black-moment.mjs [端口] [页码]
 */

const PORT = Number(process.argv[2] || 9240)
const PAGE = Number(process.argv[3] || 1)

async function cdp(expression, timeoutMs = 60000) {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('没有找到可调试的页面')
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    const timer = setTimeout(() => {
      try { ws.close() } catch {}
      reject(new Error('CDP 超时'))
    }, timeoutMs)
    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true }
      }))
    }
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id !== 1) return
      clearTimeout(timer)
      ws.close()
      if (msg.result?.exceptionDetails) {
        reject(new Error(msg.result.exceptionDetails.exception?.description || '表达式异常'))
      } else {
        resolve(msg.result?.result?.value)
      }
    }
    ws.onerror = (e) => { clearTimeout(timer); reject(new Error(`WebSocket 错误: ${e.message || e}`)) }
  })
}

const start = `(() => {
  const P = __PAGE__;
  window.__blackWatch = [];

  /* 采样：返回 [宽度, 亮度百分比] —— 亮度百分比的语义见注释 */
  function read() {
    const el = document.querySelector('.pdf-page[data-page="' + P + '"]');
    const cv = el && el.querySelector('canvas.pdf-page__canvas');
    if (!cv) return null;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    /* 只采中心一条横带，够快，且能代表这一页有没有内容 */
    const y = Math.floor(cv.height / 2);
    const d = ctx.getImageData(0, y, cv.width, 1).data;
    let bright = 0, dark = 0;
    for (let i = 0; i < d.length; i += 4) {
      const v = (d[i] + d[i+1] + d[i+2]) / 3;
      if (v > 200) bright++;
      else if (v < 60) dark++;
    }
    const n = d.length / 4 || 1;
    return { w: cv.width, h: cv.height, bright: Math.round(bright / n * 100), dark: Math.round(dark / n * 100) };
  }

  let prev = read();
  window.__blackWatch.push({ t: Math.round(performance.now()), tag: 'init', cur: prev });

  function tick() {
    const cur = read();
    if (cur && prev) {
      /* 「有内容」定义为 bright 和 dark 都不是压倒性的 —— 有灰阶/杂色 */
      const hadContent = prev.bright < 95 || prev.dark < 95;
      const isAllBlack = cur.dark >= 99;
      const sizeChanged = cur.w !== prev.w || cur.h !== prev.h;
      if ((hadContent && isAllBlack) || sizeChanged) {
        window.__blackWatch.push({
          t: Math.round(performance.now()),
          tag: hadContent && isAllBlack ? '!!! 变成全黑' : '尺寸变化',
          prev: prev, cur: cur
        });
      }
    }
    prev = cur;
    window.__blackRaf = requestAnimationFrame(tick);
  }
  window.__blackRaf = requestAnimationFrame(tick);
  return 'watching page ' + P;
})()`

const stop = `(() => {
  if (window.__blackRaf) cancelAnimationFrame(window.__blackRaf);
  window.__blackRaf = null;
  return JSON.stringify(window.__blackWatch || [], null, 1);
})()`

const withPage = (s) => s.replace(/__PAGE__/g, String(PAGE))

console.log(`=== 监控第 ${PAGE} 页画布（端口 ${PORT}）===`)
console.log(await cdp(withPage(start)))

console.log('--- 2 秒后切到 90% 缩放 ---')
await new Promise((r) => setTimeout(r, 2000))
await cdp(`(() => { window.__store.getState().setZoom(0.9); return 'zoomed' })()`)

console.log('--- 观察 6 秒 ---')
await new Promise((r) => setTimeout(r, 6000))

console.log('--- 事件记录 ---')
console.log(await cdp(stop))
