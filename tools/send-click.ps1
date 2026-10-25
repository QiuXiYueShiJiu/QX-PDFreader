# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright 2026 秋夕月拾旧

﻿# 用 SendInput 发送真实鼠标点击
#
# 为什么另写一个而不是用现有的 click-at.ps1：
#   click-at.ps1 用的是 mouse_event（旧 API），
#   对采用「分层窗口 + 点击穿透」的全屏置顶程序（如 π6 放映时的覆盖层）
#   有时会被吞掉 —— 实测同样坐标在编辑器模式能点到、在放映模式点不到。
#   SendInput 是 XP 之后推荐的输入注入方式，走的是与真实鼠标
#   完全相同的消息路径，兼容性更好。
#
# 另外用**绝对坐标归一化**（0~65535）而不是屏幕像素，
# 这样在多显示器 / 高 DPI 下不容易算错。
#
# 用法：
#   powershell -File tools/send-click.ps1 -X 16 -Y 636
#   powershell -File tools/send-click.ps1 -X 16 -Y 636 -DoubleClick
#   powershell -File tools/send-click.ps1 -X 16 -Y 636 -Right

param(
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [switch]$DoubleClick,
  [switch]$Right,
  # 移动后停留多久再按下（毫秒）——有些程序需要看到 hover 才响应
  [int]$HoverMs = 150
)

$ErrorActionPreference = 'Stop'
# 前台硬约束守卫：本脚本会显示/置顶/最大化窗口或注入真实鼠标键盘事件，
# 默认拒绝执行（详见 tools/_guard-foreground.ps1）。
. (Join-Path $PSScriptRoot '_guard-foreground.ps1')
Assert-ForegroundAllowed

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class SendClick {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);

  [StructLayout(LayoutKind.Sequential)]
  struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct INPUT {
    public uint type;
    public MOUSEINPUT mi;
  }

  const uint INPUT_MOUSE = 0;
  const uint MOUSEEVENTF_MOVE = 0x0001;
  const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  const uint MOUSEEVENTF_LEFTUP = 0x0004;
  const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
  const uint MOUSEEVENTF_RIGHTUP = 0x0010;
  const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
  const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;

  static SendClick() { SetProcessDPIAware(); }

  /** 把屏幕像素换算成 SendInput 要求的 0~65535 归一化坐标 */
  static void ToAbsolute(int x, int y, out int nx, out int ny) {
    int sw = GetSystemMetrics(0);   // SM_CXSCREEN
    int sh = GetSystemMetrics(1);   // SM_CYSCREEN
    nx = (int)((double)x * 65535.0 / Math.Max(1, sw - 1));
    ny = (int)((double)y * 65535.0 / Math.Max(1, sh - 1));
  }

  static void Send(uint flags, int nx, int ny) {
    var inp = new INPUT[1];
    inp[0].type = INPUT_MOUSE;
    inp[0].mi.dx = nx;
    inp[0].mi.dy = ny;
    inp[0].mi.dwFlags = flags;
    inp[0].mi.mouseData = 0;
    inp[0].mi.time = 0;
    inp[0].mi.dwExtraInfo = IntPtr.Zero;
    SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
  }

  public static void MoveTo(int x, int y) {
    int nx, ny; ToAbsolute(x, y, out nx, out ny);
    Send(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, nx, ny);
  }

  public static void Click(int x, int y, bool right, int hoverMs) {
    // 先把光标真的移过去（有些控件靠 WM_MOUSEMOVE 才切换状态）
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(Math.Max(20, hoverMs));

    int nx, ny; ToAbsolute(x, y, out nx, out ny);
    uint down = right ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN;
    uint up = right ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP;

    // 带上 MOVE 标志一起发，保证位置与按键在同一个消息批次里
    Send(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, nx, ny);
    System.Threading.Thread.Sleep(40);
    Send(down | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, nx, ny);
    System.Threading.Thread.Sleep(60);
    Send(up | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, nx, ny);
  }

  public static void DoubleClick(int x, int y, int hoverMs) {
    Click(x, y, false, hoverMs);
    System.Threading.Thread.Sleep(80);
    Click(x, y, false, 20);
  }
}
'@

if ($DoubleClick) {
  [SendClick]::DoubleClick($X, $Y, $HoverMs)
} else {
  [SendClick]::Click($X, $Y, $Right.IsPresent, $HoverMs)
}

Write-Output "sendinput-click $X,$Y"
