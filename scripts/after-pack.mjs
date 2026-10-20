// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * electron-builder 的 afterPack 钩子。
 *
 * 做三件事（都必须在这个阶段做，因为 electron-builder 会覆盖原始 electron.exe）：
 *
 *   ① 清单体检（**只读，不改写**）
 *      曾经这里会注入一份自己写的 DPI 清单（含 `PerMonitorV2`）。
 *      2026-10-16 查实：只要清单里出现 `<dpiAwareness>`，
 *      **所有 Windows 原生对话框都会把进程打崩**
 *      （异常码 0x80000003，用户看到的就是「退出窗口不能正常弹出」）。
 *      现在改为直接沿用 electron 自带清单，只在这里做一次断言：
 *      产物里**不允许**出现 `<dpiAwareness>`，出现就报错终止打包。
 *      详见 scripts/inject-dpi-manifest.mjs 头部。
 *
 *   ② 改写 exe 图标
 *      打包配置里关掉了 electron-builder 的 signAndEditExecutable
 *      （它依赖 winCodeSign 解包，本机因符号链接权限会失败），
 *      因此图标要在这里自己用 resedit 写进去，否则可执行文件仍是
 *      Electron 的默认图标，任务栏与资源管理器里都显示不对。
 *
 *   ③ 写入版本信息（同上，signAndEditExecutable 关了就得自己写）
 */

import { join, resolve, dirname } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { inspectManifest } from './inject-dpi-manifest.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')
const require = createRequire(import.meta.url)

/**
 * 用 resedit 把 ico 写进 exe。
 *
 * 正确用法（查了 resedit 的类型定义后确认）：
 *   · 文件读取用 Node 的 readFileSync —— resedit 的 Data 只是命名空间，
 *     没有 readFileSync，之前误用它导致「图标跳过」
 *   · Data.IconFile.from(buffer) 解析 ICO，取 .icons 得到 IconItem 数组
 *   · Resource.IconGroupEntry.replaceIconsForResource(entries, id, lang, icons)
 *     会同时处理 RT_GROUP_ICON 与 RT_ICON 两组资源，不用手工算 ID
 */
function applyIcon(exePath, icoPath) {
  if (!existsSync(icoPath)) {
    return { ok: false, reason: `图标文件不存在：${icoPath}` }
  }

  let ResEdit
  try {
    // resedit 是 electron-builder 的传递依赖，通常已在 node_modules 里
    ResEdit = require('resedit')
  } catch {
    return { ok: false, reason: '未找到 resedit 模块' }
  }

  const { NtExecutable, NtExecutableResource, Data, Resource } = ResEdit

  // ① 读 exe 与 ico（都用 Node 原生读取）
  const exeBuffer = readFileSync(exePath)
  const icoBuffer = readFileSync(icoPath)

  // ② 解析 ICO
  const iconFile = Data.IconFile.from(icoBuffer)
  const iconItems = iconFile.icons.map((item) => item.data)

  if (iconItems.length === 0) {
    return { ok: false, reason: 'ICO 里没有可用图标' }
  }

  // ③ 打开 exe 的资源节
  const exe = NtExecutable.from(exeBuffer, { ignoreCert: true })
  const res = NtExecutableResource.from(exe)

  /*
   * ④ 替换图标组。
   *   id = 1 是主图标组（Windows 默认从最小的 ID 取应用图标），
   *   lang = 1033（en-US）与 electron 自带资源一致，避免出现重复组。
   */
  Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, iconItems)

  // ⑤ 写回资源并生成新文件
  res.outputResource(exe)
  writeFileSync(exePath, Buffer.from(exe.generate()))

  return { ok: true, count: iconItems.length }
}

/**
 * 用 resedit 写入版本信息。
 *
 * ── 为什么需要这一步 ────────────────────────────────────────
 *   打包配置里关掉了 signAndEditExecutable（它依赖 winCodeSign 解包，
 *   本机因符号链接权限会失败），代价是 electron-builder **也不会**
 *   写 exe 的版本资源 —— 于是文件属性里显示的是 Electron 自己的
 *   版本号（33.4.11），而不是本应用的版本。
 *
 * ── 两个踩过的坑 ────────────────────────────────────────────
 *   ① **必须先把旧版本资源全删掉**。
 *      electron.exe 自带一个版本资源（lang=1033，值是 Electron 的版本）。
 *      只调 outputToResourceEntries 是「再插一个」而不是「替换」，
 *      结果 exe 里有两条版本资源 —— Windows 读第一条，
 *      属性页显示空白或错误信息。
 *
 *   ② **语言要统一**。
 *      createEmpty() 的默认语言是中性 0，而 Electron 的资源是 1033。
 *      两边混用会把字符串表拆成两组，某些字段读不到。
 *      这里统一用 0（中性），并显式声明可用语言。
 *
 * @param version 四段式版本号，如 1.0.0.2
 */
function applyVersionInfo(exePath, version, productName) {
  let ResEdit
  try {
    ResEdit = require('resedit')
  } catch {
    return { ok: false, reason: '未找到 resedit 模块' }
  }

  const { NtExecutable, NtExecutableResource, Resource } = ResEdit

  /* 版本号必须四段数字；缺段补 0，避免 resedit 因格式不对抛错 */
  const parts = String(version)
    .split('.')
    .map((n) => parseInt(n, 10) || 0)
  while (parts.length < 4) parts.push(0)
  const verStr = parts.join('.')

  const exeBuffer = readFileSync(exePath)
  const exe = NtExecutable.from(exeBuffer, { ignoreCert: true })
  const res = NtExecutableResource.from(exe)

  /* ---------- ① 删掉所有已存在的版本资源（坑 ①）---------- */
  const RT_VERSION = 16
  const kept = res.entries.filter((e) => e.type !== RT_VERSION)
  const removed = res.entries.length - kept.length
  res.entries.length = 0
  res.entries.push(...kept)

  /* ---------- ② 写入唯一一份完整的版本信息 ---------- */
  const NEUTRAL = { lang: 0, codepage: 1200 } // 语言中性 + Unicode

  const vi = Resource.VersionInfo.createEmpty()
  vi.setFileVersion(...parts.slice(0, 4))
  vi.setProductVersion(...parts.slice(0, 4))
  vi.setStringValues(NEUTRAL, {
    ProductName: productName,
    FileDescription: productName,
    FileVersion: verStr,
    ProductVersion: verStr,
    OriginalFilename: `${productName}.exe`,
    CompanyName: '秋夕月拾旧',
    LegalCopyright: `Copyright (C) 2026 秋夕月拾旧`
  })
  // 声明可用语言，与字符串表保持一致（坑 ②）
  vi.replaceAvailableLanguages([NEUTRAL])
  vi.outputToResourceEntries(res.entries)

  res.outputResource(exe)
  writeFileSync(exePath, Buffer.from(exe.generate()))

  return { ok: true, version: verStr, removed }
}

export default async function afterPack(context) {
  const { appOutDir, packager } = context
  const productName = packager.appInfo.productFilename
  const exePath = join(appOutDir, `${productName}.exe`)

  if (!existsSync(exePath)) {
    console.warn(`  [after-pack] 未找到 ${exePath}，跳过后续处理`)
    return
  }

  /* ---------- ① 图标 ---------- */
  try {
    const r = applyIcon(exePath, join(projectRoot, 'build', 'icon.ico'))
    console.log(
      r.ok
        ? `  [after-pack] 已写入应用图标（${r.count} 个尺寸）：${productName}.exe`
        : `  [after-pack] 图标跳过：${r.reason}`
    )
  } catch (error) {
    // 图标失败不阻断打包 —— 应用照常能跑，只是显示默认图标
    console.warn(
      `  [after-pack] 图标写入失败：${error instanceof Error ? error.message : error}`
    )
  }

  /* ---------- ② 清单体检：绝不允许把 <dpiAwareness> 带进产物 ---------- */
  try {
    const info = inspectManifest(exePath)
    console.log(
      `  [after-pack] 清单体检：${info.slot} 字节槽位；` +
        `dpiAware=${info.hasDpiAware} dpiAwareness=${info.hasDpiAwareness} ` +
        `Common-Controls=${info.hasCommonControls} longPathAware=${info.hasLongPathAware}`
    )
    if (info.danger) {
      throw new Error(
        `${productName}.exe 的清单里含 <dpiAwareness> —— 这会让所有原生对话框把进程打崩` +
          `（用户报的「退出窗口不能正常弹出」就是它）。请确认 scripts/inject-dpi-manifest.mjs 没被改回去。`
      )
    }
    if (!info.hasDpiAware) {
      console.warn(
        '  [after-pack] ⚠ 清单里没有 <dpiAware>：进程不是 DPI aware，' +
          '可能出现「内容不被合成到屏幕上 / 全屏只占一部分」（2026-10-15 报过）。'
      )
    }
  } catch (error) {
    // 这一条是**硬失败**：打包出带 dpiAwareness 的 exe 等于交付一个必崩的版本
    console.error(
      `  [after-pack] ★★ 清单体检不通过：${error instanceof Error ? error.message : error}`
    )
    throw error
  }

  /* ---------- ③ 版本信息 ---------- */
  try {
    /*
     * ★ 版本号直接读 package.json 的 buildVersion，不用 packager.appInfo.version。
     *   踩坑记录：appInfo.version 被 electron-builder 归一化成三段式，
     *   实测写进去变成了 1.0.0.0（末尾补 0），而不是我们要的 1.0.0.2。
     *   自己读原始字段最可靠。
     */
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
    const version = pkg.buildVersion || pkg.version
    const r = applyVersionInfo(exePath, version, productName)
    console.log(
      r.ok
        ? `  [after-pack] 已写入版本信息 ${r.version}：${productName}.exe`
        : `  [after-pack] 版本信息跳过：${r.reason}`
    )
  } catch (error) {
    console.warn(
      `  [after-pack] 版本信息写入失败：${error instanceof Error ? error.message : error}`
    )
  }
}
