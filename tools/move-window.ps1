# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright 2026 秋夕月拾旧

﻿# 把指定窗口移到屏幕外/其他位置（临时让开被遮挡区域）
#
# 用途：ClassIsland 之类的桌面横幅会占满屏幕顶部，
# 把 PowerPoint 的功能区标签盖住。测试时需要临时让它让开。
#
# 注意：这是临时移动，不是关闭 —— 用完可以用 -Restore 移回。
#
# 用法：
#   powershell -File tools/move-window.ps1 -Title "ClassIsland" -X 0 -Y -300
#   powershell -File tools/move-window.ps1 -Title "ClassIsland" -Restore

param(
  [Parameter(Mandatory = $true)][string]$Title,
  [int]$X = 0,
  [int]$Y = 0,
  [switch]$Restore,
  # 移到屏幕下方之外（默认的「让开」方式）
  [switch]$Hide
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

public class WindowMover {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);

  public struct RECT { public int L, T, R, B; }

  // SWP_NOZORDER(0x0004) | SWP_NOACTIVATE(0x0010)
  const uint FLAGS = 0x0004 | 0x0010;

  static WindowMover() { SetProcessDPIAware(); }

  public static string Run(string key, int x, int y, bool restore, bool hide) {
    var sb = new StringBuilder();
    int count = 0;
    int screenH = GetSystemMetrics(1);

    EnumWindows(delegate(IntPtr handle, IntPtr l) {
      var t = new StringBuilder(512);
      GetWindowTextW(handle, t, 512);
      string title = t.ToString();
      if (title.Length == 0) return true;
      if (title.IndexOf(key, StringComparison.OrdinalIgnoreCase) < 0) return true;
      if (!IsWindowVisible(handle)) return true;

      RECT r; GetWindowRect(handle, out r);
      int w = r.R - r.L, h = r.B - r.T;
      if (w < 200 || h < 60) return true;

      if (restore) {
        SetWindowPos(handle, IntPtr.Zero, 0, 0, w, h, FLAGS);
        sb.AppendLine("  已复位: " + title.Substring(0, Math.Min(40, title.Length)) + " → 0,0");
      } else if (hide) {
        // 移到屏幕下方之外
        SetWindowPos(handle, IntPtr.Zero, 0, screenH + 50, w, h, FLAGS);
        sb.AppendLine("  已移出屏幕: " + title.Substring(0, Math.Min(40, title.Length)));
      } else {
        SetWindowPos(handle, IntPtr.Zero, x, y, w, h, FLAGS);
        sb.AppendLine("  已移到 " + x + "," + y + ": " + title.Substring(0, Math.Min(40, title.Length)));
      }
      count++;
      return true;
    }, IntPtr.Zero);

    return count == 0 ? "  未找到匹配 \"" + key + "\" 的可见窗口" : sb.ToString();
  }
}
'@

if ($Restore) {
  Write-Output ([WindowMover]::Run($Title, 0, 0, $true, $false))
} elseif ($Hide) {
  Write-Output ([WindowMover]::Run($Title, 0, 0, $false, $true))
} else {
  Write-Output ([WindowMover]::Run($Title, $X, $Y, $false, $false))
}
