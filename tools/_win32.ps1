# tools/_win32.ps1
#
# 会动窗口的测试工具共用的 Win32 封装（ShowWindow / SetForegroundWindow /
# MoveWindow / SendInput）。只被 tools/*.ps1 里那几支手动工具 dot-source，
# 不进套件（套件一律连 CDP，不碰前台）。
#
# 用法：
#   . (Join-Path $PSScriptRoot '_win32.ps1')

Set-StrictMode -Version Latest

if (-not ('QxWin32' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class QxWin32 {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int tall, bool repaint);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
}

$script:SW_HIDE = 0
$script:SW_SHOWNORMAL = 1
$script:SW_SHOWMAXIMIZED = 3

function Get-QxMainWindow {
  <#
    .SYNOPSIS
    按进程 id 找主窗口句柄（只认有标题的顶层窗口）。
  #>
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  $p = Get-Process -Id $ProcessId -ErrorAction Stop
  if ($p.MainWindowHandle -ne [IntPtr]::Zero) { return $p.MainWindowHandle }
  $p.Refresh()
  return $p.MainWindowHandle
}

function Get-QxWindowRect {
  param([Parameter(Mandatory = $true)][IntPtr]$Handle)
  $r = New-Object QxWin32+RECT
  if (-not [QxWin32]::GetWindowRect($Handle, [ref]$r)) { throw "GetWindowRect 失败：$Handle" }
  return $r
}

function Set-QxForeground {
  param([Parameter(Mandatory = $true)][IntPtr]$Handle)
  [QxWin32]::ShowWindow($Handle, $script:SW_SHOWNORMAL) | Out-Null
  [QxWin32]::SetForegroundWindow($Handle) | Out-Null
}

function Send-QxClick {
  <#
    .SYNOPSIS
    在屏幕坐标点一下左键（按下 + 抬起，间隔 40ms）。
  #>
  param(
    [Parameter(Mandatory = $true)][int]$X,
    [Parameter(Mandatory = $true)][int]$Y
  )
  [QxWin32]::SetCursorPos($X, $Y) | Out-Null
  Start-Sleep -Milliseconds 40
  [QxWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)   # LEFTDOWN
  Start-Sleep -Milliseconds 40
  [QxWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)   # LEFTUP
}

function Send-QxKey {
  <#
    .SYNOPSIS
    按一次按键（vk 是虚拟键码，例如 0x0D = Enter、0x1B = Esc）。
  #>
  param([Parameter(Mandatory = $true)][byte]$VirtualKey)
  [QxWin32]::keybd_event($VirtualKey, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [QxWin32]::keybd_event($VirtualKey, 0, 2, [UIntPtr]::Zero)
}
