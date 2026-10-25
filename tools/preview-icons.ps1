# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
# Copyright 2026 秋夕月拾旧

﻿# 生成图标预览图（把 ICO 的各个尺寸拼到一张 PNG 上）
#
# 用途：设计图标时需要直观对比不同尺寸下的清晰度。
# 这个脚本只用于开发查看，不参与打包。

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $root 'test-results'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$canvas = New-Object System.Drawing.Bitmap(640, 340)
$g = [System.Drawing.Graphics]::FromImage($canvas)
$g.Clear([System.Drawing.Color]::FromArgb(248, 249, 252))
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

$titleFont = New-Object System.Drawing.Font('Microsoft YaHei UI', 11, [System.Drawing.FontStyle]::Bold)
$smallFont = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$dark = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(30, 34, 44))
$muted = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(120, 130, 148))

# 要在预览里展示的尺寸
$showSizes = @(256, 128, 64, 48, 32, 24, 16)

$rowY = 40
foreach ($item in @(
    @{ File = 'build\icon.ico'; Label = '应用图标（深红底 + 白纸 + 大 P 小 df）' },
    @{ File = 'build\pdf-file.ico'; Label = 'PDF 文件图标（资源管理器中 .pdf 显示这个）' }
)) {
    $icoPath = Join-Path $root $item.File
    if (-not (Test-Path $icoPath)) { Write-Host "跳过 $($item.File)（不存在）"; continue }

    $g.DrawString($item.Label, $titleFont, $dark, 20, ($rowY - 24))

    $x = 24
    foreach ($size in $showSizes) {
        # 从 ICO 里取出指定尺寸（Icon 构造会挑最接近的）
        $ico = New-Object System.Drawing.Icon($icoPath, $size, $size)
        $bmp = $ico.ToBitmap()

        # 底部对齐，便于观察不同尺寸的视觉重量是否一致
        $y = $rowY + (256 - $size)
        $g.DrawImage($bmp, $x, $y, $size, $size)

        $label = "$size"
        $sz = $g.MeasureString($label, $smallFont)
        $g.DrawString($label, $smallFont, $muted, ($x + $size / 2 - $sz.Width / 2), ($rowY + 262))

        $x += $size + 16
        $bmp.Dispose()
        $ico.Dispose()
    }

    $rowY += 320
}

$g.Dispose()
$outFile = Join-Path $outDir 'ICON-PREVIEW.png'
$canvas.Save($outFile, [System.Drawing.Imaging.ImageFormat]::Png)
$canvas.Dispose()

Write-Host "预览已生成: $outFile"
