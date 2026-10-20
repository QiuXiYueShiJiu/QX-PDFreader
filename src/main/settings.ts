// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 设置的持久化存储。
 *
 * 落盘：app.getPath('userData')/settings.json、recent.json、positions.json
 * 策略：同步写。设置变更频率低，可靠性优先；且能避免退出时异步写丢失。
 */

import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mergeSettings } from '@shared/settings'
import type { Annotation, ReaderSettings, RecentFile } from '@shared/types'

let cache: ReaderSettings | null = null

function userFile(name: string): string {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return join(dir, name)
}

/** 读取 JSON，失败返回兜底值（不抛异常，保证应用能起来） */
function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch (error) {
    console.warn(`[settings] 读取 ${path} 失败：`, error)
    return fallback
  }
}

/**
 * 原子性写 JSON：先写临时文件，再用 rename 顶替目标文件。
 *
 * ★ 必须用 renameSync 而不是「读 tmp 再写回目标」：
 *   后者在写入过程中若被中断（断电、强杀进程、并发写），
 *   目标文件会变成半截内容 —— 表现为「批注/设置莫名丢失」。
 *   rename 在同一分区上是原子操作，要么是旧的完整文件，
 *   要么是新的完整文件，不存在中间状态。
 */
function writeJson(path: string, value: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    renameSync(tmp, path)
  } catch (error) {
    console.warn(`[settings] 写入 ${path} 失败：`, error)
  }
}

/* ============================================================
 * 阅读器设置
 * ============================================================ */

export function getSettings(): ReaderSettings {
  if (cache) return cache
  cache = mergeSettings(readJson<unknown>(userFile('settings.json'), null))
  return cache
}

export function patchSettings(patch: Partial<ReaderSettings>): ReaderSettings {
  const next = mergeSettings({ ...getSettings(), ...patch })
  cache = next
  writeJson(userFile('settings.json'), next)
  return next
}

/* ============================================================
 * 最近打开
 * ============================================================ */

export function getRecent(): RecentFile[] {
  const list = readJson<RecentFile[]>(userFile('recent.json'), [])
  if (!Array.isArray(list)) return []
  // 过滤掉已经被删除的文件，避免点开报错
  return list.filter((item) => item && typeof item.path === 'string' && existsSync(item.path))
}

/** 加入最近列表（去重，最新的排最前，超出上限截断） */
export function pushRecent(entry: { path: string; name: string; page: number }): RecentFile[] {
  const limit = Math.max(1, getSettings().recentLimit)
  const list = getRecent().filter((item) => item.path !== entry.path)
  list.unshift({ ...entry, at: Date.now() })
  const trimmed = list.slice(0, limit)
  writeJson(userFile('recent.json'), trimmed)
  return trimmed
}

/* ============================================================
 * 每份文件的阅读位置
 * ============================================================ */

type PositionMap = Record<string, { page: number; at: number }>

export function readLastPosition(filePath: string): number | null {
  const map = readJson<PositionMap>(userFile('positions.json'), {})
  const hit = map[filePath]
  return hit && Number.isFinite(hit.page) ? hit.page : null
}

export function writeLastPosition(filePath: string, page: number): boolean {
  const map = readJson<PositionMap>(userFile('positions.json'), {})
  map[filePath] = { page, at: Date.now() }

  // 只保留最近 200 份，避免文件无限增长
  const entries = Object.entries(map)
    .sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0))
    .slice(0, 200)
  const trimmed: PositionMap = {}
  for (const [key, value] of entries) trimmed[key] = value

  writeJson(userFile('positions.json'), trimmed)
  return true
}

/* ============================================================
 * 批注
 * ============================================================ */

/* ============================================================
 * 批注
 *
 * ── 为什么不做持久化（按需求刻意去掉）────────────────────────
 *   曾经把批注写进 userData/annotations.json，甚至改成了
 *   「PDF 同目录旁挂文件」以便携带。现已按要求全部移除：
 *   批注只存在于**当前这一次运行的会话里**，关掉程序即清空。
 *
 *   带来的好处：
 *     · 不会在用户的 PDF 旁边生成任何额外文件
 *     · 不会出现「重装后批注还在/不在」这类不一致
 *     · 批注是讲课时随手圈画的草稿，本就不需要长期留存
 *
 *   实现上保留这几个函数（而非删掉调用点），是为了让渲染层
 *   的代码结构不变 —— 以后若要恢复持久化，只改这里即可。
 * ============================================================ */

/** 读取：不持久化，恒返回空列表 */
export function getAnnotations(_filePath: string): Annotation[] {
  void _filePath
  return []
}

/** 写入：不持久化，原样回显（渲染层的状态自己维护） */
export function setAnnotations(_filePath: string, list: Annotation[]): Annotation[] {
  void _filePath
  return list.filter((a) => a && typeof a.id === 'string' && Number.isFinite(a.page))
}

/** 追加一条批注 */
export function addAnnotation(filePath: string, item: Annotation): Annotation[] {
  const current = getAnnotations(filePath)
  return setAnnotations(filePath, [...current, item])
}

/** 删除一条批注 */
export function removeAnnotation(filePath: string, id: string): Annotation[] {
  const current = getAnnotations(filePath)
  return setAnnotations(
    filePath,
    current.filter((a) => a.id !== id)
  )
}

/** 修改一条批注（目前用于编辑备注） */
export function updateAnnotation(
  filePath: string,
  id: string,
  patch: Partial<Annotation>
): Annotation[] {
  const current = getAnnotations(filePath)
  return setAnnotations(
    filePath,
    current.map((a) => (a.id === id ? { ...a, ...patch, id: a.id } : a))
  )
}

/** 清空某份文档的批注 */
export function clearAnnotations(filePath: string): Annotation[] {
  return setAnnotations(filePath, [])
}
