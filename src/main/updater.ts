// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 版本更新检查（双通道 + 静默部署版校验值通道）。
 *
 * ── 三条通道 ──────────────────────────────────────────────────
 *   1. GitHub Releases API（公开版主通道，全球可用，国内可能慢）
 *      GET https://api.github.com/repos/QiuXiYueShiJiu/QX-PDFreader/releases/latest
 *   2. 镜像站 `api.php`（公开版备用通道，站点爬 GitHub，国内快）
 *      GET https://xn--6rso4u4lc86ad09c.top/contact/api.php
 *      资源：/contact/asset.php?repo=<full_name>&f=assets/<tag>/<文件名>&dl=1
 *      ★ 必须是 `assets/<tag>/<文件名>`，裸文件名 404（踩过）
 *   3. 自定义部署通道（只有内置了通道参数的自定义版才会用；地址与头名在 build-info 里）
 *      返回 { ok, latest:{version,tag,notes,published_at,page,asset:{name,size,sha256,url}} }
 *      下载地址同样来自 build-info，客户端下完校验 SHA256。
 *
 * ── 为什么在主进程 ────────────────────────────────────────────
 *   渲染层 CSP 是 `connect-src 'self' pdf-file: blob: data:`，
 *   放开外网等于给渲染层开出网口子；主进程还能绕开 CORS。
 *
 * ── 失败策略 ──────────────────────────────────────────────────
 *   检查更新是锦上添花：断网、镜像挂了、格式变了 —— 一律 ok:false + 原因。
 *   公开版两条通道**并行**查，取版本号更高的那个；同版本时按用户偏好
 *   （设置里的 updateChannel，默认 auto→镜像站优先，因为国内更快）。
 *   静默部署版失败**不回落**到公开通道，避免把静默部署用户引到公开版。
 */

import { app, net, shell } from 'electron'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MIRROR_ORIGIN = 'https://xn--6rso4u4lc86ad09c.top'
const MIRROR_CONTACT = `${MIRROR_ORIGIN}/contact/`
const API_URL = `${MIRROR_CONTACT}api.php`
/*
 * 自定义部署通道的地址、请求头名、校验值全部来自 resources/build-info.json
 * （构建时从内部配置注入），源码里不出现任何端点或头名字面量。
 */
const GITHUB_API = 'https://api.github.com/repos/QiuXiYueShiJiu/QX-PDFreader/releases/latest'
const REPO = 'QiuXiYueShiJiu/QX-PDFreader'
const TIMEOUT_MS = 12_000

export type UpdateSource = 'github' | 'mirror' | 'special'
export type UpdateChannel = 'auto' | 'github' | 'mirror'

export interface UpdateAsset {
  name: string
  size: number
  url: string
  /** 静默部署版清单里给的校验值（公开通道一般没有） */
  sha256?: string
  /** 下载时需要带的校验值（静默部署版） */
  token?: string
  source?: UpdateSource
}

export interface UpdateCheckResult {
  ok: boolean
  newer: boolean
  current: string
  latest: string
  /** 这条结果来自哪条通道 */
  source?: UpdateSource
  page?: string
  notes?: string
  publishedAt?: string
  asset?: UpdateAsset
  error?: string
  /** 其他通道的版本（调试/展示用，例如两边都查到时） */
  others?: Array<{ source: UpdateSource; latest: string }>
}

/** 打包时注入的运行时声明（resources/build-info.json） */
interface CustomChannelInfo {
  updatePath?: string
  assetPath?: string
  header?: string
  token?: string
}

interface BuildInfo {
  variant?: string
  channel?: 'public' | 'special' | 'custom'
  custom?: CustomChannelInfo
}

export function readBuildInfo(): BuildInfo {
  const candidates = [
    join(process.resourcesPath ?? '', 'build-info.json'),
    join(app.getAppPath(), 'build', 'build-info.json'),
    join(process.cwd(), 'build', 'build-info.json')
  ]
  for (const p of candidates) {
    try {
      const info = JSON.parse(readFileSync(p, 'utf8')) as BuildInfo
      if (info && typeof info === 'object') return info
    } catch {
      /* 继续试下一个 */
    }
  }
  return {}
}

/** 是否为「自定义部署版」（内置校验值 + 指定通道） */
export function isSpecialBuild(): boolean {
  const info = readBuildInfo()
  return info.channel === 'custom' || info.channel === 'special' || info.variant === 'special'
}

function customChannel(): CustomChannelInfo {
  return readBuildInfo().custom ?? {}
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

/** 本地版本号：打包时写入 package.json 的 buildVersion（如 1.0.2.0） */
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

/* ============================================================
 * 通道一：镜像站 api.php
 * ============================================================ */

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

function pickMirrorAsset(
  assets: Array<{ name?: string; size?: number }> | undefined,
  version: string,
  tag: string
): UpdateAsset | undefined {
  if (!Array.isArray(assets)) return undefined
  const exes = assets.filter((a) => typeof a.name === 'string' && /\.exe$/i.test(a.name))
  if (exes.length === 0) return undefined
  const named = exes.find((a) => a.name!.includes(version)) ?? exes[0]
  const name = named.name as string
  /*
   * ★ 镜像站的资源路径是 `assets/<tag>/<文件名>`，不是裸文件名。
   * 站点 JS 的 assetUrl() 就是这么拼的，传裸文件名会 404（别改回去）。
   */
  const local = `assets/${tag}/${name}`
  return {
    name,
    size: Number(named.size ?? 0),
    url: `${MIRROR_CONTACT}asset.php?repo=${encodeURIComponent(REPO)}&f=${encodeURIComponent(local)}&dl=1`,
    source: 'mirror'
  }
}

async function checkMirror(timeoutMs: number, current: string): Promise<UpdateCheckResult> {
  const base: UpdateCheckResult = { ok: false, newer: false, current, latest: current, source: 'mirror' }
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
    const asset = newer ? pickMirrorAsset(release.assets, latest, String(release.tag)) : undefined
    return {
      ok: true,
      newer,
      current,
      latest,
      source: 'mirror',
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
 * 通道二：GitHub Releases API
 * ============================================================ */

interface GithubRelease {
  tag_name?: string
  name?: string
  prerelease?: boolean
  draft?: boolean
  published_at?: string
  html_url?: string
  body?: string
  assets?: Array<{ name?: string; size?: number; browser_download_url?: string }>
}

function pickGithubAsset(
  assets: Array<{ name?: string; size?: number; browser_download_url?: string }> | undefined,
  version: string
): UpdateAsset | undefined {
  if (!Array.isArray(assets)) return undefined
  const exes = assets.filter(
    (a) => typeof a.name === 'string' && /\.exe$/i.test(a.name) && typeof a.browser_download_url === 'string'
  )
  if (exes.length === 0) return undefined
  const named = exes.find((a) => a.name!.includes(version)) ?? exes[0]
  return {
    name: named.name as string,
    size: Number(named.size ?? 0),
    url: named.browser_download_url as string,
    source: 'github'
  }
}

async function checkGithub(timeoutMs: number, current: string): Promise<UpdateCheckResult> {
  const base: UpdateCheckResult = { ok: false, newer: false, current, latest: current, source: 'github' }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await net.fetch(GITHUB_API, {
      signal: ac.signal,
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'qiuxi-pdf-reader-updater',
        'cache-control': 'no-cache'
      }
    })
    if (!res.ok) return { ...base, error: `GitHub 返回 HTTP ${res.status}` }
    const release = (await res.json()) as GithubRelease
    if (!release?.tag_name) return { ...base, error: 'GitHub 没有可用的 release' }
    if (release.draft || release.prerelease) return { ...base, error: '最新 release 是预发布版，已跳过' }

    const latest = String(release.tag_name).replace(/^v/i, '')
    const newer = isNewer(latest, current)
    const asset = newer ? pickGithubAsset(release.assets, latest) : undefined
    return {
      ok: true,
      newer,
      current,
      latest,
      source: 'github',
      page: release.html_url ?? '',
      notes: release.body ?? '',
      publishedAt: release.published_at ?? '',
      asset
    }
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    return { ...base, error: aborted ? '连接 GitHub 超时' : '连接 GitHub 失败（可能被墙或没有网络）' }
  } finally {
    clearTimeout(timer)
  }
}

/* ============================================================
 * 通道三：静默部署版（内置校验值）
 * ============================================================ */

interface SpecialPayload {
  ok?: boolean
  error?: string
  org?: string
  latest?: {
    version?: string
    tag?: string
    notes?: string
    published_at?: string
    page?: string
    asset?: { name?: string; size?: number; sha256?: string; url?: string }
  } | null
}

async function checkSpecial(timeoutMs: number, current: string): Promise<UpdateCheckResult> {
  const base: UpdateCheckResult = { ok: false, newer: false, current, latest: current, source: 'special' }
  const { token = '', header = '', updatePath = '' } = customChannel()
  if (!token) return { ...base, error: '静默部署版缺少内置校验值（构建时没有注入）' }
  if (!updatePath) return { ...base, error: '静默部署版缺少通道地址（构建时没有注入）' }

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await net.fetch(`${MIRROR_CONTACT}${updatePath}?v=${encodeURIComponent(current)}`, {
      signal: ac.signal,
      headers: {
        accept: 'application/json',
        'cache-control': 'no-cache',
        ...(header ? { [header]: token } : {})
      }
    })
    if (res.status === 401) return { ...base, error: '静默部署校验值无效或已被吊销' }
    if (!res.ok) return { ...base, error: `静默部署服务器返回 HTTP ${res.status}` }
    const data = (await res.json()) as SpecialPayload
    if (!data.ok) return { ...base, error: data.error ?? '静默部署服务器返回失败' }
    if (!data.latest) return { ...base, error: '静默部署服务器上还没有发布版本' }

    const latestInfo = data.latest
    const latest = String(latestInfo.version ?? '').replace(/^v/i, '')
    if (!latest) return { ...base, error: '静默部署清单缺少版本号' }
    const newer = isNewer(latest, current)
    let asset: UpdateAsset | undefined
    if (newer && latestInfo.asset?.name) {
      const rel = String(latestInfo.asset.url ?? '')
      const url = rel ? new URL(rel, MIRROR_CONTACT).href : ''
      asset = {
        name: String(latestInfo.asset.name),
        size: Number(latestInfo.asset.size ?? 0),
        url,
        sha256: latestInfo.asset.sha256 ? String(latestInfo.asset.sha256).toLowerCase() : undefined,
        token,
        source: 'special'
      }
    }
    return {
      ok: true,
      newer,
      current,
      latest,
      source: 'special',
      page: latestInfo.page ?? '',
      notes: latestInfo.notes ?? '',
      publishedAt: latestInfo.published_at ?? '',
      asset
    }
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    return { ...base, error: aborted ? '连接静默部署服务器超时' : '连接静默部署服务器失败（可能没有网络）' }
  } finally {
    clearTimeout(timer)
  }
}

/* ============================================================
 * 汇总：并行查公开通道，按版本挑最高的
 * ============================================================ */

/** 从多条结果里挑版本最高的；同版本按偏好（auto → 镜像站优先） */
export function pickBest(results: UpdateCheckResult[], prefer: UpdateChannel): UpdateCheckResult | undefined {
  const ok = results.filter((r) => r.ok)
  if (ok.length === 0) return undefined
  const rank = (r: UpdateCheckResult): number =>
    prefer === 'github' ? (r.source === 'github' ? 2 : 1) : prefer === 'mirror' ? (r.source === 'mirror' ? 2 : 1) : r.source === 'mirror' ? 2 : 1

  return [...ok].sort((a, b) => {
    if (isNewer(a.latest, b.latest)) return -1
    if (isNewer(b.latest, a.latest)) return 1
    return rank(b) - rank(a)
  })[0]
}

/**
 * 查一次最新版本。
 *
 * @param timeoutMs 允许调用方缩短（自动检查用 6s，手动检查用默认 12s）
 * @param prefer    公开版的通道偏好（静默部署版忽略它）
 */
export async function checkForUpdate(
  timeoutMs = TIMEOUT_MS,
  prefer: UpdateChannel = 'auto'
): Promise<UpdateCheckResult> {
  const current = currentVersion()

  // 静默部署版：只走校验值通道，失败不回落
  if (isSpecialBuild()) {
    return checkSpecial(timeoutMs, current)
  }

  const tasks: Array<Promise<UpdateCheckResult>> = []
  if (prefer !== 'mirror') tasks.push(checkGithub(timeoutMs, current))
  if (prefer !== 'github') tasks.push(checkMirror(timeoutMs, current))

  const settled = await Promise.all(tasks)
  const best = pickBest(settled, prefer)
  if (!best) {
    const reasons = settled.map((r) => r.error).filter(Boolean)
    return {
      ok: false,
      newer: false,
      current,
      latest: current,
      error: reasons[0] ?? '连接更新服务器失败'
    }
  }
  const others = settled
    .filter((r) => r !== best && r.ok)
    .map((r) => ({ source: r.source as UpdateSource, latest: r.latest }))
  return { ...best, others }
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

/** 允许下载的站点：镜像站自己 + GitHub 的 release 资源域名 */
function isAllowedUrl(url: string): boolean {
  return (
    url.startsWith(`${MIRROR_ORIGIN}/`) ||
    url.startsWith('https://github.com/') ||
    url.startsWith('https://objects.githubusercontent.com/') ||
    url.startsWith('https://release-assets.githubusercontent.com/') ||
    url.startsWith('https://api.github.com/')
  )
}

function sha256Of(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * 下载安装包，返回本地路径。
 *
 * 只允许下载检查结果里给出的那个 asset：URL 必须在允许的站点下，
 * 避免这条 IPC 被当成「任意地址下载器」。
 * 静默部署版带 `sha256` 时会校验，不匹配直接删文件。
 */
export async function downloadUpdate(
  asset: UpdateAsset,
  onProgress: (p: DownloadProgress) => void
): Promise<{ ok: boolean; path?: string; error?: string }> {
  if (!asset?.url || !isAllowedUrl(asset.url)) {
    return { ok: false, error: '下载地址不在允许的域名下，已拒绝' }
  }
  if (downloading) return { ok: false, error: '已经有一个下载任务在进行' }
  downloading = true

  const target = join(updateDir(), asset.name.replace(/[\\/:*?"<>|]/g, '_'))
  try {
    const headers: Record<string, string> = {}
    const customHeader = customChannel().header
  if (asset.token && customHeader) headers[customHeader] = asset.token
    if (asset.source === 'github') headers['accept'] = 'application/octet-stream'
    const res = await net.fetch(asset.url, { headers })
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
    } else {
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
    }

    const size = statSync(target).size
    if (total > 0 && size < total * 0.98) {
      rmSync(target, { force: true })
      return { ok: false, error: `下载不完整（${size}/${total} 字节）` }
    }
    if (asset.sha256) {
      const actual = await sha256Of(target)
      if (actual !== asset.sha256.toLowerCase()) {
        rmSync(target, { force: true })
        return { ok: false, error: `安装包校验失败（期望 ${asset.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）` }
      }
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
