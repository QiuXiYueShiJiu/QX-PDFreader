// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * PDF 工具箱验证（v1.0.2）。
 *
 * ── 这支用例在验什么 ───────────────────────────────────────────
 * 工具箱（合并/拆分/水印/压缩/加解密/图片互转/Office→PDF）本身由
 * 主进程 + 渲染层协作完成，任何一层漏接都表现为「点开面板、点运行、
 * 什么都不发生」：
 *   · 面板没渲染 → 入口没接上（Toolbar / RightRail / App）
 *   · IPC 没注册 → 报 No handler registered
 *   · preload 没暴露 → window.pdfApp.tools 是 undefined
 *   · 打包丢文件 → 运行时找不到 pdf-lib / fflate
 * 所以这里端到端跑两条**真实**链路（水印、元数据），并检查面板结构。
 *
 * 全部离线、不弹窗：输出一律写到 test-results/ 下的临时文件。
 *
 * 用法：node tools/verify-tools.mjs <端口>
 */

const PORT = process.argv[2] ?? '9411'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
let failed = 0

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failed += 1
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  —— ${detail}` : ''}`)
}

async function connect() {
  const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error('没有页面目标（实例没起或端口不对）')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true })
  })

  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data))
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`))
      else resolve(msg.result)
    }
  })

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      seq += 1
      pending.set(seq, { resolve, reject })
      ws.send(JSON.stringify({ id: seq, method, params }))
    })

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? '页面执行异常')
    }
    return r.result?.value
  }

  /* 表达式里直接 return 一个值，避免到处写 JSON.stringify */
  const evaluateJson = (body) => evaluate(`(() => { ${body} })()`)

  return { evaluate, evaluateJson, close: () => ws.close() }
}

const ROOT = process.cwd().split(String.fromCharCode(92)).join('/')
const FIXTURE = process.env.PDF_READER_FIXTURE ?? ROOT + '/tests/fixture/fixture.pdf'
const OUT_WM = ROOT + '/test-results/_tools-wm.pdf'
const OUT_META = ROOT + '/test-results/_tools-meta.pdf'

const { evaluate, evaluateJson, close } = await connect()

try {
  /* ── 1) 前置：API 暴露与文档就绪 ────────────────────────── */
  const ready = await evaluateJson(`
    const st = window.__store.getState()
    return {
      tools: typeof window.pdfApp?.tools,
      advanced: typeof window.pdfApp?.advanced,
      pages: st.pageCount,
      name: st.fileName || null
    }
  `)
  check('preload 暴露 tools / advanced 两组 API', ready.tools === 'object' && ready.advanced === 'object', JSON.stringify(ready))
  check('文档已打开', Boolean(ready.name), `${ready.name ?? '无'}，${ready.pages} 页`)
  if (ready.tools !== 'object' || !ready.name) throw new Error('前置条件不足，后续判据跳过')

  /* ── 2) 面板：入口与结构 ───────────────────────────────── */
  const panel = await evaluate(`
    (async () => {
      window.__store.getState().setShowTools(true)
      await new Promise((r) => setTimeout(r, 400))
      const nav = document.querySelectorAll('.tools-nav__item').length
      const back = Boolean(document.querySelector('.tools-back'))
      const title = document.querySelector('.tools-panel .sb-settings-title')?.textContent?.trim() ?? ''
      const closeBtn = Boolean(document.querySelector('.tools-panel [aria-label="关闭工具箱"]'))
      const cards = document.querySelectorAll('[data-tool-id]').length
      return JSON.stringify({ nav, back, cards, title, closeBtn })
    })()
  `)
  const p = JSON.parse(panel)
  check('工具箱面板能打开（右侧抽屉）', p.nav > 0, `分类 ${p.nav} 个，工具卡 ${p.cards} 个`)
  check('面板标题与关闭按钮存在', p.title.includes('工具箱') && p.closeBtn, p.title || '（无标题）')

  /* 工具箱是模态抽屉（带 .sb-settings-scrim），必须关掉，
     否则遮罩会盖住后面脚本要点的按钮（实测把 verify-content-edit 的「涂白」挡住）。 */
  const closed = await evaluate(`
    (async () => {
      const btn = document.querySelector('.tools-panel [aria-label="关闭工具箱"]')
      btn?.click()
      await new Promise((r) => setTimeout(r, 350))
      return JSON.stringify({
        panel: Boolean(document.querySelector('.tools-panel')),
        scrim: Boolean(document.querySelector('.sb-settings-scrim'))
      })
    })()
  `)
  const c = JSON.parse(closed)
  check('用完自动关掉工具箱（不留遮罩）', !c.panel && !c.scrim, c.panel ? '面板还在' : '面板已关、无遮罩')

  /* ── 3) 端到端：水印（渲染层画图 → 主进程贴到每页） ─────── */
  const wm = await evaluate(`
    (async () => {
      const c = document.createElement('canvas')
      c.width = 240
      c.height = 100
      const ctx = c.getContext('2d')
      ctx.fillStyle = 'rgba(200, 30, 30, 0.85)'
      ctx.fillRect(0, 0, 240, 100)
      ctx.fillStyle = '#ffffff'
      ctx.font = '28px sans-serif'
      ctx.fillText('SAMPLE', 20, 62)
      const data = await (await fetch(c.toDataURL('image/png'))).arrayBuffer()
      return JSON.stringify(
        await window.pdfApp.tools.watermark({
          sourcePath: ${JSON.stringify(FIXTURE)},
          targetPath: ${JSON.stringify(OUT_WM)},
          image: { data, width: 240, height: 100 },
          opacity: 0.6,
          rotation: 0,
          position: 'center'
        })
      )
    })()
  `)
  const w = JSON.parse(wm)
  check('水印链路跑通（tools:watermark）', w.ok === true, JSON.stringify(w.info ?? w.error ?? w))
  check('水印覆盖全部页', w.ok === true && Number(w.info?.['加盖页数'] ?? 0) === ready.pages, `加盖 ${w.info?.['加盖页数'] ?? 0} / ${ready.pages} 页`)

  /* ── 4) 端到端：元数据写出（pdf-lib 改信息字典） ────────── */
  const meta = await evaluate(`
    (async () => JSON.stringify(await window.pdfApp.advanced.metadata({
      sourcePath: ${JSON.stringify(FIXTURE)},
      targetPath: ${JSON.stringify(OUT_META)},
      title: '探针标题',
      author: '探针'
    })))()
  `)
  const m = JSON.parse(meta)
  check('元数据改写跑通（adv:metadata）', m.ok === true, JSON.stringify(m.info ?? m.error ?? m))
  check('输出文件路径已返回', typeof m.path === 'string' && m.path.endsWith('_tools-meta.pdf'), m.path ?? '（无）')

  /* ── 5) 高级工具的表单类 IPC 至少注册了 ─────────────────── */
  const names = await evaluateJson(`
    const api = window.pdfApp?.advanced ?? {}
    return Object.keys(api).sort()
  `)
  const need = ['formsQuery', 'formsFill', 'sign', 'redact', 'exportWord', 'exportExcel', 'comparePdf', 'batch', 'print']
  const missing = need.filter((k) => !names.includes(k))
  check('高级工具 API 齐全', missing.length === 0, missing.length ? `缺 ${missing.join('、')}` : `${names.length} 个方法`)
} catch (err) {
  check('用例执行', false, String(err?.message ?? err))
} finally {
  const passed = results.length - failed
  console.log(`\n  PDF 工具箱：${passed} / ${results.length} 通过${failed ? `，${failed} 项失败` : ''}`)
  close()
  process.exit(failed ? 1 : 0)
}
