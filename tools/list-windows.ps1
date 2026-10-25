# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright 2026 秋夕月拾旧

﻿# 列出所有可见的顶层窗口（标题 + 尺寸）
#
# 用途：找窗口时先看清有哪些，再决定操作哪个。
# 只列出「像正常应用窗口」的（尺寸够大），过滤掉提示条与子窗口。

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public class WindowList {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);

  public struct RECT { public int L, T, R, B; }

  static WindowList() { SetProcessDPIAware(); }

  public static string All() {
    var sb = new StringBuilder();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      var t = new StringBuilder(512);
      GetWindowTextW(h, t, 512);
      string title = t.ToString();
      if (title.Length == 0) return true;
      RECT r; GetWindowRect(h, out r);
      int w = r.R - r.L, hh = r.B - r.T;
      if (w < 300 || hh < 200) return true;
      sb.AppendLine("  " + w + "x" + hh + " @ " + r.L + "," + r.T
        + (IsZoomed(h) ? "  [最大化]" : "")
        + "  " + title.Substring(0, Math.Min(70, title.Length)));
      return true;
    }, IntPtr.Zero);
    return sb.Length == 0 ? "  （没有可见的窗口）" : sb.ToString();
  }
}
'@

Write-Output ([WindowList]::All())
