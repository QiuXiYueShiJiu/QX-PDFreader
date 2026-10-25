# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright 2026 秋夕月拾旧

﻿# 显示并置顶指定标题的窗口
#
# 用途：应用以 --hidden 启动后需要人工查看时，把窗口显示出来。
# 与 --hidden 配合使用：测试时隐藏，需要人工确认时用本脚本唤出。
#
# 用法：
#   powershell -File tools/show-window.ps1 -Title "PDF 阅读器"

param(
  [Parameter(Mandatory = $true)][string]$Title
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

public class WindowShow {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);

  static WindowShow() { SetProcessDPIAware(); }

  public static string Run(string key) {
    var sb = new StringBuilder();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      var t = new StringBuilder(256);
      GetWindowTextW(h, t, 256);
      if (t.ToString().IndexOf(key, StringComparison.OrdinalIgnoreCase) < 0) return true;

      // SW_RESTORE=9 先还原（可能被最小化），SW_SHOW=5 再显示
      ShowWindow(h, 9);
      ShowWindow(h, 5);
      // 置顶再取消置顶，确保它跳到最前面
      SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0002 | 0x0001);
      SetWindowPos(h, new IntPtr(-2), 0, 0, 0, 0, 0x0002 | 0x0001);
      SetForegroundWindow(h);

      sb.AppendLine("  " + t.ToString().Substring(0, Math.Min(50, t.Length)) + "  可见=" + IsWindowVisible(h));
      return true;
    }, IntPtr.Zero);

    return sb.Length == 0 ? "  未找到匹配窗口" : sb.ToString();
  }
}
'@

$result = [WindowShow]::Run($Title)
Write-Output $result
