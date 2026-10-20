// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 退出确认的**完整链路**：点「退出应用」→ 弹出三选一 → 选「取消」→ 应用还活着。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 与 tools/verify-quit-dialog.mjs 的分工（两支都要留着）
 * ══════════════════════════════════════════════════════════════════════
 *   · verify-quit-dialog.mjs ：查**接线**。静态查产物里有没有
 *     dialog.showMessageBox / app:quit / 两个按钮文案；运行时在 `--hidden`
 *     下点一次退出，核对日志里「收到 app:quit 请求」恰好一次、
 *     「隐藏模式：跳过退出确认」出现、端口消失。它**刻意不弹窗**。
 *   · 本脚本 ：查**用户唯一看得见的那一段** —— 隐藏模式会跳过原生框，
 *     所以「框到底出不出、出来后选取消会不会把程序关掉」以前没人验过。
 *     做法是复用套件的隐藏实例，但让它带 `--allow-native-dialogs`
 *     （src/main/index.ts 的 DIALOG_PROBE），于是原生框会照常弹出；
 *     再用 PostMessage(WM_CLOSE) 关掉它（PostMessage 不改前台）。
 *
 * 为什么值得单独一支：2026-10-16 用户报「退出窗口不能正常弹出」，
 * 根因（清单注入 dpiAwareness → 原生框打崩进程）恰好落在这条路上，
 * 而旧判据全绿。**判据覆盖不到的地方，就是 bug 藏身的地方。**
 *
 * 判据：
 *   ① 页面有「退出应用」按钮，且点得动；
 *   ② 有未导出编辑时，app:quit 交给渲染层问用户（日志里那句）
 *      —— 这条走的是 doc:confirm-unsaved，不是 quit 确认框，单列；
 *   ③ 无编辑时点退出 → 主进程日志出现「收到 app:quit 请求」；
 *   ④ 隐藏模式下**可以**真的弹出原生框（探针开启时不应打印「跳过退出确认」）；
 *   ⑤ 关掉确认框（等价用户点「取消」）后：实例端口还在、进程还活着。
 *
 * 用法：node tools/verify-quit-flow.mjs [端口]（默认复用套件实例 9294）
 *       环境变量 PDF_READER_LOG 指向套件那份主进程日志（套件会自动传）
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const PORT = Number(process.argv[3] ?? process.argv[2] ?? 9294)
const LOG = process.env.PDF_READER_LOG ?? join(root, 'test-results', `instance-${PORT}.log`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

const readLog = () => {
  try {
    return readFileSync(LOG, 'utf8')
  } catch {
    return ''
  }
}

console.log('=== 退出确认链路：点退出 → 框弹出 → 取消 → 还在 ===\n')
console.log(`端口 ${PORT}`)
console.log(`日志 ${LOG}\n`)

const alive = await pageAlive()
check('端口上有活实例（本脚本复用套件那个，不另起 —— 应用有单实例锁）', alive)
if (!alive) {
  console.log(`\n=== 结果：${fails.length} 项未通过 ✗ ===`)
  for (const f of fails) console.log('  - ' + f)
  process.exit(1)
}

/*
 * ---------- 打开原生框探针 ----------
 *
 * ★ 为什么由用例自己开、而且用完必须关：
 *   隐藏实例默认跳过原生确认框。这条用例要验「框真的弹得出来」，
 *   所以必须开；但如果整轮套件都开着（早先就是启动参数常开），
 *   后面 verify-quit-dialog 期望的「点退出 → 应用真的退出」会变成
 *   「弹框并阻塞」，判据全红；更糟的是弹出来的模态框没人关会把主进程
 *   卡死，后续每一支用例都开始 CDP 超时 —— 实测一次泄漏红了六支。
 */
/*
 * ★ dev 轮次不验「原生框真的弹出」这一段。
 *
 *   dev 模式（PDF_READER_DEV=1）跑的是 node_modules\electron\dist\electron.exe，
 *   它的内嵌清单是 Electron 官方那份 —— 里面**带 `<dpiAwareness>`**，
 *   而正是这个元素会让 Windows 原生对话框把进程打崩（0x80000003）。
 *   换句话说：在 dev exe 上弹原生框，测的恰好是「打包时必须避免的那个缺陷」，
 *   必然表现为「框没出现、进程没了」，跟本仓库代码无关。
 *
 *   故 dev 轮次只核到「app:quit 送到了主进程、没有走隐藏模式的短路」，
 *   弹框本身留给安装态套件（node tools\run-verify-suite.mjs <端口>）。
 */
const devMode = process.env.PDF_READER_DEV === '1'
if (devMode) {
  console.log('   ⚠ dev 轮次：跳过「原生确认框弹出」这一段（dev electron.exe 的清单带 dpiAwareness，弹原生框必崩）')
}

const probeSet = devMode
  ? 'dev-skip'
  : cdp(`window.pdfApp.diag.setDialogProbe(true).then(v => String(v)).catch(e => 'ERR ' + e.message)`)
const probeOn = !devMode && probeSet.trim() === 'true'
console.log(`   原生框探针：${probeOn ? '已开启（运行期）' : devMode ? 'dev 轮次不开启' : `开启失败：${probeSet}`}`)
check('能开启原生对话框探针（主进程带 --test-hooks）', probeOn || devMode, probeSet)

/* ---------- ① 按钮在位 ---------- */
const before = cdp(`JSON.stringify({
  按钮: Array.from(document.querySelectorAll('.rail-btn')).filter(b => (b.textContent||'').includes('退出应用')).length,
  脏: window.__store.getState().exportDirty,
  标签: window.__store.getState().tabs.length
})`)
let info = null
try {
  info = JSON.parse(String(before).split('\n').pop())
} catch {
  info = null
}
console.log(`   ${JSON.stringify(info)}`)
check('右栏有「退出应用」按钮', info?.按钮 >= 1)

/*
 * ---------- ② 先清掉脏状态，保证走的是「纯退出确认框」那条路 ----------
 *   有未导出编辑时 app:quit 会把决定权交回渲染层（doc:confirm-unsaved），
 *   那是另一条链路（tools/verify-content-edit 覆盖），这里不混在一起。
 */
cdp(`(() => { window.__store.setState({ exportDirty: false }); return 'ok' })()`)
await sleep(400)

/* ---------- ③ 点退出，看日志与窗口 ---------- */
/*
 * ★ dev 轮次**不点**（v2.1.3 实测踩到）：
 *   隐藏实例点了「退出应用」后，主进程走
 *   `if (HIDDEN_MODE && !DIALOG_PROBE) app.quit()` —— 进程直接消失，
 *   正在执行的 `Runtime.evaluate` 永远不返回（cdp-eval 打出
 *   "Detected unsettled top-level await"），后续每一支都连不上端口。
 *   安装态为什么能点：那一轮用运行期探针 setDialogProbe(true) 打开了
 *   DIALOG_PROBE，走的是「弹原生框 → 取消」那条路，进程不会退出。
 *   dev 又不能开探针（清单 dpiAwareness → 原生框必崩），所以这段整块跳过，
 *   改由安装态套件验证；这里只保留「按钮在位」这一条静态判据。
 */
const logLenBefore = readLog().length
let clicked = 'dev-skip'
if (!devMode) {
  clicked = cdp(`(() => {
    const b = Array.from(document.querySelectorAll('.rail-btn')).find(x => (x.textContent||'').includes('退出应用'));
    if (!b) return 'no-button';
    b.click();
    return 'clicked';
  })()`)
  check('点到了「退出应用」', clicked.includes('clicked'), clicked)
  await sleep(600)
  check('主进程收到了 app:quit 请求', readLog().length > logLenBefore, `日志新增 ${readLog().length - logLenBefore} 行`)
} else {
  console.log('   ⚠ dev 轮次：不点「退出应用」（隐藏模式会直接退出进程，后续用例全断）')
}

let dialogSeen = false
let pid = null
if (probeOn) {
  // 找实例 pid：套件日志里没有 pid，用端口反查监听进程
  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`
    ],
    { windowsHide: true, encoding: 'utf8', timeout: 20000 }
  )
  const pidText = `${r.stdout ?? ''}`.trim()
  if (/^\d+$/.test(pidText)) {
    pid = Number(pidText)
    for (let i = 0; i < 16; i++) {
      await sleep(250)
      const w = spawnSync(
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
        { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 30000 }
      )
      const rows = `${w.stdout ?? ''}`.trim().split('\n')
      const dlg = rows.find((l) => l.split('|')[5] === '#32770' && l.split('|')[3] === 'true')
      if (dlg) {
        dialogSeen = true
        console.log(`   原生框：${dlg}`)
        const hwnd = dlg.split('|')[1]
        const c = spawnSync(
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
        console.log(`   关闭原生框（WM_CLOSE）：${`${c.stdout ?? ''}`.trim()}`)
        await sleep(900)
        /*
         * ★ 探针用完立刻关掉。
         *   不清掉的话，后面 verify-quit-dialog 一点「退出应用」就又会弹一个
         *   没人关的模态框，主进程被阻塞 → 那一支之后全部 CDP 超时。
         */
        const off = cdp(`window.pdfApp.diag.setDialogProbe(false).then(v => String(v)).catch(e => 'ERR')`)
        console.log(`   探针已关闭：${off}`)
        break
      }
    }
  } else {
    console.log('   ⚠ 没能用端口反查到进程 pid')
  }
}

await sleep(1200)

/* ---------- ④ 日志与存活 ---------- */
const log = readLog()
const delta = log.slice(logLenBefore)

if (devMode) {
  /*
   * dev 轮次：不点退出（见 ③ 的说明），所以「请求送达」这条也跳过 ——
   * 否则整份日志里前一次运行留下的「收到 app:quit 请求」会让判据假绿。
   * 这一支在 dev 只核「按钮在位」；请求送达 + 原生框全部由安装态轮次验。
   */
  console.log('   ⚠ dev 轮次到此为止：只核「退出应用按钮在位」。请求送达与原生框由安装态套件验证。')
} else if (probeOn) {
  const gotRequest = /收到 app:quit 请求/.test(delta)
  check('主进程收到了 app:quit 请求', gotRequest)
  check('探针开启时不再出现「隐藏模式：跳过退出确认」', !delta.includes('隐藏模式：跳过退出确认'))
  check('★ 退出确认框真的弹出来了（原生 #32770）', dialogSeen)
  check('关掉确认框（等价点「取消」）后实例还在', await pageAlive())
} else {
  // 普通隐藏实例：按设计跳过确认框直接退。这一支到这儿实例已经没了，
  // 留一条明确说明，避免把「设计如此」误判成失败。
  console.log('   ⚠ 实例没带 --allow-native-dialogs，按设计会跳过确认框直接退出；')
  console.log('     这一支只核对到「请求送达主进程」。要验框本身请用套件（会自动带探针）。')
}

console.log(`\n=== 结果：${fails.length ? `${fails.length} 项未通过 ✗` : '全部通过 ✓'} ===`)
if (fails.length) {
  for (const f of fails) console.log('  - ' + f)
  process.exit(1)
}
process.exit(0)
