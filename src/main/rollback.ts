// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 更新回滚（2.0.0，需求清单 B13）。
 *
 * ── 解决什么问题 ──────────────────────────────────────────────
 *   自动更新最怕「新版本装上就起不来」：用户手里既没有旧安装包，
 *   也没法在崩溃的界面里点「回滚」。所以这里做三件事：
 *     1. 下载过的新安装包留三份副本（rollback 目录），随时能重装回去；
 *     2. 每次启动记一次数，正常进到界面就清零 —— 连续两次没进界面
 *        说明这一版有启动级问题；
 *     3. 连续失败两次时，主进程主动弹框问「回滚到还留着的哪个版本」，
 *        不需要用户能操作界面。
 *
 * ── 为什么不拦「同一版本」重复安装 ────────────────────────────
 *   用户点两次同一个包很正常（比如想修一下装坏的）。真正要拦的是
 *   「回滚到与当前完全相同的版本」—— 那没有任何意义，还白等两分钟。
 */

import { app, dialog, shell } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/** 最多留几份旧安装包（320MB 一份，3 份约 1GB，普通磁盘可接受） */
const KEEP_VERSIONS = 3

/** 连续多少次「进了进程但没进界面」判定启动失败 */
const FAIL_THRESHOLD = 2

export interface RollbackEntry {
  version: string
  path: string
  size: number
  savedAt: string
}

function rollbackDir(): string {
  const dir = join(app.getPath('userData'), 'rollback')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function statePath(): string {
  return join(app.getPath('userData'), 'boot-state.json')
}

interface BootState {
  /** 已经启动但没进入界面的次数 */
  failures: number
  /** 上一次启动的时间戳 */
  lastBootAt: string
}

function readBootState(): BootState {
  try {
    const raw = readFileSync(statePath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<BootState>
    return {
      failures: typeof parsed.failures === 'number' ? parsed.failures : 0,
      lastBootAt: typeof parsed.lastBootAt === 'string' ? parsed.lastBootAt : ''
    }
  } catch {
    return { failures: 0, lastBootAt: '' }
  }
}

function writeBootState(state: BootState): void {
  try {
    writeFileSync(statePath(), JSON.stringify(state), 'utf8')
  } catch {
    /* 记不下来也不该影响启动 */
  }
}

/** 进程起来时调用：失败计数 +1，并记时间 */
export function markBootStart(): void {
  const state = readBootState()
  writeBootState({ failures: state.failures + 1, lastBootAt: new Date().toISOString() })
}

/** 渲染层真正画出来了才调用：清零 */
export function markBootOk(): void {
  writeBootState({ failures: 0, lastBootAt: new Date().toISOString() })
}

/** 连续失败是否已达阈值（启动时用它决定要不要弹回滚提示） */
export function bootFailures(): number {
  return readBootState().failures
}

export function listRollback(): RollbackEntry[] {
  const dir = rollbackDir()
  try {
    return readdirSync(dir)
      .filter((name) => /\.(exe|zip)$/i.test(name))
      .map((name) => {
        const full = join(dir, name)
        const info = statSync(full)
        const version = /(\d+\.\d+\.\d+(?:\.\d+)?)/.exec(basename(name))?.[1] ?? '未知'
        return { version, path: full, size: info.size, savedAt: info.mtime.toISOString() }
      })
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
  } catch {
    return []
  }
}

function prune(): void {
  const entries = listRollback()
  for (const stale of entries.slice(KEEP_VERSIONS)) {
    rmSync(stale.path, { force: true })
  }
}

/**
 * 把下载好的安装包留一份副本。
 *
 * 只接 `.exe`（Windows 安装包）。Linux/ macOS 的产物结构不同，
 * 那边等用户恢复 Linux 支持时再单独处理，不能把 deb 塞进这里假装能回滚。
 */
export function keepInstaller(installerPath: string, version: string): { ok: boolean; error?: string } {
  try {
    if (!/\.[a-z0-9]+$/i.test(installerPath)) return { ok: false, error: '文件类型不认识' }
    const target = join(rollbackDir(), `QX-PDFreader-${version}-setup${installerPath.match(/\.[a-z0-9]+$/i)?.[0] ?? '.exe'}`)
    copyFileSync(installerPath, target)
    prune()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: `保存安装包失败：${(error as Error).message}` }
  }
}

/**
 * 回滚到指定版本：静默装回旧包，然后退出当前进程。
 *
 * 只拦「与当前版本相同」这一种情况 —— 装一样的包没有意义。
 * 用户设置（settings.json）与批注都不在安装目录里，重装不会丢。
 */
export function rollbackTo(version: string): { ok: boolean; error?: string } {
  const current = app.getVersion()
  if (version === current) {
    return { ok: false, error: `当前就是 ${current}，不需要回滚` }
  }
  const entry = listRollback().find((e) => e.version === version)
  if (!entry) return { ok: false, error: `没有找到 ${version} 的安装包` }
  if (!entry.path.toLowerCase().endsWith('.exe')) {
    return { ok: false, error: '这个文件不能自动安装，请手动运行' }
  }
  /* 交给系统安装器：静默装、装完重启应用（安装器自己会拉起新进程） */
  void shell.openPath(entry.path)
  setTimeout(() => app.quit(), 800)
  return { ok: true }
}

/**
 * 启动时若连续失败达阈值，弹一个「要不要回滚」的框。
 *
 * 这个框必须在渲染层就绪**之前**就能弹（正是界面起不来的时候），
 * 所以直接在主进程里调 dialog，等用户选完再继续。
 */
export async function askRollbackIfUnstable(): Promise<void> {
  if (bootFailures() < FAIL_THRESHOLD) return
  const entries = listRollback().filter((e) => e.version !== app.getVersion())
  if (entries.length === 0) return
  const labels = entries.map((e) => `回滚到 ${e.version}`)
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: '启动似乎不稳定',
    message: `最近两次启动都没能进入界面（当前版本 ${app.getVersion()}）。`,
    detail:
      '如果这是新版本带来的问题，可以退回之前用过的版本。设置、最近文件和批注都不会丢。\n\n' +
      `可选版本：${entries.map((e) => e.version).join('、')}`,
    buttons: [...labels, '继续用当前版本'],
    defaultId: 0,
    cancelId: labels.length
  })
  if (response >= labels.length) {
    /* 用户选了「继续」：把计数清掉，别再反复问 */
    markBootOk()
    return
  }
  rollbackTo(entries[response].version)
}
