// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * verify-image-float.mjs —— 图片工具：入口搬到上栏、面板改成可拖动浮层（2.0.0 B5）
 *
 * 用户第 4 条：「图片工具不要单独悬浮按钮，合并到上栏」。
 * 1.9.0.0 的做法是右侧一个常驻的圆形悬浮按钮（`.image-tools-toggle`），
 * 挡阅读区、跟右栏抢位置；现在入口进上栏「工具」页的「图片」组，
 * 面板也不再是整屏模态，而是可以拖着走的浮层（`image-float`）。
 *
 * 判据：
 *   ① 上栏「工具」页有「图片处理」按钮；
 *   ② 点它打开浮层，旧的悬浮圆按钮已经不存在；
 *   ③ 浮层不是整屏遮罩（没有 `.sb-settings-scrim`），窗体本身小于视口；
 *   ④ 拖头部能改变浮层位置（位置真的动了）；
 *   ⑤ 拖动不会把浮层拖出视口（坐标被夹住）；
 *   ⑥ 关闭按钮能收起来，且 store 的 showImageTools 跟着变 false。
 *
 * 用法：node tools/verify-image-float.mjs [端口]
 */
import { spawnSync } from 'node:child_process'

const PORT = process.argv[2] ?? '9610'
const ROOT = process.cwd()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function cdp(expr) {
  const r = spawnSync(process.execPath, ['scripts/cdp-eval.mjs', PORT, expr], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  })
  const out = (r.stdout ?? '').trim()
  if (!out) throw new Error(`CDP 无输出：${(r.stderr ?? '').trim()}`)
  return out
}

const ev = (body) => {
  const out = cdp(`(async () => { ${body} })()`)
  if (out === 'undefined') return undefined
  try {
    return JSON.parse(out)
  } catch {
    return out
  }
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : `  —— ${detail}`}`)
}

async function main() {
  console.log('图片工具浮层（隐藏窗口）')
  console.log(`  端口 ${PORT}\n`)

  /* 归位：关掉别的面板、切到「工具」页签 */
  await ev(`
    const s = window.__store.getState()
    if (s.showSettings) s.setShowSettings(false)
    if (s.showPluginStore) s.setShowPluginStore(false)
    if (s.showThemeStore) s.setShowThemeStore(false)
    if (s.showImageTools) s.setShowImageTools(false)
    if (s.compareOpen) s.closeComparePane()
    return true
  `)
  await sleep(300)
  await ev(`
    const tab = document.querySelector('[data-tb-id="ribbon-tab-tools"]')
    if (tab) tab.click()
    return true
  `)
  await sleep(400)

  /* ① 入口在上栏 */
  const entry = await ev(`
    const b = document.querySelector('[data-tb-id="tool-image"]')
    if (!b) return { found: false }
    const r = b.getBoundingClientRect()
    return { found: true, label: (b.getAttribute('aria-label') || b.textContent || '').trim(), inRibbon: Boolean(b.closest('.ribbon')), visible: r.width > 0 && r.height > 0 }
  `)
  check('① 上栏「工具」页有图片处理入口', entry.found === true && entry.inRibbon === true && entry.visible === true, entry.label)

  /* ② 打开浮层；旧的悬浮圆按钮必须消失 */
  const opened = await ev(`
    const b = document.querySelector('[data-tb-id="tool-image"]')
    b.click()
    await new Promise((r) => setTimeout(r, 500))
    const panel = document.querySelector('.image-float')
    return {
      panel: Boolean(panel),
      legacyToggle: Boolean(document.querySelector('.image-tools-toggle')),
      scrim: Boolean(document.querySelector('.sb-settings-scrim')),
      state: window.__store.getState().showImageTools
    }
  `)
  check('② 点入口打开浮层', opened.panel === true && opened.state === true)
  check('③ 旧的右侧悬浮圆按钮已删除', opened.legacyToggle === false)
  check('④ 浮层不是整屏遮罩（不再用 sb-settings-scrim）', opened.scrim === false)

  /* ⑤ 浮层比视口小（真的是浮层不是整页） */
  const size = await ev(`
    const p = document.querySelector('.image-float')
    const r = p.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight, position: getComputedStyle(p).position }
  `)
  check(
    '⑤ 浮层尺寸小于视口且是绝对定位',
    size.w < size.vw - 40 && size.h <= size.vh && size.position === 'absolute',
    JSON.stringify(size)
  )

  /* ⑥ 拖头部：位置真的变 */
  const before = await ev(`
    const p = document.querySelector('.image-float')
    const r = p.getBoundingClientRect()
    return { x: Math.round(r.left), y: Math.round(r.top) }
  `)
  const dragged = await ev(`
    const head = document.querySelector('.image-float__head')
    const panel = document.querySelector('.image-float')
    const r0 = panel.getBoundingClientRect()
    const startX = Math.round(r0.left + 80)
    const startY = Math.round(r0.top + 12)
    const opts = (x, y) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 })
    head.dispatchEvent(new PointerEvent('pointerdown', opts(startX, startY)))
    for (let i = 1; i <= 6; i++) {
      window.dispatchEvent(new PointerEvent('pointermove', opts(startX - i * 20, startY + i * 8)))
      await new Promise((r) => setTimeout(r, 30))
    }
    window.dispatchEvent(new PointerEvent('pointerup', opts(startX - 120, startY + 48)))
    await new Promise((r) => setTimeout(r, 250))
    const r1 = panel.getBoundingClientRect()
    return { x: Math.round(r1.left), y: Math.round(r1.top) }
  `)
  check(
    '⑥ 拖头部能移动浮层',
    dragged.x !== before.x || dragged.y !== before.y,
    `${JSON.stringify(before)} → ${JSON.stringify(dragged)}`
  )

  /* ⑦ 狠拖到左上角：坐标被夹住，不会出视口 */
  const clamped = await ev(`
    const head = document.querySelector('.image-float__head')
    const panel = document.querySelector('.image-float')
    const r0 = panel.getBoundingClientRect()
    const sx = Math.round(r0.left + 60)
    const sy = Math.round(r0.top + 10)
    const opts = (x, y) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 })
    head.dispatchEvent(new PointerEvent('pointerdown', opts(sx, sy)))
    for (let i = 1; i <= 8; i++) {
      window.dispatchEvent(new PointerEvent('pointermove', opts(sx - i * 400, sy - i * 300)))
      await new Promise((r) => setTimeout(r, 20))
    }
    window.dispatchEvent(new PointerEvent('pointerup', opts(-3000, -2000)))
    await new Promise((r) => setTimeout(r, 250))
    const r1 = panel.getBoundingClientRect()
    return { x: Math.round(r1.left), y: Math.round(r1.top) }
  `)
  check('⑦ 拖到视口外会被夹住（左 8 / 上 36 起）', clamped.x >= 8 && clamped.y >= 36, JSON.stringify(clamped))

  /* ⑧ 关闭：浮层消失、store 归位 */
  const closed = await ev(`
    const btn = document.querySelector('.image-float .sb-icon-btn[aria-label="关闭"]')
    if (!btn) return { clicked: false }
    btn.click()
    await new Promise((r) => setTimeout(r, 400))
    return { clicked: true, panel: Boolean(document.querySelector('.image-float')), state: window.__store.getState().showImageTools }
  `)
  check('⑧ 关闭按钮收起浮层并复位状态', closed.clicked === true && closed.panel === false && closed.state === false)

  /* 收尾：回「开始」页，别把后面的用例留在工具页 */
  await ev(`
    const tab = document.querySelector('[data-tb-id="ribbon-tab-home"]')
    if (tab) tab.click()
    return true
  `)
  await sleep(300)

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${failed.length === 0 ? '✓ 全部通过' : `✗ 失败 ${failed.length} 项`}（${results.length} 项）`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('✗', e.message)
  process.exit(1)
})
