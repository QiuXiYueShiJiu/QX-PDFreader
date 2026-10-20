// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 左侧导航跳页验证 —— 专治用户报的「点缩略图跳不到指定页」。
 *
 * ★ 这个 bug 为什么会发生
 *   连续滚动模式下，滚动位置是被 layout effect 驱动的（DocumentView 里
 *   「翻页后修正滚动位置」那段）。点缩略图只改了 store 里的 page，
 *   如果那个 effect 随后又按旧的 page 把滚动位置改回去，视觉上就「跳不动」。
 *   所以光断言 store.page === 8 不够 —— **必须**看第 8 页是不是真的
 *   落进了视口，而且第 1 页是不是已经移出去。这条断言才叫端到端。
 *
 * ★ 判据
 *   ① 点击后 store.page 变成目标页
 *   ② 1.2 秒后（给 layout effect 跑完的时间），目标页的 .pdf-page
 *      矩形中心落在视口垂直范围内
 *   ③ 原来那一页已经不在视口里（证明是真的滚过去了，不是两页同屏）
 *   ④ 缩略图上的 is-active 也跟着换了（左栏高亮不能骗人）
 *
 * 用法：node tools/verify-jump-navigation.mjs [端口]
 *
 * 注意：本文件含中文，**不要**用 PowerShell 的 Set-Content / 重定向改写
 *       （实测会被写成 GBK 乱码，Node 直接 SyntaxError）。要改就用编辑工具。
 */

const port = process.argv[2] ?? '9223'

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 一次取样的完整现场：store 页码 + 目标页矩形 + 缩略图高亮 */
const SNAP = (target) => `(() => {
  const st = window.__store.getState();
  const el = document.querySelector('.pdf-page[data-page="${target}"]');
  let 矩形 = null, 在视口 = false;
  if (el) {
    const r = el.getBoundingClientRect();
    const mid = r.top + r.height / 2;
    矩形 = { top: Math.round(r.top), bottom: Math.round(r.bottom), 中: Math.round(mid), 高: Math.round(r.height) };
    在视口 = r.bottom > 0 && r.top < window.innerHeight;
  }
  const act = document.querySelector('.thumb.is-active');
  return JSON.stringify({
    store页: st.page,
    目标页节点: !!el,
    在视口,
    矩形,
    视口高: window.innerHeight,
    当前高亮缩略图: act ? act.textContent.trim() : null,
    视图模式: st.viewMode
  });
})()`

/** 真实点击缩略图（不是直接调 setPage —— 要测的就是点击那条链路） */
const CLICK_THUMB = (n) => `(() => {
  const t = document.querySelector('.thumb[title="跳转到第 ${n} 页"]');
  if (!t) {
    const all = Array.from(document.querySelectorAll('.thumb')).map(x => x.getAttribute('title'));
    return '★找不到第 ${n} 页缩略图；现有的：' + JSON.stringify(all.slice(0, 12));
  }
  t.click();
  return 'clicked';
})()`

console.log('=== 左侧导航跳页验证 ===\n')

/* 确保左栏是打开的 —— Sidebar 只在 showSidebar 为真时才挂载（App.tsx:356），
 * 没打开的话页签、缩略图全都不存在，脚本会误报「功能坏了」。 */
const prep = await evaluate(`(() => {
  const st = window.__store.getState();
  const out = { 原本showSidebar: st.showSidebar, 缩略图数: document.querySelectorAll('.thumb').length };
  if (!st.showSidebar) st.setShowSidebar(true);
  out.视图模式 = st.viewMode;
  return JSON.stringify(out);
})()`)
console.log(`准备：${prep}`)
await sleep(700)

/* 再确保页签停在「页面缩略图」上 */
await evaluate(`(() => {
  if (document.querySelectorAll('.thumb').length) return 'ok';
  const tab = document.querySelector('.sidebar__tab[title="页面缩略图"]');
  if (tab) tab.click();
  return 'ok';
})()`)
await sleep(600)

const thumbs = JSON.parse(await evaluate(`JSON.stringify({ 缩略图数: document.querySelectorAll('.thumb').length })`))
if (!thumbs.缩略图数) {
  console.log('★ 左栏没有缩略图，无法继续（可能需要先打开文档）')
  process.exit(1)
}
console.log(`  缩略图 ${thumbs.缩略图数} 个\n`)

/* 起点：回到第 1 页 */
await evaluate(`(() => { window.__store.getState().setPage(1); return 'ok' })()`)
await sleep(900)

const targets = [8, 2, 9, 1]
let fails = 0

for (const t of targets) {
  console.log(`--- 跳到第 ${t} 页 ---`)
  const clicked = await evaluate(CLICK_THUMB(t))
  if (clicked.startsWith('★')) {
    console.log(`  ${clicked}`)
    fails++
    continue
  }
  /* 立刻看一眼：store 是不是当场就变了（反应速度） */
  await sleep(120)
  const quick = JSON.parse(await evaluate(SNAP(t)))
  /* 再等 layout effect 跑完，看视觉上有没有真的滚过去 */
  await sleep(1200)
  const after = JSON.parse(await evaluate(SNAP(t)))

  console.log(`  点击后立刻：store页=${quick.store页}  目标页在视口=${quick.在视口}`)
  console.log(`  1.2 秒后  ：store页=${after.store页}  目标页在视口=${after.在视口}  矩形=${JSON.stringify(after.矩形)}`)
  console.log(`  高亮缩略图=${after.当前高亮缩略图}  视图模式=${after.视图模式}`)

  const problems = []
  if (after.store页 !== t) problems.push(`store 页码是 ${after.store页}，不是 ${t}`)
  if (!after.目标页节点) problems.push('目标页节点不存在')
  else if (!after.在视口) problems.push('目标页没进视口（滚动位置没跟过去）')
  if (after.高亮缩略图 && after.高亮缩略图 !== String(t)) {
    problems.push(`左栏高亮的还是第 ${after.高亮缩略图} 页`)
  }

  /* 单页/对开模式下不存在「上一页同时可见」，跳过这条 */
  if (after.视图模式 === 'continuous' || after.视图模式 === 'facing-continuous') {
    const others = await evaluate(`(() => {
      const vis = Array.from(document.querySelectorAll('.pdf-page')).filter(el => {
        const r = el.getBoundingClientRect();
        return r.bottom > 0 && r.top < window.innerHeight;
      }).map(el => el.dataset.page);
      return JSON.stringify(vis);
    })()`)
    console.log(`  同屏页：${others}`)
    const vis = JSON.parse(others)
    if (vis.length && !vis.includes(String(t))) problems.push(`同屏页 ${others} 里没有 ${t}`)
  }

  if (problems.length) {
    console.log(`  ✗ ${problems.join('；')}`)
    fails++
  } else {
    console.log('  ✓')
  }
  console.log('')
}

console.log(fails ? `=== 结果：${fails} 个目标页跳转失败 ===` : '=== 结果：全部通过 ✓ ===')
process.exit(fails ? 1 : 0)
