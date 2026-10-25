// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 整屏截图并裁剪出指定区域。
 *
 * 为什么不用 PrintWindow：
 *   在本机环境下 Add-Type 编译 P/Invoke 代码总是失败
 *   （报「命名空间 System.Drawing 中不存在类型」，实为编译环境限制）。
 *   而整屏 BitBlt + 裁剪完全可行，且目标窗口本来就显示在屏幕上，
 *   直接抓真实像素反而更准确。
 *
 * 缩放说明：
 *   本机 150% 缩放，system 逻辑坐标 2560x1440、物理 3840x2160。
 *   脚本内部先 SetProcessDPIAware，保证坐标与物理像素一致。
 *
 * 用法：
 *   node tools/crop-shot.mjs <x,y,w,h> <out.png>            # 单区域
 *   node tools/crop-shot.mjs --full <out.png>               # 整屏
 *   node tools/crop-shot.mjs --list                         # 列出屏幕尺寸
 */

import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, existsSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const args = process.argv.slice(2)
const isList = args[0] === '--list'
const isFull = args[0] === '--full'

const rect = isList || isFull ? '' : args[0] ?? ''
const outAbs = isList
  ? ''
  : resolve(root, isFull ? args[1] ?? 'shot.png' : args[1] ?? 'shot.png')
if (!isList) mkdirSync(dirname(outAbs), { recursive: true })

const cs = `
using System;
using System.Runtime.InteropServices;

public class Shot {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("user32.dll")] static extern bool BitBlt(IntPtr d, int x, int y, int w, int h, IntPtr s, int sx, int sy, int rop);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr hdc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int w, int h);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);

  static Shot() { SetProcessDPIAware(); }

  public static int ScreenW() { return GetSystemMetrics(0); }
  public static int ScreenH() { return GetSystemMetrics(1); }

  /** 抓整屏到内存位图，返回句柄信息供后续裁剪 */
  static IntPtr Grab(int x, int y, int w, int h, out IntPtr mem, out IntPtr bmp, out IntPtr hdc) {
    hdc = GetDC(IntPtr.Zero);
    mem = CreateCompatibleDC(hdc);
    bmp = CreateCompatibleBitmap(hdc, w, h);
    SelectObject(mem, bmp);
    BitBlt(mem, 0, 0, w, h, hdc, x, y, 0x00CC0020);
    return bmp;
  }

  static void Cleanup(IntPtr mem, IntPtr bmp, IntPtr hdc) {
    DeleteObject(bmp);
    DeleteDC(mem);
    ReleaseDC(IntPtr.Zero, hdc);
  }

  public static void CaptureRect(int x, int y, int w, int h, string path) {
    IntPtr mem, bmp, hdc;
    Grab(x, y, w, h, out mem, out bmp, out hdc);
    using (var img = System.Drawing.Bitmap.FromHbitmap(bmp)) {
      img.Save(path, System.Drawing.Imaging.ImageFormat.Png);
    }
    Cleanup(mem, bmp, hdc);
  }

  /** 整屏截图并放大指定倍率，便于逐像素看清小图标 */
  public static void CaptureFull(string path, float zoom) {
    int w = ScreenW(), h = ScreenH();
    IntPtr mem, bmp, hdc;
    Grab(0, 0, w, h, out mem, out bmp, out hdc);

    using (var src = System.Drawing.Bitmap.FromHbitmap(bmp)) {
      if (zoom > 1.01f) {
        int zw = (int)(w * zoom), zh = (int)(h * zoom);
        using (var big = new System.Drawing.Bitmap(zw, zh))
        using (var g = System.Drawing.Graphics.FromImage(big)) {
          g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.NearestNeighbor;
          g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.Half;
          g.DrawImage(src, 0, 0, zw, zh);
          big.Save(path, System.Drawing.Imaging.ImageFormat.Png);
        }
      } else {
        src.Save(path, System.Drawing.Imaging.ImageFormat.Png);
      }
    }
    Cleanup(mem, bmp, hdc);
  }

  /** 整屏截图后裁出区域，并可按倍率放大 */
  public static void CaptureFullThenCrop(string path, int cx, int cy, int cw, int ch, float zoom) {
    int w = ScreenW(), h = ScreenH();
    IntPtr mem, bmp, hdc;
    Grab(0, 0, w, h, out mem, out bmp, out hdc);

    using (var src = System.Drawing.Bitmap.FromHbitmap(bmp)) {
      var rect = new System.Drawing.Rectangle(cx, cy, cw, ch);
      using (var crop = new System.Drawing.Bitmap(cw, ch))
      using (var gc = System.Drawing.Graphics.FromImage(crop)) {
        gc.DrawImage(src, new System.Drawing.Rectangle(0, 0, cw, ch), rect, System.Drawing.GraphicsUnit.Pixel);

        if (zoom > 1.01f) {
          int zw = (int)(cw * zoom), zh = (int)(ch * zoom);
          using (var big = new System.Drawing.Bitmap(zw, zh))
          using (var g = System.Drawing.Graphics.FromImage(big)) {
            g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.NearestNeighbor;
            g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.Half;
            g.DrawImage(crop, 0, 0, zw, zh);
            big.Save(path, System.Drawing.Imaging.ImageFormat.Png);
          }
        } else {
          crop.Save(path, System.Drawing.Imaging.ImageFormat.Png);
        }
      }
    }
    Cleanup(mem, bmp, hdc);
  }
}
`

const zoom = Number(args.find((a) => a.startsWith('--zoom='))?.split('=')[1] ?? '1')

const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
${cs}
'@

${isList ? `Write-Output ("screen=" + [Shot]::ScreenW() + "x" + [Shot]::ScreenH())` : ''}
${!isList && isFull ? `[Shot]::CaptureFull('${outAbs}', ${zoom}f); Write-Output 'full-captured'` : ''}
${!isList && !isFull ? `$p = '${rect}'.Split(','); [Shot]::CaptureFullThenCrop('${outAbs}', [int]$p[0], [int]$p[1], [int]$p[2], [int]$p[3], ${zoom}f); Write-Output 'cropped'` : ''}
`

const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
  windowsHide: true,
  encoding: 'utf8'
})

console.log((r.stdout || '').trim() || '(无输出)')
if (r.stderr) console.error(r.stderr.slice(0, 600))
if (!isList && existsSync(outAbs)) console.log('saved: ' + outAbs)
