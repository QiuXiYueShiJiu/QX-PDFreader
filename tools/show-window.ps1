# tools/show-window.ps1 —— 把指定进程的主窗口显示出来（手动排查用）
#
# 会动前台：默认拒绝，除非显式授权 $env:PDF_READER_ALLOW_FOREGROUND = '1'
param([Parameter(Mandatory = $true)][int]$ProcessId)
. (Join-Path $PSScriptRoot '_guard-foreground.ps1')
. (Join-Path $PSScriptRoot '_win32.ps1')
Assert-ForegroundAllowed
[QxWin32]::ShowWindow((Get-QxMainWindow -ProcessId $ProcessId), $script:SW_SHOWNORMAL) | Out-Null
Write-Host "已显示 pid=$ProcessId 的主窗口"
