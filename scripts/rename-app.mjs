// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 改名脚本：秋夕月拾旧-PDF阅读器 → 秋夕-PDF阅读器（2026-10-16，v2.0.0.0）
 *
 * ── 为什么要脚本而不是手改 ──────────────────────────────────
 *   名字散落在 package.json、主进程、五个组件、index.html 里，
 *   手改容易漏。漏掉的那处会在界面上显示旧名字，
 *   属于「一看就知道没改干净」的瑕疵。
 *
 * ── 三个不要碰（改错了会出真问题）────────────────────────────
 *   ① `name`（smartboard-pdf-reader）不要碰：标准版安装包的默认目录
 *      APP_FILENAME 走的是 sanitizedName（= name），改了默认装到别处。
 *   ② `appId`（com.qiuxiyue.qxpdfreader）不要碰：卸载注册表项与升级判定
 *      都按它走，改了会变成「程序和功能」里两条、且装成两份。
 *   ③ userData 目录名（秋夕月拾旧-PDF阅读器）不要碰：它由 productName 决定，
 *      而用户设置/最近文件/阅读位置都在里面。主进程用
 *      `app.setPath('userData', …)` 把它钉死（见 src/main/index.ts），
 *      所以 productName 改名后老数据仍然读得到。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'

/** 界面显示用的名字 */
const DISPLAY = '秋夕-PDF阅读器'
/** exe 文件名（任务管理器/属性页显示的就是它；用户要求叫秋夕-PDF阅读器） */
const EXE = '秋夕-PDF阅读器'
/** 稳定标识：appId 用它，永不随显示名变 */
const APP_ID_SUFFIX = 'qxpdfreader'

/** 旧名的各种写法（都要替换掉） */
const OLD_VARIANTS = [
  '智慧黑板PDF阅读器',
  '智慧黑板 PDF 阅读器',
  'smartboard-pdf-reader',
  '秋夕月拾旧-PDF阅读器'
]

let changed = 0

/* ---------- ① package.json ---------- */
{
  const path = 'package.json'
  const pkg = JSON.parse(readFileSync(path, 'utf8'))

  pkg.build ??= {}
  pkg.build.appId = `com.qiuxiyue.${APP_ID_SUFFIX}`
  pkg.productName = DISPLAY
  /*
   * 著作权归属（用户明确要求「著作权依旧秋夕月拾旧」）：
   *   · author          → exe 版本资源里的 CompanyName 与安装包发布者
   *   · build.copyright → LegalCopyright（属性页「版权」那一行）
   * 两者都要，缺一个属性页上就会空着或显示旧名。
   */
  pkg.author = '秋夕月拾旧'
  pkg.build.copyright = 'Copyright © 秋夕月拾旧'
  // 描述里也带着旧产品名（任务管理器「描述」列会显示），一并换掉
  if (typeof pkg.description === 'string') {
    pkg.description = pkg.description.replace(/^[^—]*——/, `${DISPLAY} ——`)
  }
  // exe 文件名：用户要求叫「秋夕-PDF阅读器」，中文名在 Windows 上没问题，
  // 但要清楚副作用 —— 任务栏固定项指向旧文件名会失效，需要重新固定。
  pkg.build.executableName = EXE
  pkg.build.nsis ??= {}
  pkg.build.nsis.shortcutName = DISPLAY
  pkg.build.nsis.artifactName = `${DISPLAY}-\${version}-安装程序.\${ext}`

  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  console.log('  package.json:')
  console.log('    productName    =', pkg.productName)
  console.log('    executableName =', pkg.build.executableName)
  console.log('    appId          =', pkg.build.appId)
  console.log('    shortcutName   =', pkg.build.nsis.shortcutName)
  changed++
}

/* ---------- ② 源码与 HTML 里的显示名 ---------- */
const SOURCES = [
  'src/main/index.ts',
  'src/renderer/index.html',
  'src/renderer/src/App.tsx',
  'src/renderer/src/components/RightRail.tsx',
  'src/renderer/src/components/SettingsPanel.tsx',
  'src/renderer/src/components/TitleBar.tsx'
]

for (const path of SOURCES) {
  if (!existsSync(path)) {
    console.log(`  (跳过，不存在) ${path}`)
    continue
  }
  const before = readFileSync(path, 'utf8')
  let after = before
  for (const old of OLD_VARIANTS) {
    after = after.split(old).join(DISPLAY)
  }
  if (after !== before) {
    writeFileSync(path, after, 'utf8')
    console.log(`  已更新: ${path}`)
    changed++
  }
}

console.log(`\n  共修改 ${changed} 处。`)
