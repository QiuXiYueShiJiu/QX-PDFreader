# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright 2026 秋夕月拾旧

﻿# 发送按键（用于自动化测试）
#
# 为什么写成独立脚本而不是内联 -Command：
#   PowerShell 通过 -Command 传内联 C# 时，双引号会被外层 shell 剥掉，
#   导致 Add-Type 编译失败（报「无法识别的转义序列」）。
#   独立文件没有这个问题。
#
# 用法：
#   powershell -File tools/send-key.ps1 -Key Esc
#   powershell -File tools/send-key.ps1 -Key Right -Times 5
#   powershell -File tools/send-key.ps1 -Key F5

param(
  [Parameter(Mandatory = $true)][string]$Key,
  [int]$Times = 1,
  [int]$DelayMs = 200
)

$ErrorActionPreference = 'Stop'
# 前台硬约束守卫：本脚本会显示/置顶/最大化窗口或注入真实鼠标键盘事件，
# 默认拒绝执行（详见 tools/_guard-foreground.ps1）。
. (Join-Path $PSScriptRoot '_guard-foreground.ps1')
Assert-ForegroundAllowed

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class KeySender {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern uint MapVirtualKeyW(uint code, uint mapType);

  static KeySender() { SetProcessDPIAware(); }

  public static void Tap(byte vk, int delayMs) {
    // 用 MapVirtualKey 拿到扫描码，某些程序（尤其 Qt / 游戏）只认扫描码
    byte scan = (byte)MapVirtualKeyW(vk, 0);
    keybd_event(vk, scan, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(60);
    keybd_event(vk, scan, 2, UIntPtr.Zero);
    System.Threading.Thread.Sleep(delayMs);
  }
}
'@

# 虚拟键码表（只列测试常用的）
$vkMap = @{
  'Esc'       = 0x1B
  'Enter'     = 0x0D
  'Space'     = 0x20
  'Tab'       = 0x09
  'Backspace' = 0x08
  'Left'      = 0x25
  'Up'        = 0x26
  'Right'     = 0x27
  'Down'      = 0x28
  'Delete'    = 0x2E
  'Home'      = 0x24
  'End'       = 0x23
  'PageUp'    = 0x21
  'PageDown'  = 0x22
  'F1'        = 0x70
  'F2'        = 0x71
  'F3'        = 0x72
  'F4'        = 0x73
  'F5'        = 0x74
  'F6'        = 0x75
  'F11'       = 0x7A
  'F12'       = 0x7B
}

if (-not $vkMap.ContainsKey($Key)) {
  Write-Error "未收录的按键: $Key（可用: $($vkMap.Keys -join ', ')）"
  exit 1
}

$vk = [byte]$vkMap[$Key]
for ($i = 0; $i -lt $Times; $i++) {
  [KeySender]::Tap($vk, $DelayMs)
}

Write-Output "sent $Key x$Times"
