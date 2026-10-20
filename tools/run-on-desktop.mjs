// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 在虚拟桌面上启动 PDF 阅读器，**全程不弹出任何窗口**。
 *
 * 为什么用 Node 而不是 PowerShell（这是用户明确要求）：
 *   PowerShell 进程本身会创建控制台窗口 —— 即使加 -WindowStyle Hidden，
 *   在从非控制台环境启动时仍可能闪一下黑窗。
 *   Node 的 spawn 带 `windowsHide: true`，由系统保证不显示窗口，
 *   子进程也一律继承这个设置，因此整条链路零弹窗。
 *
 * 虚拟桌面部分由 tools/bin/desktop-launcher.exe 完成
 *   （WinExe 子系统，自身也不弹控制台）。
 *
 * 用法：
 *   node tools/run-on-desktop.mjs
 *   node tools/run-on-desktop.mjs --port 9223 --pdf "D:\a.pdf" --wait 15
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
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
const waitSec = Number(opt('wait', '15'))
const desktopName = opt('desktop', 'SBTEST')

/* ---------- 工具：无窗口地执行命令 ---------- */
function runHidden(command, args, options = {}) {
  return spawnSync(command, args, {
    windowsHide: true,
    encoding: 'utf8',
    cwd: root,
    ...options
  })
}

/** 判断某个进程名是否还在运行（用 tasklist，无窗口） */
function isRunning(name) {
  const r = runHidden('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH'])
  return typeof r.stdout === 'string' && r.stdout.includes(name)
}

/* ---------- 1. 清理旧实例 ---------- */
for (const name of ['秋夕-PDF阅读器.exe', '秋夕月拾旧-PDF阅读器.exe', 'QXPDFReader.exe', '智慧黑板PDF阅读器.exe', 'electron.exe']) {
  if (isRunning(name)) {
    runHidden('taskkill', ['/F', '/IM', name])
    console.log(`  已结束旧进程: ${name}`)
  }
}
// taskkill 需要一点时间释放端口
await new Promise((r) => setTimeout(r, 2000))

/* ---------- 2. 确保启动器已编译 ---------- */
const launcher = join(root, 'tools', 'bin', 'desktop-launcher.exe')
if (!existsSync(launcher)) {
  console.log('  启动器未编译，正在编译…')
  const build = runHidden('dotnet', [
    'publish',
    join(root, 'tools', 'DesktopLauncher.csproj'),
    '-c',
    'Release',
    '-r',
    'win-x64',
    '-o',
    join(root, 'tools', '.publish'),
    '--nologo',
    '-v',
    'quiet'
  ])
  if (build.status !== 0) {
    console.error('  编译失败:', build.stdout || build.stderr)
    process.exit(1)
  }
  // dotnet publish 产物直接拷到 bin
  const pubDir = join(root, 'tools', '.publish')
  const copy = runHidden('cmd', [
    '/c',
    `xcopy /Y /Q "${pubDir}\\*.exe" "${join(root, 'tools', 'bin')}\\" >nul && ` +
      `xcopy /Y /Q "${pubDir}\\*.dll" "${join(root, 'tools', 'bin')}\\" >nul && ` +
      `xcopy /Y /Q "${pubDir}\\*.json" "${join(root, 'tools', 'bin')}\\" >nul`
  ])
  void copy
}

/* ---------- 3. 启动到虚拟桌面 ---------- */
const logDir = join(root, 'test-results')
mkdirSync(logDir, { recursive: true })
const launcherLog = join(logDir, 'desktop-launcher.log')
if (existsSync(launcherLog)) rmSync(launcherLog)

const electron = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
if (!existsSync(electron)) {
  console.error(`  找不到 electron.exe: ${electron}`)
  process.exit(1)
}

const childArgs = [desktopName, electron, '.', `--remote-debugging-port=${port}`]
if (pdf) childArgs.push(pdf)
childArgs.push('--no-wait', '--log', launcherLog)

console.log(`  启动到虚拟桌面 ${desktopName}，端口 ${port}`)
if (pdf) console.log(`  待打开文件: ${pdf}`)

// detached + windowsHide + stdio ignore：
//   · detached 让启动器不随本脚本退出而结束
//   · windowsHide 保证不出现任何窗口
//   · stdio ignore 避免管道句柄被继承（句柄会拖住进程）
const child = spawn(launcher, childArgs, {
  windowsHide: true,
  detached: true,
  stdio: 'ignore',
  cwd: root
})
child.unref()

/* ---------- 4. 等待并报告 ---------- */
await new Promise((r) => setTimeout(r, waitSec * 1000))

console.log('--- 启动器日志 ---')
if (existsSync(launcherLog)) {
  for (const line of readFileSync(launcherLog, 'utf8').split('\n')) {
    if (line.trim()) console.log('  ' + line.trim())
  }
} else {
  console.log('  (无)')
}

const alive = isRunning('electron.exe')
console.log(`--- electron 进程存活: ${alive} ---`)

/* ---------- 5. 验证用户桌面上没有窗口 ---------- */
const probe = runHidden('powershell', [
  '-NoProfile',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
  `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DW {
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EP cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  public static int Count() {
    int n = 0;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      var t = new StringBuilder(256); GetWindowTextW(h, t, 256);
      if (t.ToString().Contains("PDF") && IsWindowVisible(h)) n++;
      return true;
    }, IntPtr.Zero);
    return n;
  }
}
"@
[DW]::Count()
`
])

const visible = (probe.stdout || '').trim().split('\n').pop()
console.log(`--- 用户桌面上的可见窗口: ${visible} (必须为 0) ---`)

/* ---------- 6. 打印结果路径，便于后续脚本使用 ---------- */
writeFileSync(
  join(logDir, 'desktop-run.json'),
  JSON.stringify({ port, pdf, desktopName, alive, visibleWindows: visible }, null, 2),
  'utf8'
)
