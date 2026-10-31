# tools/move-window.ps1 —— 移动/缩放指定进程的主窗口
param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [int]$X = 0, [int]$Y = 0, [int]$Width = 1600, [int]$Height = 900
)
. (Join-Path $PSScriptRoot '_guard-foreground.ps1')
. (Join-Path $PSScriptRoot '_win32.ps1')
Assert-ForegroundAllowed
$h = Get-QxMainWindow -ProcessId $ProcessId
[QxWin32]::MoveWindow($h, $X, $Y, $Width, $Height, $true) | Out-Null
Write-Host "已把 pid=$ProcessId 的窗口移到 ${X},${Y} 尺寸 ${Width}x${Height}"
