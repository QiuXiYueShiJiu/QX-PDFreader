// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 插件商店与插件宿主的端到端验证（2.0.0）。
 *
 * 覆盖：
 *   ① 右栏入口打开的「插件商店」面板存在，分「发现 / 已装」两个页签；
 *   ② 面板里**没有**主题商店的东西（两者分家，用户第 2、7 条）；
 *   ③ 装一个真实的 .qxplugin（现场用 fflate 打 zip）→ 出现在「已装」；
 *   ④ 插件注册的命令出现在上栏「工具 → 插件」组；
 *   ⑤ 命令可执行（返回 ok）；
 *   ⑥ 停用 / 启用状态能落盘并回读；
 *   ⑦ 卸载后从列表与命令表里都消失；
 *   ⑧ 权限闸门：清单里没声明 ui.dialog 的插件调 api.ui.notify 会被拦住。
 *
 * 用法：node tools\run-verify-suite.mjs --dev <端口> verify-plugin-store.mjs
 * 也可以单跑：node tools\verify-plugin-store.mjs <端口>
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT = Number(process.argv[2] ?? 9222)
const TMP = join(ROOT, 'test-results', 'plugin-fixture')

let pass = 0
let fail = 0

function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ✓ ${name}${detail ? `（${detail}）` : ''}`)
    pass += 1
  } else {
    console.log(`  ✗ ${name}${detail ? `（${detail}）` : ''}`)
    fail += 1
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * cdp-eval 会把结果按 2 空格缩进打印（对象是多行），所以不能只读最后一行。
 * 先整体 parse，失败再退回「最后一行」，最后兜底当字符串。
 */
async function cdp(expression) {
  const out = execFileSync(
    process.execPath,
    [join(ROOT, 'scripts', 'cdp-eval.mjs'), String(PORT), expression],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  ).trim()
  try {
    return JSON.parse(out)
  } catch {
    const lines = out.split(/\r?\n/).filter(Boolean)
    const last = lines[lines.length - 1]
    try {
      return JSON.parse(last)
    } catch {
      return last
    }
  }
}

/** 包一层 async IIFE，避免 JSON.stringify(Promise) 拿到 {} */
async function ev(body) {
  return cdp(`(async () => { ${body} })()`)
}

/**
 * 造两个插件包：
 *   qx.probe      —— 正常插件，注册一条命令，run 时只返回成功；
 *   qx.no-perm    —— 清单里不声明 ui.dialog，activate 里就调 api.ui.notify，
 *                    用来验证「没声明就被拦住」这条真的生效。
 */
function buildPackages() {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })

  const encoder = new TextEncoder()

  const goodManifest = {
    id: 'qx.probe',
    name: '自检插件',
    version: '1.0.0',
    author: '验证脚本',
    description: '只注册一条 ping 命令，用来确认插件链路是通的',
    permissions: ['document.read'],
    main: 'main.js'
  }
  const goodMain = `
exports.activate = function (api) {
  api.commands.register({
    id: 'ping',
    label: '自检 ping',
    run: function () {
      // 命令本身不产生副作用，能被调到就算通过
      return true
    }
  })
}
`
  const goodZip = zipSync({
    'manifest.json': encoder.encode(JSON.stringify(goodManifest, null, 2)),
    'main.js': encoder.encode(goodMain)
  })
  const goodPath = join(TMP, 'qx-probe.qxplugin')
  writeFileSync(goodPath, goodZip)

  const badManifest = {
    id: 'qx.no-perm',
    name: '越权插件',
    version: '1.0.0',
    description: '清单没声明 ui.dialog，却想弹提示',
    permissions: ['document.read'],
    main: 'main.js'
  }
  const badMain = `
exports.activate = function (api) {
  var blocked = 'not-tried'
  try {
    api.ui.notify('hello')
    blocked = 'allowed'
  } catch (e) {
    blocked = 'blocked'
  }
  api.commands.register({
    id: 'report',
    label: '越权结果',
    // 拦住才算通过：没拦住就抛错，runCommand 会返回 ok:false
    run: function () {
      if (blocked !== 'blocked') throw new Error('权限闸门没拦住：' + blocked)
      return true
    }
  })
}
`
  const badZip = zipSync({
    'manifest.json': encoder.encode(JSON.stringify(badManifest, null, 2)),
    'main.js': encoder.encode(badMain)
  })
  const badPath = join(TMP, 'qx-no-perm.qxplugin')
  writeFileSync(badPath, badZip)

  return { goodPath, badPath }
}

async function main() {
  console.log('▶ 插件商店 / 插件宿主')

  /* 先把可能残留的旧安装清掉，保证从干净状态开始 */
  await ev(`
    const s = window.__store.getState()
    const list = await window.pdfApp.plugins.list()
    for (const p of list) await window.pdfApp.plugins.uninstall(p.id)
    await s.loadPlugins()
    return true
  `)

  /* ① 面板存在、两个页签 */
  const panel = await ev(`
    const s = window.__store.getState()
    s.setShowPluginStore(true)
    await new Promise((r) => setTimeout(r, 400))
    const root = document.querySelector('[data-plugin-store="1"]')
    const tabs = [...(root?.querySelectorAll('[data-tb-id^="plugin-tab-"]') ?? [])].map((b) => b.dataset.tbId)
    return {
      open: !!root,
      tabs,
      title: root?.querySelector('.plugin-store__title')?.textContent ?? '',
      dialogLabel: root?.getAttribute('aria-label') ?? '',
      hasThemeStoreInside: !!root?.querySelector('[data-market-item]')
    }
  `)
  check('① 插件商店面板打开', panel?.open === true)
  check('① 两个页签：发现 / 已装', JSON.stringify(panel?.tabs ?? []) === JSON.stringify(['plugin-tab-discover', 'plugin-tab-installed']), (panel?.tabs ?? []).join(','))
  check('① 标题是「插件商店」', panel?.title === '插件商店', panel?.title ?? '')
  check('② 面板里没有主题卡片（与主题商店分家）', panel?.hasThemeStoreInside === false)

  /* ③ 装两个包 */
  const { goodPath, badPath } = buildPackages()
  const installGood = await ev(`
    const s = window.__store.getState()
    const r = await window.pdfApp.plugins.installPath(${JSON.stringify(goodPath)})
    const r2 = await window.pdfApp.plugins.installPath(${JSON.stringify(badPath)})
    await s.loadPlugins()
    return { good: r, bad: r2 }
  `)
  check('③ 正常插件安装成功', installGood?.good?.ok === true, installGood?.good?.error ?? '')
  check('③ 越权插件（清单合法）也能装上，权限问题留到运行期', installGood?.bad?.ok === true, installGood?.bad?.error ?? '')

  const listed = await ev(`
    const s = window.__store.getState()
    await s.loadPlugins()
    const items = (await window.pdfApp.plugins.list()).map((p) => ({ id: p.id, name: p.name, v: p.version, on: p.enabled }))
    const cmds = await window.pdfApp.plugins.commands()
    return { items, cmds }
  `)
  const ids = (listed?.items ?? []).map((p) => p.id)
  check('③ 已装列表里有 qx.probe', ids.includes('qx.probe'), ids.join(','))
  check('③ 已装列表里有 qx.no-perm', ids.includes('qx.no-perm'))

  /* ④ 命令进上栏「工具 → 插件」组 */
  const ribbon = await ev(`
    const s = window.__store.getState()
    s.setShowPluginStore(false)
    s.setRibbonTab ? s.setRibbonTab('tools') : null
    document.querySelector('[data-tb-id="ribbon-tab-tools"]')?.click()
    await new Promise((r) => setTimeout(r, 500))
    const groups = [...document.querySelectorAll('.ribbon__group')].map((g) => ({
      label: g.querySelector('.ribbon__group-label')?.textContent ?? '',
      ids: [...g.querySelectorAll('[data-tb-id]')].map((b) => b.dataset.tbId)
    }))
    const plug = groups.find((g) => g.label === '插件')
    return { groups: groups.map((g) => g.label), plugIds: plug?.ids ?? [] }
  `)
  check('④ 上栏出现「插件」分组', (ribbon?.groups ?? []).includes('插件'), (ribbon?.groups ?? []).join('|'))
  check(
    '④ 分组里挂着两条插件命令',
    (ribbon?.plugIds ?? []).includes('qx.probe:ping') && (ribbon?.plugIds ?? []).includes('qx.no-perm:report'),
    (ribbon?.plugIds ?? []).join(',')
  )

  /* ⑤ 命令可执行 */
  const ran = await ev(`
    const a = await window.pdfApp.plugins.run('qx.probe:ping')
    const b = await window.pdfApp.plugins.run('qx.no-perm:report')
    return { a, b }
  `)
  check('⑤ 正常命令执行成功', ran?.a?.ok === true, ran?.a?.error ?? '')

  /* ⑧ 权限闸门：没声明 ui.dialog 的插件弹提示会被拦住 */
  const permBlocked = await ev(`
    const r = await window.pdfApp.plugins.run('qx.no-perm:report')
    return r
  `)
  check('⑧ 越权调用被拦截（命令仍返回成功，拦截发生在插件内部）', permBlocked?.ok === true)

  /* ⑥ 停用 / 启用 */
  const toggled = await ev(`
    const s = window.__store.getState()
    await window.pdfApp.plugins.setEnabled('qx.probe', false)
    await s.loadPlugins()
    const off = (await window.pdfApp.plugins.list()).find((p) => p.id === 'qx.probe')
    await window.pdfApp.plugins.setEnabled('qx.probe', true)
    await s.loadPlugins()
    const on = (await window.pdfApp.plugins.list()).find((p) => p.id === 'qx.probe')
    return { off: off?.enabled, on: on?.enabled }
  `)
  check('⑥ 停用后 enabled=false', toggled?.off === false)
  check('⑥ 再启用后 enabled=true', toggled?.on === true)

  /* ⑦ 卸载 */
  const removed = await ev(`
    const s = window.__store.getState()
    const r1 = await window.pdfApp.plugins.uninstall('qx.probe')
    const r2 = await window.pdfApp.plugins.uninstall('qx.no-perm')
    await s.loadPlugins()
    const left = (await window.pdfApp.plugins.list()).map((p) => p.id)
    const cmds = (await window.pdfApp.plugins.commands()).map((c) => c.id)
    return { r1, r2, left, cmds }
  `)
  check('⑦ 卸载成功', removed?.r1?.ok === true && removed?.r2?.ok === true)
  check('⑦ 列表里不再有这两个插件', (removed?.left ?? []).length === 0, (removed?.left ?? []).join(','))
  check('⑦ 命令表也清空了', (removed?.cmds ?? []).length === 0)

  /* 收尾：面板关掉，别影响后面的用例 */
  await ev(`
    const s = window.__store.getState()
    s.setShowPluginStore(false)
    s.setRibbonTab ? s.setRibbonTab('home') : null
    document.querySelector('[data-tb-id="ribbon-tab-home"]')?.click()
    await new Promise((r) => setTimeout(r, 300))
    return true
  `)
  await sleep(200)

  console.log(`\n  ${pass} 项通过，${fail} 项失败`)
  if (fail > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('脚本异常：', error)
  process.exitCode = 1
})
