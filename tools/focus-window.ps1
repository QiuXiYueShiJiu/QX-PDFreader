# tools/focus-window.ps1 —— 把指定进程的主窗口拉到前台（手动排查用）
param([Parameter(Mandatory = $true)][int]$ProcessId)
. (Join-Path $PSScriptRoot '_guard-foreground.ps1')
. (Join-Path $PSScriptRoot '_win32.ps1')
Assert-ForegroundAllowed
Set-QxForeground -Handle (Get-QxMainWindow -ProcessId $ProcessId)
Write-Host "已切到 pid=$ProcessId 的主窗口"
