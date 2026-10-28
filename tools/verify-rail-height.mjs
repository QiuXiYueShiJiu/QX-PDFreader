// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * verify-rail-height.mjs —— 右栏随窗口高度降档、永不滚动（2.0.0 B4）
 *
 * 用户第 3 条：「右栏依旧没做到真正随窗口缩放，现在右栏又能滑动了，正常不该这样」。
 * 1.9.0.0 的右栏是 `overflow-y: auto`（2026-10-16 为「退出按钮被裁」加的兜底），
 * 代价是 150% 缩放下一屏装不下就自己长出滚动条，看起来像面板坏了。
 *
 * 现在的契约（src/renderer/src/components/RightRail.tsx + styles/rails.css）：
 *   · `.rail` 恒为 `overflow: hidden` —— 任何高度都不滚动；
 *   · 高度 ≥ 680px 走正常档（`data-rail="normal"`），按 @media 逐级收尺寸；
 *   · 高度 < 680px 走极矮档（`data-rail="tiny"`），翻页与缩放收进「页码」浮层；\n *   · 浮层里的翻页/缩放按钮与右栏同一套 DOM，只是换了容器。
 *
 * 为什么用 CDP 的 Emulation 改设备高度：隐藏窗口不接受 Win32 的尺寸调整，
 * 视口恒为 1440×940，只能从渲染层内部改。
 *
 * 用法：node tools/verify-rail-height.mjs [端口]
 */

const port = Number(process.argv[2] ?? 9600)

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
  const send = (method, params) =>
    new Promise((res) => {
      const myId = ++id
      pending.set(myId, res)
      ws.send(JSON.stringify({ id: myId, method, params }))
    })
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('表达式异常: ' + JSON.stringify(r.exceptionDetails.exception?.description))
    return r.result.value
  }
  return { ws, send, evalJs }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : `  —— ${detail}`}`)
}

const PROBE = `JSON.stringify((() => {
  const rail = document.querySelector('.rail--right')
  if (!rail) return { rail: false }
  const cs = getComputedStyle(rail)
  const btn = rail.querySelector('[data-rail-group="pager-pop"] button')
  const groups = [...rail.querySelectorAll('[data-rail-group]')].map((g) => g.dataset.railGroup)
  return {
    rail: true,
    mode: rail.dataset.rail || '',
    overflowY: cs.overflowY,
    scrollable: rail.scrollHeight > rail.clientHeight + 1,
    h: Math.round(rail.getBoundingClientRect().height),
    groups,
    menu: Boolean(btn),
    viewport: { w: innerWidth, h: innerHeight }
  }
})())`

async function main() {
  console.log('右栏高度自适应（隐藏窗口）')
  console.log(`  端口 ${port}\n`)
  const { ws, send, evalJs } = await connect()

  /** 改设备高度后等布局稳定 */
  const measureAt = async (height) => {
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height,
      deviceScaleFactor: 1,
      mobile: false
    })
    await sleep(500)
    return JSON.parse(await evalJs(PROBE))
  }

  try {
    /* ① 回到正常高度：不滚动、正常档 */
    const normal = await measureAt(940)
    check('① 940px 高：右栏正常档、不滚动', normal.rail && normal.mode === 'normal' && !normal.scrollable, JSON.stringify({ mode: normal.mode, scrollable: normal.scrollable }))
    check('② 任何时候都不该能滚动（overflow 必须是 hidden）', normal.overflowY === 'hidden', normal.overflowY)

    /* ③ 中等高度：继续正常档，但按钮尺寸降过（用告警高度验证不滚动） */
    const mid = await measureAt(820)
    check('③ 820px 高：仍是正常档、仍不滚动', mid.mode === 'normal' && !mid.scrollable, JSON.stringify({ mode: mid.mode, scrollable: mid.scrollable }))

    /* ④ 极矮：进 tiny 档，冒出「页码」入口 */
    const tiny = await measureAt(640)
    check('④ 640px 高：降为极矮档', tiny.mode === 'tiny', tiny.mode)
    check('⑤ 极矮档也不滚动（翻页与缩放已收进浮层）', !tiny.scrollable, JSON.stringify({ scrollable: tiny.scrollable, h: tiny.h }))
    check('⑥ 极矮档有「页码与缩放」入口', tiny.menu === true)

    /* ⑦ 点开浮层：里面有翻页与缩放，且点得动 */
    const opened = JSON.parse(
      await evalJs(`JSON.stringify((() => {
        const btn = document.querySelector('[data-rail-group="pager-pop"] button')
        if (!btn) return { ok: false }
        btn.click()
        return { ok: true }
      })())`)
    )
    await sleep(400)
    const pop = JSON.parse(
      await evalJs(`JSON.stringify((() => {
        const el = document.querySelector('.rail-pop')
        if (!el) return { pop: false }
        const labels = [...el.querySelectorAll('.rail-btn__label')].map((b) => (b.textContent || '').trim())
        const ids = labels
        return {
          pop: true,
          ids,
          hasPager: labels.includes('上一页') && labels.includes('下一页'),
          hasZoom: labels.includes('放大') && labels.includes('缩小'),
          overflowY: getComputedStyle(el).overflowY
        }
      })())`)
    )
    check('⑦ 点「页码」能开浮层', opened.ok && pop.pop === true)
    check('⑧ 浮层里带翻页与缩放按钮', pop.hasPager === true && pop.hasZoom === true, JSON.stringify(pop.ids?.slice(0, 8)))

    /* ⑨ 关掉浮层（Esc），回到极矮档 */
    await evalJs(`(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return true
    })()`)
    await sleep(300)
    const stillTiny = JSON.parse(await evalJs(PROBE))
    check('⑨ 关浮层后仍停在极矮档（不误切回正常档）', stillTiny.mode === 'tiny', stillTiny.mode)

    /* 收尾：清掉设备覆盖，恢复真实视口 */
    await send('Emulation.clearDeviceMetricsOverride')
    /* 清掉覆盖后要主动踢一次 resize：RightRail 靠 window.resize 更新档位 */
    await evalJs(`(() => { window.dispatchEvent(new Event('resize')); return true })()`)
    await sleep(600)
    const restored = JSON.parse(await evalJs(PROBE))
    check('⑩ 收尾：视口恢复、右栏回到正常档', restored.mode === 'normal' && restored.scrollable === false, JSON.stringify(restored.viewport))
  } finally {
    ws.close()
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${failed.length === 0 ? '✓ 全部通过' : `✗ 失败 ${failed.length} 项`}（${results.length} 项）`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('✗', e.message)
  process.exit(1)
})
