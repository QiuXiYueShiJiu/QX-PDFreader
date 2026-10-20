// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 「原生对话框不许把进程打崩」+「退出确认框真的弹得出来」—— 端到端判据。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么必须有这一支（2026-10-16，用户报「现在退出窗口不能正常弹出」）
 * ══════════════════════════════════════════════════════════════════════
 * v2.0.0.0 交付后，点右栏「退出应用」的表现是：
 *   **没有确认框，进程直接消失**（APPCRASH，异常码 0x80000003，
 *     偏移固定 0x639afd5；WER 里有 AppCrash_秋夕-PDF阅读器.exe_* 报告）。
 * 根因是打包时往 exe 内嵌清单里注入了 `<dpiAwareness>` —— 只要清单里有
 * 这个元素，**任何** Windows 原生对话框（showMessageBox / showOpenDialog /
 * showSaveDialog）都会把进程打崩。详见 scripts/inject-dpi-manifest.mjs 头部。
 *
 * 之所以以前没抓到：旧用例 tools/verify-quit-dialog.mjs 自己写着「不真弹窗」，
 * 只查了 IPC 接线（通道在不在、日志有没有），而**隐藏模式本来就会跳过弹框**，
 * 所以「弹框这条路」从头到尾没有被验证过。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 这一支怎么测（全程后台，不弹用户的任何可见窗口）
 * ══════════════════════════════════════════════════════════════════════
 *  ① 静态：已安装产物的 exe 内嵌清单里**不允许**有 `<dpiAwareness>`
 *     （直接读 PE 字节，不用启动任何东西；这一条就能直接指认根因）；
 *  ② 静态：清单里必须有 `<dpiAware>`（否则进程不是 DPI aware，
 *     会回到 2026-10-15 那个「内容不被合成到屏幕上」的老问题）；
 *  ③ 动态：**把 app.asar 解出来，把 `--hidden` 短路改成可被
 *     `--allow-native-dialogs` 打开**（见 src/main/index.ts 的 DIALOG_PROBE），
 *     再起一个隐藏实例 → 点「退出应用」→ 断言：
 *       · 进程没有崩（2.5s 后还活着）；
 *       · 真的出现一个原生框窗口（class `#32770`，标题「退出应用」）；
 *       · 用 PostMessage(WM_CLOSE) 关掉它后进程仍然活着（说明框是模态、
 *         且关闭后回到正常状态），最后强杀收尾。
 *
 * 这一支不需要套件里的实例：它自己起一个（端口与套件不同），
 * 所以可以放在 DEFAULT_SUITE 的任何位置。
 *
 * 用法：node tools/verify-native-dialogs.mjs [端口]
 *       环境变量 PDF_READER_EXE 指向被测 exe（默认已安装的那份）
 */

import { spawn, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installedExe, installedAppDir, fixturePath } from '../scripts/packaging-paths.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const PORT = Number(process.argv[3] ?? process.argv[2] ?? 9295)
const INSTALLED = installedAppDir()
const DEFAULT_EXE = installedExe()
const PDF = fixturePath()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* electron.exe 若在 ELECTRON_RUN_AS_NODE 下会被当成 node 跑，必须摘掉 */
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const fails = []
function check(label, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? '  —— ' + detail : ''}`)
  if (!ok) fails.push(label)
}

function cdp(expr, timeout = 25000) {
  const r = spawnSync('node', [join(root, 'scripts', 'cdp-eval.mjs'), String(PORT), expr], {
    cwd: root,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout
  })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
}

async function pageAlive() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, {
      signal: AbortSignal.timeout(1500)
    })
    const list = await res.json()
    return list.some((t) => t.type === 'page')
  } catch {
    return false
  }
}

/** 该 pid 的顶层窗口（含不可见） */
function winList(pid) {
  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(root, 'tools', 'foreground-snapshot.ps1'),
      '-ProcessId',
      String(pid)
    ],
    { cwd: root, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30000 }
  )
  return `${r.stdout ?? ''}`
    .trim()
    .split('\n')
    .filter((l) => l.startsWith('W|'))
}

function isAlive(pid) {
  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'alive' } else { 'dead' }`
    ],
    { windowsHide: true, encoding: 'utf8', timeout: 20000 }
  )
  return `${r.stdout ?? ''}`.trim() === 'alive'
}

/** 给一个 hwnd 发 WM_CLOSE（PostMessage，不动前台） */
function postClose(hwnd) {
  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(root, 'tools', '_post-close.ps1'),
      '-Hwnd',
      String(hwnd)
    ],
    { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 20000 }
  )
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
}

/** 读 exe 内嵌清单的可读片段（latin1 原样），用于静态判据 */
function manifestText(exePath) {
  if (!existsSync(exePath)) return null
  const buf = readFileSync(exePath)
  /*
   * ★ 必须从 `</assembly>` 往回找 `<assembly`。
   *   直接 `indexOf('<assembly')` 会命中**结束标签**里的 `<assembly`
   *   子串（'</assembly>' 的第 1 个字符就是 '<'），窗口于是从结束标签
   *   之后开始，前面所有元素全被切掉 —— 判据会误报
   *   「清单里没有 <dpiAware>」。实测踩过。
   */
  const endAt = buf.lastIndexOf('</assembly>', undefined, 'utf8')
  if (endAt < 0) return null
  // ★ 找**开始**标签必须带上属性前的空格：用 '<assembly' 会命中
  //   '</assembly>' 里的同名子串（'</assembly>' 的第 1 个字符就是 '<'），
  //   窗口于是从结束标签开始，前面所有元素全被切掉。
  const startAt = buf.lastIndexOf('<assembly ', endAt, 'utf8')
  if (startAt < 0) return null
  /*
   * 清单里各元素紧挨着写（没有缩进换行），electron 原始清单就 644 字节左右，
   * 自己写的会到 1KB 出头，所以给 4KB 窗口足够。
   */
  return buf.subarray(startAt, Math.min(buf.length, endAt + 4096)).toString('latin1')
}

console.log('=== 原生对话框端到端判据（清单体检 + 退出框真的弹出）===\n')

const EXE = process.env.PDF_READER_EXE ?? DEFAULT_EXE
console.log(`被测 exe：${EXE}\n`)

/*
 * dev 模式下被测的是 node_modules/electron/dist/electron.exe：
 *   · 它的内嵌清单是 Electron 官方那份 —— 没有 after-pack 注入的 dpiAware，
 *     而且**本来就带** <dpiAwareness>；
 *   · 它也没有 app.asar 可拆开把 `--hidden` 短路改成探针开关。
 * 本用例的每一条判据都只对**打包产物**成立，dev 轮次跳过，
 * 打包安装后由安装态套件跑同一支脚本真查（见 tools/run-verify-suite.mjs 的 --installed 模式）。
 */
if (process.env.PDF_READER_DEV === '1') {
  console.log('⚠ 跳过：本用例只针对打包产物（已安装的 exe + app.asar）。')
  console.log('   dev 版 electron.exe 的清单/代码布局与产物不同，查它只会得到与本次改动无关的假红。')
  process.exit(0)
}

/* ═══════════════ ① 静态：清单体检 ═══════════════ */
console.log('① exe 内嵌清单体检（静态，不启动）')
const mtext = manifestText(EXE)
check('能读到内嵌清单', mtext !== null, EXE)
if (mtext) {
  const hasAwareness = mtext.includes('<dpiAwareness')
  const hasAware = mtext.includes('<dpiAware')
  const hasCommonControls = mtext.includes('Microsoft.Windows.Common-Controls')
  console.log(
    `   dpiAware=${hasAware}  dpiAwareness=${hasAwareness}  Common-Controls=${hasCommonControls}`
  )
  check(
    '★ 清单里没有 <dpiAwareness>（有这个元素，所有原生对话框都会把进程打崩）',
    !hasAwareness,
    hasAwareness ? '检出 <dpiAwareness>，请重新打包（不要再注入 DPI 清单）' : ''
  )
  check(
    '清单里有 <dpiAware>（进程必须 DPI aware，否则会「内容不被合成到屏幕上」）',
    hasAware
  )
  check(
    '清单里有 Common-Controls 依赖（缺了 exe 会报 side-by-side 配置错误起不来）',
    hasCommonControls
  )
}

/* ═══════════════ ② 动态：造一个「允许弹原生框」的隐藏实例 ═══════════════ */
console.log('\n② 起一个允许弹原生框的隐藏实例，点「退出应用」')

const resourcesDir = join(dirname(EXE), 'resources')
const asarPath = join(resourcesDir, 'app.asar')
const asarDir = join(resourcesDir, 'app')
let workDir = null

const ASAR_CLI = join(root, 'node_modules', '@electron', 'asar', 'bin', 'asar.js')

/**
 * 决定「探针实例从哪儿加载载荷」。
 *
 * ── 为什么不再改产物 ───────────────────────────────────────────
 *   最早的做法是把 `out/main/index.js` 里 `HIDDEN_MODE && !DIALOG_PROBE`
 *   这条短路替换成运行期判断，再重新打包 asar。那样有三个坏处：
 *     · 每跑一次就改一次**源码产物**，跑完还得记得它不是原样；
 *     · 打包 asar 时 electron-vite 留在外部的运行时依赖（pdf-lib 等）
 *       不在包里，页面永远不就绪，排查了很久；
 *     · 判据自己动过被测对象，可信度下降。
 *   现在源码里 `DIALOG_PROBE` 本来就是**运行期**从 argv 读的
 *   （src/main/index.ts），所以只要启动时带上 `--allow-native-dialogs`
 *   就行，一个字节都不用改。
 */
function resolvePayload() {
  const devRoot = process.env.PDF_READER_DEV_ROOT ?? root
  if (existsSync(join(devRoot, 'out', 'main', 'index.js'))) {
    return { kind: 'app-root', appRoot: devRoot }
  }
  return { kind: 'asar', appDir: null }
}

/*
 * ★ 不能把新的载荷塞进安装目录（那会改动用户装的东西）。
 *   做法：复制一份 exe 到临时目录 —— Electron 是按 **exe 所在目录**
 *   找 resources / dll / pak 的，把 exe 复制过去就等于换了一套运行环境。
 */
function stageExe(probe) {
  const base = workDir ?? mkdtempSync(join(tmpdir(), 'qx-probe-stage-'))
  workDir = base
  const stage = join(base, 'stage')
  mkdirSync(join(stage, 'resources'), { recursive: true })
  const exeName = EXE.split('\\').pop()
  const stagedExe = join(stage, exeName)

  copyFileSync(EXE, stagedExe)

  /* Electron 还要在 exe 同级找 dll / pak（icudtl.dat、*.pak、ffmpeg.dll…），
   * 缺一个都起不来。文件优先硬链接，目录只能递归复制。 */
  let linked = 0
  let copied = 0
  for (const f of readdirSync(dirname(EXE))) {
    if (f === exeName || f === 'resources') continue
    const src = join(dirname(EXE), f)
    const dst = join(stage, f)
    if (existsSync(dst)) continue
    if (statSync(src).isDirectory()) {
      cpSync(src, dst, { recursive: true })
      copied += 1
      continue
    }
    try {
      linkSync(src, dst)
      linked += 1
    } catch {
      copyFileSync(src, dst)
      copied += 1
    }
  }
  console.log(`   暂存静态文件：硬链接 ${linked} 个、复制 ${copied} 个`)

  /*
   * ★ 打包后的 exe 必须自带 `resources\app.asar` 才能启动 —— 这是它找**主进程**
   *   代码的唯一位置；`--app-root` 只覆盖渲染层载荷，不换主进程。
   *   早先这里只给 `probe.kind === 'asar'` 复制 asar，app-root 那条路漏了：
   *   暂存目录里没有 app.asar → exe 起来是个空壳（日志全白、CDP 永远不就绪），
   *   2026-10-18 安装态轮次因此红了「探针实例渲染层就绪」。
   *   现在：只要被测 exe 旁边有 app.asar 就一并带上（复用它自己那份 = 测的就是那个包）。
   */
  const srcAsar = join(dirname(EXE), 'resources', 'app.asar')
  if (existsSync(srcAsar)) {
    copyFileSync(srcAsar, join(stage, 'resources', 'app.asar'))
    console.log(`   暂存 resources/app.asar（${(statSync(srcAsar).size / 1024 / 1024).toFixed(1)} MB，主进程代码）`)
  } else if (probe.kind === 'asar') {
    throw new Error(`找不到 ${srcAsar}`)
  }

  console.log(`   暂存目录：${stage}（顶层 ${readdirSync(stage).length} 项）`)
  if (!existsSync(stagedExe)) throw new Error(`暂存 exe 不存在：${stagedExe}`)
  return stagedExe
}

let probe = resolvePayload()
check('能定位到探针载荷（工程根 out/ 或 exe 同级 resources）', probe !== null)

let pid = null
let stagedExe = null
if (probe) {
  try {
    stagedExe = stageExe(probe)
  } catch (error) {
    console.log(`   暂存 exe 失败：${error instanceof Error ? error.message : error}`)
  }
}

if (stagedExe && existsSync(stagedExe)) {
  /*
   * ★ 日志文件名**不要用 `.log` 结尾**。
   *   Electron 会把形如 `*.log` 的路径当自己的 `--log-file` 语义处理，
   *   于是这个参数被抽走、不再传给应用 —— 而 `extractFileArg()` 会把它
   *   当成「不是 .pdf 的参数」丢掉（本来也没事），麻烦的是我们以为
   *   日志会写到那儿，实际是空的，看起来像「进程什么都没打印」。
   *   用 .txt 最省心（套件那边暂时还是 .log，因为它只要内容、
   *   而且确实读到了，属于历史包袱，先不动）。
   */
  const logPath = join(root, 'test-results', `nd-probe-${PORT}.txt`)
  mkdirSync(dirname(logPath), { recursive: true })
  const spawnArgs = [
    '--hidden',
    '--test-hooks',
    '--allow-native-dialogs',
    `--remote-debugging-port=${PORT}`
  ]
  if (probe.kind === 'app-root') {
    spawnArgs.push(`--app-root=${probe.appRoot}`)
    console.log(`   载荷根（--app-root）：${probe.appRoot}`)
  }
  /*
   * ★ PDF 路径用**环境变量**传，不放进 argv。
   *   Electron 会把 argv 里第一个非开关参数当成「应用路径」，而
   *   `--app-root=<目录>` 已经是那个位置了 —— 再跟一个 PDF 路径就会
   *   被拿去 require，抛 `ERR_UNKNOWN_FILE_EXTENSION: ".pdf"`，
   *   进程活着但页面永远不就绪（日志一片空白，极难定位）。
   *   主进程侧读 PDF_READER_OPEN_FILE（见 src/main/index.ts 的 pendingFile）。
   */
  const child = spawn(stagedExe, spawnArgs, {
    cwd: dirname(stagedExe),
    detached: true,
    stdio: ['ignore', openSync(logPath, 'w'), openSync(logPath, 'a')],
    windowsHide: true,
    env: { ...env, PDF_READER_OPEN_FILE: PDF }
  })
  child.unref()
  pid = child.pid
  console.log(`   已起探针实例 pid=${pid}（日志 ${logPath}）`)

  let ready = false
  for (let i = 0; i < 80; i++) {
    await sleep(500)
    const s = cdp(
      `(() => { try { const s = window.__store.getState(); return s.pageCount ? 'ready:' + s.pageCount : 'no' } catch (e) { return 'no' } })()`,
      8000
    )
    if (s.startsWith('ready:')) {
      console.log(`   渲染层就绪（${((i + 1) * 0.5).toFixed(1)}s，${s.slice(6)} 页）`)
      ready = true
      break
    }
  }
  check('探针实例渲染层就绪', ready)
  if (!ready) {
    const txt = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
    console.log('   探针实例日志（尾部 25 行）：')
    console.log(
      txt
        .split('\n')
        .slice(-25)
        .map((l) => '     ' + l)
        .join('\n') || '     （空）'
    )
  }

  if (ready) {
    const before = winList(pid)
    const clicked = cdp(`(() => {
      window.__store.setState({ exportDirty: false });
      const b = Array.from(document.querySelectorAll('.rail-btn')).find(x => (x.textContent||'').includes('退出应用'));
      if (!b) return 'no-button';
      b.click();
      return 'clicked';
    })()`)
    check('点到了「退出应用」按钮', clicked.includes('clicked'), clicked)

    /* 盯 3.5s：要么出现 #32770 原生框，要么进程崩掉 */
    let dialog = null
    let crashed = false
    for (let i = 0; i < 14; i++) {
      await sleep(250)
      if (!isAlive(pid)) {
        crashed = true
        break
      }
      const now = winList(pid)
      const found = now.find((w) => w.split('|')[5] === '#32770' && w.split('|')[3] === 'true')
      if (found) {
        dialog = found
        break
      }
      void before
    }

    check('进程没有在点完退出后崩溃（以前这里就是 APPCRASH）', !crashed)
    check(
      '★ 退出确认框真的弹出来了（原生 #32770 窗口可见）',
      Boolean(dialog),
      dialog ?? '3.5s 内没看到可见的 #32770 窗口'
    )

    if (dialog) {
      const parts = dialog.split('|')
      check('原生框标题是「退出应用」', parts[6]?.includes('退出应用'), parts[6] ?? '')
      const closed = postClose(parts[1])
      console.log(`   关闭原生框（WM_CLOSE，不动前台）：${closed}`)
      await sleep(1200)
      check('关掉确认框后进程仍然活着（模态框没把主进程带走）', isAlive(pid))
    }
  }

  /* 收尾：强杀探针实例，绝不动用户自己的阅读器 */
  if (isAlive(pid)) {
    spawnSync(
      'powershell',
      ['-NoProfile', '-Command', `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Stop-Process -Force`],
      { windowsHide: true }
    )
    console.log('\n   （收尾）已强杀探针实例')
  }
} else {
  fails.push('探针实例没能起来')
}

/* 清理临时目录 */
if (workDir) {
  try {
    rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* 忽略：临时目录清不掉不影响判据 */
  }
}

console.log(`\n=== 结果：${fails.length ? `${fails.length} 项未通过 ✗` : '全部通过 ✓'} ===`)
if (fails.length) {
  for (const f of fails) console.log('  - ' + f)
  process.exit(1)
}
process.exit(0)
