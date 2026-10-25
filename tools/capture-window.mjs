// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 抓取窗口或屏幕区域的截图（第三方软件界面研究用）。
 *
 * 关键点：优先用 PrintWindow 而不是 BitBlt。
 *   BitBlt 只能抓「当前活动桌面上真实可见」的像素，
 *   窗口被遮挡时会抓到黑块；
 *   PrintWindow 让目标窗口自己把内容重绘到我们的 DC 上，
 *   即使被遮挡也能取到正确内容。
 *
 * C# 侧注意（踩过的坑）：
 *   · 不要 `using System.Drawing;`，类名与 System.Drawing 里的类型撞名时，
 *     编译器会报「命名空间 System.Drawing 中不存在类型」这种误导性错误
 *   · 一律用全限定名 System.Drawing.Image / System.Drawing.Imaging.ImageFormat
 *
 * 用法：
 *   node tools/capture-window.mjs --rect <x,y,w,h> --out <file.png>
 *   node tools/capture-window.mjs --title <关键字> --out <file.png>
 */

import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const argv = process.argv.slice(2)
function opt(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const rect = opt('rect', '')
const title = opt('title', '')
const outAbs = resolve(root, opt('out', 'test-results/capture.png'))
mkdirSync(dirname(outAbs), { recursive: true })
// PowerShell 单引号字符串里反斜杠无需转义，直接给绝对路径
const outArg = outAbs

const cs = `
using System;
using System.Runtime.InteropServices;
using System.Text;

public class ScreenCapture {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  delegate bool EnumProc(IntPtr h, IntPtr l);

  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("user32.dll")] static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, int rop);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr hdc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int w, int h);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);

  static ScreenCapture() { SetProcessDPIAware(); }

  public static IntPtr FindByTitle(string key) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      var t = new StringBuilder(256);
      GetWindowTextW(h, t, 256);
      if (t.ToString().IndexOf(key, StringComparison.OrdinalIgnoreCase) >= 0) {
        RECT r; GetWindowRect(h, out r);
        if ((r.R - r.L) > 40 && (r.B - r.T) > 40) { found = h; return false; }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static bool CaptureWindow(IntPtr h, string path) {
    RECT r; GetWindowRect(h, out r);
    int w = r.R - r.L, hh = r.B - r.T;
    if (w <= 0 || hh <= 0) return false;

    IntPtr hdc = GetDC(IntPtr.Zero);
    IntPtr mem = CreateCompatibleDC(hdc);
    IntPtr bmp = CreateCompatibleBitmap(hdc, w, hh);
    IntPtr old = SelectObject(mem, bmp);

    // PW_RENDERFULLCONTENT = 2，能抓到 DirectComposition 合成的内容
    bool ok = PrintWindow(h, mem, 2);
    if (!ok) ok = PrintWindow(h, mem, 0);

    if (ok) {
      using (var img = System.Drawing.Image.FromHbitmap(bmp)) {
        img.Save(path, System.Drawing.Imaging.ImageFormat.Png);
      }
    }

    SelectObject(mem, old);
    DeleteObject(bmp);
    DeleteDC(mem);
    ReleaseDC(IntPtr.Zero, hdc);
    return ok;
  }

  public static void CaptureRect(int x, int y, int w, int hh, string path) {
    IntPtr hdc = GetDC(IntPtr.Zero);
    IntPtr mem = CreateCompatibleDC(hdc);
    IntPtr bmp = CreateCompatibleBitmap(hdc, w, hh);
    IntPtr old = SelectObject(mem, bmp);
    BitBlt(mem, 0, 0, w, hh, hdc, x, y, 0x00CC0020);   // SRCCOPY
    using (var img = System.Drawing.Image.FromHbitmap(bmp)) {
      img.Save(path, System.Drawing.Imaging.ImageFormat.Png);
    }
    SelectObject(mem, old);
    DeleteObject(bmp);
    DeleteDC(mem);
    ReleaseDC(IntPtr.Zero, hdc);
  }
}
`

const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
${cs}
'@

if ('${rect}' -ne '') {
  $parts = '${rect}'.Split(',')
  [ScreenCapture]::CaptureRect([int]$parts[0], [int]$parts[1], [int]$parts[2], [int]$parts[3], '${outArg}')
  Write-Output 'rect-captured'
} else {
  $h = [ScreenCapture]::FindByTitle('${title}')
  if ($h -eq [IntPtr]::Zero) { Write-Output 'NOT_FOUND'; exit 1 }
  $ok = [ScreenCapture]::CaptureWindow($h, '${outArg}')
  Write-Output ('PrintWindow=' + $ok)
}
`

const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
  windowsHide: true,
  encoding: 'utf8'
})

console.log((r.stdout || '').trim() || '(无输出)')
if (r.stderr) console.error(r.stderr.slice(0, 600))
