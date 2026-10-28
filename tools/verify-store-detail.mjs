// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * verify-store-detail.mjs —— 插件商店的检索/分类/详情/一键更新（2.0.0 B10）
 *
 * 用户第 7 条要求「API 支持范围广一点」，B10 把商店要有的能力列全了：
 * 搜索、分类/标签筛选、排序、已装标记与更新提示、详情页（截图 + 说明 + 版本历史）、
 * 一键更新全部。verify-plugin-store.mjs 管的是安装与权限闸门，这支只管**面板能力**。
 *
 * 清单不联网：直接注入 shopItems，再对着真实 DOM 断言。之所以敢这么测，
 * 是因为「清单从哪来」已经由 verify-plugin-store 的安装链路覆盖，
 * 这里要验的是「拿到清单以后面板能不能用」。
 *
 * 判据：
 *   ① 有分类胶囊；点「浅色」只剩浅色插件
 *   ② 搜索与分类能叠加（分类内搜不到 → 空提示）
 *   ③ 点「详情」开抽屉，作者/权限/版本历史都在
 *   ④ 关了抽屉能回到列表
 *   ⑤ 有已装且版本不同 → 卡片出现「可更新」标记，且冒出「更新全部」按钮
 *   ⑥ 收尾：清掉注入的清单、关面板
 *
 * 用法：node tools/verify-store-detail.mjs [端口]
 */
import { spawnSync } from 'node:child_process'

const PORT = process.argv[2] ?? '9630'
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

const ITEMS = [
  {
    id: 'qx-dark-a',
    name: '深色示例甲',
    version: '1.2.0',
    author: '秋夕月拾旧',
    description: '把当前页做成深色讲义的示例插件',
    download: 'https://example.com/a.qxplugin',
    sha256: 'a'.repeat(64),
    size: 1024,
    category: '深色',
    tags: ['投影', '讲义'],
    permissions: ['document.read', 'network'],
    preview: ['https://example.com/a-1.png', 'https://example.com/a-2.png'],
    requires: ['网络'],
    versions: [
      { version: '1.2.0', date: '2026-10-20', note: '支持分屏' },
      { version: '1.1.0', date: '2026-10-01', note: '首个公开版' }
    ]
  },
  {
    id: 'qx-light-b',
    name: '浅色示例乙',
    version: '1.0.0',
    author: '另一位老师',
    description: '浅色皮肤的示例插件',
    download: 'https://example.com/b.qxplugin',
    category: '浅色',
    permissions: ['document.read']
  },
  {
    id: 'qx-light-c',
    name: '浅色示例丙',
    version: '2.0.0',
    author: '另一位老师',
    description: '另一个浅色示例',
    download: 'https://example.com/c.qxplugin',
    category: '浅色',
    permissions: ['settings.write']
  }
]

async function main() {
  console.log('插件商店的面板能力（隐藏窗口）')
  console.log(`  端口 ${PORT}\n`)

  /* 注入清单并把「已装」里挑一条做成旧版本，用来验「可更新」与「更新全部」 */
  const seeded = await ev(`
    const items = ${JSON.stringify(ITEMS)}
    const installed = window.__store.getState().installedPlugins
    if (installed.length > 0) {
      items[0] = { ...items[0], id: installed[0].id, name: installed[0].name, version: '9.9.9' }
    }
    window.__store.setState({ pluginShopItems: items, pluginShopError: '', showPluginStore: true })
    await new Promise((r) => setTimeout(r, 700))
    const tab = document.querySelector('[data-tb-id="plugin-tab-discover"]')
    if (tab) tab.click()
    await new Promise((r) => setTimeout(r, 300))
    return { installed: window.__store.getState().installedPlugins.length, cards: document.querySelectorAll('[data-plugin-shop-item]').length }
  `)
  check('① 商店打开并渲染出注入的卡片', seeded.cards === 3, `${seeded.cards} 张`)

  /* ② 分类胶囊 + 筛选 */
  const cats = await ev(`
    const chips = [...document.querySelectorAll('.plugin-store__cat')].map((b) => b.textContent.trim())
    const lightBtn = [...document.querySelectorAll('.plugin-store__cat')].find((b) => b.textContent.trim() === '浅色')
    if (!lightBtn) return { chips, cards: -1 }
    lightBtn.click()
    await new Promise((r) => setTimeout(r, 300))
    const cards = [...document.querySelectorAll('[data-plugin-shop-item]')].map((a) => a.dataset.pluginShopItem)
    const pressed = lightBtn.getAttribute('aria-pressed')
    return { chips, cards, pressed }
  `)
  check('② 分类胶囊来自清单（全部 / 深色 / 浅色）', cats.chips.includes('全部') && cats.chips.includes('深色') && cats.chips.includes('浅色'), JSON.stringify(cats.chips))
  check('③ 点分类只剩该类插件', Array.isArray(cats.cards) && cats.cards.length === 2 && cats.cards.every((id) => id.startsWith('qx-light')), JSON.stringify(cats.cards))
  check('④ 分类按钮按下态正确', cats.pressed === 'true')

  /* ⑤ 搜索与分类叠加：在「浅色」里搜「深色示例」应为空 */
  const combo = await ev(`
    const input = document.querySelector('[data-tb-id="plugin-search"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '深色示例甲')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 400))
    return { cards: document.querySelectorAll('[data-plugin-shop-item]').length, empty: Boolean(document.querySelector('[data-plugin-search-empty]')) }
  `)
  check('⑤ 分类内搜索不到时给空提示（不会跨类漏出来）', combo.cards === 0 && combo.empty === true, JSON.stringify(combo))

  /* ⑥ 清掉搜索、回到「全部」，点详情 */
  const detail = await ev(`
    const input = document.querySelector('[data-tb-id="plugin-search"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const allBtn = [...document.querySelectorAll('.plugin-store__cat')].find((b) => b.textContent.trim() === '全部')
    if (allBtn) allBtn.click()
    await new Promise((r) => setTimeout(r, 400))
    const btn = document.querySelector('[data-tb-id="plugin-detail-qx-dark-a"]')
    if (!btn) return { opened: false }
    btn.click()
    await new Promise((r) => setTimeout(r, 400))
    const d = document.querySelector('[data-plugin-detail]')
    if (!d) return { opened: true, drawer: false }
    return {
      opened: true,
      drawer: true,
      id: d.dataset.pluginDetail,
      shots: d.querySelectorAll('.plugin-store__shot').length,
      versions: d.querySelectorAll('.plugin-store__versions li').length,
      meta: [...d.querySelectorAll('.plugin-store__meta dt')].map((x) => x.textContent.trim()),
      text: d.textContent || ''
    }
  `)
  check('⑥ 点「详情」打开抽屉', detail.opened === true && detail.drawer === true && detail.id === 'qx-dark-a')
  check('⑦ 抽屉里有效果图与版本历史', detail.shots === 2 && detail.versions === 2, `图 ${detail.shots} / 版本 ${detail.versions}`)
  check('⑧ 抽屉里写明权限与作者', detail.text.includes('读取文档内容') && detail.text.includes('秋夕月拾旧') && detail.text.includes('深色'), JSON.stringify(detail.meta))

  /* ⑨ 关抽屉 */
  const closed = await ev(`
    const btn = document.querySelector('[data-tb-id="plugin-detail-close"]')
    if (!btn) return { ok: false }
    btn.click()
    await new Promise((r) => setTimeout(r, 350))
    return { ok: true, drawer: Boolean(document.querySelector('[data-plugin-detail]')) }
  `)
  check('⑨ 关掉抽屉能回到列表', closed.ok === true && closed.drawer === false)

  /* ⑩ 可更新标记与「更新全部」
     「已装」列表取决于本机装过什么，验证机上通常是空的 ——
     所以这里直接往 store 里塞一条旧版本的已装记录，只验界面判断，
     不依赖用户环境（真正装包的链路由 verify-plugin-store 覆盖）。 */
  const update = await ev(`
    window.__store.setState({
      installedPlugins: [
        {
          id: 'qx-dark-a',
          name: '深色示例甲',
          version: '0.9.0',
          author: '秋夕月拾旧',
          description: '',
          permissions: [],
          enabled: true,
          dir: ''
        }
      ]
    })
    await new Promise((r) => setTimeout(r, 400))
    const cards = [...document.querySelectorAll('[data-plugin-shop-item]')]
    const bad = cards.filter((c) => c.textContent.includes('可更新'))
    const btn = document.querySelector('[data-tb-id="plugin-update-all"]')
    return { cards: cards.length, updateCards: bad.length, hasUpdateAll: Boolean(btn), label: btn ? btn.textContent.trim() : '' }
  `)
  check('⑩ 已装且版本不同 → 卡片标「可更新」', update.updateCards >= 1, `${update.updateCards} 张`)
  check('⑪ 有可更新项时出现「更新全部」', update.hasUpdateAll === true, update.label)

  /* 收尾：清空注入清单、关面板，别把后面的用例带跑 */
  const cleaned = await ev(`
    window.__store.setState({ pluginShopItems: null, installedPlugins: [] })
    const s = window.__store.getState()
    if (s.showPluginStore) s.setShowPluginStore(false)
    await new Promise((r) => setTimeout(r, 300))
    return { open: window.__store.getState().showPluginStore }
  `)
  check('⑫ 收尾：清单清空、面板关闭', cleaned.open === false)

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${failed.length === 0 ? '✓ 全部通过' : `✗ 失败 ${failed.length} 项`}（${results.length} 项）`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('✗', e.message)
  process.exit(1)
})
