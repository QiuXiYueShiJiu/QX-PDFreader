// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 主题与自定义背景图（v1.0.4.0）。
 *
 * 判据（DOM 层，不依赖截图，隐藏窗口下也稳定）：
 *   ① 主题共 13 档（默认包 11 档 + Metro + 液态玻璃），面板里渲染出默认包的 11 个按钮
 *   ② 逐个切换：html[data-theme] 与 --bg 校验值都跟着变
 *   ③ Metro 主题把圆角校验值归零（直角是它的形态特征）
 *   ④ 深色类主题的 --text 比 --bg 亮；浅色类相反
 *   ⑤ 自定义背景图：设置绝对路径后 --reader-image 变成 pdf-file URL
 *   ⑥ 背景图真的能解码（<img> onload，宽度 > 0）
 *   ⑦ 压暗与模糊两个参数写进 CSS 变量
 *   ⑧ 清空路径后回到 none
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
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

const evRaw = (wrapper, body) => {
  const r = spawnSync(process.execPath, [CDP_EVAL, PORT, `(${wrapper}() => { ${body} })()`], {
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

const ev = (body) => evRaw('', body)
/** 需要 await 的片段（例如等图片解码）必须走异步包裹，否则页面里报 await is only valid... */
const evAsync = (body) => evRaw('async ', body)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const BG_DIR = 'A:\\testwallpaper'
const BG_CANDIDATES = ['阿罗娜.png', '壁纸.jpg']
const BG_PATH = (() => {
  for (const name of BG_CANDIDATES) {
    const full = join(BG_DIR, name)
    if (existsSync(full)) return full
  }
  return ''
})()

console.log('主题与背景图（DOM 断言）')

// ① 设置面板里 8 个主题按钮
const buttons = ev(`
  const s = window.__store.getState()
  s.setShowSettings(true)
  return { open: Boolean(document.querySelector('.sb-settings')), n: document.querySelectorAll('[data-theme-option]').length }
`)
await sleep(400)
const opened = ev(`
  const list = [...document.querySelectorAll('[data-theme-option]')]
  return { n: list.length, names: list.map((el) => el.getAttribute('data-theme-option')) }
`)
/*
 * v1.0.6.0 起主题拆成 3 个「主题包」：
 *   默认包（7 档配色）/ Metro / 液态玻璃。
 * 所以「默认包」里只剩 7 个 [data-theme-option]，另外两档由主题包按钮承担。
 * 这里断言的是「13 档都可达」，而不是「面板里同时有 13 个按钮」。
 */
const packCount = ev("return document.querySelectorAll('[data-theme-pack]').length")
const totalThemes = (opened.n ?? 0) + (packCount >= 3 ? 2 : 0) /* 内置 11 + Metro + 液态玻璃 = 13 */
check(
  '① 主题共 13 档（3 个主题包：默认 11 档 + Metro + 液态玻璃）',
  opened.n === 11 && packCount === 3,
  `默认包 ${opened.n} 档：${(opened.names ?? []).join(',')}；主题包 ${packCount} 个；合计 ${totalThemes} 档`
)

// ②③④ 逐档切换
const themes = [
  'light',
  'sepia',
  'dark',
  'night',
  'forest',
  'warm',
  'contrast',
  'paper',
  'midnight',
  'plum',
  'glow',
  'metro',
  'glass'
]
const seen = []
for (const t of themes) {
  ev(`window.__store.getState().patchSettings({ theme: '${t}' }); return true`)
  await sleep(180)
  const info = ev(`
    const cs = getComputedStyle(document.documentElement)
    const rgb = (v) => v.trim().split(/\\s+/).map(Number)
    const bg = rgb(cs.getPropertyValue('--bg'))
    const text = rgb(cs.getPropertyValue('--text'))
    return {
      attr: document.documentElement.dataset.theme,
      bg: cs.getPropertyValue('--bg').trim(),
      text: cs.getPropertyValue('--text').trim(),
      radius: cs.getPropertyValue('--radius').trim(),
      bgLum: bg[0] * 0.299 + bg[1] * 0.587 + bg[2] * 0.114,
      textLum: text[0] * 0.299 + text[1] * 0.587 + text[2] * 0.114
    }
  `)
  seen.push({ theme: t, ...info })
}
const attrOk = seen.every((x) => x.attr === x.theme)
check('② 每档 html[data-theme] 都写对', attrOk, seen.map((x) => x.attr).join(','))
const distinct = new Set(seen.map((x) => x.bg)).size
check('② 每档 --bg 校验值互不相同', distinct === 13, `${distinct}/13 个不同底色`)
const contrastOk = seen.every((x) => Math.abs(x.textLum - x.bgLum) > 40)
check('④ 每档文字与底色对比足够', contrastOk, seen.map((x) => `${x.theme}:${Math.round(Math.abs(x.textLum - x.bgLum))}`).join(' '))
const metro = seen.find((x) => x.theme === 'metro')
check('③ Metro 圆角归零', metro?.radius === '0px', `--radius=${metro?.radius}`)

// ⑤⑥⑦ 背景图
ev(`window.__store.getState().patchSettings({ theme: 'light' }); return true`)
if (!BG_PATH) {
  console.log('  · 跳过背景图判据：A:\\testwallpaper 下没有可用图片')
} else {
  const applied = ev(`
    window.__store.getState().patchSettings({
      readerImage: ${JSON.stringify(BG_PATH)},
      readerImageDim: 0.45,
      readerImageBlur: 6
    })
    return true
  `)
  void applied
  await sleep(700)
  const state = evAsync(`
    const cs = getComputedStyle(document.documentElement)
    const raw = cs.getPropertyValue('--reader-image').trim()
    const url = raw.replace(/^url\\(\\"?/, '').replace(/\\"?\\)$/, '')
    const loaded = await new Promise((res) => {
      const img = new Image()
      img.onload = () => res({ ok: true, w: img.naturalWidth, h: img.naturalHeight })
      img.onerror = () => res({ ok: false, w: 0, h: 0 })
      img.src = url
      setTimeout(() => res({ ok: false, w: 0, h: 0 }), 4000)
    })
    return {
      url: url.slice(0, 80),
      isPdfFile: url.startsWith('pdf-file://'),
      dim: cs.getPropertyValue('--reader-image-dim').trim(),
      blur: cs.getPropertyValue('--reader-image-blur').trim(),
      loaded: loaded.ok,
      w: loaded.w,
      h: loaded.h
    }
  `)
  check('⑤ 设置路径后 --reader-image 变成 pdf-file URL', Boolean(state.isPdfFile), state.url)
  check('⑥ 背景图能解码', Boolean(state.loaded), `${state.w}x${state.h}`)
  check('⑦ 压暗与模糊写进 CSS 变量', state.dim === '0.45' && state.blur === '6px', `dim=${state.dim} blur=${state.blur}`)

  ev(`window.__store.getState().patchSettings({ readerImage: '' }); return true`)
  await sleep(300)
  const cleared = ev(`
    const v = getComputedStyle(document.documentElement).getPropertyValue('--reader-image').trim()
    return { v, dim: getComputedStyle(document.documentElement).getPropertyValue('--reader-image-dim').trim() }
  `)
  check('⑧ 清空后回到 none', cleared.v === 'none' && cleared.dim === '0', `--reader-image=${cleared.v}`)
}

// 收尾：回到浅色 + 关设置
ev(`
  window.__store.getState().patchSettings({ theme: 'light', readerImage: '', readerImageDim: 0.35, readerImageBlur: 0 })
  window.__store.getState().setShowSettings(false)
  return true
`)

console.log(`\n${fails.length === 0 ? '✓ 主题与背景图' : '✗ 主题与背景图'}：${fails.length === 0 ? '全部通过' : `${fails.length} 项失败`}`)
process.exit(fails.length === 0 ? 0 : 1)
