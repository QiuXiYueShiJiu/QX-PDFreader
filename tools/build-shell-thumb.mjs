// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 编译资源管理器缩略图提供器（tools/shell-thumb/QXThumb.cs → build/shell-thumb/QXThumb.dll）。
 *
 * 为什么用 .NET Framework 自带的 csc.exe 而不引入 MSVC：
 *   打包机不一定有 Visual Studio 构建链，但 Win10 自带 .NET Framework 4.x，
 *   `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` 一定在。
 *   产物是个普通类库，靠 mscoree.dll 承载，不需要装额外运行时。
 *
 * 没装 .NET 的极端环境（如精简系统）就让这一步失败但不阻塞打包 ——
 * 缩略图是增强功能，缺了它程序照样运行，只是资源管理器显示通用图标。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const SRC = join(ROOT, 'tools', 'shell-thumb', 'QXThumb.cs')
const OUT_DIR = join(ROOT, 'build', 'shell-thumb')
const OUT_DLL = join(OUT_DIR, 'QXThumb.dll')

const CANDIDATES = [
  join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
]

function findCsc() {
  for (const p of CANDIDATES) if (existsSync(p)) return p
  return null
}

const csc = findCsc()
if (!csc) {
  console.warn('[shell-thumb] 找不到 csc.exe（.NET Framework 4.x），跳过缩略图提供器编译')
  console.warn('[shell-thumb] 程序仍可正常打包运行，只是资源管理器不显示 PDF 缩略图')
  process.exit(0)
}

mkdirSync(OUT_DIR, { recursive: true })

try {
  execFileSync(
    csc,
    [
      '/nologo',
      '/target:library',
      '/platform:anycpu',
      '/optimize+',
      '/warnaserror-',
      `/out:${OUT_DLL}`,
      /*
       * Registry 类（Microsoft.Win32.Registry）在 .NET Framework 里就在 mscorlib，
       * 不需要单独 /r 引用 —— 早期这里多写了一行 `/r:Microsoft.Win32.Registry`，
       * csc 直接报 CS0006（那是 .NET Core 的拆分程序集名）。
       */
      '/r:System.dll',
      '/r:System.Drawing.dll',
      SRC,
    ],
    { stdio: 'inherit' }
  )
  console.log('[shell-thumb] 编译完成：', OUT_DLL, statSync(OUT_DLL).size, 'B')
} catch (err) {
  console.error('[shell-thumb] 编译失败：', err?.message ?? err)
  process.exit(1)
}

/* 顺带把 C# 源码也放进产物目录：交付包要能看懂「这个 dll 是怎么来的」 */
copyFileSync(SRC, join(OUT_DIR, 'QXThumb.cs'))
mkdirSync(dirname(OUT_DLL), { recursive: true })
