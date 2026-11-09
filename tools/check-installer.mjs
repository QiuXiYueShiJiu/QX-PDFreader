// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 安装/卸载脚本的破坏性操作自检（2.1.1.0 起）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────
 *   2.1.1.0 差点带着「覆盖升级清空用户数据」发出去：卸载段里有一句
 *     RMDir /r "$APPDATA\秋夕月拾旧-PDF阅读器"
 *   而 electron-builder 在**覆盖升级**时会先跑旧版卸载程序。
 *   也就是说这句删的是真正的数据目录（settings.json / 最近文件 / 阅读位置），
 *   只要装上这个版本，用户下一次升级就清档 —— 一跳测试根本测不出来。
 *
 *   这个脚本把判据写成可执行的：凡是卸载段里对**数据目录**的递归删除，
 *   一律拦下。以后改安装器不用靠人记得。
 *
 * ── 判据 ────────────────────────────────────────────────────
 *   1) 禁止 RMDir /r 作用于数据目录（$APPDATA\秋夕月拾旧-PDF阅读器、
 *      $APPDATA\秋夕-PDF阅读器、$LOCALAPPDATA\秋夕月拾旧-PDF阅读器 等）；
 *   2) 禁止 Delete / RMDir 作用于 userData 下的已知文件名（settings.json 等）；
 *   3) .nsh.in 与生成物 .nsh（存在时）都要过。
 *
 *   白名单式的「空壳目录」（新 productName 建的、1.1/1.2 时代遗留的）
 *   允许删除 —— 它们不含用户数据。
 *
 * 用法：node tools/check-installer.mjs
 */

import { readFileSync, existsSync, statSync } from 'node:fs'

const FILES = ['build/installer.nsh.in', 'build/installer.nsh']

/**
 * 含用户数据的目录：任何递归删除都算错。
 *
 * 只有这一个 —— src/main/index.ts 的 LEGACY_USER_DATA_NAME 把 userData
 * 钉到了 $APPDATA\秋夕月拾旧-PDF阅读器（productName 改名前的老名字）。
 * $APPDATA\秋夕-PDF阅读器 是改名后 Electron 建的空壳，
 * $LOCALAPPDATA\秋夕月拾旧-PDF阅读器 只是 Chromium 缓存，删了会重建，
 * 这两个允许清。
 */
const DATA_DIRS = ['$APPDATA\\秋夕月拾旧-PDF阅读器']

/** 数据目录里的关键文件：直接删也算错 */
const DATA_FILES = ['settings.json', 'recent.json', 'lastread.json', 'window-state.json']

/**
 * 允许清除的「空壳目录」——必须逐个登记，未登记的一律拦下。
 *
 * 为什么用登记制而不是「不是 DATA_DIRS 就放行」：
 * 「哪个目录装用户数据」这个事实会随 productName、setPath 调用、
 * 甚至某次重构而变。放行制等于每次都要重新推演一遍；登记制把
 * 「我认为这个目录不含数据」写进仓库，改一处就要改一次，审查时看得见。
 * 2.1.1.0 的事故正是「以为某个 $APPDATA 目录是空壳」这类推断没被记录。
 */
const SAFE_SHELL_DIRS = [
  '$APPDATA\\秋夕-PDF阅读器',
  '$APPDATA\\智慧黑板PDF阅读器',
  '$LOCALAPPDATA\\秋夕月拾旧-PDF阅读器'
]

/**
 * 允许的安装根目录。
 *
 * 公开版必须装到系统盘的标准位置；把 D:\QXClass\PDFReader 这种
 * 「某个单位的内网路径」烘进安装包，对没有 D 盘的用户是**装不上**，
 * 不是「装错地方」——2026-11-09 的 2.1.1.0 就是这么发出去的。
 * @@INSTALL_DIR@@ 是模板占位符（构建时才替换），放行。
 */
const INSTALL_ROOTS = [
  '@@INSTALL_DIR@@',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  '$PROGRAMFILES',
  '$PROGRAMFILES64',
  '$PROGRAMFILES32',
  '$LOCALAPPDATA',
  '$APPDATA'
]

const errs = []
let checked = 0

for (const rel of FILES) {
  if (!existsSync(rel)) continue
  checked++
  // 生成物比模板旧说明是上一轮留下的，跳过（构建时会重新生成）
  if (rel.endsWith('installer.nsh') && existsSync('build/installer.nsh.in')) {
    const a = statSync('build/installer.nsh').mtimeMs
    const b = statSync('build/installer.nsh.in').mtimeMs
    if (a < b) { console.log('· build/installer.nsh 比模板旧，视为过期生成物，跳过'); continue }
  }
  const src = readFileSync(rel, 'utf8')
  const lines = src.split(/\r?\n/)

  lines.forEach((line, i) => {
    const at = `${rel}:${i + 1}`
    const code = line.replace(/^\s*;.*$/, '') // 整行注释跳过
    if (!code.trim()) return

    // ① 递归删除数据目录
    const rm = code.match(/^\s*RMDir\s+\/r\s+"([^"]+)"/i)
    if (rm) {
      const target = rm[1]
      const hit = DATA_DIRS.find((d) => target.toLowerCase() === d.toLowerCase())
      if (hit) {
        errs.push(`${at} 卸载/安装脚本递归删除了数据目录 ${hit} —— 覆盖升级会清档，必须删掉这句`)
        return
      }
      // 前缀命中：$APPDATA\秋夕月拾旧-PDF阅读器\cache 之类
      const prefix = DATA_DIRS.find((d) => target.toLowerCase().startsWith(d.toLowerCase() + '\\'))
      if (prefix) {
        errs.push(`${at} 递归删除了数据目录下的子路径 ${target} —— 用户数据目录不应被安装器改动`)
        return
      }
      // 数据根下的任何目录都必须逐个登记为「空壳」，否则视为误删候选
      const lower = target.toLowerCase()
      const inDataRoot = lower.startsWith('$appdata\\') || lower.startsWith('$localappdata\\')
      if (inDataRoot) {
        const safe = SAFE_SHELL_DIRS.some((d) => lower === d.toLowerCase())
        if (!safe) {
          errs.push(`${at} 递归删除了未登记的数据根目录 ${target} —— 若确认不含用户数据，请加进 SAFE_SHELL_DIRS 并写明依据`)
        }
      }
    }

    // ② 安装根目录不是系统盘标准位置（内网/个人路径被烘进公开包）
    const inst = code.match(/StrCpy\s+\$INSTDIR\s+"([^"]+)"/i)
    if (inst) {
      const target = inst[1]
      const lower = target.toLowerCase()
      const ok = INSTALL_ROOTS.some((r) => lower.startsWith(r.toLowerCase()))
      if (!ok) {
        errs.push(`${at} 安装目录 ${target} 不在允许的根目录（C:\\Program Files 或 %LOCALAPPDATA%）—— 公开包不能带内网/个人路径，否则没 D 盘的用户装不上`)
      }
    }

    // ③ 直接删数据文件
    const del = code.match(/^\s*Delete\s+"([^"]+)"/i)
    if (del) {
      const lower = del[1].toLowerCase()
      const bad = DATA_FILES.find((f) => lower.endsWith('\\' + f) || lower.endsWith('/' + f))
      if (bad) errs.push(`${at} 删除了数据文件 ${bad} —— 用户设置不应被安装器删除`)
    }
  })
}

if (checked === 0) {
  console.log('· 没找到 installer 模板，跳过（干净 clone 尚未生成 build/installer.nsh 是正常的）')
  process.exit(0)
}

if (errs.length) {
  console.log(`✗ 安装器自检失败 ${errs.length} 项（检查了 ${checked} 个文件）`)
  for (const e of errs) console.log('  ' + e)
  process.exit(1)
}

console.log(`✓ 安装器自检通过：${checked} 个文件，无破坏性删除`)
