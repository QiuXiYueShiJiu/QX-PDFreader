// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 打包参数：把「装到哪、叫什么名字」从源码里挪出来。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要单独一份（用户 2026-10-16 要求：源码零隐私信息 + 版本隔离）
 * ══════════════════════════════════════════════════════════════════
 *   源码是要 Apache-2.0 开源的，不能出现学校名、内网目录、本机路径。
 *   但交付时快速版又必须装到指定的内网目录、安装包名要带学校标识。
 *   解法：源码里只留**通用默认值**，交付参数放在这份**不发布**的
 *   `build/packaging.json` 里（已在 .gitignore 中）。
 *
 * 字段：
 *   installDir     快速版（oneClick）默认安装目录。留空 = 用"未发布"的默认值
 *   installDirArtifact  安装包产物名里是否追加学校/客户标识
 *   artifactName   标准版安装包文件名模板（${ext} 会被替换成 exe）
 *
 * 用法（一般由 scripts/build-installers.mjs 读，不需要手动跑）：
 *   node scripts/build-setup.mjs          # 依据 packaging.json 生成 build/installer.nsh
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

/**
 * 变体：'standard' = 公开发行版（标准向导版）；'quick' = 专供版（快速安装版）。
 *
 * build-installers.mjs 在**每次打包之前**用 `--variant=xxx` 跑一次这里，
 * 以便把「适用范围 / 使用单位 / 技术支持」写成对应变体的内容：
 *   · 公开版这三项必须为空（不得出现任何单位信息）；
 *   · 专供版必须带适用范围声明与技术支持。
 * 两份包共用同一个 nsis include 与同一个 resources/build-info.json，
 * 所以不区分变体就会出现「公开版里带着学校名」。
 */
const VARIANT = (() => {
  const arg = process.argv.find((a) => a.startsWith('--variant='))
  const v = arg ? arg.slice('--variant='.length) : 'standard'
  return v === 'quick' ? 'quick' : 'standard'
})()

/**
 * 默认安装目录（**通用值，不含任何客户/学校信息**）。
 * 交付时由 build/packaging.json 覆盖。
 */
const DEFAULT_INSTALL_DIR = 'C:\\Program Files\\QXPDFReader'

/**
 * 首次运行 build-setup 时写进 build/packaging.json 的**通用默认值**。
 *
 * ★ 这里**不要**写具体的单位名 / 内网目录 —— 本文件是公开源码。
 *   交付时把真实值填进 build/packaging.json（该文件不发布），
 *   或者直接用环境变量 PDFREADER_INSTALL_DIR / PDFREADER_QUICK_NAME 覆盖。
 */
const DEFAULT_DELIVERY_INSTALL_DIR = 'C:\\Program Files\\QXPDFReader'
const DEFAULT_DELIVERY_QUICK_ARTIFACT = 'PDF阅读器-快速安装.${ext}'

/** 默认产物名（通用） */
const DEFAULT_ARTIFACT = '秋夕-PDF阅读器-${buildVersion}-安装程序.${ext}'

function readPackaging() {
  const p = join(root, 'build', 'packaging.json')
  if (!existsSync(p)) {
    /*
     * 首次运行：生成一份**带交付默认值**的 packaging.json，然后按它构建。
     * 这份文件不进源码仓（.gitignore 已排除），所以「装到哪、包叫什么」
     * 这类客户信息只存在于本机，源码里始终是通用值。
     */
    const seed = {
      _comment:
        '交付参数：不随源码发布（.gitignore 已排除）。开源默认值见 scripts/build-setup.mjs。',
      installDir: DEFAULT_DELIVERY_INSTALL_DIR,
      quickArtifactName: DEFAULT_DELIVERY_QUICK_ARTIFACT,
      artifactName: DEFAULT_ARTIFACT
    }
    writeFileSync(p, `${JSON.stringify(seed, null, 2)}\n`, 'utf8')
    console.log('  [setup] 已生成 build/packaging.json（交付参数，不发布）')
    return seed
  }
  try {
    const cfg = JSON.parse(readFileSync(p, 'utf8'))
    console.log('  [setup] 已读取 build/packaging.json（交付参数，不随源码发布）')
    return cfg
  } catch (error) {
    console.warn(`  [setup] build/packaging.json 解析失败，改用默认值：${error.message}`)
    return {}
  }
}

const cfg = readPackaging()
const installDir = (cfg.installDir ?? DEFAULT_INSTALL_DIR).replace(/\\+$/, '')

/**
 * 需要顺带清掉的**旧安装目录**（交付值，源码里为空数组）。
 *
 * 本版默认安装位置从 C:\Program Files\QiuXiPDFReader-legacy 改成 C:\Program Files\QiuXiPDFReader。
 * 老机器上可能留着整个旧目录：两份 exe、两个卸载器、
 * 指向旧 exe 的快捷方式。安装时清掉，避免用户点错版本。
 */
const legacyInstallDirs = Array.isArray(cfg.legacyInstallDirs)
  ? cfg.legacyInstallDirs.filter((d) => typeof d === 'string' && d.trim() && d !== installDir)
  : []

/* ---------- 生成 installer.nsh（NSIS 不支持 include 外部数据，只能生成） ---------- */
const nshSrc = join(root, 'build', 'installer.nsh.in')
const nshOut = join(root, 'build', 'installer.nsh')

if (!existsSync(nshSrc)) {
  console.error(`  [setup] ★ 找不到模板 ${nshSrc}`)
  process.exit(1)
}

const template = readFileSync(nshSrc, 'utf8')
if (!template.includes('@@INSTALL_DIR@@')) {
  console.error('  [setup] ★ 模板里找不到 @@INSTALL_DIR@@ 占位符')
  process.exit(1)
}

/* ---------- 品牌 / 声明（源码里只留通用值，交付值来自 packaging.json） ---------- */
const legal = {
  site: cfg.legal?.site ?? '秋夕月拾旧.top',
  publisher: cfg.legal?.publisher ?? '秋夕月拾旧',
  notice:
    cfg.legal?.notice ??
    '本项目以 PolyForm Noncommercial License 1.0.0 授权：非商业用途免费；商业用途需另行授权。',
  /*
   * ★ 公开版必须为空 —— 用户要求「公开版本安装包不出现任何隐私信息」，
   *   而「适用范围 / 使用单位 / 技术支持」通常带单位名与联系人，
   *   所以它们只在专供版构建时由 packaging.json 注入，源码里不出现。
   */
  standard: {
    org: cfg.legal?.standard?.org ?? '',
    usageScope: cfg.legal?.standard?.usageScope ?? '',
    support: cfg.legal?.standard?.support ?? ''
  },
  quick: {
    org: cfg.legal?.quick?.org ?? '',
    usageScope: cfg.legal?.quick?.usageScope ?? '',
    support: cfg.legal?.quick?.support ?? ''
  }
}

/** 把声明渲染成 NSIS 注释块（安装脚本里可读、不参与逻辑） */
function legalDecl(variant) {
  const v = legal[variant]
  return [
    `;  著作权所有 by ${legal.publisher}`,
    `;  官方网站：${legal.site}`,
    ';  授权协议：PolyForm Noncommercial License 1.0.0',
    ';            （非商业用途免费；商业用途需另行授权）',
    v.usageScope ? `;  适用范围：${v.usageScope}` : ';  适用范围：（公开发行版，无额外限制）',
    v.support ? `;  ${v.support}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * 按变体生成 NSIS include。
 *
 * 为什么要生成两次：electron-builder 两次打包共用同一个 `nsis.include`，
 * 而两份安装包要显示的声明不同（专供版多一条适用范围 + 技术支持）。
 * 所以在每次打包前重新渲染一次。
 */
/**
 * 生成「清理旧安装目录」的 NSIS 片段。
 *
 * 用 StrCmp 逐条比较，而不是无条件 RMDir —— 万一将来有人把
 * 新目录与旧目录配成同一个，无条件删会把安装目标自己删掉。
 */
function legacyCleanupBlock() {
  if (legacyInstallDirs.length === 0) {
    return '  ; （没有配置 legacyInstallDirs，无需迁移）'
  }
  return legacyInstallDirs
    .map(
      (dir) =>
        '  StrCmp $INSTDIR "' +
        dir +
        '" +2\n' +
        '    RMDir /r "' +
        dir +
        '"'
    )
    .join('\n')
}

function renderNsh(variant) {
  /*
   * 变体标记：写成 !define 而不是靠替换正文。
   *
   * 为什么需要它：专供版要把安装目录**定死**，公开版必须尊重
   * 命令行 /D= 与向导里选的目录（见 installer.nsh.in 的 customInit）。
   * electron-builder 的 nsis 配置**没有**传自定义宏定义的口子
   * （试过 --config.nsis.define.X，schema 直接拒绝），
   * 所以只能在这里按变体把 !define 插到文件开头。
   * 用具名宏而非 !if 正文替换，是因为 !define 会递归展开，
   * 能穿透 
sis.include 被包在宏里导致的 include guard 问题。
   */
  const flag = variant === 'quick' ? '!define QX_QUICK_EDITION\n' : ''
  const v = legal[variant]
  return flag + template
    .replaceAll('@@INSTALL_DIR@@', installDir)
    .replaceAll('@@LEGACY_DIR_CLEANUP@@', legacyCleanupBlock())
    .replaceAll('@@LEGAL_DECL@@', legalDecl(variant))
    .replaceAll('@@LEGAL_PUBLISHER@@', legal.publisher)
    .replaceAll('@@LEGAL_SITE@@', legal.site)
    .replaceAll('@@LEGAL_NOTICE@@', legal.notice)
    .replaceAll('@@LEGAL_ORG@@', v.org)
    .replaceAll('@@LEGAL_USAGE_SCOPE@@', v.usageScope)
    .replaceAll('@@LEGAL_SUPPORT@@', v.support)
}

/* 默认先写标准版（build-installers.mjs 会在每次打包前重写对应变体） */
writeFileSync(nshOut, renderNsh(VARIANT), 'utf8')
console.log('  [setup] 变体 = ' + VARIANT)
if (legacyInstallDirs.length) console.log(`  [setup] 迁移清理：${legacyInstallDirs.join('、')}`)
console.log(`  [setup] 已生成 build/installer.nsh  默认安装目录（两版相同）= ${installDir}`)

/* ---------- 把产物名写回 package.json（electron-builder 从这里读） ---------- */
const pkgPath = join(root, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
pkg.build ??= {}
pkg.build.nsis ??= {}

const artifact = cfg.artifactName ?? DEFAULT_ARTIFACT
pkg.build.nsis.artifactName = artifact.replace('${buildVersion}', pkg.buildVersion ?? pkg.version)

writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
console.log(`  [setup] 标准版产物名 = ${pkg.build.nsis.artifactName}`)

/* ---------- 把快速版产物名交给构建脚本用 ---------- */
const quick = cfg.quickArtifactName ?? 'PDF阅读器-快速安装.${ext}'
console.log(`  [setup] 快速版产物名 = ${quick}`)

/* 顺手写一份给 build-installers.mjs 读的小文件，避免它再解析一次 JSON */
writeFileSync(
  join(root, 'build', '.packaging-resolved.json'),
  `${JSON.stringify(
    { installDir, artifactName: pkg.build.nsis.artifactName, quickArtifactName: quick, legal },
    null,
    2
  )}\n`,
  'utf8'
)

/*
 * ---------- 生成公开版（标准版）的运行时声明文件 ----------
 *
 * 应用在「关于」面板里要显示：著作权 / 官方网站 / 授权协议 /
 * （专供版额外的）适用范围与技术支持。这些值随构建变形，
 * 所以打成一个 `build-info.json` 交给 extraResources 装进安装目录，
 * 运行期由主进程读它 —— 源码里只有通用默认值。
 */
const buildInfo = {
  product: pkg.productName ?? '秋夕-PDF阅读器',
  version: pkg.version,
  buildVersion: pkg.buildVersion,
  publisher: legal.publisher,
  site: legal.site,
  notice: legal.notice,
  /* 默认写公开版；build-installers.mjs 在打专供版前会覆盖成专供版 */
  variant: VARIANT,
  org: legal[VARIANT].org,
  usageScope: legal[VARIANT].usageScope,
  support: legal[VARIANT].support
}
writeFileSync(
  join(root, 'build', 'build-info.json'),
  `${JSON.stringify(buildInfo, null, 2)}\n`,
  'utf8'
)
console.log(`  [setup] 已生成 build/build-info.json（公开版声明）`)
