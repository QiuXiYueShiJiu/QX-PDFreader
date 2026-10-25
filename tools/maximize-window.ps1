# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright 2026 秋夕月拾旧

﻿# 查找并最大化指定窗口
#
# 用途：把 DSH 窗口最大化，方便用户查看运行状态。
#
# 实现要点：
#   · ShowWindow(SW_MAXIMIZE=3) 是标准最大化，
#     比「设成屏幕大小 + 去边框」更稳（保留窗口的标准行为）
#   · 如果窗口已经最大化，SW_MAXIMIZE 仍是幂等的，不会来回跳
#   · 用 EnumWindows 遍历顶层窗口按标题匹配；
#     桌面上的窗口都是顶层窗口，一定能枚举到
#
# 用法（可传多个关键字，任一命中即处理）：
#   powershell -File tools/maximize-window.ps1 -Title "DSH"
#   powershell -Command "& tools/maximize-window.ps1 -Title 'DeepSeek Harness','DSH'"

param(
  # 字符串数组：多个关键字用逗号分隔（PowerShell 会自动转成数组）
  [Parameter(Mandatory = $true)][string[]]$Title
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

public class WindowMax {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);

  public struct RECT { public int L, T, R, B; }

  const int SW_MAXIMIZE = 3;
  const int SW_RESTORE = 9;

  static WindowMax() { SetProcessDPIAware(); }

  public static string Run(string key) {
    var sb = new StringBuilder();
    int count = 0;

    EnumWindows(delegate(IntPtr h, IntPtr l) {
      var t = new StringBuilder(512);
      GetWindowTextW(h, t, 512);
      string title = t.ToString();
      if (title.Length == 0) return true;
      if (title.IndexOf(key, StringComparison.OrdinalIgnoreCase) < 0) return true;
      if (!IsWindowVisible(h)) return true;

      RECT r; GetWindowRect(h, out r);
      // 太小的多是子窗口或提示条，跳过
      if ((r.R - r.L) < 300 || (r.B - r.T) < 200) return true;

      // 最小化的窗口要先还原，否则 SW_MAXIMIZE 不生效
      if (IsIconic(h)) { ShowWindow(h, SW_RESTORE); System.Threading.Thread.Sleep(150); }

      ShowWindow(h, SW_MAXIMIZE);
      SetForegroundWindow(h);

      System.Threading.Thread.Sleep(150);
      RECT r2; GetWindowRect(h, out r2);
      sb.AppendLine("  " + title.Substring(0, Math.Min(60, title.Length))
        + "  → " + (r2.R - r2.L) + "x" + (r2.B - r2.T)
        + (IsZoomed(h) ? "  [已最大化]" : "  [未最大化]"));
      count++;
      return true;
    }, IntPtr.Zero);

    return count == 0 ? "  未找到匹配 \"" + key + "\" 的可见窗口" : sb.ToString();
  }
}
'@

Write-Output ([WindowMax]::Run($Title))
