// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 统一测试运行器：启动应用 → 跑验证 → 收尾，**全程不弹出任何窗口**。
 *
 * 三条硬性要求（用户明确提出）：
 *   ① 测试窗口不能出现在用户桌面上
 *   ② 不能弹出控制台窗口
 *   ③ 不打扰用户
 *
 * 实现方式：
 *   · 用 Node 的 spawn（windowsHide: true）而不是 PowerShell 脚本 ——
 *     PowerShell 自身会创建控制台窗口
 *   · 应用进程加 STARTF_USESHOWWINDOW/SW_HIDE，窗口从创建起就是隐藏的
 *   · 所有验证走 Chrome DevTools Protocol，对隐藏窗口完全有效
 *
 * 注意：不用 Windows 虚拟桌面（CreateDesktop）。
 *   实测 Electron 在非活动桌面上会被创建后立即退出
 *   （CreateProcess 成功但进程秒退），无法稳定使用。
 *
 * 用法：
 *   node tools/test-run.mjs --pdf "<路径>" --script tools/verify-annotations.mjs
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2)
function opt(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const port = Number(opt('port', '9223'))
const pdf = opt('pdf', '')
const script = opt('script', '')
const waitSec = Number(opt('wait', '12'))
const keepAlive = argv.includes('--keep')
/**
 * 指定要启动的 exe（默认用开发态的 electron）。
 * 传安装版路径即可验证打包产物，例如：
 *   --exe "D:\PdfReaderTest\智慧黑板PDF阅读器.exe"
 */
const exeOverride = opt('exe', '')

/* ---------- 无窗口执行命令 ---------- */
function runHidden(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { windowsHide: true, encoding: 'utf8', cwd: root, ...opts })
}

function isRunning(name) {
  const r = runHidden('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH'])
  return typeof r.stdout === 'string' && r.stdout.includes(name)
}

function killAll() {
  for (const name of ['秋夕-PDF阅读器.exe', '秋夕月拾旧-PDF阅读器.exe', 'QXPDFReader.exe', '智慧黑板PDF阅读器.exe', 'electron.exe']) {
    if (isRunning(name)) runHidden('taskkill', ['/F', '/IM', name])
  }
}

/* ---------- 1. 清场 ---------- */
killAll()
await new Promise((r) => setTimeout(r, 1500))

/* ---------- 2. 启动（隐藏窗口） ---------- */
/*
 * 默认用开发态的 electron.exe 加载当前目录；
 * 传 --exe 时改为直接启动那个可执行文件（用于验证安装版）。
 * 两者的参数形式不同：electron 需要先给一个目录，安装版不需要。
 */
let launchExe
let args

if (exeOverride) {
  launchExe = exeOverride
  if (!existsSync(launchExe)) {
    console.error(`找不到指定的可执行文件: ${launchExe}`)
    process.exit(1)
  }
  args = [`--remote-debugging-port=${port}`, '--hidden']
} else {
  launchExe = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  if (!existsSync(launchExe)) {
    console.error(`找不到 electron.exe: ${launchExe}`)
    process.exit(1)
  }
  args = ['.', `--remote-debugging-port=${port}`, '--hidden']
}
if (pdf) args.push(pdf)

const logDir = join(root, 'test-results')
mkdirSync(logDir, { recursive: true })

/*
 * 直接 spawn Electron，并传 --hidden 让应用自己保持窗口隐藏。
 *
 * 为什么不再用 PowerShell 的 -WindowStyle Hidden：
 *   那条路子实测不可靠 —— 输出重定向为空、进程状态难以判断，
 *   Node 侧还容易在拼接命令时被转义问题绊住，排查成本很高。
 *   现在把「是否显示窗口」变成应用自己的启动开关（主进程的 HIDDEN_MODE），
 *   行为确定、可测试，外部只需 windowsHide 抑制可能出现的控制台窗口。
 */
console.log(`启动应用（--hidden，端口 ${port}）…`)
console.log(`  可执行文件: ${launchExe}`)
const child = spawn(launchExe, args, {
  windowsHide: true,
  detached: true,
  stdio: 'ignore',
  cwd: root
})
child.unref()

await new Promise((r) => setTimeout(r, waitSec * 1000))

const alive = isRunning('electron.exe')
console.log(`应用存活: ${alive}`)

/* ---------- 3. 确认没有可见窗口 ---------- */
const probe = runHidden('powershell', [
  '-NoProfile',
  '-Command',
  `
Add-Type @"
using System;using System.Text;using System.Runtime.InteropServices;
public class VW {
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EP cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  public static int Count() {
    var pids = new System.Collections.Generic.HashSet<uint>();
    foreach (var p in System.Diagnostics.Process.GetProcessesByName("electron")) pids.Add((uint)p.Id);
    int n = 0;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!pids.Contains(pid)) return true;
      var t = new StringBuilder(256); GetWindowTextW(h, t, 256);
      if (t.Length > 0 && IsWindowVisible(h)) n++;
      return true;
    }, IntPtr.Zero);
    return n;
  }
}
"@
[VW]::Count()
`
])
const visibleCount = (probe.stdout || '').trim().split('\n').pop()
console.log(`用户桌面上可见的应用窗口: ${visibleCount} （必须为 0）`)

/* ---------- 4. 跑验证脚本 ---------- */
if (script) {
  console.log(`\n运行验证: ${script}\n`)
  const verify = spawnSync('node', [script, String(port)], {
    windowsHide: true,
    encoding: 'utf8',
    cwd: root
  })
  console.log(verify.stdout || '')
  if (verify.stderr) console.error(verify.stderr)
}

/* ---------- 5. 收尾 ---------- */
mkdirSync(logDir, { recursive: true })
writeFileSync(
  join(logDir, 'test-run.json'),
  JSON.stringify({ port, pdf, alive, visibleWindows: visibleCount, script }, null, 2),
  'utf8'
)

if (!keepAlive) {
  console.log('\n收尾：结束应用进程')
  killAll()
}
