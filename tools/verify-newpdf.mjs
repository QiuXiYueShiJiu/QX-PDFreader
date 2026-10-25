/* 新建空白 PDF（1.0.7.0 新增）—— 端到端断言。
 *
 * 为什么单独立一支：这是「用户能点到的最外一层」，牵动主进程（pdf-lib 落盘）、
 * IPC、preload、工具栏按钮、对话框、以及创建后是否复用同一个窗口。任何一环
 * 松动都只表现为「点了没反应」，端到端最容易发现。
 *
 * 判据：
 *   ① 工具栏有「新建」按钮（data-tb-id="new-pdf"）
 *   ② 点开后对话框出现，默认 1 页 / A4 / 纵向
 *   ③ 页数能加、能切横向与米黄纸
 *   ④ 创建后多出一个标签，且新文档页数 = 3
 *   ⑤ 新文档是横向（宽 > 高）
 *   ⑥ 原文档还在（没有把旧标签顶掉）
 *
 * 用法：node tools/verify-newpdf.mjs [端口]
 * 注意：跑完会留下一个 `docs/.tmp-blank-*.pdf` 以外的新文件在 userData/untitled，
 * 不在仓库里，无需清理。
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
  if (!out) {
    console.error(`CDP 无输出：${(r.stderr ?? '').trim().slice(0, 300)}`)
    return {}
  }
  try {
    return JSON.parse(out)
  } catch {
    console.error(`CDP 返回不是 JSON：${out.slice(0, 300)}`)
    return {}
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const click = (selector) =>
  ev(`
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    el.click()
    return true
  `)

const before = ev(`
  const s = window.__store.getState()
  return { tabs: s.tabs.length, pages: s.pageCount, active: s.activeTabId }
`)

/* ---------------- ① 入口 ---------------- */
const entry = ev(`
  const b = document.querySelector('[data-tb-id="new-pdf"]')
  return { found: !!b, label: b ? (b.textContent || '').trim() : '' }
`)
check('① 工具栏有「新建」按钮', entry?.found === true, `文案「${entry?.label ?? ''}」`)

await click('[data-tb-id="new-pdf"]')
await sleep(450)
const dialog = ev(`
  const d = document.querySelector('.newpdf')
  if (!d) return { open: false }
  const pages = d.querySelector('[data-tb-id="newpdf-pages"]')
  const activeSize = d.querySelector('[data-tb-id^="newpdf-size-"][aria-pressed="true"]')
  const portrait = d.querySelector('[data-tb-id="newpdf-portrait"]')
  return {
    open: true,
    pages: pages ? Number(pages.value || pages.textContent) || 0 : 0,
    size: activeSize?.dataset.tbId ?? '',
    portrait: portrait?.getAttribute('aria-pressed') === 'true'
  }
`)
check('② 对话框出现，默认 1 页 / A4 / 纵向', dialog?.open === true && dialog.pages === 1 && dialog.size === 'newpdf-size-A4' && dialog.portrait === true, JSON.stringify(dialog))

/* ---------------- ③ 改页数 / 方向 / 底色 ---------------- */
await click('[data-tb-id="newpdf-pages-up"]')
await sleep(160)
await click('[data-tb-id="newpdf-pages-up"]')
await sleep(200)
const pagesNow = ev(`
  const el = document.querySelector('[data-tb-id="newpdf-pages"]')
  return el ? Number(el.value || el.textContent) || 0 : 0
`)
check('③ 页数能加到 3', pagesNow === 3, `实际 ${pagesNow}`)

await click('[data-tb-id="newpdf-landscape"]')
await sleep(180)
await click('[data-tb-id="newpdf-bg-fdf9f0"]')
await sleep(180)
const tuned = ev(`
  const d = document.querySelector('.newpdf')
  return {
    landscape: d?.querySelector('[data-tb-id="newpdf-landscape"]')?.getAttribute('aria-pressed') === 'true',
    cream: d?.querySelector('[data-tb-id="newpdf-bg-fdf9f0"]')?.getAttribute('aria-pressed') === 'true'
  }
`)
check('③ 能切横向与米黄纸', tuned?.landscape === true && tuned?.cream === true, JSON.stringify(tuned))

/* ---------------- ④ 创建 ---------------- */
await click('[data-tb-id="newpdf-create"]')
await sleep(2600)
const after = ev(`
  const s = window.__store.getState()
  const page = document.querySelector('.pdf-page')
  const w = page ? page.getBoundingClientRect().width : 0
  const h = page ? page.getBoundingClientRect().height : 0
  return {
    tabs: s.tabs.length,
    pages: s.pageCount,
    active: s.activeTabId,
    title: (s.tabs.find((t) => t.id === s.activeTabId)?.title ?? ''),
    dialogOpen: !!document.querySelector('.newpdf'),
    pageW: Math.round(w),
    pageH: Math.round(h)
  }
`)
check('④ 创建后多出一个标签', after?.tabs === (before?.tabs ?? 0) + 1, `标签 ${before?.tabs} → ${after?.tabs}`)
check('④ 新文档 3 页', after?.pages === 3, `页数 ${after?.pages}`)
check('④ 创建后对话框已关闭', after?.dialogOpen === false, `dialogOpen=${after?.dialogOpen}`)
check('⑤ 新文档是横向（宽 > 高）', (after?.pageW ?? 0) > (after?.pageH ?? 0) && (after?.pageW ?? 0) > 0, `${after?.pageW}×${after?.pageH}`)
check('⑥ 原文档仍在（没被顶掉）', (before?.active ?? '') !== (after?.active ?? ''), `active ${before?.active} → ${after?.active}`)

/* ---------------- 收尾：关掉自己建的标签 ----------------
 * 用例之间共用一个实例，留着这个空白文档会让后面的 verify-tabs 基线变成 2 个标签
 * （2026-10-24 实测：整跑时 verify-tabs ① 与 ④ 就是被它顶红的）。 */
const closed = ev(`
  const s = window.__store.getState()
  const target = ${JSON.stringify(after?.active ?? '')}
  if (target && s.tabs.length > 1) s.closeTab(target)
  return window.__store.getState().tabs.length
`)
check('收尾：关掉新建的标签，实例回到原状', closed === before?.tabs, `标签数 ${closed}`)

console.log(fail === 0 ? `\n✓ 新建空白 PDF：全部通过` : `\n✗ 新建空白 PDF：失败 ${fail} 项 / 共 ${pass + fail} 项`)
process.exit(fail === 0 ? 0 : 1)
