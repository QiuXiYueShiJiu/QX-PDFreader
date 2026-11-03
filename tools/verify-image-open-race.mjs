// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 连开多张图片不丢（「高帧率下偶发打不开」回归用例）。
 *
 * ══════════════════════════════════════════════════════════════
 * 用户报的问题（2026-11-03，录制宣发片时发现）
 * ══════════════════════════════════════════════════════════════
 *   「连续打开两张图片，第二张有概率失败」，弹
 *   「这张图片打不开：…文件可能已损坏，或扩展名与实际内容不符」；
 *   单独打开同一个文件必成功，空闲时也常成功 —— 只在录制/高负载时必现。
 *
 * ── 根因（三条叠在一起，见 src/main/index.ts imageToPdfFile 文件头）──
 *   ① 同一张图被连开两次时，命中判断（existsSync）在写之前，
 *      两次都走「未命中」，同时往同一个缓存路径写；
 *   ② writeFile 先截断再写，渲染层可能拿到半截文件；
 *   ③ 两次转换完全并行，上一张还没收尾时再解码，nativeImage 会偶发
 *      返回空图 → 抛「无法解码」。
 *
 * ── 判据 ────────────────────────────────────────────────────
 *   不 await 地连开 6 张，每 150ms 一张（比人手快、比 B 的脚本慢一点），
 *   要求：**每一次 open.path 都返回 ok**，且最后页签数 ≥ 1、没有报错文案。
 *   修之前这条用例会间歇失败（约 1/3），修之后应当稳定全绿。
 *
 * 用法：node tools/run-verify-suite.mjs --dev 9297 verify-image-open-race.mjs
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = process.argv[2] ?? '9229'
const COUNT = 6

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let fails = 0
let checks = 0

const check = (ok, label, detail = '') => {
  checks += 1
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  —— ${detail}` : ''}`)
  if (!ok) fails += 1
}

function cdp(expr) {
  const r = spawnSync('node', [join(root, 'scripts', 'cdp-eval.mjs'), PORT, expr], {
    cwd: root,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120000
  })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
}

function parseObj(text) {
  const a = text.indexOf('{')
  const b = text.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    return JSON.parse(text.slice(a, b + 1))
  } catch {
    return null
  }
}

/* 六张不同的图：拿仓库里的截图复制成独立文件，避免"同一路径"掩盖问题 */
const tmp = mkdtempSync(join(tmpdir(), 'qx-open-race-'))
const files = []
{
  const { readdirSync } = await import('node:fs')
  const shots = readdirSync(join(root, 'docs', 'screenshots'))
    .filter((n) => /\.png$/i.test(n))
    .sort()
    .slice(0, COUNT)
  check(shots.length === COUNT, '准备工作：截图可作图片输入', `${shots.length} 张`)
  for (const [i, name] of shots.entries()) {
    const dst = join(tmp, `race-${i + 1}.png`)
    copyFileSync(join(root, 'docs', 'screenshots', name), dst)
    files.push(dst)
  }
}

console.log('连开多张图片不丢')
console.log(`  端口 ${PORT}`)
console.log(`  图片 ${files.length} 张 → ${tmp}\n`)

/* ---------- 不 await 地连发，模拟"上一张还没收尾就开下一张" ---------- */
const fired = files.map((file) => `window.pdfApp.open.path(${JSON.stringify(file)})`)
const burst = cdp(
  `(async () => {
     const posts = [${fired.join(',')}];
     const results = [];
     for (let i = 0; i < posts.length; i += 1) {
       const p = posts[i];
       if (i > 0) await new Promise((r) => setTimeout(r, 150));
       results.push(p.then(
         (r) => ({ ok: !!(r && r.ok), error: (r && r.error) || '' }),
         (e) => ({ ok: false, error: String(e) })
       ));
     }
     const settled = await Promise.all(results);
     return JSON.stringify({ settled });
   })()`
)
const parsed = parseObj(burst)
const settled = parsed?.settled ?? []
check(settled.length === COUNT, '① 六次打开都有返回', `收到 ${settled.length} 条`)

const failed = settled.filter((r) => !r.ok)
check(
  failed.length === 0,
  `② 没有一次失败（修之前会间歇失败）`,
  failed.length ? failed.map((f) => f.error.slice(0, 60)).join(' | ') : ''
)

/* ---------- 页面停在最后一张、页数正常 ---------- */
await sleep(1200)
const state = parseObj(
  cdp(`JSON.stringify({
    pageCount: window.__store.getState().pageCount,
    fileName: window.__store.getState().fileName || '',
    tabs: (window.__store.getState().tabs || []).length
  })`)
)
check(!!state && state.pageCount === 1, '③ 最终停在 1 页的图片文档', JSON.stringify(state))
check(!!state && /\.png$/i.test(state.fileName), '④ 标题是原图片名', state?.fileName)

rmSync(tmp, { recursive: true, force: true })

console.log('')
if (fails) {
  console.log(`✗ ${fails}/${checks} 项未通过`)
  process.exit(1)
}
console.log(`✓ ${checks}/${checks} 项通过`)
