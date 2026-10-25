# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright 2026 秋夕月拾旧

﻿# 模拟鼠标点击（用于研究第三方软件界面）
#
# 用 mouse_event 发送真实输入事件 —— 目标程序收到的是标准 WM_LBUTTONDOWN，
# 与人工点击无异，比 SendMessage 兼容性好（Qt 程序对后者常无响应）。
#
# 用法：
#   powershell -File tools/click-at.ps1 -X 100 -Y 200
#   powershell -File tools/click-at.ps1 -X 100 -Y 200 -DoubleClick

param(
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [switch]$DoubleClick,
  # 点击前先移动鼠标过去，模拟真实悬停（有些控件需要 hover 才响应）
  [switch]$NoMove
)

$ErrorActionPreference = 'Stop'
# 前台硬约束守卫：本脚本会显示/置顶/最大化窗口或注入真实鼠标键盘事件，
# 默认拒绝执行（详见 tools/_guard-foreground.ps1）。
. (Join-Path $PSScriptRoot '_guard-foreground.ps1')
Assert-ForegroundAllowed

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class MouseSim {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

  const uint LEFTDOWN = 0x0002;
  const uint LEFTUP = 0x0004;

  static MouseSim() { SetProcessDPIAware(); }

  public static void Move(int x, int y) { SetCursorPos(x, y); }

  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(60);
    mouse_event(LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(50);
    mouse_event(LEFTUP, 0, 0, 0, UIntPtr.Zero);
  }

  public static void DoubleClick(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(60);
    for (int i = 0; i < 2; i++) {
      mouse_event(LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
      System.Threading.Thread.Sleep(30);
      mouse_event(LEFTUP, 0, 0, 0, UIntPtr.Zero);
      System.Threading.Thread.Sleep(80);
    }
  }

  public static string Cursor() {
    POINT p; GetCursorPos(out p);
    return p.X + "," + p.Y;
  }
}
'@

if (-not $NoMove) { [MouseSim]::Move($X, $Y); Start-Sleep -Milliseconds 120 }

if ($DoubleClick) { [MouseSim]::DoubleClick($X, $Y) } else { [MouseSim]::Click($X, $Y) }

Start-Sleep -Milliseconds 200
Write-Output ("clicked " + $X + "," + $Y + "  cursor=" + [MouseSim]::Cursor())
