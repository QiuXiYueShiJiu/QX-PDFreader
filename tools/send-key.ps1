# tools/send-key.ps1 —— 向指定进程窗口发一次按键（虚拟键码）
param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][byte]$VirtualKey
)
. (Join-Path $PSScriptRoot '_guard-foreground.ps1')
. (Join-Path $PSScriptRoot '_win32.ps1')
Assert-ForegroundAllowed
Set-QxForeground -Handle (Get-QxMainWindow -ProcessId $ProcessId)
Send-QxKey -VirtualKey $VirtualKey
Write-Host ("已向 pid={0} 发送按键 0x{1:X2}" -f $ProcessId, $VirtualKey)
