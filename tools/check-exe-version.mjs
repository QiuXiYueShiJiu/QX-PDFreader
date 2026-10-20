// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 检查 exe 的版本资源字符串是否写进去了。
 *
 * ── 为什么单独写这个脚本 ────────────────────────────────────
 *   Windows 的「属性 → 详细信息」读的是版本资源里的
 *   StringFileInfo 字符串表。数字版本（FileVersion/ProductVersion）
 *   与字符串表是**两套数据**，可能一个写成功另一个没写。
 *   只看 PowerShell 的 VersionInfo.FileVersion 会误判 ——
 *   那个字段读的是数字部分。
 *   这里用 resedit 把资源完整读回来，逐个语言表打印。
 *
 * 用法：node tools/check-exe-version.mjs [exe路径]
 *       （默认查**已安装的专供版** 安装目录\秋夕-PDF阅读器.exe）
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { installedExe } from '../scripts/packaging-paths.mjs'

const require = createRequire(import.meta.url)
const ResEdit = require('resedit')

/*
 * 默认路径改过两次，这里写清楚以免再踩：
 *   最初是 原始安装目录\pdfreader\智慧黑板PDF阅读器.exe，
 *   后来专供版改名为「秋夕月拾旧-PDF阅读器」并把安装位置固定到 安装目录。
 */
const DEFAULT_EXE = installedExe()
const exePath = process.argv[2] ?? DEFAULT_EXE

if (!existsSync(exePath)) {
  console.error(`✗ 找不到：${exePath}`)
  console.error('  默认查的是已安装的专供版；要查别的就把它当参数传进来。')
  process.exit(2)
}

console.log(`=== ${exePath} ===\n`)

const buf = readFileSync(exePath)
const exe = ResEdit.NtExecutable.from(buf, { ignoreCert: true })
const res = ResEdit.NtExecutableResource.from(exe)

const vis = ResEdit.Resource.VersionInfo.fromEntries(res.entries)
if (vis.length === 0) {
  console.log('★ 没有版本资源')
  process.exit(1)
}

for (const vi of vis) {
  console.log('资源条目 lang =', vi.lang)

  const fi = vi.fixedInfo
  /* VS_FIXEDFILEINFO 的版本号是 HIWORD/LOWORD 拼出来的四段式 */
  const fromMSLS = (ms, ls) =>
    [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff].join('.')

  console.log('  数字版本 fileVersion    =', fromMSLS(fi.fileVersionMS, fi.fileVersionLS))
  console.log('  数字版本 productVersion =', fromMSLS(fi.productVersionMS, fi.productVersionLS))

  const available = vi.getAvailableLanguages()
  const forStrings = vi.getAllLanguagesForStringValues()
  console.log('  availableLanguages      =', JSON.stringify(available))
  console.log('  字符串表语言            =', JSON.stringify(forStrings))

  if (forStrings.length === 0) {
    console.log('  ★ 字符串表为空 —— 属性页里「文件说明/公司」会显示空白')
  }
  for (const lang of forStrings) {
    const values = vi.getStringValues(lang)
    console.log(`  语言 ${JSON.stringify(lang)} 的字符串:`, JSON.stringify(values, null, 2))
  }
  console.log('')
}
