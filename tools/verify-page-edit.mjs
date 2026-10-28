/* 页面结构编辑（插入空白页 / 删除本页）—— 端到端断言。
 *
 * 用户需求（2026-10-27）：「编辑功能里面可以新建空白页或删除空白页」。
 *
 * 为什么单独立一支：
 *   这条链路横跨 渲染层按钮 → store → preload → 主进程 pdf-lib → 写工作副本
 *   → 关标签重开文件。任何一环断了，用户看到的就是「点了没反应」或者
 *   「页数没变」，只有端到端能抓住。
 *
 * 设计前提（写在主进程里，这里再断一次）：
 *   · 改的是 userData/pages 下的**工作副本**，原文件一个字节都不动；
 *   · 插页尺寸跟随上一页；页码落在新插入的那一页上；
 *   · 只剩一页时不允许删。
 *
 * 用法：node tools/verify-page-edit.mjs [端口]
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const CDP_EVAL = join(ROOT, 'scripts', 'cdp-eval.mjs')
const PORT = Number(process.argv[2] ?? 9200)

let pass = 0
let fail = 0
const check = (name, okCondition, detail = '') => {
  if (okCondition) {
    pass += 1
    console.log(`  ✓ ${name}${detail ? ` —— ${detail}` : ''}`)
  } else {
    fail += 1
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

const ev = (body) => {
  const r = spawnSync(process.execPath, [CDP_EVAL, PORT, `JSON.stringify((() => { ${body} })())`], {
    encoding: 'utf8',
    timeout: 60000
  })
  const out = (r.stdout ?? '').trim()
  if (!out) return {}
  try {
    return JSON.parse(out)
  } catch {
    return {}
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 等条件成立（页面结构编辑要落盘 + 重开文档，不是瞬间完成） */
async function waitFor(body, ms = 15000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (ev(`return (${body})`) === true) return true
    await sleep(250)
  }
  return false
}

const click = (selector) =>
  ev(`
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    const r = el.getBoundingClientRect()
    const opt = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0 }
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opt, pointerId: 1, pointerType: 'mouse', isPrimary: true }))
    el.dispatchEvent(new MouseEvent('mousedown', opt))
    el.dispatchEvent(new PointerEvent('pointerup', { ...opt, pointerId: 1, pointerType: 'mouse', isPrimary: true }))
    el.dispatchEvent(new MouseEvent('mouseup', opt))
    el.dispatchEvent(new MouseEvent('click', opt))
    return true
  `)

console.log(`=== 页面结构编辑（端口 ${PORT}）===`)

/* ---------- ① 入口在「开始」页的插入组里 ---------- */
await click('[data-tb-id="ribbon-tab-home"]')
await sleep(400)
const entry = ev(`
  const ins = document.querySelector('[data-tb-id="page-insert-blank"]')
  const del = document.querySelector('[data-tb-id="page-delete"]')
  const group = ins?.closest('.ribbon__group')
  return {
    ins: !!ins, del: !!del,
    insLabel: ins ? (ins.textContent || '').trim() : '',
    delLabel: del ? (del.textContent || '').trim() : '',
    group: group ? (group.querySelector('.ribbon__group-label')?.textContent || '') : ''
  }
`)
check(
  '① 功能区有「加页」「删页」两个按钮',
  entry.ins && entry.del,
  `加页=${entry.ins} 删页=${entry.del} 文案=${entry.insLabel}/${entry.delLabel} 分组=${entry.group}`
)
check('① 两个按钮落在「插入」组里（和插文字/图片同一类操作）', entry.group === '插入', `分组=${entry.group}`)

/* ---------- ② 记录初始页数 ---------- */
const before = ev(`
  const s = window.__store.getState()
  const tab = s.tabs.find((t) => t.id === s.activeTabId)
  return { pages: s.pageCount, page: s.page, path: tab?.path ?? '', name: tab?.name ?? '' }
`)
check('② 当前文档有多页（够测插页/删页）', before.pages > 1, `共 ${before.pages} 页，在第 ${before.page} 页`)

/*
 * 先跳到中间页再插。
 *
 * 回归项：新文档一打开，滚动观察会把页码拉回「可见面积最大的页」（通常是第 1 页），
 * 于是「从第 3 页插一张」插完会停在 1/21。store.reopenActiveTab 现在等新文档页数
 * 落定后再补一次 setPage，这条断言就是它的看门人。
 */
if (before.pages >= 5) {
  ev(`window.__store.getState().setPage(3); return true`)
  await sleep(700)
  const mid = ev(`
    const s = window.__store.getState()
    return { page: s.page, pages: s.pageCount }
  `)
  check('② 先跳到第 3 页（覆盖「插完停在中间页」这条回归）', mid.page === 3, `第 ${mid.page}/${mid.pages} 页`)
  before.page = mid.page
}

/* ---------- ③ 插入空白页 ---------- */
const clicked = await click('[data-tb-id="page-insert-blank"]')
check('③ 点得到「加页」按钮', clicked === true)

const inserted = await waitFor(`window.__store.getState().pageCount === ${before.pages + 1}`, 20000)
const afterInsert = ev(`
  const s = window.__store.getState()
  const tab = s.tabs.find((t) => t.id === s.activeTabId)
  return { pages: s.pageCount, page: s.page, path: tab?.path ?? '', name: tab?.name ?? '', loading: s.loading }
`)
check('③ 页数 +1（真的写进了 PDF）', inserted, `${before.pages} → ${afterInsert.pages}`)
check(
  '③ 落在新插入的那一页（页码接着原来那页）',
  afterInsert.page === before.page,
  `当前第 ${afterInsert.page} 页（原第 ${before.page} 页）`
)
check(
  '③ 打开的是工作副本（原文件没被改）',
  afterInsert.path !== before.path && /pages[\\/]/.test(afterInsert.path),
  `副本=${afterInsert.path.split(/[\\/]/).pop()}`
)
check('③ 标签名保持原文件名（不暴露副本路径）', afterInsert.name === before.name, `标签=${afterInsert.name}`)

/* ---------- ④ 新页真是空白的 ---------- */
const blank = ev(`
  const pages = Array.from(document.querySelectorAll('.pdf-page'))
  const target = pages.find((p) => p.getAttribute('data-page') === String(${before.page}))
  const canvas = target ? target.querySelector('canvas.pdf-page__canvas') : null
  return {
    found: !!target,
    canvas: !!canvas,
    w: canvas ? canvas.width : 0,
    h: canvas ? canvas.height : 0
  }
`)
check(
  '④ 新插的页渲染出来了（有画布）',
  blank.found && blank.canvas && blank.w > 0,
  `第 ${before.page} 页：画布 ${blank.w}x${blank.h}`
)

/* ---------- ⑤ 删除本页，回到原来的页数 ---------- */
await click('[data-tb-id="page-delete"]')
const deleted = await waitFor(`window.__store.getState().pageCount === ${before.pages}`, 20000)
const afterDelete = ev(`
  const s = window.__store.getState()
  return { pages: s.pageCount, page: s.page, loading: s.loading }
`)
check('⑤ 删掉一页后页数回到原值', deleted, `${afterInsert.pages} → ${afterDelete.pages}`)

/* ---------- ⑥ 收尾：回到第 1 页，别把页码留给后面的脚本 ---------- */
ev(`
  window.__store.getState().setPage(1)
  const sc = document.querySelector('.viewer-scroll')
  if (sc) sc.scrollTop = 0
  return true
`)
await sleep(600)
const final = ev(`return { page: window.__store.getState().page, pages: window.__store.getState().pageCount }`)
check('⑥ 收尾：回到第 1 页', final.page === 1, `第 ${final.page}/${final.pages} 页`)

/* ---------- ⑦ 收尾：把标签换回原始夹具文件 ----------
 * 页面结构编辑会把标签指到工作副本（userData/pages/<hash>.pdf）。
 * 后面的用例（尤其是 verify-tabs）都假设「当前开的还是 tests/fixture/fixture.pdf」，
 * 留着副本标签会让它们从「2 个标签」开始数，成片假红。
 */
const FIXTURE_JSON = JSON.stringify(join(ROOT, 'tests', 'fixture', 'fixture.pdf'))
ev(`
  const s = window.__store.getState()
  const tab = s.tabs.find((t) => t.id === s.activeTabId)
  if (tab) s.closeTab(tab.id)
  return true
`)
await sleep(400)
ev(`window.__store.getState().openFile(${FIXTURE_JSON}, 1).then(() => true)`)
await sleep(1500)
const restored = ev(`
  const s = window.__store.getState()
  return { tabs: s.tabs.length, path: s.tabs[0]?.path ?? '', name: s.tabs[0]?.name ?? '' }
`)
check(
  '⑦ 收尾：标签换回原始夹具文件（不把工作副本留给后面的用例）',
  restored.tabs === 1 && restored.path.endsWith('fixture.pdf'),
  `标签 ${restored.tabs} 个、当前 ${restored.name}`
)

console.log(
  fail === 0
    ? `\n✓ 页面结构编辑：全部通过（${pass} 项）`
    : `\n✗ 页面结构编辑：失败 ${fail} 项 / 共 ${pass + fail} 项`
)
process.exit(fail === 0 ? 0 : 1)
