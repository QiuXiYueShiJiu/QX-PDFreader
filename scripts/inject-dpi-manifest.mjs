// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * Windows 清单（manifest）处理 —— **自 2026-10-16 起不再改写**。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 一、这个文件曾经做什么
 * ══════════════════════════════════════════════════════════════════════
 * 2026-10-15：electron.exe 内嵌清单当时只声明 `<dpiAware>true/pm</dpiAware>`，
 * 用户报「窗口几何/DOM 都对，但内容不被合成到屏幕上、全屏只占一部分」。
 * 因为内嵌清单优先于 AppCompatFlags 注册表，只能改清单，于是有了本脚本：
 * 定位 PE 资源里的 RT_MANIFEST，用**同长度**的新清单原地覆盖。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 二、为什么现在必须停掉（v2.0.0.0 交付后的头号缺陷）
 * ══════════════════════════════════════════════════════════════════════
 * 用户报：「**现在退出窗口不能正常弹出**」。
 *
 * 【症状】点右栏「退出应用」→ 没有确认框，进程直接 APPCRASH，
 *   主窗口一起消失，任务栏里残留一个空白小窗。
 *   Windows 事件日志 Application Error 1000：
 *     异常代码 0x80000003（STATUS_BREAKPOINT），
 *     偏移固定 0x639afd5，故障模块就是应用自己的 exe；
 *   C:\ProgramData\Microsoft\Windows\WER\ReportArchive 下有
 *   AppCrash_秋夕-PDF阅读器.exe_* 一组报告（可用
 *   `Get-WinEvent -FilterHashtable @{LogName='Application';ProviderName='Application Error'}`
 *   复现取证）。
 *
 * 【定位：等长替换清单里的一个值，其余字节完全相同】
 *   工具：tools/_mk-dpi-variants.mjs（造变体）、
 *         tools/_diag-min-electron.mjs（最小 Electron 应用里点原生框）、
 *         tools/_budget-manifest.mjs（量清单槽位预算）。
 *   同一份 electron 33.4.11，结果：
 *
 *     | 清单里有没有 <dpiAwareness> | dialog.showMessageBox |
 *     |---|---|
 *     | 没有（electron 原始清单）    | ✅ 正常弹出 |
 *     | PerMonitorV2                | ❌ 进程崩溃 |
 *     | System                      | ❌ 进程崩溃 |
 *     | Bogus（完全无效的值）        | ❌ 进程崩溃 |
 *
 *   ⇒ **只要清单里出现元素 `<dpiAwareness>`，任何原生对话框都会把进程打崩，
 *      与取值无关。** dialog.showOpenDialog / showSaveDialog 同样中招。
 *
 * 【第二个坑：Common-Controls 依赖是必需的】
 *   electron 原始清单里有
 *     `<dependency>` → `Microsoft.Windows.Common-Controls 6.0.0.0`
 *   把它挖掉，exe 直接起不来（side-by-side configuration is incorrect）。
 *   而 2026-10-15 那版自己写的清单里**根本没有这一段**。
 *
 * 【第三个坑：槽位根本不够】
 *   electron 原始清单正好占满 PE 里的 644 字节槽位（`</assembly>` 之后
 *   紧接 0x00，两处一律没有填充）。所以：
 *     · 「在原始清单上追加 longPathAware」→ 放不下；
 *     · 「自己写一份 含 Common-Controls 依赖 + longPathAware 的清单」
 *       → 最少 1014 字节，放不下；
 *     · 硬写到 644 字节之后 → 越过槽位，exe 报 SxS 错误起不来（实测）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 三、现在的做法
 * ══════════════════════════════════════════════════════════════════════
 * **一个字节都不改**，直接用 electron 自带清单：
 *   · 它已经有 `<dpiAware>true/pm</dpiAware>`（两代写法里的 SMI/2005 那份），
 *     进程本来就是 DPI aware，不会被位图拉伸；
 *   · PerMonitorV2 这类每显示器感知由 Chromium 在启动时自己调
 *     `SetProcessDpiAwarenessContext()` 完成，不依赖清单声明；
 *   · 「内容不被合成到屏幕上」那个原始问题的根因是当时**清单里连
 *     dpiAware 都没有**，保留 electron 原始的 dpiAware 即可（见
 *     docs/待办-2026-10-15.md 的「附：本版本已修完的问题」）。
 *
 * 代价：暂时没有 `longPathAware`（>260 字符路径）。
 * 若将来确实需要，**不要再走清单这条路**，可选：
 *   ① 在文件读写处统一加 `\\?\` 前缀（Node 侧可控）；
 *   ② 换用清单槽位更大的壳（例如自己写的 launcher exe 作为入口）。
 *
 * 逃生舱：`QX_FORCE_DPI_MANIFEST=1` 会恢复「在原始清单上追加
 * longPathAware」的行为（**永远不会再写 dpiAwareness**）。
 * 真要用，务必补跑 tools/verify-quit-dialog.mjs、tools/verify-export-ipc.mjs、
 * tools/verify-tabs.mjs —— 它们会真的走原生框。
 *
 * 用法：
 *   node scripts/inject-dpi-manifest.mjs                     # 默认：只体检、不改
 *   node scripts/inject-dpi-manifest.mjs <exe路径> [更多...]
 */

import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')

/** 逃生舱：只有显式设了它才真的改清单 */
const FORCE = process.env.QX_FORCE_DPI_MANIFEST === '1'

/** 唯一允许追加的片段；`<dpiAwareness>` 永远不写 */
const ADDITIONS =
  '<longPathAware xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">true</longPathAware>'

/** 在字节流里定位内嵌清单（从后往前找，要求落在文件最后 1.1 MB 内） */
function locateManifest(buffer) {
  const END = '</assembly>'
  const endAt = buffer.lastIndexOf(END, undefined, 'utf8')
  if (endAt < 0 || endAt < buffer.length - 1100000) return null

  // ★ `<assembly ` 带空格：不带空格会命中 `</assembly>` 里的同名子串
  //   （'</assembly>' 的第 1 个字符就是 '<'），startAt 会落到结束标签上，
  //   算出来的可用空间全是错的。踩过。
  const startAt = buffer.lastIndexOf('<assembly ', endAt, 'utf8')
  if (startAt < 0) return null

  let from = startAt
  const declAt = buffer.lastIndexOf('<?xml', startAt, 'utf8')
  if (declAt >= 0 && startAt - declAt < 200) from = declAt

  const dataEnd = endAt + END.length
  let usableEnd = dataEnd
  while (usableEnd < buffer.length && (buffer[usableEnd] === 0x00 || buffer[usableEnd] === 0x20)) {
    usableEnd += 1
  }

  return { from, endAt, dataEnd, usableEnd, size: dataEnd - from, room: usableEnd - from }
}

/**
 * 体检：报告某个 exe 的清单状态。
 *
 * `danger` 为 true 表示清单里有 `<dpiAwareness>` —— 这个产物**一定会**
 * 在任何原生对话框上崩溃，必须重新打包。
 */
export function inspectManifest(exePath) {
  const buffer = readFileSync(exePath)
  const text = buffer.toString('latin1')
  const loc = locateManifest(buffer)
  return {
    path: exePath,
    size: buffer.length,
    slot: loc ? loc.size : null,
    room: loc ? loc.room : null,
    hasDpiAware: text.includes('<dpiAware'),
    hasDpiAwareness: text.includes('<dpiAwareness'),
    hasDpiAwarenessValueNamespace: text.includes('SMI/2016/WindowsSettings'),
    hasCommonControls: text.includes('Microsoft.Windows.Common-Controls'),
    hasLongPathAware: text.includes('longPathAware'),
    /** ★ 关键判据：有了它，原生对话框必崩 */
    danger: text.includes('<dpiAwareness')
  }
}

/**
 * 对单个文件打补丁。
 *
 * 默认**什么都不做**，只把「为什么」写进返回值里 —— 这不是省事，
 * 而是上面那一串实测得出的结论。
 */
export function patchExecutable(exePath) {
  const info = inspectManifest(exePath)

  if (!FORCE) {
    return {
      patched: false,
      skipped: true,
      info,
      reason:
        '默认不改写清单：注入 <dpiAwareness> 会让所有原生对话框把进程打崩（见本文件头部）'
    }
  }

  const buffer = readFileSync(exePath)
  if (buffer.readUInt16LE(0) !== 0x5a4d) throw new Error('不是有效的 PE 文件（缺少 MZ 头）')
  if (info.hasLongPathAware) {
    return { patched: false, skipped: true, info, reason: '已包含 longPathAware，无需重复注入' }
  }

  const loc = locateManifest(buffer)
  if (!loc) throw new Error('未找到内嵌清单，无法原地替换')

  const add = Buffer.from(ADDITIONS, 'utf8')
  const kept = buffer.subarray(loc.from, loc.endAt)
  const closing = buffer.subarray(loc.endAt, loc.dataEnd)
  const need = kept.length + add.length + closing.length
  if (need > loc.room) {
    // electron 原始清单正好占满槽位，正常都会走到这里
    throw new Error(
      `清单槽位只有 ${loc.room} 字节，追加后需要 ${need} 字节，放不下（这就是默认不改的原因之一）`
    )
  }

  const out = Buffer.alloc(loc.room, 0x20)
  let at = 0
  kept.copy(out, at)
  at += kept.length
  add.copy(out, at)
  closing.copy(out, at)
  out.copy(buffer, loc.from)
  writeFileSync(exePath, buffer)

  return {
    patched: true,
    info: inspectManifest(exePath),
    offset: loc.from,
    room: loc.room,
    kept: kept.length,
    added: add.length,
    size: statSync(exePath).size
  }
}

function defaultTargets() {
  const candidate = join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  try {
    readFileSync(candidate)
    return [candidate]
  } catch {
    return []
  }
}

// ★ 必须先判断「本模块是否被直接执行」再跑 CLI（after-pack.mjs 会 import 本模块）
const invokedDirectly =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  const args = process.argv.slice(2)
  const targets = args.length > 0 ? args : defaultTargets()

  if (targets.length === 0) {
    console.error('未指定目标，且找不到 node_modules/electron/dist/electron.exe')
    process.exit(1)
  }

  let failed = 0
  for (const target of targets) {
    try {
      const info = inspectManifest(target)
      console.log(
        `  [manifest] ${target}\n` +
          `    清单 ${info.size} 字节 / 槽位 ${info.slot} 字节（可用 ${info.room}）；` +
          `dpiAware=${info.hasDpiAware} dpiAwareness=${info.hasDpiAwareness} ` +
          `Common-Controls=${info.hasCommonControls} longPathAware=${info.hasLongPathAware}`
      )
      if (info.danger) {
        console.error(
          '    ★★ 警告：这份产物含 <dpiAwareness>，任何原生对话框（退出确认 / 打开 / 另存为）都会让它崩溃！'
        )
        failed += 1
        continue
      }
      const r = patchExecutable(target)
      console.log(r.patched ? `    已写入 longPathAware（偏移 ${r.offset}）` : `    跳过：${r.reason}`)
    } catch (error) {
      failed += 1
      console.error(`  [manifest] ${target} 失败：${error instanceof Error ? error.message : error}`)
    }
  }

  process.exit(failed > 0 ? 1 : 0)
}
