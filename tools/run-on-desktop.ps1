# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright 2026 秋夕月拾旧

﻿# 在虚拟桌面上启动 PDF 阅读器（供测试使用）
#
# 为什么必须这样做：
#   之前所有测试都直接开在用户真实桌面上，窗口不断弹出挡视野，
#   用户只能手动关掉，我还误判成「程序自己退出」白查了半天。
#   现在统一走这个脚本：窗口只存在于独立桌面 SBTEST，
#   用户桌面上看不到任何东西，也不会抢焦点。
#
# 同时保证不弹控制台窗口：
#   · 启动器本身是 WinExe（Windows GUI 子系统）
#   · 子进程带 CREATE_NO_WINDOW | DETACHED_PROCESS
#   · 本脚本用 -WindowStyle Hidden 静默运行
#
# 用法：
#   powershell -File tools/run-on-desktop.ps1 [-Port 9223] [-Pdf <路径>] [-Wait 15]

param(
  [int]$Port = 9223,
  [string]$Pdf = '',
  [int]$Wait = 15,
  [string]$DesktopName = 'SBTEST'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$logDir = Join-Path $root 'test-results'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$launcherLog = Join-Path $logDir 'desktop-launcher.log'

# ---------- 清理旧实例 ----------
Get-Process '智慧黑板PDF阅读器', 'electron' -ErrorAction SilentlyContinue |
  Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
if (Test-Path $launcherLog) { Remove-Item $launcherLog -Force }

# ---------- 确保启动器已编译 ----------
$launcher = Join-Path $root 'tools\bin\desktop-launcher.exe'
if (-not (Test-Path $launcher)) {
  Write-Host '启动器未编译，正在编译…'
  powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'tools\build-launcher.ps1') | Out-Null
}

# ---------- 组装参数 ----------
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) { throw "electron.exe not found: $electron" }

$childArgs = @(
  $DesktopName,
  $electron,
  '.',
  "--remote-debugging-port=$Port"
)
if ($Pdf -ne '') { $childArgs += $Pdf }
$childArgs += @('--no-wait', '--log', $launcherLog)

# 注意：不要用 -RedirectStandardOutput，那会要求有控制台并可能弹窗
Start-Process -FilePath $launcher `
  -ArgumentList $childArgs `
  -WorkingDirectory $root `
  -WindowStyle Hidden

# ---------- 等启动完成 ----------
Start-Sleep -Seconds $Wait

# ---------- 报告状态 ----------
Write-Host '--- launcher log ---'
if (Test-Path $launcherLog) { Get-Content $launcherLog | ForEach-Object { "  $_" } }
else { Write-Host '  (无日志)' }

$n = (Get-Process electron -ErrorAction SilentlyContinue | Measure-Object).Count
Write-Host "--- electron processes: $n ---"

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DesktopProbe {
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EP cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  public static int VisibleReaderWindows() {
    int n = 0;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      var t = new StringBuilder(256); GetWindowTextW(h, t, 256);
      if (t.ToString().Contains("PDF 阅读器") && IsWindowVisible(h)) n++;
      return true;
    }, IntPtr.Zero);
    return n;
  }
}
"@
$visible = [DesktopProbe]::VisibleReaderWindows()
Write-Host "--- 用户桌面上可见的阅读器窗口: $visible (必须为 0) ---"
