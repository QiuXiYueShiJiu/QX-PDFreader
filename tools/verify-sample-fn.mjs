// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 验证 hasVisibleContent 的降采样读数是否可靠。
 *
 * 背景：切缩放后第 1 页画布全图采样是 0~0（纯黑），
 *       但同一个函数返回 true 导致渲染被跳过，页面永不自愈。
 *       事件序列已排除「有人清空画布」，所以嫌疑落在采样本身。
 *
 * 本脚本做四组对照：
 *   ① 现造一张纯黑画布   → hasVisibleContent 应返回 false
 *   ①b 现造一张纯白画布  → 应返回 false
 *   ② 真实页面画布直接采样
 *   ③ 拷到同尺寸临时画布再采样（区分「原画布有问题」与「降采样有问题」）
 *   ④ 直接读原画布中心 50×50 作为真相
 *
 * ⚠ 属性名必须用带引号的字符串形式（o['中文']）。
 *   踩坑：写成 o.①纯黑画布 会直接 SyntaxError —— 中文不是合法标识符，
 *   而 Runtime.evaluate 只回一句 "Invalid or unexpected token"，
 *   极难联想到是属性名的问题。整套测试因此白跑了两轮。
 *
 * 用法：node tools/verify-sample-fn.mjs [端口] [页码]
 */

const PORT = Number(process.argv[2] || 9239)
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
  const o = {};

  /* 把页面里的 hasVisibleContent 逻辑照抄一份（原函数在模块作用域，外部拿不到） */
  function sample(canvas) {
    try {
      const N = 24;
      const probe = document.createElement('canvas');
      probe.width = N; probe.height = N;
      const pctx = probe.getContext('2d', { willReadFrequently: true });
      if (!pctx) return { ret: true, note: 'no-ctx' };
      pctx.drawImage(canvas, 0, 0, N, N);
      const data = pctx.getImageData(0, 0, N, N).data;
      let below = 0, minCh = 255, maxCh = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i+1], b = data[i+2];
        if (r < 240 || g < 240 || b < 240) below++;
        minCh = Math.min(minCh, r, g, b);
        maxCh = Math.max(maxCh, r, g, b);
      }
      return { ret: below > 0, below: below, range: minCh + '~' + maxCh };
    } catch (e) { return { ret: true, note: String(e) } }
  }

  /* 1 现造纯黑画布 */
  const black = document.createElement('canvas');
  black.width = 800; black.height = 1100;
  const bctx = black.getContext('2d', { alpha: false });
  bctx.fillStyle = '#000'; bctx.fillRect(0, 0, 800, 1100);
  o['1_纯黑画布'] = sample(black);

  /* 2 现造纯白画布 */
  const white = document.createElement('canvas');
  white.width = 800; white.height = 1100;
  const wctx = white.getContext('2d', { alpha: false });
  wctx.fillStyle = '#fff'; wctx.fillRect(0, 0, 800, 1100);
  o['2_纯白画布'] = sample(white);

  /* 3 现造有内容的画布（白底 + 一条黑线） */
  const inked = document.createElement('canvas');
  inked.width = 800; inked.height = 1100;
  const ictx = inked.getContext('2d', { alpha: false });
  ictx.fillStyle = '#fff'; ictx.fillRect(0, 0, 800, 1100);
  ictx.strokeStyle = '#000'; ictx.lineWidth = 6;
  ictx.beginPath(); ictx.moveTo(50, 550); ictx.lineTo(750, 550); ictx.stroke();
  o['3_有内容画布'] = sample(inked);

  /* 4 真实页面画布 */
  const el = document.querySelector('.pdf-page[data-page="__PAGE__"]');
  const cv = el && el.querySelector('canvas.pdf-page__canvas');
  if (!cv) { o['4_真实'] = 'not-found'; return JSON.stringify(o, null, 1); }
  o['4_真实画布尺寸'] = cv.width + 'x' + cv.height;
  o['5_真实画布采样'] = sample(cv);

  const copy = document.createElement('canvas');
  copy.width = cv.width; copy.height = cv.height;
  const cctx = copy.getContext('2d', { alpha: false });
  cctx.drawImage(cv, 0, 0);
  o['6_拷贝后采样'] = sample(copy);

  /* 7 直接读原画布中心小块，作为真相 */
  const g = cv.getContext('2d', { willReadFrequently: true });
  const cx = Math.floor(cv.width / 2), cy = Math.floor(cv.height / 2);
  const patch = g.getImageData(cx - 25, cy - 25, 50, 50).data;
  let pmin = 255, pmax = 0;
  for (let i = 0; i < patch.length; i += 4) {
    pmin = Math.min(pmin, patch[i], patch[i+1], patch[i+2]);
    pmax = Math.max(pmax, patch[i], patch[i+1], patch[i+2]);
  }
  o['7_原画布中心50x50范围'] = pmin + '~' + pmax;
  return JSON.stringify(o, null, 1);
})()`

console.log(`=== 采样函数可靠性对照（端口 ${PORT}）===`)
console.log(await cdp(expr.replace(/__PAGE__/g, String(PAGE))))
