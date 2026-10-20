# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright 2026 秋夕月拾旧

﻿# 整屏截图并裁剪出指定区域
#
# 纯 PowerShell 实现。
#
# 为什么不用 C# Add-Type 的 P/Invoke：
#   本机环境下 Add-Type 编译自定义类型总是失败
#   （报「命名空间 System.Drawing 中不存在类型」，实为编译环境限制），
#   而 PowerShell 自带的 Graphics.CopyFromScreen 完全够用。
#
# 用法：
#   powershell -File tools/crop-shot.ps1 -Out full.png
#   powershell -File tools/crop-shot.ps1 -Out rail.png -Rect "168,626,80,908"
#   powershell -File tools/crop-shot.ps1 -Out zoom.png -Rect "168,626,80,908" -Zoom 4

param(
  [Parameter(Mandatory = $true)][string]$Out,
  # 裁剪区域：x,y,w,h（物理像素）。省略则截整屏。
  [string]$Rect = '',
  # 放大倍率，便于逐像素看清小图标
  [double]$Zoom = 1.0
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$root = Split-Path -Parent $PSScriptRoot
$outPath = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path $root $Out }
$outDir = Split-Path -Parent $outPath
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

# 虚拟屏范围：多显示器时也能覆盖
$screen = [System.Windows.Forms.SystemInformation]::VirtualScreen

if ($Rect -eq '') {
  $x = $screen.X; $y = $screen.Y; $w = $screen.Width; $h = $screen.Height
} else {
  $p = $Rect.Split(',')
  $x = [int]$p[0]; $y = [int]$p[1]; $w = [int]$p[2]; $h = [int]$p[3]
}

$src = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($src)
$g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
$g.Dispose()

if ($Zoom -gt 1.01) {
  $zw = [int]($w * $Zoom)
  $zh = [int]($h * $Zoom)
  $big = New-Object System.Drawing.Bitmap($zw, $zh)
  $gb = [System.Drawing.Graphics]::FromImage($big)
  # 最近邻插值：放大后每个原始像素是纯色块，便于辨认图标细节
  $gb.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
  $gb.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
  $gb.DrawImage($src, 0, 0, $zw, $zh)
  $gb.Dispose()
  $big.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $big.Dispose()
} else {
  $src.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
}

$src.Dispose()
Write-Output "saved: $outPath  (${w}x${h} at $x,$y, zoom=$Zoom)"
