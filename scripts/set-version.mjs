// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 统一维护 package.json 里的版本号与安装包命名。
 *
 * ── 为什么要分两个字段 ──────────────────────────────────────
 *   npm 的 version 必须是**严格三段式 semver**，
 *   写 1.1.0.1 会被 electron-builder 直接拒绝：
 *     ⨯ Invalid version: "1.1.0.1"
 *
 *   Windows 的 exe 文件版本属性支持四段式（major.minor.build.revision），
 *   electron-builder 为此提供了专门的 buildVersion 字段。
 *   因此：
 *     version      = 2.1.0      ← 给 npm / semver 用
 *     buildVersion = 2.0.0.0    ← 写进 exe 属性，属性页显示 v2.0.0.0
 *
 * ── 为什么安装包名不跟着 version ────────────────────────────
 *   若用 ${version}，产物会叫「…-2.0.0-安装程序.exe」，
 *   与用户看到的「v2.0.0.0」对不上，容易误判装的是哪版。
 *   所以这里写死四段式版本号。
 */

import { readFileSync, writeFileSync } from 'node:fs'

/** 应用显示名（与 package.json 的 productName 保持一致） */
const PRODUCT = '秋夕-PDF阅读器'
/** 三段式，给 npm / semver */
const SEMVER = '1.0.8'
/** 四段式，写进 exe 属性、也用于安装包文件名 */
const WIN_VERSION = '1.0.9.0'

const path = 'package.json'
const pkg = JSON.parse(readFileSync(path, 'utf8'))

pkg.version = SEMVER
pkg.buildVersion = WIN_VERSION

pkg.build ??= {}
pkg.build.nsis ??= {}
pkg.build.nsis.artifactName = `${PRODUCT}-${WIN_VERSION}-安装程序.\${ext}`

writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

console.log('  productName  =', pkg.productName)
console.log('  version      =', pkg.version, '  (semver，给 npm)')
console.log('  buildVersion =', pkg.buildVersion, '  (写进 exe 属性)')
console.log('  artifactName =', pkg.build.nsis.artifactName)
