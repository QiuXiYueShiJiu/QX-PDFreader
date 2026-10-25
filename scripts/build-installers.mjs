// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 生成两个安装包：
 *   ① 秋夕-PDF阅读器-<版本>-安装程序.exe              标准版
 *   ② PDF阅读器-快速安装.exe                  快速版（一键）
 *
 * ── 两个包的差异 ────────────────────────────────────────────
 *   标准版 oneClick=false：有安装向导，用户可选目录。
 *     注意：**协助式模式下无法用 customInit 指定默认目录** ——
 *     模板的 setInstallModePerUser 在目录页显示时才执行，
 *     位于 customInit 之后，会把值覆盖掉（已实测）。
 *     所以标准版装到 electron-builder 的默认位置。
 *
 *   快速版 oneClick=true：双击即装，不问任何问题。
 *     一次性模式下 initMultiUser 在 customInit **之前**执行，
 *     因此 installer.nsh 里设的 $INSTDIR = <INSTALL_DIR>
 *     能生效（已实测）。
 *     装完自动启动应用，省掉一次点击。
 *
 * ── 为什么要分成两个包 ──────────────────────────────────────
 *   学校场景里两种需求并存：
 *     · 机房批量部署 → 要「双击就跑完」，不能有人守着点下一步
 *     · 个人安装     → 想自己选装到哪
 *   一个包无法同时满足，所以分开构建。
 *
 * 用法：node scripts/build-installers.mjs
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync, readdirSync } from 'node:fs'

const pkgForOut = JSON.parse(readFileSync('package.json', 'utf8'))

/*
 * 交付参数（装到哪、两个包叫什么）**不在源码里**：
 * 先跑 build-setup.mjs，它会把 build/packaging.json（不发布）
 * 与源码里的通用默认值合并成 build/.packaging-resolved.json。
 *
 * 这样即使有人拿到源码，也看不到客户的本地安装目录与定制包名。
 */
const setup = spawnSync('node', ['scripts/build-setup.mjs'], { stdio: 'inherit', shell: true })
if (setup.status !== 0) {
  console.error('★ build-setup.mjs 失败，先修好它再打包')
  process.exit(setup.status ?? 1)
}

const resolved = JSON.parse(readFileSync('build/.packaging-resolved.json', 'utf8'))

/*
 * 产物输出目录：读 package.json 的 build.directories.output（单一来源）。
 *
 * 早先这里写死 `--config.directories.output=dist-installer`，
 * 于是 package.json 里配了别的目录也不生效 —— 所以改成跟着配置走，
 * 需要自定义时设 PDF_RELEASE_DIR 环境变量即可。
 */
const OUT_DIR = pkgForOut.build?.directories?.output ?? 'dist-installer'

/** 快速版安装包的文件名（去掉 ${ext} 占位符） */
const QUICK_NAME = String(resolved.quickArtifactName).replace(/\.\$\{ext\}$/, '')

function run(cmd, args, label) {
  console.log(`\n=== ${label} ===`)
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      ELECTRON_BUILDER_BINARIES_MIRROR:
        'https://npmmirror.com/mirrors/electron-builder-binaries/'
    }
  })
  if (r.status !== 0) {
    console.error(`★ ${label} 失败（exit ${r.status}）`)
    process.exit(r.status ?? 1)
  }
}

/**
 * 按变体重渲染「声明」，再打包。
 *
 * ★ 为什么必须每次重渲染（用户要求）：
 *   · 公开版（标准版）安装包**不得出现任何单位/学校信息**；
 *   · 专供版（快速版）必须带**适用范围声明**与技术支持。
 *   两者共用同一个 `nsis.include` 与同一个 `resources/build-info.json`，
 *   所以必须在每次打包**之前**把它们改成对应变体的内容 ——
 *   否则会出现「公开版里带着学单位名称」这种直接违反要求的情况。
 */
function renderVariant(variant) {
  const r = spawnSync('node', ['scripts/build-setup.mjs', `--variant=${variant}`], {
    stdio: 'inherit',
    shell: true
  })
  if (r.status !== 0) {
    console.error(`★ 渲染 ${variant} 变体声明失败`)
    process.exit(r.status ?? 1)
  }
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const winVersion = pkg.buildVersion ?? pkg.version
console.log(`应用：${pkg.productName}   版本：${winVersion}`)

/* ---------- ① 渲染层与主进程代码 ---------- */
run('npx.cmd', ['electron-vite', 'build'], '构建应用代码')

/* ---------- ② 标准版（带向导，可选目录 · 公开版声明） ---------- */
renderVariant('standard')
run(
  'npx.cmd',
  [
    'electron-builder',
    '--win',
    '--x64',
    '--config.nsis.oneClick=false',
    '--config.nsis.allowToChangeInstallationDirectory=true',
    // 标准版也带上自定义脚本（为将来预留），但不依赖它设目录
    '--config.nsis.include=build/installer.nsh'
  ],
  '打包 标准版'
)

/* ---------- ③ 快速版（一键，装到 <INSTALL_DIR> · 专供版声明） ---------- */
renderVariant('quick')
run(
  'npx.cmd',
  [
    'electron-builder',
    '--win',
    '--x64',
    '--config.nsis.oneClick=true',
    '--config.nsis.perMachine=false',
    '--config.nsis.allowToChangeInstallationDirectory=false',
    // 装完自动启动：快速部署时少一次点击
    '--config.nsis.runAfterFinish=true',
    '--config.nsis.include=build/installer.nsh',
    // 产物名固定成学校要的那个
    `--config.nsis.artifactName=${QUICK_NAME}.\${ext}`
  ],
  '打包 快速版'
)

/* ---------- ③b 静默部署版（一键静默 · 内置校验值通道） ---------- */
/*
 * 只在显式传 --with-special 时打：静默部署版要带单位声明与内置校验值，
 * 平时做公开包不该把它顺手产出来（容易发错文件）。
 */
const WITH_SPECIAL = process.argv.includes('--with-special')
const SPECIAL_NAME = String(resolved.specialArtifactName ?? '秋夕-PDF阅读器-${buildVersion}-静默部署版安装程序.${ext}')
  .replace('.${ext}', '')
if (WITH_SPECIAL) {
  renderVariant('special')
  run(
    'npx.cmd',
    [
      'electron-builder',
      '--win',
      '--x64',
      '--config.nsis.oneClick=true',
      '--config.nsis.perMachine=false',
      '--config.nsis.allowToChangeInstallationDirectory=false',
      // 静默部署版装完不自动启动：单位部署时批量装完再统一开
      '--config.nsis.runAfterFinish=false',
      '--config.nsis.include=build/installer.nsh',
      // 产物名：`${ext}` 是 electron-builder 的占位符，这里要原样传给它
      `--config.nsis.artifactName=${SPECIAL_NAME}.\${ext}`
    ],
    '打包 静默部署版'
  )
}

/* ---------- ④ 收尾：把工作区还原成「公开版声明」 ---------- */
/*
 * 打包完立刻还原。否则工作区会停在专供版状态，
 * 下次有人只跑一次 `build-setup` 或直接 `electron-builder` 时，
 * 公开版包里就会带上学单位名称 —— 这类事故排查起来很费劲。
 */
renderVariant('standard')
console.log('\n（收尾）工作区声明已还原为公开版')

/* ---------- 汇总 ---------- */
console.log('\n=== 产物 ===')
if (existsSync(OUT_DIR)) {
  for (const f of readdirSync(OUT_DIR)) {
    if (!f.endsWith('.exe') || f.startsWith('__uninstaller')) continue
    const size = (readFileSync(`${OUT_DIR}/${f}`).length / 1024 / 1024).toFixed(1)
    console.log(`  ${f}   ${size} MB`)
  }
}
