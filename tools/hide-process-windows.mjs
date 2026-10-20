// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 让某个进程的所有可见窗口立即隐藏。
 *
 * 用途：测试时把 GUI 窗口从用户屏幕上移走。
 *
 * 为什么用隐藏窗口而不是虚拟桌面：
 *   虚拟桌面（CreateDesktop + lpDesktop）对 Electron 不可靠 ——
 *   实测进程能在虚拟桌面上创建成功，但随后立即退出，
 *   原因与 GPU/合成器在非活动桌面上的初始化有关，难以稳定。
 *   而「创建后立刻隐藏」对所有程序都成立，且 Chrome DevTools Protocol
 *   对隐藏窗口依然可用（渲染、脚本执行、截图都不受影响），
 *   因此这是更稳妥的测试隔离方式。
 *
 * 实现要点：
 *   · 用 EnumWindows 遍历**所有桌面**上的顶层窗口（EnumWindows 本身就是
 *     枚举当前窗口站的全部桌面，不需要切桌面）
 *   · 只隐藏「可见且属于目标进程」的窗口，避免误伤其它程序
 *   · 子窗口与工具窗口一并处理（Electron 有多个顶层窗口）
 *
 * 用法：node tools/hide-process-windows.mjs <进程名>
 */

import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const processName = process.argv[2] ?? 'electron'
const pid = process.argv[3] ?? ''

const psScript = `
$ErrorActionPreference = 'SilentlyContinue'

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class WindowHider {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  delegate bool EnumProc(IntPtr h, IntPtr l);

  public static string HideForPids(int[] targetPids) {
    var hidden = new List<string>();
    var targets = new HashSet<int>(targetPids);

    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;

      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (!targets.Contains((int)pid)) return true;

      var title = new StringBuilder(256);
      GetWindowTextW(h, title, 256);
      var cls = new StringBuilder(256);
      GetClassNameW(h, cls, 256);

      // SW_HIDE = 0；隐藏后 CDP 仍可驱动该页面
      ShowWindow(h, 0);
      hidden.Add(pid + "|" + cls + "|" + title);
      return true;
    }, IntPtr.Zero);

    return string.Join("\\n", hidden);
  }
}
"@

$names = @('${processName}')
$procs = Get-Process -Name $names -ErrorAction SilentlyContinue
if ('${pid}' -ne '') {
  $procs = $procs | Where-Object { $_.Id -eq ${pid || 0} }
}
if (-not $procs) { Write-Output 'NO_PROCESS'; exit 0 }

$pids = @($procs | ForEach-Object { $_.Id })
Write-Output ("PIDS=" + ($pids -join ','))
$result = [WindowHider]::HideForPids($pids)
if ($result -eq '') { Write-Output 'NO_VISIBLE_WINDOW' } else { Write-Output $result }
`

const result = spawnSync(
  'powershell',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
  { windowsHide: true, encoding: 'utf8', cwd: root }
)

const out = (result.stdout || '').trim()
console.log(out || '(无输出)')

mkdirSync(join(root, 'test-results'), { recursive: true })
writeFileSync(join(root, 'test-results', 'hide-result.txt'), out, 'utf8')
