// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * verify-theme-store.mjs —— 主题商店：入口在设置里、清单能吃下 B9 的新字段
 *
 * 2.0.0 把「主题配色」和「插件」拆成两个商店（用户第 2、7 条）：
 *   · 主题商店 → 设置 → 外观 → 「主题商店」按钮（`settings-open-market`）；
 *   · 插件商店 → 右栏（另有用例 verify-plugin-store.mjs 覆盖）。
 *
 * 本用例盯的是 B9 的清单能力在客户端真的生效：
 *   ① 设置 → 外观里有主题商店入口，点开是 `.market-panel`，标题写「主题商店」；
 *   ② 清单里的 `pack` 会连带改圆角/模糊/面板透明度（装了以后主题包形态跟着换）；
 *   ③ 清单里的 `preview` / `category` 能读出来（详情卡片用）；
 *   ④ 缺七个配色任意一个的条目不收（整条丢弃，不做半坏主题）；
 *   ⑤ `pack` 写坏不影响这条配色（可选项坏掉只当没写）。
 *
 * 清单不是从网上下载的（测试环境不该依赖外网），而是直接灌进 store 的
 * `marketItems`，再用真实的 `installTheme` 走一遍安装链路。
 *
 * 用法：node tools/verify-theme-store.mjs [端口]
 */
import { spawnSync } from 'node:child_process'

const PORT = process.argv[2] ?? '9620'
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

/** 三条测试清单：一条完整、一条带坏 pack、一条缺配色 */
const ITEMS = [
  {
    id: 'qx-test-a',
    name: '测试包甲',
    version: '1.0.0',
    author: '秋夕月拾旧',
    desc: '七色齐全 + 主题包形态 + 预览图 + 分类',
    category: '浅色',
    preview: 'https://example.com/a.png',
    theme: {
      accent: '47 125 109',
      bg: '250 246 237',
      surface: '255 255 255',
      text: '32 34 38',
      muted: '120 116 108',
      border: '226 219 205',
      readerBg: '244 239 229'
    },
    pack: { radius: 18, blur: 12, panelAlpha: 0.62 }
  },
  {
    id: 'qx-test-b',
    name: '测试包乙',
    version: '1.0.0',
    desc: 'pack 写坏（radius 不是数字）—— 应该只当没写',
    theme: {
      accent: '120 80 200',
      bg: '24 26 32',
      surface: '32 35 42',
      text: '236 238 242',
      muted: '150 154 164',
      border: '58 62 72',
      readerBg: '20 22 28'
    },
    pack: { radius: '很圆', blur: 6, panelAlpha: 0.5 }
  },
  {
    id: 'qx-test-c',
    name: '测试包丙',
    version: '1.0.0',
    desc: '缺 readerBg —— 整条不该被收进清单',
    theme: {
      accent: '200 60 60',
      bg: '255 255 255',
      surface: '255 255 255',
      text: '20 20 20',
      muted: '120 120 120',
      border: '220 220 220'
    }
  }
]

async function main() {
  console.log('主题商店（隐藏窗口）')
  console.log(`  端口 ${PORT}\n`)

  /* 归位：关掉一切面板、回到默认主题，记下原始设置以便收尾 */
  const before = await ev(`
    const s = window.__store.getState()
    if (s.showTools) s.setShowTools(false)
    if (s.showPluginStore) s.setShowPluginStore(false)
    if (s.showThemeStore) s.setShowThemeStore(false)
    if (s.showImageTools) s.setShowImageTools(false)
    if (s.compareOpen) s.closeComparePane()
    const st = window.__store.getState().settings
    return { theme: st.theme, radius: st.glassRadius, blur: st.glassBlur, alpha: st.panelAlpha, custom: st.customThemeId || '' }
  `)

  /* ① 打开设置 → 外观 → 主题商店 */
  const opened = await ev(`
    const s = window.__store.getState()
    if (!s.showSettings) s.setShowSettings(true)
    await new Promise((r) => setTimeout(r, 500))
    const card = document.querySelector('[data-tb-id="settings-tab-appearance"]') || null
    if (card) card.click()
    await new Promise((r) => setTimeout(r, 300))
    const btn = document.querySelector('[data-tb-id="settings-open-market"]')
    if (!btn) return { entry: false }
    btn.click()
    await new Promise((r) => setTimeout(r, 600))
    const panel = document.querySelector('[data-market="1"]')
    const title = (panel?.querySelector('h2')?.textContent || '').trim()
    return { entry: true, panel: Boolean(panel), title, pluginStore: Boolean(document.querySelector('[data-plugin-store="1"]')) }
  `)
  check('① 设置 → 外观里有「主题商店」入口', opened.entry === true)
  check('② 打开的是主题商店，不是插件商店', opened.panel === true && opened.title.includes('主题商店') && opened.pluginStore === false, opened.title)

  /* ③ 归一规则：缺配色的整条丢弃、坏 pack 只当没写 */
  const normalized = await ev(`
    const items = ${JSON.stringify(ITEMS)}
    const list = window.__marketNormalize.list(items)
    const byId = Object.fromEntries(list.map((x) => [x.id, x]))
    return {
      count: list.length,
      ids: list.map((x) => x.id),
      aPack: byId['qx-test-a']?.pack || null,
      bPack: byId['qx-test-b']?.pack || null,
      bAccent: byId['qx-test-b']?.theme?.accent || ''
    }
  `)
  check('③ 缺一个配色的条目被整条丢弃', normalized.count === 2 && !String(normalized.ids).includes('qx-test-c'), JSON.stringify(normalized.ids))
  check('④ 合法的 pack 被原样留下', normalized.aPack && normalized.aPack.radius === 18 && normalized.aPack.blur === 12, JSON.stringify(normalized.aPack))
  check('⑤ pack 写坏只当没写，配色照样可用', normalized.bPack === null && normalized.bAccent === '120 80 200', JSON.stringify({ pack: normalized.bPack, accent: normalized.bAccent }))

  /* 把合法清单灌进 store（后面的安装走真实链路） */
  await ev(`
    const list = window.__marketNormalize.list(${JSON.stringify(ITEMS)})
    window.__store.setState({ marketItems: list })
    await new Promise((r) => setTimeout(r, 200))
    return true
  `)

  /* ④ 装「测试包甲」：主题变 custom，圆角/模糊/透明度跟 pack 一起变 */
  const installed = await ev(`
    const item = window.__store.getState().marketItems.find((x) => x.id === 'qx-test-a')
    await window.__store.getState().installTheme(item)
    await new Promise((r) => setTimeout(r, 700))
    const s = window.__store.getState().settings
    const root = document.documentElement
    return {
      theme: s.theme,
      customId: s.customThemeId || '',
      radius: s.glassRadius,
      blur: s.glassBlur,
      alpha: s.panelAlpha,
      cssRadius: getComputedStyle(root).getPropertyValue('--radius').trim(),
      cssBlur: getComputedStyle(root).getPropertyValue('--glass-blur').trim()
    }
  `)
  check('⑥ 装包后主题切到 custom', installed.theme === 'custom' && installed.customId === 'qx-test-a', JSON.stringify({ theme: installed.theme, id: installed.customId }))
  check(
    '⑦ 清单里的 pack 形态一起生效（圆角 18 / 模糊 12 / 透明度 0.62）',
    installed.radius === 18 && installed.blur === 12 && Math.abs(installed.alpha - 0.62) < 0.001,
    JSON.stringify({ radius: installed.radius, blur: installed.blur, alpha: installed.alpha })
  )
  check('⑧ CSS 变量跟着 pack 走', installed.cssRadius === '18px' && installed.cssBlur === '12px', JSON.stringify({ radius: installed.cssRadius, blur: installed.cssBlur }))

  /* ⑦ 可选项（preview / category）在清单里读得到 */
  const meta = await ev(`
    const item = window.__store.getState().marketItems.find((x) => x.id === 'qx-test-a')
    return { preview: item.preview || '', category: item.category || '' }
  `)
  check('⑨ 清单能带预览图与分类', meta.preview.startsWith('https://') && meta.category === '浅色', JSON.stringify(meta))

  /* 收尾：把设置还原（别把后面的主题用例带跑偏），关面板 */
  const restored = await ev(`
    const s = window.__store.getState()
    await s.patchSettings({
      theme: ${JSON.stringify(before.theme)},
      glassRadius: ${Number(before.radius) || 10},
      glassBlur: ${Number(before.blur) || 0},
      panelAlpha: ${Number(before.alpha) || 1}
    })
    if (window.__store.getState().showThemeStore) s.setShowThemeStore(false)
    if (window.__store.getState().showSettings) s.setShowSettings(false)
    await new Promise((r) => setTimeout(r, 400))
    const st = window.__store.getState().settings
    return { theme: st.theme, radius: st.glassRadius, open: window.__store.getState().showThemeStore || window.__store.getState().showSettings }
  `)
  check('⑩ 收尾：主题与面板都还原', restored.theme === before.theme && restored.open === false, JSON.stringify(restored))

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${failed.length === 0 ? '✓ 全部通过' : `✗ 失败 ${failed.length} 项`}（${results.length} 项）`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('✗', e.message)
  process.exit(1)
})
