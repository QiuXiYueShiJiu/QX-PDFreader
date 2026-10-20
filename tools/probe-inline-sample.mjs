// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 直接复刻 PdfPage 里 hasVisibleContent 的采样逻辑，与 probe-page-pixels 的
 * 稀疏采样并排比较。
 *
 * 为什么要单独测：
 *   「切缩放后整页死黑」修复里，guard 用 hasVisibleContent 判断画布有没有内容，
 *   而 probe-page-pixels 用稀疏网格采样判断亮点/暗点，两者对同一张画布
 *   给出了**互相矛盾**的结论（guard 说有内容 → 跳过渲染；探测说亮点 0 暗点 100）。
 *   必须先把「到底哪个读数是真的」钉死，否则改哪儿都是瞎改。
 *
 *   两者的差别只有采样密度：
 *     · hasVisibleContent 缩到 24×24 = 576 像素，逐点看
 *     · probe 按 x+=31 / y+=37 跳采，803×1136 下约 27×31 = 837 点
 *   如果结论不同，说明画布上有**稀疏分布的少数亮点** ——
 *   那很可能不是「渲染没跑」，而是「渲染跑了但只画了一小部分」。
 *
 * 用法：node tools/probe-inline-sample.mjs [端口] [页码]
 */

const PORT = Number(process.argv[2] || 9236)
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

const expr = `(() => {
  const el = document.querySelector('.pdf-page[data-page="${PAGE}"]');
  if (!el) return JSON.stringify({ 错误: '找不到页面节点' });
  const cv = el.querySelector('canvas.pdf-page__canvas');
  if (!cv) return JSON.stringify({ 错误: '找不到画布' });

  const o = { 画布属性: cv.width + 'x' + cv.height };

  /* ① 复刻 hasVisibleContent：缩到 24×24 逐点看 */
  const N = 24;
  const probe = document.createElement('canvas');
  probe.width = N; probe.height = N;
  const pctx = probe.getContext('2d', { willReadFrequently: true });
  pctx.drawImage(cv, 0, 0, N, N);
  const pdata = pctx.getImageData(0, 0, N, N).data;
  let below = 0, minCh = 255, maxCh = 0;
  for (let i = 0; i < pdata.length; i += 4) {
    const r = pdata[i], g = pdata[i+1], b = pdata[i+2];
    if (r < 240 || g < 240 || b < 240) below++;
    minCh = Math.min(minCh, r, g, b);
    maxCh = Math.max(maxCh, r, g, b);
  }
  o.hasVisibleContent返回值 = below > 0;
  o.缩略采样_低于240的点数 = below;
  o.缩略采样_通道范围 = minCh + '~' + maxCh;

  /* ② 复刻 probe-page-pixels 的稀疏跳采 */
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  let bright = 0, dark = 0, n = 0, mn = 255, mx = 0;
  for (let y = 0; y < cv.height; y += 37) {
    for (let x = 0; x < cv.width; x += 31) {
      const i = (y * cv.width + x) * 4;
      const v = (d[i] + d[i+1] + d[i+2]) / 3;
      if (v > 200) bright++;
      if (v < 60) dark++;
      mn = Math.min(mn, v); mx = Math.max(mx, v);
      n++;
    }
  }
  o.稀疏采样_总点 = n;
  o.稀疏采样_亮点 = bright;
  o.稀疏采样_暗点 = dark;
  o.稀疏采样_灰度范围 = Math.round(mn) + '~' + Math.round(mx);

  /* ③ 全图逐点统计（最可靠，作为裁判） */
  let fullBright = 0, fullDark = 0, fullN = 0;
  for (let y = 0; y < cv.height; y += 3) {
    for (let x = 0; x < cv.width; x += 3) {
      const i = (y * cv.width + x) * 4;
      const v = (d[i] + d[i+1] + d[i+2]) / 3;
      if (v > 200) fullBright++;
      else if (v < 60) fullDark++;
      fullN++;
    }
  }
  o.全图_亮点占比 = Number((fullBright / fullN * 100).toFixed(1));
  o.全图_暗点占比 = Number((fullDark / fullN * 100).toFixed(1));

  o.容器背景是否黑图 = (getComputedStyle(el.querySelector('.pdf-page__cwrap')).backgroundImage || '').slice(0, 200);
  o.事件序列 = (window.__sbInkTrace || []).slice(-40);
  return JSON.stringify(o, null, 1);
})()`

console.log(`=== 第 ${PAGE} 页采样对照（端口 ${PORT}）===`)
console.log(await cdp(expr))
