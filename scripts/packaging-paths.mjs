// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 打包/安装位置的**唯一来源**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要有这个文件（用户 2026-10-16 要求：源码零隐私信息）
 * ══════════════════════════════════════════════════════════════════
 *   以前 `D:\QXClass\QXPDFReader` 这个安装目录被硬编码在十几处源码与脚本里，
 *   仓库一开源就把客户的部署路径泄出去了。
 *   现在：
 *     · 源码里只有**通用默认值**（见下面 DEFAULT_*）；
 *     · 真实交付值放在 `build/packaging.json`（.gitignore 已排除，永不发布）；
 *     · 这个模块按「环境变量 → packaging.json → 通用默认值」的顺序取，
 *       所有工具与脚本都从这里读，不再各写一份。
 *
 * 用法：
 *   import { installedExe, fixturePath, productName } from '../scripts/packaging-paths.mjs'
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const projectRoot = resolve(here, '..')

/** 通用默认值（开源可见，不含客户信息） */
const DEFAULT_INSTALL_DIR = 'C:\\Program Files\\QXPDFReader'
const DEFAULT_PRODUCT = '秋夕-PDF阅读器'

/** 金标准夹具位置（工程内，随源码一起分发） */
export const FIXTURE_RELATIVE = join('tests', 'fixture', 'fixture.pdf')

/**
 * **第二份**夹具：多标签页用例必须用两个**不同**路径，
 * 否则会命中 store 的「同路径复用已有标签」逻辑，第二个文件开不出新标签。
 */
export const FIXTURE_B_RELATIVE = join('tests', 'fixture', 'fixture-b.pdf')

function readPackaging() {
  const p = join(projectRoot, 'build', 'packaging.json')
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return {}
  }
}

const cfg = readPackaging()

/** 安装根目录（NSIS 把「应用子目录」建在这里）：环境变量 > packaging.json > 通用默认值 */
export function installDir() {
  return (
    process.env['PDF_READER_INSTALL_DIR'] ??
    cfg.installDir ??
    DEFAULT_INSTALL_DIR
  )
}

/**
 * 应用子目录名（= package.json 的 `name`）。
 *
 * ── 为什么需要这一层 ──────────────────────────────────────────────
 *   v2.1.0.1 起 NSIS 脚本（build/installer.nsh.in）把程序装进
 *   `$INSTDIR\<APP_FILENAME>\`，也就是安装根目录下再多一层 `qiuxi-pdf-reader`：
 *     D:\QXClass\PDFReader\              ← installDir()
 *     D:\QXClass\PDFReader\qiuxi-pdf-reader\   ← 真正的程序目录
 *   早先的脚本直接拼 `installDir()\秋夕-PDF阅读器.exe`，2026-10-18 装的
 *   2.1.1.0 之后全部指向不存在的路径（退出对话框用例因此读错了 app.asar）。
 */
export function appSubDir() {
  return process.env['PDF_READER_APP_SUBDIR'] ?? 'qiuxi-pdf-reader'
}

/** 程序目录（exe / resources 所在）：兼容「没有子目录」的旧安装 */
export function installedAppDir() {
  const exeName = `${productName()}.exe`
  const layered = join(installDir(), appSubDir())
  if (existsSync(join(layered, exeName))) return layered
  // 旧布局（exe 直接躺在安装根下）——存在就用它，避免迁移期误判
  if (existsSync(join(installDir(), exeName))) return installDir()
  return layered
}

/** 产品显示名（exe 文件名去扩展名） */
export function productName() {
  return process.env['PDF_READER_PRODUCT'] ?? DEFAULT_PRODUCT
}

/**
 * 已安装的 exe 完整路径。
 * 环境变量 PDF_READER_EXE 优先级最高（单独测某一份产物时用）。
 */
export function installedExe() {
  if (process.env['PDF_READER_EXE']) return process.env['PDF_READER_EXE']
  return join(installedAppDir(), `${productName()}.exe`)
}

/**
 * 金标准测试夹具的完整路径。
 * 环境变量 PDF_READER_FIXTURE 可覆盖（例如指向一份真实业务文档做抽样验证）。
 */
export function fixturePath() {
  if (process.env['PDF_READER_FIXTURE']) return process.env['PDF_READER_FIXTURE']
  return join(projectRoot, FIXTURE_RELATIVE)
}

/** 第二份夹具的完整路径（多标签用例用） */
export function fixtureBPath() {
  if (process.env['PDF_READER_FIXTURE_B']) return process.env['PDF_READER_FIXTURE_B']
  return join(projectRoot, FIXTURE_B_RELATIVE)
}

/** 打印一行来源说明，方便用例自证「我测的是哪一份」 */
export function describeTargets() {
  return {
    安装目录: installDir(),
    程序目录: installedAppDir(),
    已安装exe: installedExe(),
    夹具: fixturePath(),
    来源: existsSync(join(projectRoot, 'build', 'packaging.json'))
      ? 'build/packaging.json + 环境变量覆盖'
      : '通用默认值（没有 packaging.json）'
  }
}
