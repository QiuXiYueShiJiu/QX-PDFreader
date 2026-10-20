# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright 2026 秋夕月拾旧

﻿# 激活指定窗口并设为前台（含最大化选项）
#
# 用于自动化演示：确保目标窗口在屏幕上可见、且在最前面。
#
# 关键点：Windows 有「前台窗口锁定」机制，普通 SetForegroundWindow
# 在调用方不是前台进程时会失败（只闪烁任务栏图标）。
# 用 AttachThreadInput 把当前线程附加到目标窗口所属线程，
# 就能绕过这个限制。
#
# 用法：
#   powershell -File tools/focus-window.ps1 -Title "PowerPoint" -Maximize
#   powershell -File tools/focus-window.ps1 -Title "PowerPoint" -Width 3840 -Height 2100

param(
  [Parameter(Mandatory = $true)][string]$Title,
  [switch]$Maximize,
  [int]$Width = 0,
  [int]$Height = 0
)

$ErrorActionPreference = 'Stop'
# 前台硬约束守卫：本脚本会显示/置顶/最大化窗口或注入真实鼠标键盘事件，
# 默认拒绝执行（详见 tools/_guard-foreground.ps1）。
. (Join-Path $PSScriptRoot '_guard-foreground.ps1')
Assert-ForegroundAllowed

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public class WindowFocus {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);

  public struct RECT { public int L, T, R, B; }

  const int SW_RESTORE = 9;
  const int SW_MAXIMIZE = 3;
  const int SW_SHOW = 5;

  static WindowFocus() { SetProcessDPIAware(); }

  public static string Run(string key, bool maximize, int w, int h) {
    var sb = new StringBuilder();
    int count = 0;

    EnumWindows(delegate(IntPtr handle, IntPtr l) {
      var t = new StringBuilder(512);
      GetWindowTextW(handle, t, 512);
      string title = t.ToString();
      if (title.Length == 0) return true;
      if (title.IndexOf(key, StringComparison.OrdinalIgnoreCase) < 0) return true;

      RECT r0; GetWindowRect(handle, out r0);
      if ((r0.R - r0.L) < 400 || (r0.B - r0.T) < 300) return true;

      // 还原（可能被最小化），再按需最大化或指定尺寸
      if (IsIconic(handle)) { ShowWindow(handle, SW_RESTORE); System.Threading.Thread.Sleep(250); }

      if (maximize) {
        ShowWindow(handle, SW_MAXIMIZE);
      } else if (w > 0 && h > 0) {
        ShowWindow(handle, SW_RESTORE);
        System.Threading.Thread.Sleep(250);
        SetWindowPos(handle, IntPtr.Zero, 0, 0, w, h, 0x0040);
      } else {
        ShowWindow(handle, SW_SHOW);
      }

      System.Threading.Thread.Sleep(200);

      // 绕过前台锁定
      uint pid; GetWindowThreadProcessId(handle, out pid);
      uint cur = GetCurrentThreadId();
      AttachThreadInput(cur, pid, true);
      BringWindowToTop(handle);
      SetForegroundWindow(handle);
      System.Threading.Thread.Sleep(150);
      AttachThreadInput(cur, pid, false);

      RECT r; GetWindowRect(handle, out r);
      sb.AppendLine("  " + title.Substring(0, Math.Min(55, title.Length))
        + "  → " + (r.R - r.L) + "x" + (r.B - r.T) + " @ " + r.L + "," + r.T);
      count++;
      return true;
    }, IntPtr.Zero);

    return count == 0 ? "  未找到匹配 \"" + key + "\" 的窗口" : sb.ToString();
  }
}
'@

$result = [WindowFocus]::Run($Title, $Maximize.IsPresent, $Width, $Height)
Write-Output $result
