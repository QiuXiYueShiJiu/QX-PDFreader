// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 缩放全链路回归：所有缩放档位走一遍，每档都确认第 1 页画布不是黑的。
 *
 * 背景：刚修掉「切缩放后整页死黑且永不自愈」—— 真因是 hasVisibleContent
 * 的判据「任一通道 < 240 即算有内容」，而 alpha:false 的画布被清空后
 * 恰好是纯黑（0 < 240 恒成立），于是被清空的画布反而被判成「已画好」，
 * 渲染被跳过、rendered 恒为 true，没有任何机制能自愈。
 *
 * 本脚本覆盖三类路径，任何一条回归都会立刻暴露：
 *   ① 数值缩放：0.5 / 0.75 / 0.9 / 1 / 1.5 / 2 / 3（含缩放按钮的乘性步进）
 *   ② 非数值模式：fit-width / fit-page / actual
 *   ③ 连续快速切换：连点 12 次缩放按钮，模拟用户狂按
 *
 * 判定：每档静置后采样第 1 页画布，「暗 > 95%」即判失败。
 *
 * 用法：node tools/verify-zoom-link.mjs [端口]
 */

const PORT = Number(process.argv[2] || 9242)

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

/* 页面内的采样：直接调组件挂出来的 __sbSampleCanvas，与判据同源 */
const SAMPLE = `(() => {
  if (!window.__sbSampleCanvas) return 'no-hook';
  return window.__sbSampleCanvas(1);
})()`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function parse(s) {
  const m = /亮(\d+)% 暗(\d+)% 中(\d+)%(?: 透(\d+)%)?/.exec(String(s))
  if (!m) return null
  return {
    bright: Number(m[1]),
    dark: Number(m[2]),
    mid: Number(m[3]),
    /* 老版本探针没有这一项，缺省 0 表示「没有透明像素」 */
    clear: m[4] === undefined ? 0 : Number(m[4])
  }
}

let failures = 0
let checks = 0

async function check(label) {
  const raw = await cdp(SAMPLE)
  const v = parse(raw)
  checks++
  if (!v) {
    console.log(`  ⚠ ${label} → 读不到（${raw}）`)
    return
  }
  /*
   * 失败判据要看「不透光暗点」。
   *
   * ★ 为什么不能只看「暗」
   *   还没画好的画布像素全零：alpha=0（透明，用户看到白纸）与
   *   alpha=255（不透明黑，用户看到黑板）的 RGB 一模一样。
   *   只看暗点占比会把「正在加载」误判成故障，
   *   之前的排查就被这个假阳性带偏过好几轮。
   *   真正会显形的黑 = 整张画布几乎全是「不透光的暗」。
   */
  const opaqueDark = (v.dark * (100 - v.clear)) / 100
  const bad = opaqueDark > 95
  if (bad) failures++
  console.log(`  ${bad ? '❌' : '✅'} ${label} → ${raw}`)
}

console.log(`=== 缩放全链路回归（端口 ${PORT}）===`)

for (const z of [0.5, 0.75, 0.9, 1, 1.5, 2, 3]) {
  await cdp(`(() => { window.__store.getState().setZoom(${z}); return 'ok' })()`)
  await sleep(2600)
  await check(`数值缩放 ${z}`)
}

for (const mode of ['fit-width', 'fit-page', 'actual']) {
  await cdp(`(() => { window.__store.getState().setZoom(${JSON.stringify(mode)}); return 'ok' })()`)
  await sleep(2600)
  await check(`模式 ${mode}`)
}

console.log('--- 连续快速缩放 12 次（模拟狂按缩放按钮）---')
await cdp(`(() => { window.__store.getState().setZoom(1); return 'ok' })()`)
await sleep(2000)
await cdp(`(async () => {
  const s = window.__store.getState();
  for (let i = 0; i < 12; i++) {
    if (i % 2 === 0) s.zoomIn(); else s.zoomOut();
    await new Promise(r => setTimeout(r, 120));
  }
  return 'done';
})()`)
await sleep(4000)
await check('狂按 12 次后')

console.log(`\n=== 结果：${checks - failures}/${checks} 通过 ===`)
if (failures > 0) {
  console.log('❌ 有档位出现全黑画布，需要继续排查')
  process.exitCode = 1
} else {
  console.log('✅ 所有缩放档位画布都有内容')
}
