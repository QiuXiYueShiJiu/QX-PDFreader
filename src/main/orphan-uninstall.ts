/**
 * 清理「孤儿」卸载注册表项。
 *
 * ── 为什么要做 ─────────────────────────────────────────────
 *   从 2.1.1.0 起标准版把安装目录从 `C:\Program Files\QiuXiPDFReader` / `C:\Program Files\QiuXiPDFReader`
 *   换到了 `%LOCALAPPDATA%\Programs\QiuXiPDFReader`。旧版卸载器会用 RMDir 把旧目录删掉，
 *   但 NSIS 的卸载注册表项（`...\Uninstall\秋夕-PDF阅读器`）留了下来：
 *   「应用和功能」里还列着旧版，点它去调一个已经不存在的 uninstall.exe。
 *
 * ── 判据（宁可漏删，不可误删）──────────────────────────────
 *   · 只认 `InstallLocation`（去掉尾反斜杠、统一大小写后）**完全等于**已知旧安装目录；
 *   · `DisplayName` 只进日志，不参与判断 —— 同名产品可能是别人家的；
 *   · 当前正在运行的这个安装目录永远不删；
 *   · 没写 InstallLocation 的项一律跳过。
 *
 * ── 性能 ─────────────────────────────────────────────────
 *   一开始是「每个子键一次 reg query」，实测扫三根要 ~240 次进程启动、20 秒以上，
 *   而且跑在启动路径上（阻塞窗口）。改成每根一次 `reg query <root> /s`，
 *   一次拿到全部子键与值，再在内存里切块解析 —— 三次进程调用搞定。
 */

import { execFileSync } from 'node:child_process'
import { dirname, normalize } from 'node:path'

/** 历史上出现过的安装目录（比较前统一 normalize，见 normalizeDir） */
const LEGACY_INSTALL_DIRS = [
  'C:\\Program Files\\QiuXiPDFReader',
  'C:\Program Files\QiuXiPDFReader\\QXPDFReader',
  'C:\Program Files\QiuXiPDFReader',
]

const UNINSTALL_ROOTS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
]

export interface OrphanEntry {
  root: string
  key: string
  displayName: string
  installLocation: string
}

function normalizeDir(value: string): string {
  return normalize(value.trim())
    .replace(/[\\/]+$/, '')
    .toLowerCase()
}

function currentInstallDir(): string {
  return normalizeDir(dirname(process.execPath))
}

function reg(args: string[]): string {
  try {
    return execFileSync('reg.exe', args, {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return ''
  }
}

/**
 * reg.exe 输出里根键是全称（HKEY_CURRENT_USER\\…），而我们传进去的是缩写
 * （HKCU\\…）——直接 startsWith 会一条都匹配不上，表现为「扫描恒为空」。
 */
function expandRoot(root: string): string {
  if (root.startsWith('HKCU\\')) return 'HKEY_CURRENT_USER\\' + root.slice(5)
  if (root.startsWith('HKLM\\')) return 'HKEY_LOCAL_MACHINE\\' + root.slice(5)
  return root
}

interface RawKey {
  key: string
  values: Map<string, string>
}

/** 一次 reg query <root> /s，把输出切成「键 → 值」 */
function scanRoot(root: string): RawKey[] {
  const out = reg(['query', root, '/s'])
  if (!out) return []
  const fullRoot = expandRoot(root).toLowerCase()
  const result: RawKey[] = []

  let current: RawKey | null = null
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue

    // 值行：名字 + 空格 + REG_XXX + 空格 + 值
    const valueMatch = line.match(/^(.+?)\s{2,}(REG_[A-Z_]+)\s{2,}(.*)$/)
    if (valueMatch && current) {
      current.values.set(valueMatch[1].trim(), valueMatch[3].trim())
      continue
    }

    // 键行：整行是 HKEY_… 路径
    if (line.toLowerCase().startsWith(fullRoot + '\\')) {
      const key = line.slice(fullRoot.length + 1)
      if (key && !key.includes('\\')) {
        current = { key, values: new Map() }
        result.push(current)
      } else {
        current = null
      }
      continue
    }

    current = null
  }
  return result
}

/** 扫出所有「InstallLocation 指向已知旧目录」的卸载项 */
export function listOrphanUninstallEntries(): OrphanEntry[] {
  const current = currentInstallDir()
  const legacy = new Set(LEGACY_INSTALL_DIRS.map(normalizeDir))
  const found: OrphanEntry[] = []

  for (const root of UNINSTALL_ROOTS) {
    for (const entry of scanRoot(root)) {
      const loc = entry.values.get('InstallLocation')
      if (!loc) continue
      const norm = normalizeDir(loc)
      if (!legacy.has(norm)) continue
      if (norm === current) continue
      found.push({
        root,
        key: entry.key,
        displayName: entry.values.get('DisplayName') || '',
        installLocation: loc,
      })
    }
  }
  return found
}

/** 删除扫出来的孤儿项；用「再查一次是否还在」判定，不信返回码 */
export function cleanOrphanUninstallEntries(): OrphanEntry[] {
  const removed: OrphanEntry[] = []
  for (const entry of listOrphanUninstallEntries()) {
    reg(['delete', `${entry.root}\\${entry.key}`, '/f'])
    if (!reg(['query', `${entry.root}\\${entry.key}`])) removed.push(entry)
  }
  return removed
}

export { LEGACY_INSTALL_DIRS }
