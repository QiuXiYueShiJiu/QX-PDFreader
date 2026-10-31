# tools/maximize-window.ps1 —— 最大化指定进程的主窗口
param([Parameter(Mandatory = $true)][int]$ProcessId)
. (Join-Path $PSScriptRoot '_guard-foreground.ps1')
. (Join-Path $PSScriptRoot '_win32.ps1')
Assert-ForegroundAllowed
[QxWin32]::ShowWindow((Get-QxMainWindow -ProcessId $ProcessId), $script:SW_SHOWMAXIMIZED) | Out-Null
Write-Host "已最大化 pid=$ProcessId 的主窗口"
