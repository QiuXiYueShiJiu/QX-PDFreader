// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 探查「缩放落定后位图有没有跟上」。
 *
 * 打印三个诊断挂钩（由 DocumentView 的 PdfPage 写入 DOM）：
 *   dataset.dbgSize —— 撑尺寸 effect 的输入与结果
 *   dataset.dbg     —— 渲染 effect 的输入
 *   dataset.dbgWhy  —— 渲染 effect 从哪个分支退出的
 * 以及位图实际尺寸与版面尺寸，用来看两者是否脱节。
 *
 * 用法：node tools/probe-settle.mjs [端口] [目标缩放值]
 */

const port = Number(process.argv[2] ?? 9280)
const target = Number(process.argv[3] ?? 1.8)

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'))
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
    const p = pending.get(msg.id)
    if (p) {
      pending.delete(msg.id)
      p(msg.result)
    }
  }
  const evalJs = async (expression) => {
    const r = await new Promise((res) => {
      const myId = ++id
      pending.set(myId, res)
      ws.send(
        JSON.stringify({
          id: myId,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true }
        })
      )
    })
    if (r.exceptionDetails) {
      throw new Error('表达式异常: ' + JSON.stringify(r.exceptionDetails.exception?.description))
    }
    return r.result.value
  }
  return { ws, evalJs }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* 探针写成一行，避免引号嵌引号把 CDP 表达式搞坏 */
const PROBE = `JSON.stringify((function(){
  var el = document.querySelector('.pdf-page');
  if (!el) return { err: 'no page' };
  var cv = el.querySelector('canvas.pdf-page__canvas');
  var wrap = el.querySelector('.pdf-page__cwrap');
  return {
    zoom: String(window.__store.getState().zoom),
    layoutW: wrap ? Math.round(wrap.getBoundingClientRect().width) : -1,
    bitmap: cv ? cv.width + 'x' + cv.height : 'none',
    dpr: window.devicePixelRatio,
    dbgSize: wrap ? wrap.dataset.dbgSize : null,
    dbg: wrap ? wrap.dataset.dbg : null,
    dbgWhy: wrap ? wrap.dataset.dbgWhy : null,
    stage: wrap ? wrap.dataset.stage : null
  };
})())`

const { ws, evalJs } = await connect()

console.log(`=== 落定探查（目标缩放 ${target}）===\n`)

await evalJs(`window.__store.getState().setZoom(${target})`)
await sleep(400)
console.log('停手后 0.4s:')
console.log('  ' + (await evalJs(PROBE)))

await sleep(1600)
console.log('\n停手后 2.0s:')
console.log('  ' + (await evalJs(PROBE)))

await sleep(2500)
console.log('\n停手后 4.5s:')
console.log('  ' + (await evalJs(PROBE)))

console.log('\n采样: ' + (await evalJs('window.__sbSampleCanvas(1)')))

ws.close()
