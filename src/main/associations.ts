// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 文件关联与开机自启（WPS 那套做法）。
 *
 * ── 为什么不是「打开系统设置页让用户自己点」────────────────────
 *   Windows 10/11 把默认程序锁在 `UserChoice` 里，安装器不能直接改它的值
 *   （键上有一条拒绝写入的 ACL，而且值里带一个用扩展名+SID+时间戳算出来的
 *   Hash，写错了系统会静默忽略）。
 *   但**删掉 UserChoice 是允许的**，删掉之后资源管理器会回落到
 *   `HKCU\Software\Classes\.ext` 的默认值 —— 那一条我们能写。
 *   所以流程是：写 ProgID → 写 `.ext` 默认值 → 删 UserChoice → 通知外壳刷新。
 *   用户下次双击就直接进秋夕，不会弹「你要用什么打开」。
 *
 * ── 只动 HKCU ────────────────────────────────────────────────
 *   全程 HKCU，不需要管理员，也不碰其它用户和系统级 HKLM。卸载残留只有
 *   一个 ProgID 和几个默认值，不影响别人。
 */

import { execFileSync } from 'node:child_process'
import { app } from 'electron'

const PROGID = 'QiuXi.PDFReader'
const APP_NAME = '秋夕-PDF阅读器'
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const RUN_VALUE = 'QiuXiPDFReader'

/** 支持的关联后缀（和主进程的 IMAGE_EXTS 保持一致） */
export const ASSOC_EXTS = [
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.bmp',
  '.gif',
  '.ico',
  '.tif',
  '.tiff'
] as const

function reg(args: string[]): void {
  try {
    execFileSync('reg.exe', args, { stdio: 'ignore', windowsHide: true })
  } catch {
    /* 键不存在时 del 会返回非 0，忽略即可 */
  }
}

/** 读某个后缀当前的默认 ProgID；没有就返回空串 */
function currentDefault(ext: string): string {
  try {
    const out = execFileSync(
      'reg.exe',
      ['query', `HKCU\\Software\\Classes\\${ext}`, '/ve'],
      { encoding: 'utf8', windowsHide: true }
    )
    const m = out.match(/REG_SZ\s+(.+)$/m)
    return m ? m[1].trim() : ''
  } catch {
    return ''
  }
}
function setValue(key: string, name: string, value: string): void {
  reg(['add', key, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'])
}

/** 通知资源管理器：关联变了，图标和双击行为要重新读 */
function notifyShell(): void {
  try {
    execFileSync(
      'rundll32.exe',
      ['shell32.dll,SHChangeNotify', '0x08000000', '0', '0,0'],
      { stdio: 'ignore', windowsHide: true }
    )
  } catch {
    /* 通知失败不影响关联本身 */
  }
}

/**
 * 把勾选的后缀交给秋夕。
 *
 * 传空数组 = 撤销：把 `.ext` 的默认值和 UserChoice 都删掉，交还给系统默认。
 */
export function applyAssociations(exts: string[]): { ok: boolean; applied: string[]; error?: string } {
  const wanted = ASSOC_EXTS.filter((e) => exts.includes(e))
  const exe = process.execPath

  try {
    /* 1) ProgID：双击时真正被调用的那条命令 */
    reg(['add', `HKCU\\Software\\Classes\\${PROGID}`, '/ve', '/t', 'REG_SZ', '/d', `${APP_NAME} 文档`, '/f'])
    reg(['add', `HKCU\\Software\\Classes\\${PROGID}\\DefaultIcon`, '/ve', '/t', 'REG_SZ', '/d', `"${exe}",0`, '/f'])
    reg([
      'add', `HKCU\\Software\\Classes\\${PROGID}\\shell\\open\\command`,
      '/ve', '/t', 'REG_SZ', '/d', `"${exe}" "%1"`, '/f'
    ])

    /*
     * 2) 只处理「用户这次勾了」的后缀，未勾的一个字都不写。
     *
     *    UserChoice 也只在勾选时删——它是系统里那条「这个后缀归谁」的最终裁定，
     *    删掉等于替用户改默认程序。我们只在用户亲手勾了某个后缀时这么做，
     *    安装、升级、启动一概不碰（applyAssociations 只有设置页会调）。
     */
    for (const ext of wanted) {
      const key = `HKCU\\Software\\Classes\\${ext}`
      reg(['add', key, '/ve', '/t', 'REG_SZ', '/d', PROGID, '/f'])
      reg(['add', `${key}\\OpenWithProgids`, '/v', PROGID, '/t', 'REG_SZ', '/d', '', '/f'])
      reg([
        'delete',
        `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${ext}\\UserChoice`,
        '/f'
      ])
    }

    /*
     * 取消勾选的后缀：只撤回**确实是我们写的**那一条。
     * 先读一遍默认值比对 ProgID —— 如果这个后缀后来被别的程序接管了，
     * 或者用户把它指给了别的阅读器，删掉就等于替别人擦屁股。
     */
    for (const ext of ASSOC_EXTS) {
      if (wanted.includes(ext)) continue
      if (currentDefault(ext) === PROGID) {
        reg(['delete', `HKCU\\Software\\Classes\\${ext}`, '/ve', '/f'])
      }
      reg(['delete', `HKCU\\Software\\Classes\\${ext}\\OpenWithProgids`, '/v', PROGID, '/f'])
    }

    /* 4) 「设置 → 默认应用」里能按应用名找到我们（Capabilities） */
    const cap = `HKCU\\Software\\${APP_NAME}\\Capabilities`
    setValue(cap, 'ApplicationName', APP_NAME)
    setValue(cap, 'ApplicationDescription', '上课能批注的 PDF 阅读器')
    reg(['add', `${cap}\\FileAssociations`, '/f'])
    for (const ext of wanted) setValue(`${cap}\\FileAssociations`, ext, PROGID)
    reg([
      'add', 'HKCU\\Software\\RegisteredApplications',
      '/v', APP_NAME, '/t', 'REG_SZ', '/d', `Software\\${APP_NAME}\\Capabilities`, '/f'
    ])

    notifyShell()
    return { ok: true, applied: wanted }
  } catch (error) {
    return { ok: false, applied: [], error: String(error) }
  }
}

/**
 * 开机自启。
 *
 * 写 HKCU\...\Run 一条就够，不需要计划任务也不需要管理员。
 * 用 app.getPath('exe') 而不是 process.execPath：打包后两者相同，
 * 但开发态下 execPath 是 electron.exe，不加参数会起个空白窗口。
 */
export function setAutoStart(enabled: boolean): { ok: boolean; error?: string } {
  try {
    if (enabled) {
      reg(['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', `"${app.getPath('exe')}" --hidden`, '/f'])
    } else {
      reg(['delete', RUN_KEY, '/v', RUN_VALUE, '/f'])
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

/** 当前开机自启是否开着（读注册表，不靠设置文件猜） */
export function isAutoStartOn(): boolean {
  try {
    execFileSync('reg.exe', ['query', RUN_KEY, '/v', RUN_VALUE], { stdio: 'ignore', windowsHide: true })
    return true
  } catch {
    return false
  }
}
