// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 退出应用的确认：验证它真的走**主进程原生对话框**，而不是渲染层自绘浮层。
 *
 * ── 为什么要有这个脚本 ───────────────────────────────────────
 *   docs\待办-2026-10-15.md 第二项要求把退出确认从 DOM 浮层
 *   （RightRail 里那个 ExitConfirm）改成 Electron 的
 *   `dialog.showMessageBox(mainWindow, …)`，理由是 DOM 浮层：
 *     · 不进任务栏、Alt+Tab 切不到；
 *     · 主窗口被遮挡/最小化时跟着一起看不见，用户以为按钮失灵。
 *
 *   这件事**没法靠肉眼看日志确认** —— 点一下按钮要么退出要么不退出，
 *   而真正的差别在「确认框由谁弹」。所以分两层查：
 *
 *     ① 静态：**已安装产物**里到底有没有原生对话框那根线
 *        （读 app.asar 与 out/main/index.js，找 showMessageBox /
 *         app:quit / defaultId / noLink / 两个按钮文案，
 *         同时确认旧浮层的 class 痕迹已经消失）
 *     ② 运行时：**另起一个自己的隐藏实例**（带 stdout 捕获），
 *        点「退出应用」，然后核对主进程日志：
 *          · 「收到 app:quit 请求」恰好一次 —— 请求真的发出去了
 *          · 「隐藏模式：跳过退出确认，直接退出」—— 没弹原生模态框
 *          · 进程真的退出了 —— 请求真的被主进程处理了
 *
 * ── 两个必须记住的坑（都踩过）────────────────────────────────
 *   ★ 别想给 `window.pdfApp.app.quit` 挂计数器
 *     contextBridge 暴露的对象是**深冻结**的，赋值在非严格模式下
 *     **静默失败不抛错**，于是「探针挂上了」是假阳性，
 *     点下去调用的还是真 quit。要用日志和进程退出做证据，不要用探针。
 *   ★ 别自己另起一个实例
 *     主进程开头就 `app.requestSingleInstanceLock()`（src/main/index.ts:73），
 *     套件实例活着的时候，第二个实例会**转发参数后立刻自杀** ——
 *     表现为 CDP 端口刚连上就 ECONNRESET，白忙一场。
 *     所以：端口上已经有活实例就复用它，没有（单跑）才自己起。
 *   ★ 点了退出之后这个实例就没了
 *     所以本脚本在套件里排**最后**；隐藏模式下按设计跳过确认框直接退，
 *     正好当成「请求真的被主进程处理了」的证据。
 *
 * 用法：node tools/verify-quit-dialog.mjs [端口]
 *       环境变量：PDF_READER_EXE 改测试目标（默认已安装版）
 *                 PDF_READER_LOG 指向套件那份主进程日志（套件会自动传）
 */

import { readFileSync, existsSync, readdirSync, mkdirSync, openSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installedExe, installedAppDir, fixturePath } from '../scripts/packaging-paths.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PORT = Number(process.argv[3] ?? process.argv[2] ?? 9290)
/*
 * 已安装产物 = **exe 旁边**的 resources/app.asar。
 * 不能拿 installDir() 直接拼 resources —— 2.1.x 的 NSIS 会多建一层
 * `qiuxi-pdf-reader\`，拼出来是 `D:\QXClass\PDFReader\resources\app.asar`
 * （旧布局、安装后根本不存在），2026-10-18 安装态轮次因此假红两条。
 */
const EXE = process.env.PDF_READER_EXE ?? installedExe()
const APP_DIR = dirname(EXE)
const INSTALLED = installedAppDir()
const PDF = fixturePath()
const LOG = process.env.PDF_READER_LOG ?? join(root, 'test-results', `instance-${PORT}.log`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function cdp(expr, timeout = 30000) {
  const r = spawnSync('node', [join(root, 'scripts', 'cdp-eval.mjs'), String(PORT), expr], {
    cwd: root,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout
  })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
}

const j = (s) => {
  try {
    return JSON.parse(String(s).split('\n').pop())
  } catch {
    return null
  }
}

const fails = []
function check(label, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? '  —— ' + detail : ''}`)
  if (!ok) fails.push(label)
}

/** 在文件里找一段 ASCII / UTF-8 标记（asar 是二进制容器，JS 内容仍是明文） */
function containsMarker(file, marker) {
  if (!existsSync(file)) return null
  const buf = readFileSync(file)
  return buf.includes(Buffer.from(marker, 'utf8'))
}

/** 去掉 /* … *\/ 注释后再找标记：注释里的说明文字不算「残留」 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '')
}

console.log('=== 退出应用：原生确认对话框验证 ===\n')

/* ---------- ① 静态：产物里有没有那根线 ---------- */
console.log('① 产物静态检查')

const asar = join(APP_DIR, 'resources', 'app.asar')
const builtMain = join(root, 'out', 'main', 'index.js')

const asarDialog = containsMarker(asar, 'showMessageBox')
const asarChannel = containsMarker(asar, 'app:quit')
const builtDialog = containsMarker(builtMain, 'showMessageBox')
const builtMainText = existsSync(builtMain) ? readFileSync(builtMain, 'utf8') : ''

console.log(`   被测程序目录：${APP_DIR}`)
console.log(`   已安装 app.asar：showMessageBox=${asarDialog}  app:quit=${asarChannel}  （${asar}）`)
console.log(`   本轮构建 out/main/index.js：showMessageBox=${builtDialog}`)

/*
 * 「已安装产物」这两条只在**安装态**有意义：
 *   dev 模式（PDF_READER_DEV=1）测的是 out/ + node_modules 里那份 electron.exe，
 *   机器上装的可能是上一版，拿它对照只会得到与代码无关的假红。
 *   真正的检查由 --installed 轮次覆盖（打包安装后跑同一支脚本）。
 */
if (process.env.PDF_READER_DEV === '1') {
  console.log('   ⚠ 跳过「已安装产物」两条：dev 模式下被测目标是 out/，不是安装目录里的旧版本')
} else {
  check('已安装产物里有 dialog.showMessageBox', asarDialog === true, asar)
  check('已安装产物里有 app:quit 通道', asarChannel === true, asar)
}
check('本轮构建产物里有 showMessageBox', builtDialog === true, builtMain)

/*
 * 光有 showMessageBox 还不够 —— 得确认按钮文案和「回车/Esc 都落到取消」
 * 这套配置真的在产物里（defaultId/cancelId 都为 0）。
 */
const dialogConfig = {
  取消按钮: builtMainText.includes('取消'),
  退出按钮: builtMainText.includes('退出应用'),
  defaultId: builtMainText.includes('defaultId'),
  noLink: builtMainText.includes('noLink')
}
console.log(`   原生对话框配置：${JSON.stringify(dialogConfig, null, 0)}`)
check(
  '对话框配置齐全（两个按钮 + defaultId + noLink）',
  Object.values(dialogConfig).every(Boolean)
)

/*
 * 旧浮层的痕迹也该消失。
 * 查**去注释后**的渲染层产物：rails.css 里那段「为什么删掉」的说明
 * 是留给人看的注释，构建后仍会留在 CSS 里，不能算残留。
 */
const rendererAssets = join(root, 'out', 'renderer', 'assets')
const leftover = []
try {
  for (const f of readdirSync(rendererAssets)) {
    if (!f.endsWith('.js') && !f.endsWith('.css')) continue
    const txt = stripComments(readFileSync(join(rendererAssets, f), 'utf8'))
    if (/exit-confirm|exitConfirm/.test(txt)) leftover.push(f)
  }
} catch {
  leftover.push('（读不到 out/renderer/assets）')
}
check(
  '渲染层产物里不再有旧浮层（去注释后查 exit-confirm / exitConfirm）',
  leftover.length === 0,
  leftover.join(', ')
)

/* ---------- ② 运行时：复用活实例（没有才自己起），点退出，核对日志 ---------- */
console.log(`\n② 运行时检查（端口 ${PORT}）`)

/** 端口上有没有活的渲染层 */
async function alive() {
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

let child = null
let ready = false
if (await alive()) {
  console.log('   复用套件那个隐藏实例（不另起：app 有单实例锁，第二个实例会自杀）')
  ready = true
} else {
  const exe = process.env.PDF_READER_EXE ?? installedExe()
  /*
   * dev 轮次（PDF_READER_EXE 指向 node_modules\electron\dist\electron.exe）时，
   * 第一个参数必须是应用目录 `.`，否则 electron 会把自己当脚本宿主、
   * 根本不会加载本工程 —— 表现为「自己起一个实例」永远等不到渲染层。
   * 安装态 exe 自带应用路径，不能加 `.`。
   */
  const needsAppPath = /[\\/]node_modules[\\/]electron[\\/]dist[\\/]electron\.exe$/i.test(exe)
  const exeArgs = [
    ...(needsAppPath ? ['.'] : []),
    '--hidden',
    '--test-hooks',
    `--remote-debugging-port=${PORT}`,
    PDF
  ]
  mkdirSync(dirname(LOG), { recursive: true })
  console.log(`   自己起一个隐藏实例：${exe}`)
  console.log(`   主进程日志：${LOG}`)
  child = spawn(exe, exeArgs, {
    cwd: needsAppPath ? root : dirname(exe),
    detached: true,
    stdio: ['ignore', openSync(LOG, 'w'), openSync(LOG, 'a')],
    windowsHide: true
  })
  child.unref()

  for (let i = 0; i < 40; i++) {
    await sleep(500)
    const s = cdp(
      `(() => { try { return String(window.__store.getState().pageCount) } catch (e) { return '0' } })()`,
      8000
    )
    if (/^\d+$/.test(s.trim()) && s.trim() !== '0') {
      console.log(`   渲染层就绪（${((i + 1) * 0.5).toFixed(1)}s，${s.trim()} 页）`)
      ready = true
      break
    }
  }
}
check('隐藏实例可用（复用的或自己起的）', ready)

const readLog = () => {
  try {
    return readFileSync(LOG, 'utf8')
  } catch {
    return ''
  }
}

let before = null
if (ready) {
  before = j(
    cdp(`JSON.stringify({
      旧浮层节点: document.querySelectorAll('.exit-confirm, .exit-confirm__box').length,
      退出按钮: Array.from(document.querySelectorAll('.rail-btn')).filter(b => (b.textContent || '').includes('退出应用')).length,
      有preload退出API: !!(window.pdfApp && window.pdfApp.app && typeof window.pdfApp.app.quit === 'function'),
      preload对象冻结: !!(window.pdfApp && window.pdfApp.app && Object.isFrozen(window.pdfApp.app))
    })`)
  )
  console.log(`   ${JSON.stringify(before)}`)
  check('页面上没有旧的自绘确认浮层', before?.旧浮层节点 === 0)
  check('右栏有「退出应用」按钮', before?.退出按钮 >= 1)
  check('preload 暴露了 app.quit（渲染层唯一的出口）', before?.有preload退出API === true)
}

/*
 * 同一份主进程日志（PDF_READER_LOG）在套件里是**所有脚本共用**的：
 * 前面的 verify-quit-flow 已经点过一次「退出应用」，日志里早有 1 条
 * `收到 app:quit 请求`。所以这里只能算**增量**，写成「总数恰好 1」会假红
 * （2026-10-18 安装态轮次就红在这条：实际 2）。
 */
const logBefore = readLog()
const quitRequestsBefore = (logBefore.match(/收到 app:quit 请求/g) ?? []).length

let clicked = false
if (ready && before?.退出按钮 >= 1) {
  cdp(`(() => {
    const btn = Array.from(document.querySelectorAll('.rail-btn')).find(b => (b.textContent || '').includes('退出应用'));
    if (btn) btn.click();
    return '已点击';
  })()`)
  clicked = true
  console.log('   已点击「退出应用」，等主进程处理…')
}

/* 等实例消失：请求被处理完了才会没（隐藏模式跳过确认框，直接退） */
let gone = false
if (clicked) {
  for (let i = 0; i < 50; i++) {
    await sleep(200)
    if (!(await alive())) {
      gone = true
      break
    }
  }
}

const mainLog = readLog()
const quitRequestsTotal = (mainLog.match(/收到 app:quit 请求/g) ?? []).length
const quitRequests = quitRequestsTotal - quitRequestsBefore
const skippedDialog = mainLog.includes('隐藏模式：跳过退出确认')
const hasLog = mainLog.length > 0
console.log(
  `   主进程日志：${hasLog ? `app:quit 请求本次 +${quitRequests}（日志累计 ${quitRequestsTotal}，基线 ${quitRequestsBefore}）、跳过确认框=${skippedDialog}` : '（读不到，改用端口消失做证据）'}；实例已消失=${gone}`
)

if (clicked) {
  if (hasLog) {
    check('点「退出应用」把请求送到了主进程（本次新增 1 次）', quitRequests === 1, `本次 +${quitRequests}（累计 ${quitRequestsTotal}）`)
    check(
      '隐藏模式下跳过原生模态框（自动化不会弹窗抢前台）',
      skippedDialog,
      skippedDialog ? '日志里有「隐藏模式：跳过退出确认」' : '未出现「隐藏模式：跳过退出确认」'
    )
  } else {
    console.log('   ⚠ 没有主进程日志可读（PDF_READER_LOG 未传且自起实例失败），只用端口消失作证据')
  }
  check(
    '主进程处理完请求后应用真的退出',
    gone,
    gone ? 'CDP 端口已消失' : '10 秒内实例仍在'
  )
} else {
  console.log('   ⚠ 没能点到按钮，运行时这一层没跑')
  fails.push('运行时点击检查没跑成')
}

/* ---------- 收尾：只清自己起的那个实例，别动套件的 ---------- */
if (child && !gone) {
  spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      // 按 pid 直接杀：不能按进程名找 —— 改名后进程名是「秋夕-PDF阅读器」，
      // 写死旧名会让这条收尾静默失效（2026-10-16 改名时一并修正）。
      `Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue`
    ],
    { windowsHide: true }
  )
  console.log('\n   （收尾）强杀了本例自己起的实例')
}

/* ---------- 结论 ---------- */
console.log(`\n=== 结果：${fails.length ? `${fails.length} 项未通过 ✗` : '全部通过 ✓'} ===`)
if (fails.length) {
  for (const f of fails) console.log('  - ' + f)
  process.exit(1)
}
process.exit(0)


