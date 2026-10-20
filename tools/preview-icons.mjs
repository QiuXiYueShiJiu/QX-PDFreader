// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 图标预览生成器。
 *
 * 为什么要自己解析 ICO：
 *   System.Drawing 的 Icon 类对「PNG 压缩的 ICO」支持不好，
 *   `new Icon(path, w, h)` 会抛 ArgumentOutOfRangeException
 *   （那个构造只认老的 256 色位图格式）。
 *   而我们的 ICO 全部用 PNG 存储以保证画质，因此直接按 ICO 目录结构
 *   把 PNG 数据抠出来 —— 格式简单（6 字节头 + 每张 16 字节目录项），
 *   比绕开 System.Drawing 的限制省事得多。
 *
 * 输出：test-results/ICON-PREVIEW.png（横向排列各尺寸，底部对齐便于对比）
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outDir = join(root, 'test-results')
mkdirSync(outDir, { recursive: true })

/**
 * 解析 ICO，返回 [{size, png}]。
 * ICO 结构：6 字节头 + N×16 字节目录 + 数据区。
 */
function parseIco(path) {
  const buf = readFileSync(path)
  const count = buf.readUInt16LE(4)
  const entries = []

  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16
    // 宽高存 1 字节，0 表示 256
    const w = buf[off] === 0 ? 256 : buf[off]
    const size = buf.readUInt32LE(off + 8)
    const dataOff = buf.readUInt32LE(off + 12)
    entries.push({ size: w, png: buf.subarray(dataOff, dataOff + size) })
  }

  // 按尺寸从大到小排，预览时从大到小展示
  return entries.sort((a, b) => b.size - a.size)
}

/** 把各尺寸拼成一张预览图（用 .NET 合成，避免引图像库） */
function compose(iconPath, label, outPath) {
  const entries = parseIco(iconPath)
  const dir = join(outDir, 'ico-tmp')
  mkdirSync(dir, { recursive: true })

  // 先把 PNG 各存一份，交给 PowerShell 合成
  const files = []
  for (const e of entries) {
    const p = join(dir, `s${e.size}.png`)
    writeFileSync(p, e.png)
    files.push({ size: e.size, path: p })
  }

  const showSizes = [256, 128, 64, 48, 32, 24, 16].filter((s) => files.some((f) => f.size === s))

  // 用 PowerShell + System.Drawing 合成（它读 PNG 没问题，问题只在 ICO）
  const ps = `
Add-Type -AssemblyName System.Drawing
$canvas = New-Object System.Drawing.Bitmap(660, 320)
$g = [System.Drawing.Graphics]::FromImage($canvas)
$g.Clear([System.Drawing.Color]::FromArgb(248,249,252))
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
$tf = New-Object System.Drawing.Font('Microsoft YaHei UI', 11, [System.Drawing.FontStyle]::Bold)
$sf = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$dark = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(30,34,44))
$muted = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(120,130,148))
$g.DrawString('${label}', $tf, $dark, 20, 14)
$x = 24
${showSizes
  .map(
    (s) => `
$img = [System.Drawing.Image]::FromFile('${join(dir, `s${s}.png`).replace(/\\/g, '\\\\')}')
$y = 60 + (256 - ${s})
$g.DrawImage($img, $x, $y, ${s}, ${s})
$sz = $g.MeasureString('${s}', $sf)
$g.DrawString('${s}', $sf, $muted, ($x + ${s}/2 - $sz.Width/2), 60 + 264)
$x += ${s} + 16
$img.Dispose()`
  )
  .join('\n')}
$g.Dispose()
$canvas.Save('${outPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
$canvas.Dispose()
`
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    windowsHide: true,
    encoding: 'utf8'
  })
  if (r.status !== 0) {
    console.error('合成失败:', r.stderr?.slice(0, 400))
    return null
  }
  return outPath
}

const result = compose(join(root, 'build', 'icon.ico'), '应用图标  深红底 + 白纸 + 大 P 小 df', join(outDir, 'ICON-PREVIEW.png'))
console.log(result ? `预览已生成: ${result}` : '预览生成失败')
