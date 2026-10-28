// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 主题包（v1.0.6.0）。
 *
 * 用户 2026-10-23 的要求与反馈：
 *   · 设置里的主题有 8 档，窄面板里横向溢出（截图里最后一项被切掉）→ 拆成 3 个主题包；
 *   · 主题包 = 默认（11 档配色）/ Metro / 液态玻璃；
 *   · 每个包可以单独设置：默认包选配色、Metro 选磁贴强调色、液态玻璃调圆角与模糊；
 *   · 默认主题是米色。
 *
 * 判据（全部走 DOM 与计算样式，不截图，隐藏窗口下稳定）：
 *   ① 主题包正好 3 个，且默认（新配置）落在「默认」包
 *   ② 每档主题在包里各出现一次，没有漏项（9 档都可达）
 *   ③ 分段控件不溢出设置面板（用户截图里的 bug 的永久回归项）
 *   ④ 切到 Metro：data-theme=metro，且出现 4 个强调色按钮，点绿色 → accentColor=#107c10
 *   ⑤ 切到液态玻璃：data-theme=glass，chrome 背景是半透明（alpha < 1）
 *   ⑥ 液态玻璃的两个滑块能改 --glass-radius / --glass-blur
 *   ⑦ 默认包的 7 档逐个切换，data-theme 都跟着变
 *   ⑧ 收尾还原成米色（不影响后面的用例）
 */

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = process.argv[2] ?? '9521'
const CDP_EVAL = join(ROOT, 'scripts', 'cdp-eval.mjs')

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` —— ${detail}` : ''}`)
  if (!ok) fails.push(name)
}

const ev = (body) => {
  const r = spawnSync(
    process.execPath,
    [CDP_EVAL, PORT, `JSON.stringify((() => { ${body} })())`],
    { encoding: 'utf8', timeout: 60000 }
  )
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

/** 打开设置面板（幂等） */
const openSettings = () =>
  ev(`
    const s = window.__store.getState()
    if (!s.showSettings) s.setShowSettings(true)
    return true
  `)

const patch = (obj) =>
  ev(`
    window.__store.getState().patchSettings(${JSON.stringify(obj)})
    return true
  `)

const click = (selector) =>
  ev(`
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    el.click()
    return true
  `)

/* ---------------- ① 三个主题包 ---------------- */
// 先复位到出厂口径（米色 + 紧凑布局）：settings 是落盘的，上一轮测试留下的 glass/office
// 会让「默认主题」断言假红（2026-10-24 实测踩到）。
await patch({ theme: 'sepia', themeLayout: 'normal' })
await openSettings()
await sleep(600)

const packs = ev(`
  return [...document.querySelectorAll('[data-theme-pack]')].map((b) => ({
    id: b.dataset.themePack,
    pressed: b.getAttribute('aria-pressed') === 'true'
  }))
`)
check(
  '① 主题包正好 3 个（默认 / Metro / 液态玻璃）',
  Array.isArray(packs) &&
    packs.length === 3 &&
    packs.map((p) => p.id).join(',') === 'classic,metro,glass',
  `实际 ${Array.isArray(packs) ? packs.map((p) => p.id).join(',') : '拿不到'}`
)
check(
  '① 默认主题是米色，落在「默认」包',
  packs?.find((p) => p.id === 'classic')?.pressed === true,
  `选中 ${packs?.find((p) => p.pressed)?.id ?? '无'}`
)

/* ---------------- ② 13 档主题都可达 ---------------- */
// 必须「点一下 → 等 React 重渲染 → 再读」：一次 eval 里连点连读会拿到上一包的内容。
const allThemes = []
for (const packId of ['classic', 'metro', 'glass']) {
  await click(`[data-theme-pack="${packId}"]`)
  await sleep(350)
  const options = ev(`
    return [...document.querySelectorAll('[data-theme-option]')].map((b) => b.dataset.themeOption)
  `)
  allThemes.push({ pack: packId, options: Array.isArray(options) ? options : [] })
}
const reachable = (allThemes ?? []).flatMap((p) => {
  // Metro / 液态玻璃这两个包没有「配色」子项：包按钮本身就是那一档主题
  // （它们的设置项分别是强调色、圆角+模糊），所以把包名也算进可达集合。
  const own = (p.options ?? []).length === 0 && (p.pack === 'metro' || p.pack === 'glass') ? [p.pack] : []
  return [...(p.options ?? []), ...own]
})
const expectThemes = [
  'light',
  'warm',
  'sepia',
  'forest',
  'dark',
  'night',
  'contrast',
  'paper',
  'midnight',
  'plum',
  'glow',
  'metro',
  'glass'
]
const missing = expectThemes.filter((x) => !reachable.includes(x))
check(
  '② 13 档主题在三个包里都可达，没有漏项',
  missing.length === 0,
  missing.length ? `缺 ${missing.join(',')}` : `共 ${reachable.length} 档`
)

/* ---------------- ③ 分段控件不溢出面板 ---------------- */
const fit = ev(`
  const panel = document.querySelector('.sb-settings-panel').getBoundingClientRect()
  const segs = [...document.querySelectorAll('.sb-seg')].map((seg) => {
    const r = seg.getBoundingClientRect()
    return { w: Math.round(r.width), right: Math.round(r.right), rows: new Set([...seg.children].map((b) => Math.round(b.getBoundingClientRect().top))).size }
  })
  return { panelW: Math.round(panel.width), panelRight: Math.round(panel.right), segs }
`)
const overflows = (fit?.segs ?? []).filter((s) => s.right > (fit?.panelRight ?? 0) + 1)
check(
  '③ 所有分段控件都在面板内（用户报的横向溢出）',
  (fit?.segs?.length ?? 0) >= 2 && overflows.length === 0,
  overflows.length
    ? `${overflows.length} 个溢出，最右 ${Math.max(...overflows.map((o) => o.right))} > ${fit?.panelRight}`
    : `${fit?.segs?.length ?? 0} 个分段控件，面板宽 ${fit?.panelW}px`
)

/* ---------------- ④ Metro 包与强调色 ---------------- */
await click('[data-theme-pack="metro"]')
await sleep(400)
const metro = ev(`
  return {
    theme: document.documentElement.dataset.theme,
    radius: getComputedStyle(document.documentElement).getPropertyValue('--radius').trim(),
    accents: [...document.querySelectorAll('[data-accent-preset]')].map((b) => b.dataset.accentPreset)
  }
`)
check(
  '④ 切到 Metro 包：data-theme=metro，圆角归零，强调色入口可用（8 个预设）',
  metro?.theme === 'metro' && metro?.radius === '0px' && metro?.accents?.length === 8,
  `theme=${metro?.theme} radius=${metro?.radius} 色数=${metro?.accents?.length ?? 0}`
)

await click('[data-accent-preset="#107c10"]')
await sleep(350)
const accent = ev(`
  const s = window.__store.getState().settings
  return { set: s.accentColor, css: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() }
`)
check(
  '④ 点磁贴「绿」把强调色写成 #107c10',
  String(accent?.set ?? '').toLowerCase() === '#107c10' &&
    String(accent?.css ?? '').replace(/\s+/g, ' ') === '16 124 16',
  `设置=${accent?.set} 凭据=${accent?.css}`
)

/* ---------------- ⑤ 液态玻璃：半透明外壳 ---------------- */
/*
 * 先把两个滑块复位成默认值：上一支用例（或人工截图）可能把圆角改成了 16，
 * 直接断言「默认 14px」会误报。判据要看「凭据跟着设置走」，而不是赌环境干净。
 */
  /* 布局与配色解耦后，外壳的半透明只看主题；这里固定回紧凑布局，避免布局包的背景规则干扰判据 */
  await patch({ themeLayout: 'normal' })
/*
 * ★ 顺序必须是「先点包、再写滑块值」。
 *   点 [data-theme-pack="glass"] 会走 SettingsPanel 的 packDefaultsPatch()，把包默认值
 *   （glass 包 = 22px / 18px）写回实时字段；若先 patch 14/12 再点包，断言就会读到 22/18。
 *   放成「点包落地包默认 → 再写用户值 14/12」，验的正是 applyTheme 的 untouched 判定：
 *   用户动过滑块就尊重用户值，不被包默认顶掉。
 */
await click('[data-theme-pack="glass"]')
await sleep(400)
await patch({ theme: 'glass', glassRadius: 14, glassBlur: 12 })
await sleep(320)

/* 单条 Office 功能区后没有 .toolbar 了，外壳是 .ribbon */
const glass = ev(`
  const cs = getComputedStyle(document.querySelector('.ribbon'))
  return {
    theme: document.documentElement.dataset.theme,
    bg: cs.backgroundColor,
    blur: cs.backdropFilter || cs.webkitBackdropFilter || '',
    radius: getComputedStyle(document.documentElement).getPropertyValue('--glass-radius').trim(),
    blurVar: getComputedStyle(document.documentElement).getPropertyValue('--glass-blur').trim()
  }
`)
const alpha = (() => {
  const m = /rgba?\(([^)]+)\)/.exec(glass?.bg ?? '')
  if (!m) return null
  const parts = m[1].split(',').map((x) => Number(x.trim()))
  return parts.length === 4 ? parts[3] : 1
})()
check(
  '⑤ 切到液态玻璃：data-theme=glass，工具栏背景半透明',
  glass?.theme === 'glass' && alpha !== null && alpha < 1,
  `theme=${glass?.theme} bg=${glass?.bg}`
)
check(
  '⑤ 圆角与模糊两个凭据已生效（用户值 14px / 12px）',
  glass?.radius === '14px' && glass?.blurVar === '12px',
  `radius=${glass?.radius} blur=${glass?.blurVar} filter=${glass?.blur}`
)

/* ---------------- ⑥ 两个滑块真的能改凭据 ---------------- */
const sliders = ev(`
  const r = document.querySelector('[data-glass-radius]')
  const b = document.querySelector('[data-glass-blur]')
  if (!r || !b) return null
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(r, '24')
  r.dispatchEvent(new Event('input', { bubbles: true }))
  setter.call(b, '3')
  b.dispatchEvent(new Event('input', { bubbles: true }))
  return { radius: r.value, blur: b.value }
`)
await sleep(450)
const afterSliders = ev(`
  return {
    radius: getComputedStyle(document.documentElement).getPropertyValue('--glass-radius').trim(),
    blur: getComputedStyle(document.documentElement).getPropertyValue('--glass-blur').trim(),
    saved: {
      radius: window.__store.getState().settings.glassRadius,
      blur: window.__store.getState().settings.glassBlur
    }
  }
`)
check(
  '⑥ 拖动圆角/模糊滑块会同时改 CSS 凭据与设置',
  afterSliders?.radius === '24px' &&
    afterSliders?.blur === '3px' &&
    afterSliders?.saved?.radius === 24 &&
    afterSliders?.saved?.blur === 3,
  `凭据 ${afterSliders?.radius}/${afterSliders?.blur}，设置 ${afterSliders?.saved?.radius}/${afterSliders?.saved?.blur}（滑块读到 ${sliders?.radius}/${sliders?.blur}）`
)

/* ---------------- ⑦ 默认包 7 档逐个切换 ---------------- */
await click('[data-theme-pack="classic"]')
await sleep(400)
const classic = ['light', 'warm', 'sepia', 'forest', 'dark', 'night', 'contrast']
const switched = []
for (const name of classic) {
  const ok = await click(`[data-theme-option="${name}"]`)
  await sleep(180)
  const now = ev(`return document.documentElement.dataset.theme`)
  switched.push({ name, ok, now })
}
check(
  '⑦ 默认包 7 档逐个切换都生效',
  switched.every((one) => one.ok && one.now === one.name),
  switched
    .filter((one) => !(one.ok && one.now === one.name))
    .map((one) => `${one.name}→${one.now}`)
    .join(',') || `7 档全对`
)

/* ---------------- ⑦b 强调色：三个主题包都要能改 ---------------- */
/*
 * 用户报「改不了颜色」：1.0.6.0 里强调色只在 Metro 包露出来（而且只有 4 个固定色），
 * 默认包与液态玻璃包根本没有入口，取色器也只对阅读区底色开放。
 * 现在改成三个包共用一组预设 + 取色器 + 恢复默认，这里逐包验一遍。
 */
const accentRuns = []
for (const pack of [
  { id: 'classic', theme: 'sepia' },
  { id: 'metro', theme: 'metro' },
  { id: 'glass', theme: 'glass' }
]) {
  await patch({ theme: pack.theme, accentColor: '' })
  await sleep(320)
  const ui = ev(`
    return {
      presets: document.querySelectorAll('[data-accent-preset]').length,
      custom: document.querySelectorAll('[data-accent-custom]').length,
      reset: document.querySelectorAll('[data-accent-reset]').length
    }
  `)
  const before = ev(`return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`)
  await patch({ accentColor: '#0f766e' })
  await sleep(320)
  const after = ev(`return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`)
  const pressed = ev(`const b = document.querySelector('[data-accent-preset="#0f766e"]'); return b ? b.getAttribute('aria-pressed') : 'missing'`)
  await patch({ accentColor: '' })
  await sleep(320)
  const back = ev(`return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`)
  accentRuns.push({ ...pack, ui, before, after, pressed, back })
}
check(
  '⑦b 三个主题包都能改强调色（预设 8 个 + 取色器 + 恢复默认）',
  accentRuns.every(
    (one) =>
      one.ui?.presets === 8 &&
      one.ui?.custom === 1 &&
      one.ui?.reset === 1 &&
      one.after === '15 118 110' &&
      one.pressed === 'true' &&
      one.back === one.before &&
      one.before !== '15 118 110'
  ),
  accentRuns
    .map((one) => `${one.id}: 预设${one.ui?.presets} 取色${one.ui?.custom} 默认${one.ui?.reset} ${one.before}→${one.after}→${one.back}`)
    .join(' | ')
)


/* ---------------- ⑦c 设置页性能：玻璃主题不能把面板做成「逐帧模糊」 ---------------- */
/*
 * 用户报「设置页卡顿不流畅」。根因是液态玻璃给整块设置面板与每张卡片都挂了
 * backdrop-filter：面板占满整列、底下压着 PDF 页面，滚一像素就重算一次模糊；
 * 卡片二十多张，每张又各开一层合成。核显一体机上直接卡死。
 * 现在面板改近实底、卡片不挂模糊，这里锁死这条约束，防止以后又被"美化"回去。
 */
await patch({ theme: 'glass' })
await sleep(400)
const perf = ev(`
  const open = document.querySelector('[data-tb-id="settings"]')
  if (open && !document.querySelector('.sb-settings-panel')) open.click()
  return { opened: !!document.querySelector('.sb-settings-panel') }
`)
await sleep(500)
const perfShot = ev(`
  const panel = document.querySelector('.sb-settings-panel')
  const card = document.querySelector('.sb-card')
  if (!panel) return { err: 'no panel' }
  const panelBlur = getComputedStyle(panel).backdropFilter
  const cardBlur = card ? getComputedStyle(card).backdropFilter : 'none'
  const list = panel.querySelector('.sb-body, .sb-settings__body') || panel
  const t0 = performance.now()
  for (let i = 0; i < 24; i++) list.scrollTop = (i % 2 === 0 ? i : 24 - i) * 40
  const cost = Math.round(performance.now() - t0)
  return { panelBlur, cardBlur, cost, opened: true }
`)
check(
  '⑦c 液态玻璃下设置页不再逐帧模糊（面板/卡片无 backdrop-filter，滚动 24 次 < 500ms）',
  perfShot?.opened === true &&
    (perfShot?.panelBlur === 'none' || perfShot?.panelBlur === undefined) &&
    (perfShot?.cardBlur === 'none' || perfShot?.cardBlur === undefined) &&
    typeof perfShot?.cost === 'number' &&
    perfShot.cost < 500,
  `面板 , ${perfShot?.panelBlur} · 卡片 , ${perfShot?.cardBlur} · 滚动 , ${perfShot?.cost}ms`
)

/* ---------------- ⑧ 收尾还原 ---------------- */
/*
 * 1.9.0 起「换包会套用新包的形态」：从液态玻璃切回默认包时，圆角/模糊/面板
 * 透明度重置为默认包的出厂值（10 / 0 / 1）。否则用户会带着玻璃包的 14px 圆角
 * 进米色皮肤 —— 这正是用户报过两次的「Metro 圆角不归零」的同一个根因。
 * 所以这里请求 14/12，期望值仍是默认包的 10/0。
 */
await patch({ theme: 'sepia', accentColor: '#b0763a', glassRadius: 14, glassBlur: 12 })
await sleep(300)
const restored = ev(`
  const s = window.__store.getState().settings
  return { theme: document.documentElement.dataset.theme, radius: s.glassRadius, blur: s.glassBlur }
`)
check(
  '⑧ 收尾还原成米色（换包后圆角/模糊跟着回到默认包的 10/0）',
  restored?.theme === 'sepia' && restored?.radius === 10 && restored?.blur === 0,
  `theme=${restored?.theme} ${restored?.radius}/${restored?.blur}`
)

/*
 * 关掉设置面板。设置面板带一层全屏遮罩（.sb-settings-scrim），留着它后面的
 * verify-tabs 连标签都点不到（elementFromPoint 命中的是遮罩）—— 实测假红。
 */
ev(`
  const s = window.__store.getState()
  if (s.showSettings) s.setShowSettings(false)
  return true
`)
await sleep(400)

if (fails.length > 0) {
  console.error(`\n✗ 主题包用例失败 ${fails.length} 项：${fails.join('、')}`)
  process.exit(1)
}
console.log('\n✓ 主题包用例全部通过')
