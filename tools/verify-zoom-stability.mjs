// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 缩放稳定性观察：切换档位后**连续 4 秒**每秒采样一次。
 *
 * 为什么不能只采一次：
 *   同一个档位（0.9）在不同时刻采样会得到完全不同的结果 ——
 *   有时亮 88%（正常），有时全黑。单点采样把这个时序抖动
 *   误报成「这个档位坏了」，据此改代码就会改错方向。
 *   只有连续观察才能分清「一直黑」和「黑了一下自己恢复」。
 *
 * 输出每一档的时间序列，末尾给出判定：
 *   · 全绿            → 稳定
 *   · 先黑后亮        → 有闪烁（可接受但要知道）
 *   · 结尾仍黑        → 真故障
 *
 * 用法：node tools/verify-zoom-stability.mjs [端口]
 */

const PORT = Number(process.argv[2] || 9252)

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* 直接调组件挂出来的采样函数，与判据同源 */
const SAMPLE = `(() => window.__sbSampleCanvas ? window.__sbSampleCanvas(1) : 'no-hook')()`
const STAGE = `(() => {
  const el = document.querySelector('.pdf-page[data-page="1"] .pdf-page__cwrap');
  return el ? (el.dataset.stage || 'none') : 'no-el';
})()`

/**
 * 被采样那一页到底在不在「用户看得见」的状态。
 *
 * ★ 这一条是必须的，不能只看采样数字。
 *   连续滚动模式下，切换缩放会重排版面、滚动位置也跟着变，
 *   第 1 页完全可能被滚出视口甚至卸载掉。那时候采样函数对着一张
 *   刚建好、还没排上渲染的画布读数，得到的是一串 **0.0**——
 *   它不等于故障（用户看到的是白纸），但更不等于「稳定」：
 *   我们只是**量了一个用户看不见的东西**。
 *   早期版本没有这个检查，于是「读不到」被当成了「一切正常」，
 *   探针失效反而给出绿灯，比误报故障更危险。
 */
const PAGE_STATE = `(() => {
  const st = window.__store.getState();
  const el = document.querySelector('.pdf-page[data-page="1"]');
  const cv = el ? el.querySelector('canvas.pdf-page__canvas') : null;
  const r = el ? el.getBoundingClientRect() : null;
  const vis = r ? Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) : 0;
  return JSON.stringify({
    是当前页: st.page === 1,
    有画布: !!cv,
    像素: cv ? cv.width + 'x' + cv.height : null,
    可见高: Math.round(vis)
  });
})()`

/**
 * 从采样串里取出「不透光暗点」占比。
 *
 * ★ 为什么不能直接看「暗」
 *   还没画好的画布像素全零：alpha=0（透明，用户看到白纸）与
 *   alpha=255（不透明黑，用户看到黑板）的 RGB 一模一样，
 *   只有 alpha 分得开。只看暗点会把「正在加载」误判成故障 ——
 *   上一轮排查就被这个假阳性带偏过好几轮，修 CSS 怎么修都不变，
 *   因为量错了对象（见 DocumentView.tsx 的 __sbSampleCanvas 注释）。
 *
 * 返回 -1 表示读不到（no-hook / no-canvas），单独计数不当故障。
 */
function parseOpaqueDark(s) {
  const str = String(s)
  const md = /暗(\d+)%/.exec(str)
  if (!md) return -1
  const mc = /透(\d+)%/.exec(str)
  const dark = Number(md[1])
  const clear = mc ? Number(mc[1]) : 0
  return (dark * (100 - clear)) / 100
}

const ZOOMS = [0.5, 0.75, 0.9, 1, 1.5, 2, 3, 'fit-width', 'fit-page', 'actual']

console.log(`=== 缩放稳定性观察：每档连续 4 秒（端口 ${PORT}）===\n`)

const rows = []
for (const z of ZOOMS) {
  /*
   * ★ 每换一个档位都先把第 1 页翻回来。
   *   不这么做的话，采样目标可能早就被滚出视口/卸载了，
   *   读到的 0.0 既不是故障也不是稳定，纯属量错了对象。
   */
  await cdp(`(() => { window.__store.getState().setPage(1); return 'ok' })()`)
  await sleep(300)
  await cdp(`(() => { window.__store.getState().setZoom(${JSON.stringify(z)}); return 'ok' })()`)
  const series = []
  const states = []
  for (let i = 0; i < 8; i++) {
    await sleep(500)
    series.push(parseOpaqueDark(await cdp(SAMPLE)))
    states.push(JSON.parse(await cdp(PAGE_STATE)))
  }
  const stage = await cdp(STAGE)

  /*
   * 判定这一档有没有资格谈「稳定」：
   *   至少要有 4 次采样时，第 1 页确实是当前页、有画布、而且真的在视口里。
   *   不满足就报「∅ 看不到目标页」，而不是拿 0.0 冒充稳定。
   */
  const meaningful = states.filter((s) => s.是当前页 && s.有画布 && s.可见高 > 40).length
  const tail = series.slice(4)
  const everBlack = series.some((d) => d > 95)
  const tailBlack = tail.filter((d) => d > 95).length
  const unreadable = series.filter((d) => d < 0).length
  const verdict =
    meaningful < 4
      ? '∅ 看不到目标页'
      : unreadable === series.length
        ? '∅ 读不到'
        : tailBlack === 0
          ? everBlack
            ? '⚠ 先黑后亮'
            : '✅ 稳定'
          : '❌ 结尾仍黑'
  rows.push({ zoom: z, series, stage, verdict, meaningful })
  console.log(
    `  ${verdict.padEnd(14)} 缩放 ${String(z).padEnd(10)} 不透光暗点 ${series
      .map((d) => (d < 0 ? '—' : d.toFixed(1)))
      .join('/')}  阶段=${stage}  可见采样=${meaningful}/8`
  )
}

const bad = rows.filter((r) => r.verdict.startsWith('❌'))
const flicker = rows.filter((r) => r.verdict.startsWith('⚠'))
const blind = rows.filter((r) => r.verdict.startsWith('∅'))
const ok = rows.filter((r) => r.verdict.startsWith('✅'))
console.log(
  `\n=== 汇总：${ok.length} 稳定 / ${flicker.length} 闪烁 / ${bad.length} 故障 / ${blind.length} 看不到（探针无效，非故障） ===`
)
if (bad.length) {
  console.log('❌ 仍有结尾全黑的档位：' + bad.map((r) => r.zoom).join(', '))
  process.exitCode = 1
} else if (blind.length) {
  /*
   * ★ 「看不见目标页」必须让脚本失败，不能当成绿灯。
   *   这一档根本没验到 —— 放过去等于给了个假通过。
   */
  if (flicker.length) console.log('⚠ 有闪烁档位（最终显示正常）：' + flicker.map((r) => r.zoom).join(', '))
  console.log(
    '✗ 以下档位没能把第 1 页放进视口，等于没验：' +
      blind.map((r) => `${r.zoom}（可见采样 ${r.meaningful}/8）`).join(', ')
  )
  console.log('  （多半是切档后滚动位置没停在第 1 页，见本脚本 PAGE_STATE 的注释）')
  process.exitCode = 1
} else if (flicker.length) {
  console.log('⚠ 有闪烁档位（最终显示正常）：' + flicker.map((r) => r.zoom).join(', '))
} else {
  console.log('✅ 所有档位全程稳定')
}
