// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 市场清单的合法性校验（渲染层做，纯数据、无副作用）。
 *
 * 为什么放在渲染层：主进程只负责「别让渲染层直连外网」，清单的字段语义
 * 与主题变量是界面概念，校验跟着 UI 走更内聚；而且这里可以在不联网的情况下
 * 单测（`tools/verify-market.mjs` 用本地 HTTP 服务器喂各种坏包）。
 *
 * 规则（与服务器 `plugins.php` 一致，双向各校验一次）：
 *   · `id` 小写字母/数字/`-`/`_`，2–32 字符，且不能重复（去重在调用侧）；
 *   · `name` 非空、≤ 24 字；
 *   · `desc` ≤ 120 字（超了直接丢，不截断——截断会让作者以为写全了）；
 *   · 七个颜色变量齐全，`R G B` 每段 0–255 的整数；也接受 `#rgb` / `#rrggbb`
 *     写法，统一归一成 `R G B`（与内置主题的存法一致）。
 */

import type { MarketItem } from './store'

export const COLOR_KEYS = ['accent', 'bg', 'surface', 'text', 'muted', 'border', 'readerBg'] as const

const ID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/

/** `#2f7d6d` / `#fff` / `47 125 109` → `47 125 109`；不合法返回 null */
export function toRgbTriple(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text)
  if (hex) {
    const body = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1]
    const parts = [0, 2, 4].map((i) => parseInt(body.slice(i, i + 2), 16))
    return parts.join(' ')
  }

  const triple = text.split(/\s+/)
  if (triple.length !== 3) return null
  const nums = triple.map((part) => Number(part))
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return nums.join(' ')
}

/**
 * 把一条原始清单项归一成可用主题包；任何一条不合法就返回 null（整包丢弃）。
 * 不做「部分字段可用」的宽容：半坏的主题会让界面出现一处黑一块白。
 *
 * 2.0.0 起多认四个可选项（主题包形态 / 背景图 / 预览图 / 版本门槛）：
 * 可选项坏掉只当没写，不影响整条 —— 老清单没有这些字段照样能用。
 */
export function normalizeMarketItem(raw: unknown): MarketItem | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>

  const id = typeof item.id === 'string' ? item.id.trim() : ''
  if (!ID_RE.test(id)) return null

  const name = typeof item.name === 'string' ? item.name.trim() : ''
  if (!name || name.length > 24) return null

  const desc = typeof item.desc === 'string' ? item.desc.trim() : ''
  if (desc.length > 120) return null

  const themeRaw = item.theme
  if (!themeRaw || typeof themeRaw !== 'object') return null
  const themeIn = themeRaw as Record<string, unknown>

  const theme = {} as MarketItem['theme']
  for (const key of COLOR_KEYS) {
    const triple = toRgbTriple(themeIn[key])
    if (!triple) return null
    theme[key] = triple
  }

  const version = typeof item.version === 'string' ? item.version.trim().slice(0, 16) : ''
  const author = typeof item.author === 'string' ? item.author.trim().slice(0, 32) : ''

  return {
    id,
    name,
    desc,
    ...(version ? { version } : {}),
    ...(author ? { author } : {}),
    ...optionalBits(item),
    theme
  }
}

/** 可选项：解析失败就整块丢掉，不抛错、不影响配色 */
function optionalBits(item: Record<string, unknown>): Partial<MarketItem> {
  const out: Partial<MarketItem> = {}

  const category = typeof item.category === 'string' ? item.category.trim().slice(0, 16) : ''
  if (category) out.category = category

  if (Array.isArray(item.tags)) {
    const tags = item.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim().slice(0, 12)).slice(0, 6)
    if (tags.length > 0) out.tags = tags
  }

  const preview = typeof item.preview === 'string' ? item.preview.trim() : ''
  if (/^https?:\/\//i.test(preview)) out.preview = preview

  const minAppVersion = typeof item.minAppVersion === 'string' ? item.minAppVersion.trim().slice(0, 16) : ''
  if (minAppVersion) out.minAppVersion = minAppVersion

  const packRaw = item.pack
  if (packRaw && typeof packRaw === 'object') {
    const p = packRaw as Record<string, unknown>
    const radius = clampNumber(p.radius, 0, 40)
    const blur = clampNumber(p.blur, 0, 40)
    const panelAlpha = clampNumber(p.panelAlpha, 0.2, 1)
    if (radius !== null && blur !== null && panelAlpha !== null) {
      const shadow = typeof p.shadow === 'string' ? p.shadow.trim().slice(0, 80) : ''
      const toolbarHeight = clampNumber(p.toolbarHeight, 32, 80)
      const gap = clampNumber(p.gap, 0, 24)
      out.pack = {
        radius,
        blur,
        panelAlpha,
        ...(shadow ? { shadow } : {}),
        ...(toolbarHeight !== null ? { toolbarHeight } : {}),
        ...(gap !== null ? { gap } : {})
      }
    }
  }

  const bgRaw = item.background
  if (bgRaw && typeof bgRaw === 'object') {
    const b = bgRaw as Record<string, unknown>
    const url = typeof b.url === 'string' ? b.url.trim() : ''
    if (/^https?:\/\//i.test(url)) {
      const sha = typeof b.sha256 === 'string' ? b.sha256.trim().toLowerCase() : ''
      const size = clampNumber(b.size, 1, 64 * 1024 * 1024)
      out.background = {
        url,
        ...(/^[0-9a-f]{64}$/.test(sha) ? { sha256: sha } : {}),
        ...(size !== null ? { size: Math.round(size) } : {})
      }
    }
  }

  return out
}

/** 数字区间裁剪：不是有限数就返回 null（当没写），超范围夹到边界 */
export function clampNumber(value: unknown, min: number, max: number): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(n)) return null
  return Math.min(max, Math.max(min, n))
}

/** 整份清单：逐条归一 + 按 id 去重（后来的覆盖先前的），保持原顺序 */
export function normalizeMarketList(raw: unknown): MarketItem[] {
  if (!Array.isArray(raw)) return []
  const seen = new Map<string, MarketItem>()
  for (const entry of raw) {
    const item = normalizeMarketItem(entry)
    if (item) seen.set(item.id, item)
  }
  return [...seen.values()]
}
