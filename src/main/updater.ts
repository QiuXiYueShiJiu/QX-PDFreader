// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 版本更新检查（走镜像站的 release 汇总接口）。
 *
 * ── 为什么在主进程 ────────────────────────────────────────────
 *   渲染层的 CSP 是 `connect-src 'self' pdf-file: blob: data:`，
 *   只允许读本地 PDF；改成放开外网域名等于给渲染层开了个出网口子。
 *   放到主进程还能顺带绕开 CORS（镜像站的 api.php 不带 ACAO 头）。
 *
 * ── 数据来源 ──────────────────────────────────────────────────
 *   GET https://xn--6rso4u4lc86ad09c.top/contact/api.php
 *   返回 JSON：{ ok, repos: [ { full_name, release: {
 *     tag, name, prerelease, published_at, html_url, body,
 *     assets: [ { name, size, local } ] } } ] }
 *   资源地址：/contact/asset.php?repo=<full_name>&f=<文件名>&dl=1
 *
 * ── 失败策略 ──────────────────────────────────────────────────
 *   检查更新是「锦上添花」，任何异常都必须安静收场：
 *   断网、镜像挂了、返回格式变了 —— 一律返回 ok:false + 原因，
 *   界面上只在用户主动点「检查更新」时才提示失败，自动检查完全静默。
 */

import { app, net, shell } from 'electron'
import { createWriteStream, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MIRROR_ORIGIN = 'https://xn--6rso4u4lc86ad09c.top'
const API_URL = `${MIRROR_ORIGIN}/contact/api.php`
const REPO = 'QiuXiYueShiJiu/QX-PDFreader'
const TIMEOUT_MS = 12_000

export interface UpdateAsset {
  name: string
  size: number
  url: string
}

export interface UpdateCheckResult {
  ok: boolean
  /** 是否有比本地更高的版本 */
  newer: boolean
  /** 本地版本（buildVersion 优先） */
  current: string
  /** 远端最新版本（去掉前导 v） */
  latest: string
  /** release 页面，供「查看详情」 */
  page?: string
  /** release 说明（正文） */
  notes?: string
  publishedAt?: string
  asset?: UpdateAsset
  /** ok=false 时的原因 */
  error?: string
}

/** 把 'v1.0.0.1' / '1.0.0' 拆成数字数组，非数字段落按 0 处理 */
function parts(version: string): number[] {
  return version
    .replace(/^v/i, '')
    .split(/[.\-+]/)
    .filter((s) => s.length > 0)
    .map((s) => {
      const n = Number.parseInt(s, 10)
      return Number.isFinite(n) ? n : 0
    })
}

/** a 是否比 b 新 */
export function isNewer(a: string, b: string): boolean {
  const x = parts(a)
  const y = parts(b)
  const len = Math.max(x.length, y.length)
  for (let i = 0; i < len; i += 1) {
    const p = x[i] ?? 0
    const q = y[i] ?? 0
    if (p > q) return true
    if (p < q) return false
  }
  return false
}

/** 本地版本号：打包时写入 package.json 的 buildVersion（如 1.0.1.0） */
export function currentVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as {
      buildVersion?: string
      version?: string
    }
    return pkg.buildVersion || pkg.version || app.getVersion()
  } catch {
    return app.getVersion()
  }
}

interface MirrorRepo {
  full_name?: string
  release?: {
    tag?: string
    name?: string
    prerelease?: boolean
    published_at?: string
    html_url?: string
    body?: string
    assets?: Array<{ name?: string; size?: number; local?: boolean }>
  } | null
}

function pickAsset(
  assets: Array<{ name?: string; size?: number }> | undefined,
  version: string,
  tag: string
): UpdateAsset | undefined {
  if (!Array.isArray(assets)) return undefined
  // 只认安装包：优先带版本号的 exe，其次任意 exe（跳过校验文件/绿色版）
  const exes = assets.filter((a) => typeof a.name === 'string' && /\.exe$/i.test(a.name))
  if (exes.length === 0) return undefined
  const named = exes.find((a) => a.name!.includes(version)) ?? exes[0]
  const name = named.name as string
  /*
   * ★ 镜像站的资源路径是 `assets/<tag>/<文件名>`，不是裸文件名。
   *
   * 站点自己的 JS 就是这么拼的（contact 页面里的 assetUrl()），
   * 传裸文件名会 404 —— 这个坑踩过一次，别改回去。
   */
  const local = `assets/${tag}/${name}`
  return {
    name,
    size: Number(named.size ?? 0),
    url: `${MIRROR_ORIGIN}/contact/asset.php?repo=${encodeURIComponent(REPO)}&f=${encodeURIComponent(
      local
    )}&dl=1`
  }
}

/**
 * 查一次最新版本。
 *
 * @param timeoutMs 允许调用方缩短（自动检查用 6s，手动检查用默认 12s）
 */
export async function checkForUpdate(timeoutMs = TIMEOUT_MS): Promise<UpdateCheckResult> {
  const current = currentVersion()
  const base: UpdateCheckResult = { ok: false, newer: false, current, latest: current }

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await net.fetch(API_URL, {
      signal: ac.signal,
      headers: { accept: 'application/json', 'cache-control': 'no-cache' }
    })
    if (!res.ok) return { ...base, error: `镜像站返回 HTTP ${res.status}` }
    const data = (await res.json()) as { repos?: MirrorRepo[] }
    const repo = (data.repos ?? []).find((r) => r?.full_name === REPO)
    if (!repo) return { ...base, error: '镜像站里没有这个项目的发布信息' }
    const release = repo.release
    if (!release?.tag) return { ...base, error: '镜像站还没同步到任何 release' }
    if (release.prerelease) return { ...base, error: '最新 release 是预发布版，已跳过' }

    const latest = String(release.tag).replace(/^v/i, '')
    const newer = isNewer(latest, current)
    const asset = newer ? pickAsset(release.assets, latest, String(release.tag)) : undefined
    return {
      ok: true,
      newer,
      current,
      latest,
      page: release.html_url ?? '',
      notes: release.body ?? '',
      publishedAt: release.published_at ?? '',
      asset
    }
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    return { ...base, error: aborted ? '连接镜像站超时' : '连接镜像站失败（可能没有网络）' }
  } finally {
    clearTimeout(timer)
  }
}

/* ============================================================
 * 下载
 * ============================================================ */

export interface DownloadProgress {
  /** 已下载字节 */
  received: number
  /** 总字节（0 表示服务端没给 Content-Length） */
  total: number
  /** 0~1；total 为 0 时是 -1（不确定） */
  fraction: number
}

let downloading = false

/** 安装包落盘目录：userData/updates（不写临时目录，避免被清理工具删掉） */
function updateDir(): string {
  const dir = join(app.getPath('userData'), 'updates')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 下载安装包，返回本地路径。
 *
 * 只允许下载检查结果里给出的那个 asset：调用方传进来的 URL 必须
 * 以镜像站域名开头，避免这条 IPC 被当成「任意地址下载器」。
 */
export async function downloadUpdate(
  asset: UpdateAsset,
  onProgress: (p: DownloadProgress) => void
): Promise<{ ok: boolean; path?: string; error?: string }> {
  if (!asset?.url?.startsWith(`${MIRROR_ORIGIN}/`)) {
    return { ok: false, error: '下载地址不在镜像站域名下，已拒绝' }
  }
  if (downloading) return { ok: false, error: '已经有一个下载任务在进行' }
  downloading = true

  const target = join(updateDir(), asset.name.replace(/[\\/:*?"<>|]/g, '_'))
  try {
    const res = await net.fetch(asset.url)
    if (!res.ok) return { ok: false, error: `下载失败：HTTP ${res.status}` }
    const total = Number(res.headers.get('content-length') ?? 0) || asset.size || 0

    if (!res.body) {
      const buf = new Uint8Array(await res.arrayBuffer())
      await new Promise<void>((resolvePromise, reject) => {
        const out = createWriteStream(target)
        out.on('error', reject)
        out.on('close', () => resolvePromise())
        out.end(buf)
      })
      onProgress({ received: buf.byteLength, total: buf.byteLength, fraction: 1 })
      return { ok: true, path: target }
    }

    const reader = res.body.getReader()
    const out = createWriteStream(target)
    const done = new Promise<void>((resolvePromise, reject) => {
      out.on('error', reject)
      out.on('close', () => resolvePromise())
    })
    let received = 0
    for (;;) {
      const { done: finished, value } = await reader.read()
      if (finished) break
      if (!value) continue
      received += value.byteLength
      out.write(Buffer.from(value))
      onProgress({
        received,
        total,
        fraction: total > 0 ? Math.min(1, received / total) : -1
      })
    }
    out.end()
    await done

    const size = statSync(target).size
    if (total > 0 && size < total * 0.98) {
      rmSync(target, { force: true })
      return { ok: false, error: `下载不完整（${size}/${total} 字节）` }
    }
    return { ok: true, path: target }
  } catch (error) {
    rmSync(target, { force: true })
    return { ok: false, error: `下载出错：${error instanceof Error ? error.message : String(error)}` }
  } finally {
    downloading = false
  }
}

/** 用系统默认方式打开安装包（不静默安装：装不装由用户点） */
export async function installUpdate(path: string): Promise<{ ok: boolean; error?: string }> {
  if (!path || !/\.exe$/i.test(path)) return { ok: false, error: '安装包路径不合法' }
  const error = await shell.openPath(path)
  return error ? { ok: false, error } : { ok: true }
}
