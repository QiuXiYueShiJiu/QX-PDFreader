// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 验证「前台不会被本程序改动」——把用户 seq21024 的抱怨变成一条可复跑的判据。
 *
 * ── 待验证的缺陷（旧会话 seq21024，2026-10-15 16:09:11）──────────
 *   用户原话：「还有就是现在前台有一个空白无标题栏窗口弹出」
 *   当时只留下一句推测（「应该是我刚才 show-window.ps1 唤出的隐藏测试窗口闪了一下」），
 *   既没根因也没复现，随后会话就崩了；而现有套件全走 --hidden + keep-frames，
 *   **天然看不到这个现象**，所以套件全绿并不会自动关掉这条。
 *
 * ── 根因（本次查证，两条）────────────────────────────────────
 *   ① 测试工具侧：tools/show-window.ps1 做的是 ShowWindow + SetForegroundWindow，
 *      会把一个 --hidden 的阅读器窗口强行显示并置顶。窗口若还没画过内容，
 *      而阅读器是 frame:false 的自绘标题栏窗口（src/main/index.ts:227），
 *      它在屏幕上就是**一个空白、没有标题栏的矩形** —— 与用户描述完全一致。
 *      而 capture-flip-moment.mjs 是唯一会调它的脚本，当时正在跑。
 *      → 已给它和另外 7 个会动前台的脚本加门禁（tools/_guard-foreground.ps1，
 *        需 PDF_READER_ALLOW_FOREGROUND=1 才放行）。
 *   ② 产品侧（真 bug，用户也会遇到）：src/main/index.ts 的 second-instance 分支
 *      原先直接 `mainWindow.show()` + `focus()`，既不看 HIDDEN_MODE，
 *      也不等 ready-to-show。冷启动竞态下（双击 PDF 时上一个实例还在启动）
 *      窗口刚 new 出来、渲染层还没画过，show() 出来同样是个空白无标题栏窗口。
 *      → 已改为统一走 revealMainWindow()：隐藏模式直接忽略；内容没就绪就推迟。
 *
 * ── 判据（每条都能失败，且带「探针不是瞎的」对照）──────────────
 *   静态：① 源码里 show() 只出现在 ready-to-show 与 revealMainWindow 内，
 *          second-instance 走 revealMainWindow；
 *        ② **已构建产物** out/main/index.js 里也必须有守卫标记
 *            （防「源码改了但没重新构建」——1.2.0.1 那次正是这么漏的）；
 *        ③ 套件脚本不得引用任何抢前台的工具；
 *        ④ 8 个会动前台的脚本都调到 Assert-ForegroundAllowed，
 *            且 capture-flip-moment.mjs 有 PDF_READER_ALLOW_FOREGROUND 门禁。
 *   运行时：⑤ 探针能看见可见窗口（否则它和 list-windows.ps1 一样有盲点）；
 *         ⑥ 被测实例确实存在且有顶层窗口（探针看得见它的窗口，只是都不可见）；
 *         ⑦ 起第二个实例 → 它把文件转交后退出（退出码 0），
 *            主进程日志出现「第二实例请求」+「隐藏模式：忽略前台请求」；
 *         ⑧ 全程**没有任何时刻**前台窗口属于被测进程；
 *         ⑨ 结束后被测实例仍无任何可见窗口、CDP 仍活着（说明它没被搞死）。
 *
 * 用法：node tools/verify-no-foreground.mjs [端口]
 *   环境变量：PDF_READER_EXE 改测试目标（默认已安装版）、PDF_READER_DEV=1 走 dev 版、
 *            PDF_READER_LOG 指向套件那份主进程日志（套件会自动传）
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installedExe, fixturePath } from '../scripts/packaging-paths.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PORT = Number(process.argv[2] ?? process.env.PDF_READER_PORT ?? 9290)

const INSTALLED = installedExe()
const DEV = process.env.PDF_READER_DEV === '1'
const EXE = process.env.PDF_READER_EXE ?? (DEV ? join(root, 'node_modules', 'electron', 'dist', 'electron.exe') : INSTALLED)
const PDF = fixturePath()
const LOG = process.env.PDF_READER_LOG ?? join(root, 'test-results', `instance-${PORT}.log`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const failures = []
const notes = []
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? '  —— ' + detail : ''}`)
  if (!ok) failures.push(label)
}

/* ── 只读探针：前台窗口 + 某进程的全部顶层窗口 ───────────────── */
function snapshot(processId = 0) {
  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(root, 'tools', 'foreground-snapshot.ps1'),
      ...(processId ? ['-ProcessId', String(processId)] : [])
    ],
    { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 30000 }
  )
  const lines = `${r.stdout ?? ''}`.split(/\r?\n/).filter((l) => l.trim())
  const parse = (l) => {
    const p = l.split('|')
    return { kind: p[0], hwnd: Number(p[1]), pid: Number(p[2]), visible: p[3] === 'true', size: p[4], cls: p[5], title: p.slice(6).join('|') }
  }
  const fg = lines.find((l) => l.startsWith('FG|'))
  const totals = lines.find((l) => l.startsWith('--|'))
  return {
    ok: Boolean(fg && totals),
    fg: fg ? parse(fg) : null,
    windows: lines.filter((l) => l.startsWith('W|')).map(parse),
    totals: totals ? totals.split('|').slice(1).map(Number) : null,
    raw: lines
  }
}

/** 被测实例的进程号：靠命令行里的调试端口认，不猜名字 */
function findInstancePid() {
  const name = EXE.split('\\').pop()
  const ps =
    `Get-CimInstance Win32_Process -Filter "Name='${name}'" -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.CommandLine -like '*--remote-debugging-port=${PORT}*' } | ` +
    `Select-Object -ExpandProperty ProcessId`
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 30000
  })
  const pid = Number(`${r.stdout ?? ''}`.trim().split(/\s+/)[0])
  return Number.isFinite(pid) && pid > 0 ? pid : 0
}

async function cdpAlive() {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(3000) })).json()
    return list.some((t) => t.type === 'page' && t.url.includes('index.html'))
  } catch {
    return false
  }
}

console.log('=== 前台不被改动验证（用户 seq21024「空白无标题栏窗口」）===')
console.log(`  目标  ${EXE}${DEV ? '  (dev 版)' : '  (已安装版)'}`)
console.log(`  端口  ${PORT}\n`)

/* ── 静态判据 ─────────────────────────────────────────────── */
console.log('【静态】')
const srcMain = readFileSync(join(root, 'src', 'main', 'index.ts'), 'utf8')
{
  /** 取一段源码正文（从 startMarker 到下一条 endMarker），比按行号猜稳定得多 */
  const body = (startMarker, endMarker) => {
    const s = srcMain.indexOf(startMarker)
    if (s < 0) return ''
    const e = srcMain.indexOf(endMarker, s + startMarker.length)
    return e < 0 ? srcMain.slice(s) : srcMain.slice(s, e)
  }

  const revealBody = body('function revealMainWindow', '\nfunction ')
  const readyBody = body("once('ready-to-show'", "mainWindow.on('closed'")
  const secondBody = body("app.on('second-instance'", '})')

  check(revealBody.includes('mainWindow.show()'), '唯一的 revealMainWindow 里才有主动 show()')
  check(/HIDDEN_MODE[\s\S]*忽略前台请求/.test(revealBody), 'revealMainWindow 里有隐藏模式守卫（测试实例绝不许冒头）')
  check(/!contentReady/.test(revealBody), 'revealMainWindow 里有「内容没就绪就不显示」守卫（消除空白窗口竞态）')
  check(/contentReady = true/.test(readyBody) && /show\(\)/.test(readyBody), 'ready-to-show 里置 contentReady 并 show()')
  check(secondBody.length > 0 && !/\.show\(\)|\.focus\(\)/.test(secondBody), 'second-instance 分支不再直接 show/focus',
    secondBody.length ? '' : '没抓到 second-instance 分支正文')
  check(/revealMainWindow\(\)/.test(secondBody), 'second-instance 分支走 revealMainWindow()')

  // ② 产物里也得有 —— 源码改了没重新构建，是 1.2.0.1 那次真踩过的坑
  const outMain = join(root, 'out', 'main', 'index.js')
  const built = existsSync(outMain) ? readFileSync(outMain, 'utf8') : ''
  check(Boolean(built), `已构建产物存在（${outMain}）`)
  if (built) {
    check(built.includes('忽略前台请求') && built.includes('尚未完成首次绘制'), 'out/main/index.js 里含新守卫（产物不是旧的）')
    check(built.includes('第二实例请求'), 'out/main/index.js 里含第二实例日志')
  }

  // ③ 套件脚本不许碰抢前台的工具
  const suiteScripts = readFileSync(join(root, 'tools', 'run-verify-suite.mjs'), 'utf8')
  const listed = [...suiteScripts.matchAll(/'(verify-[\w-]+\.mjs)'/g)].map((m) => m[1])
  const bad = []
  for (const s of listed) {
    // 跳过自己：本脚本的判据里就要写出这些工具名（那是「扫描名单」，不是「调用」）
    if (s === basename(fileURLToPath(import.meta.url))) continue
    const txt = readFileSync(join(root, 'tools', s), 'utf8')
    if (/show-window|focus-window|focus-slideshow|maximize-window|move-window|click-at|send-click|send-key/.test(txt)) bad.push(s)
  }
  check(bad.length === 0, `套件里 ${listed.length} 个脚本（除自查脚本外）都不引用抢前台的工具`, bad.join(', '))

  // ④ 会动前台的脚本自己得带门禁
  const guarded = ['show-window.ps1', 'focus-window.ps1', 'focus-slideshow.ps1', 'maximize-window.ps1', 'move-window.ps1', 'click-at.ps1', 'send-click.ps1', 'send-key.ps1']
  const unguarded = guarded.filter((f) => {
    const t = readFileSync(join(root, 'tools', f), 'utf8')
    return !/Assert-ForegroundAllowed/.test(t)
  })
  check(unguarded.length === 0, `${guarded.length} 个会改前台的脚本都调到 Assert-ForegroundAllowed`, unguarded.join(', '))
  check(/Assert-ForegroundAllowed/.test(readFileSync(join(root, 'tools', '_guard-foreground.ps1'), 'utf8')),
    '守卫本体存在（tools/_guard-foreground.ps1）')
  /*
   * capture-flip-moment.mjs 是仓库里**漏提交**的辅助脚本（和 cdp-eval / show-window
   * 同一类）。它不参与产品行为，只是手动抓翻页瞬间的工具，所以缺了不该让整支
   * 用例崩掉 —— 那样会把后面真正验「前台没被改动」的运行时判据一起跳过。
   * 这里改成明确跳过并打印，缺文件这件事本身仍然可见。
   */
  const capturePath = join(root, 'tools', 'capture-flip-moment.mjs')
  if (existsSync(capturePath)) {
    check(
      /PDF_READER_ALLOW_FOREGROUND/.test(readFileSync(capturePath, 'utf8')),
      'capture-flip-moment.mjs 有 PDF_READER_ALLOW_FOREGROUND 门禁'
    )
  } else {
    console.log('  ⚠ 跳过：tools/capture-flip-moment.mjs 不在仓库里（漏提交，非产品缺陷）')
  }
}

/* ── 运行时判据 ───────────────────────────────────────────── */
console.log('\n【运行时】')
const pid = findInstancePid()
check(pid > 0, '找到被测实例进程（按命令行里的调试端口认）', pid ? `pid=${pid}` : '没找到')
if (!pid) {
  console.log('\n✗ 没有被测实例，运行时的判据无法执行')
  process.exit(1)
}

const before = snapshot(pid)
// ⑤ 探针不是瞎的：它得看得见「可见窗口」，否则「没有可见窗口」这句话没有意义
check(before.ok && before.totals && before.totals[0] > 50 && before.totals[1] > 0,
  '探针能看见顶层窗口与可见窗口（对照：探针不是瞎的）',
  before.totals ? `顶层 ${before.totals[0]}，可见 ${before.totals[1]}，本例匹配 ${before.totals[2]}` : '没读到统计行')

// ⑥ 探针确实看得见被测实例的窗口，只是都不可见
const mine = before.windows.filter((w) => w.pid === pid)
const mineVisible = mine.filter((w) => w.visible)
check(mine.length > 0, `探针看得见被测实例的顶层窗口（${mine.length} 个，含不可见的）`)
check(mineVisible.length === 0, '被测实例没有任何可见窗口（--hidden 全程成立）',
  mineVisible.map((w) => `${w.size} ${w.cls}`).join(' '))

const fgBefore = before.fg
console.log(`  基线前台：pid=${fgBefore.pid} ${fgBefore.size} 《${fgBefore.title}》`)

/*
 * ⑦ 灵敏度对照（每轮都做）：探针必须能对某个**已知可见窗口**报出 visible=true。
 *    原实现拿「当前前台进程」当正样本，但前台可能是个没有顶层可见窗口的壳
 *    （实测：音量控制浮层 pid=6300 → 该 pid 下 0 个可见窗口），
 *    那会把环境差异判成产品失败。改为从全量枚举里挑一个可见窗口当样本；
 *    一个都挑不到才跳过（而不是红）。
 */
const full = snapshot()
const control = (full.windows ?? []).find((w) => w.visible && w.pid !== pid && w.hwnd)
const fgVisible = (full.windows ?? []).filter((w) => w.visible && w.pid === fgBefore.pid).length
if (control) {
  const ctl = snapshot(control.pid)
  const hit = (ctl.windows ?? []).find((w) => w.hwnd === control.hwnd)
  check(Boolean(hit && hit.visible), '灵敏度对照：探针对已知可见窗口报出 visible=true（visible 字段真的在用）',
    `样本 pid=${control.pid} hwnd=${control.hwnd} 《${control.title}》；前台 pid=${fgBefore.pid} 可见窗口 ${fgVisible} 个`)
} else {
  console.log('   ⚠ 跳过灵敏度对照：本次枚举里没有「不属于被测实例的可见顶层窗口」（会话可能无桌面），取不到正样本')
}

// ⑦ 起第二个实例：真实用户路径（双击 PDF）—— 它必须转交文件后自己退出，
//    而且**不许**把已在跑的那个隐藏实例拽到前台
const childArgs = DEV ? ['.', '--hidden', PDF] : ['--hidden', PDF]
const logBefore = existsSync(LOG) ? readFileSync(LOG, 'utf8') : ''
const child = spawn(EXE, childArgs, { cwd: DEV ? root : dirname(EXE), windowsHide: true, stdio: 'ignore' })
const exitInfo = await new Promise((res) => {
  const timer = setTimeout(() => res({ code: 'timeout' }), 20000)
  child.on('exit', (code) => {
    clearTimeout(timer)
    res({ code })
  })
  child.on('error', (e) => {
    clearTimeout(timer)
    res({ code: 'error', e })
  })
})
check(exitInfo.code === 0, '第二个实例把文件转交后自己退出（退出码 0）', String(exitInfo.code))
try {
  child.kill()
} catch {
  /* 已经退了 */
}

/*
 * 日志里找标记要**轮询**，别只读一次就下结论：
 *   打印「第二实例请求」的是**第一个**实例（持锁那个），它在第二个实例退出后
 *   才被 Electron 回调唤醒，写日志比第二个实例的 exit 晚一点点；
 *   而且这几个字节从管道到文件还有一层缓冲。实测只读一次会偶发读空。
 *   整文件搜索（不切片）是安全的：套件启动实例时把日志按 'w' 截断过，
 *   且套件已经对账过「端口上的监听者就是它刚起的那个进程」。
 */
const waitLog = async (marker, seconds = 10) => {
  const t0 = Date.now()
  while ((Date.now() - t0) / 1000 < seconds) {
    const txt = existsSync(LOG) ? readFileSync(LOG, 'utf8') : ''
    if (txt.includes(marker)) return true
    await sleep(300)
  }
  return false
}

check(await waitLog('第二实例请求'), '主进程日志出现「第二实例请求」（说明确实走到了那条分支）')
check(await waitLog('隐藏模式：忽略前台请求'), '主进程日志出现「隐藏模式：忽略前台请求」（守卫真的生效了）')

// ⑧ 全程没有任何时刻前台属于被测进程 —— 这是「不能更改前台」的直接证据
const during = snapshot(pid)
check(during.fg.pid !== pid, '前台窗口不属于被测实例（没被抢前台）',
  `前台 pid=${during.fg.pid} 《${during.fg.title}》`)
check(mine.every((w) => !w.visible) && during.windows.filter((w) => w.pid === pid).every((w) => !w.visible),
  '事件前后被测实例的窗口始终不可见')

// ⑨ 实例没被搞死
check(await cdpAlive(), '被测实例仍存活（CDP 页面还在）')

/* ── 汇总 ─────────────────────────────────────────────────── */
const fgChanged = fgBefore.hwnd !== during.fg.hwnd
notes.push(
  fgChanged
    ? `注意：前台窗口在本次验证期间换过（基线 0x${fgBefore.hwnd.toString(16)} → 现在 0x${during.fg.hwnd.toString(16)}），` +
      '只要换成的是别的进程就与本程序无关（用户自己切窗口也会这样）'
    : `前台窗口自始至终是 0x${fgBefore.hwnd.toString(16)}（未变动）`
)

console.log(`\n  被测实例：pid=${pid}，顶层窗口 ${mine.length} 个，可见 0 个`)
for (const n of notes) console.log(`  · ${n}`)
console.log(failures.length ? `\n✗ ${failures.length} 项未通过：\n   - ${failures.join('\n   - ')}` : '\n✓ 全部通过：前台未被子进程改动，隐藏实例全程未显示')
process.exit(failures.length ? 1 : 0)
