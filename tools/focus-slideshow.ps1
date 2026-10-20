# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright 2026 秋夕月拾旧

﻿# 激活 PowerPoint 放映窗口（把它强制拉到最前）
#
# ── 为什么必须单独写这一步（关键教训）────────────────────────
#   自动化测试时反复出现「点了没反应」，一直以为是坐标不准，
#   实际原因是 **DSH 窗口自己跑到了前台**，把放映画面整个盖住，
#   点击全落在了 DSH 上，根本没到 π6。
#   因此每一批点击之前都必须先把放映窗口重新置顶。
#
# ── 技术要点 ─────────────────────────────────────────────────
#   · 放映时存在两个 PowerPoint 窗口：编辑器窗口和
#     「PowerPoint 幻灯片放映 - [xxx]」窗口，只激活后者
#   · Windows 的前台锁定机制会拦普通 SetForegroundWindow，
#     用 AttachThreadInput 附加到目标线程可绕过
#   · 只有被遮挡的窗口才需要置顶，已在前台就跳过，避免多余闪烁
#
# 用法：
#   powershell -File tools/focus-slideshow.ps1

$ErrorActionPreference = 'Stop'
# 前台硬约束守卫：本脚本会显示/置顶/最大化窗口或注入真实鼠标键盘事件，
# 默认拒绝执行（详见 tools/_guard-foreground.ps1）。
. (Join-Path $PSScriptRoot '_guard-foreground.ps1')
Assert-ForegroundAllowed

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public class SlideshowFocus {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);

  public struct RECT { public int L, T, R, B; }

  static SlideshowFocus() { SetProcessDPIAware(); }

  public static string Run() {
    var sb = new StringBuilder();
    IntPtr fg = GetForegroundWindow();
    int count = 0;

    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      var t = new StringBuilder(512);
      GetWindowTextW(h, t, 512);
      string title = t.ToString();

      // 只认放映窗口
      if (title.IndexOf("幻灯片放映", StringComparison.OrdinalIgnoreCase) < 0) return true;

      RECT r; GetWindowRect(h, out r);
      if ((r.R - r.L) < 800 || (r.B - r.T) < 600) return true;

      if (h == fg) {
        sb.AppendLine("  已在最前: " + title.Substring(0, Math.Min(50, title.Length)));
        count++;
        return true;
      }

      ShowWindow(h, 5); // SW_SHOW
      uint pid; GetWindowThreadProcessId(h, out pid);
      uint cur = GetCurrentThreadId();
      AttachThreadInput(cur, pid, true);
      BringWindowToTop(h);
      SetForegroundWindow(h);
      System.Threading.Thread.Sleep(250);
      AttachThreadInput(cur, pid, false);

      sb.AppendLine("  已置前: " + title.Substring(0, Math.Min(50, title.Length))
        + (GetForegroundWindow() == h ? "  [成功]" : "  [可能未成功]"));
      count++;
      return true;
    }, IntPtr.Zero);

    return count == 0 ? "  未找到放映窗口（演示可能已结束）" : sb.ToString();
  }
}
'@

Write-Output ([SlideshowFocus]::Run())
