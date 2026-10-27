// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 资源管理器缩略图缓存（与 shell 缩略图提供器共用的约定）。
 *
 * 为什么缓存放在 `%LOCALAPPDATA%\QiuxiPdfThumbs` 而不是 userData：
 *   shell 缩略图提供器（QXThumb.dll）跑在 explorer.exe 里，
 *   它不知道 Electron 的 userData 目录（那是 `%APPDATA%\秋夕月拾旧-PDF阅读器`，
 *   还带中文），但两者都能直接算出 `%LOCALAPPDATA%`。
 *   共用同一个目录，提供器就能「有缓存就直接返回、没有才唤起本程序渲染」。
 *
 * 缓存键 = SHA1(小写化的绝对路径) 前 24 位。
 *   ★ 为什么不用「路径+mtime+大小」做键：C# 侧要算出**完全一致**的 mtime 表示
 *   （FILETIME 100ns vs JS 毫秒）很容易错位，一旦错位就永远命中不了。
 *   改为「键只认路径，新鲜度看时间戳」：
 *     PNG 的 mtime ≥ PDF 的 mtime - 1s → 视为新鲜。
 *   两侧都只需要 stat，不需要格式化时间。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join, normalize } from 'node:path'

/** 缓存目录名（提供器里硬编码同一个名字，改这里要同步改 cs） */
const CACHE_DIR_NAME = 'QiuxiPdfThumbs'

export function thumbRoot(): string {
  /*
   * Windows 用 %LOCALAPPDATA%（提供器里硬编码了同一套推导，改这里要同步改 C++）。
   * Linux 上没有 LOCALAPPDATA，按 XDG 走 ~/.cache；两边只是缓存目录，丢了会自动重建。
   */
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA ??
        process.env.APPDATA ??
        process.env.USERPROFILE ??
        process.cwd()
      : process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? process.cwd(), '.cache')
  return join(base, CACHE_DIR_NAME)
}

/** 缓存键：小写化 + 反斜杠统一的绝对路径 → SHA1 前 24 位十六进制 */
export function thumbKey(filePath: string): string {
  const normalized = normalize(filePath).replace(/\//g, '\\').toLowerCase()
  return createHash('sha1').update(normalized, 'utf8').digest('hex').slice(0, 24)
}

export function thumbPath(filePath: string): string {
  return join(thumbRoot(), `${thumbKey(filePath)}.png`)
}

/** PNG 是否比源文件新（留 1s 余量，避免同秒写入判旧） */
export function isThumbFresh(pngPath: string, sourcePath: string): boolean {
  try {
    if (!existsSync(pngPath)) return false
    const png = statSync(pngPath).mtimeMs
    const src = statSync(sourcePath).mtimeMs
    return png + 1000 >= src
  } catch {
    return false
  }
}

/**
 * 把渲染层的 dataURL 落成缓存 PNG。
 * 返回写好的绝对路径；失败返回 null（缩略图只是「锦上添花」，不能影响主流程）。
 */
export function saveThumb(filePath: string, dataUrl: string): string | null {
  try {
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim())
    if (!match) return null
    const buf = Buffer.from(match[1], 'base64')
    if (buf.length < 64) return null
    const dir = thumbRoot()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const out = thumbPath(filePath)
    writeFileSync(out, buf)
    // 把 mtime 显式顶到「现在」，保证比刚打开的文件新
    const now = new Date()
    utimesSync(out, now, now)
    return out
  } catch {
    return null
  }
}
