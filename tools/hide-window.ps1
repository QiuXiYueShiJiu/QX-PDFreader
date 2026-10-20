# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright 2026 秋夕月拾旧

﻿# 隐藏指定标题的窗口（转入后台工作，不干扰用户）
#
# 与 show-window.ps1 配对使用：
#   需要在屏幕上确认时用 show-window，确认完用本脚本收起。
#
# 用 SW_HIDE 而不是最小化：
#   最小化仍占任务栏、仍会被 Alt+Tab 选中；SW_HIDE 让窗口彻底消失，
#   但进程与 CDP 调试端口都还在，自动化测试照常可跑。
#
# 用法：
#   powershell -File tools/hide-window.ps1 -Title "PDF 阅读器"

param(
  [Parameter(Mandatory = $true)][string]$Title
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public class WindowHide {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);

  static WindowHide() { SetProcessDPIAware(); }

  public static string Run(string key) {
    var sb = new StringBuilder();
    int count = 0;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      var t = new StringBuilder(256);
      GetWindowTextW(h, t, 256);
      if (t.ToString().IndexOf(key, StringComparison.OrdinalIgnoreCase) < 0) return true;
      if (!IsWindowVisible(h)) return true;

      ShowWindow(h, 0);   // SW_HIDE
      count++;
      sb.AppendLine("  已隐藏: " + t.ToString().Substring(0, Math.Min(50, t.Length)));
      return true;
    }, IntPtr.Zero);

    return count == 0 ? "  （没有可见的匹配窗口）" : sb.ToString();
  }
}
'@

$result = [WindowHide]::Run($Title)
Write-Output $result
