# tools/_guard-foreground.ps1
#
# 前台门禁：所有会「把窗口拉到前台 / 移动 / 点击 / 发按键」的脚本都必须先 dot-source
# 本文件并调用 Assert-ForegroundAllowed。
#
# 为什么要有它：这些脚本一旦被误调用，会把正在上课的教师机界面切换掉，或者把
# 隐藏测试实例摊到桌面。默认拒绝，只有显式设置环境变量才放行：
#
#   $env:PDF_READER_ALLOW_FOREGROUND = '1'
#
# 用法（在脚本开头）：
#   . (Join-Path $PSScriptRoot '_guard-foreground.ps1')
#   Assert-ForegroundAllowed

Set-StrictMode -Version Latest

function Test-ForegroundAllowed {
  <#
    .SYNOPSIS
    当前是否允许操作前台窗口。
  #>
  $flag = [Environment]::GetEnvironmentVariable('PDF_READER_ALLOW_FOREGROUND', 'Process')
  if ([string]::IsNullOrWhiteSpace($flag)) {
    $flag = [Environment]::GetEnvironmentVariable('PDF_READER_ALLOW_FOREGROUND', 'User')
  }
  return ($flag -eq '1' -or $flag -eq 'true')
}

function Assert-ForegroundAllowed {
  <#
    .SYNOPSIS
    拒绝在没有授权的情况下操作前台窗口，避免抢教师机的显示。
  #>
  if (Test-ForegroundAllowed) { return }

  Write-Host '[前台门禁] 已拒绝执行：该脚本会改动前台窗口。' -ForegroundColor Yellow
  Write-Host '  这属于「会抢前台」的操作，默认禁止在课堂机上运行。' -ForegroundColor Yellow
  Write-Host '  确实需要时，先在当前 PowerShell 里显式授权：' -ForegroundColor Yellow
  Write-Host "    `$env:PDF_READER_ALLOW_FOREGROUND = '1'" -ForegroundColor Cyan
  exit 97
}
