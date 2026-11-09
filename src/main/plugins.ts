// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 插件宿主（2.0.0 新增，需求清单 B8）。
 *
 * ── 形态 ────────────────────────────────────────────────────────
 *   `.qxplugin` 是一个改了后缀的 zip，里面必须有 `manifest.json`：
 *     {
 *       "id": "com.example.markdown-export",
 *       "name": "Markdown 导出",
 *       "version": "1.0.0",
 *       "author": "某某",
 *       "description": "把当前页导出成 Markdown",
 *       "minAppVersion": "2.0.0",
 *       "permissions": ["document.read", "files.write"],
 *       "allowedHosts": ["api.example.com"],  // 可选：联网白名单，只支持 https
 *       "main": "main.js",
 *       "icon": "icon.png"            // 可选
 *     }
 *   代码入口 `main.js` 里必须导出 `activate(api)`。
 *
 * ── 为什么要放进 utilityProcess ─────────────────────────────────
 *   插件能碰本地文件、能联网、能做批量处理，这些渲染层沙箱做不到，
 *   所以必须有一个“有权限”的执行环境。但**不能是主进程**：
 *   旧实现用 `vm.runInNewContext` 把插件关进一个只有 `module` / `exports` /
 *   `console` / `api` 的上下文，看起来没给 `require` —— 可 vm 不是安全边界，
 *   插件只要拿到 `api` 上的任意函数，就能顺着 `constructor.constructor`
 *   拿到主进程的 `Function`，再拿到 `process` / `require` / `fs`，
 *   等于任意代码执行。所以 vm 里那五项权限声明其实拦不住任何东西。
 *
 *   现在插件代码跑在独立的 utilityProcess（见 plugin-host.ts）：
 *   即使插件拿到那个进程的 `process` / `require`，也只是子进程，
 *   碰不到主进程的窗口、IPC、用户数据目录。真正需要的能力全部以消息
 *   请求主进程，由 plugin-broker.ts 按本文件从磁盘 manifest 读出的
 *   permissions 逐条放行 —— 子进程自称有权限不作数。
 *
 * ── 崩溃策略 ───────────────────────────────────────────────────
 *   用户选了「弹框问禁用还是重试」。命令执行一律包在 try/catch 里，
 *   出错就弹原生对话框：禁用 → 标记该插件禁用并落盘；重试 → 直接再跑一次。
 *   进程级崩溃（OOM、未捕获异常）由 broker 记 `plugin-crash` 到 crash.log，
 *   并且只影响那一个插件的宿主，不会带崩应用。
 *
 * ── 生效方式 ───────────────────────────────────────────────────
 *   安装/卸载/启停之后由界面提示「重启应用生效」。宿主在启动时一次性加载，
 *   运行期不再热插拔 —— 用户在选项里选的也是「装完提示重启」，简单可靠。
 */

import { app, dialog, ipcMain, net, shell } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { unzipSync } from 'fflate'
import { crashLog } from './crash-log'
import {
  findHostedCommand,
  listHostedCommands,
  runHostedCommand,
  setCurrentDocument,
  startPlugin,
  stopAllHosts,
  stopPlugin,
  waitForHostsReady
} from './plugin-broker'
import type { PluginHostSpec, PluginPermission } from './plugin-protocol'

/*
 * 权限类型搬到了 plugin-protocol.ts（主进程与子进程共用的纯类型文件）。
 * 这里重新导出，保持 `import { PluginPermission } from './plugins'` 的旧写法可用。
 */
export type { PluginPermission } from './plugin-protocol'

/** 当前文档状态现在归 broker 管（插件读的是它那份），这里原样转出去 */
export { setCurrentDocument }

/* ------------------------------------------------------------------ */
/* 类型                                                               */
/* ------------------------------------------------------------------ */

export interface PluginManifest {
  id: string
  name: string
  version: string
  author?: string
  description?: string
  minAppVersion?: string
  permissions?: PluginPermission[]
  /**
   * 插件自己需要联网的域名（不含协议，只写主机名，子域自动允许）。
   * 插件能碰哪些站必须写进清单让用户看见，不能靠运行期随便请求。
   */
  allowedHosts?: string[]
  main?: string
  icon?: string
}

export interface InstalledPlugin {
  id: string
  name: string
  version: string
  author: string
  description: string
  permissions: PluginPermission[]
  allowedHosts: string[]
  enabled: boolean
  dir: string
  /** 加载失败时的原因（清单坏了、代码抛异常），界面直接显示 */
  error?: string
}

interface PluginState {
  /** id → 是否启用（缺省视为启用） */
  enabled: Record<string, boolean>
}

/* ------------------------------------------------------------------ */
/* 路径与状态                                                          */
/* ------------------------------------------------------------------ */

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/
/** 主机名：允许普通域名/IP，不允许协议、路径、端口写成白名单项 */
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i
const ALLOWED_PERMISSIONS: PluginPermission[] = [
  'document.read',
  'files.write',
  'network',
  'ui.dialog',
  'settings.write'
]

function pluginsRoot(): string {
  return join(app.getPath('userData'), 'plugins')
}

function statePath(): string {
  return join(app.getPath('userData'), 'plugins.json')
}

function readState(): PluginState {
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf8')) as PluginState
    return { enabled: raw?.enabled && typeof raw.enabled === 'object' ? raw.enabled : {} }
  } catch {
    return { enabled: {} }
  }
}

function writeState(state: PluginState): void {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(statePath(), JSON.stringify(state, null, 2), 'utf8')
  } catch (error) {
    console.error('[plugin] 写状态失败', error)
  }
}

/* ------------------------------------------------------------------ */
/* 已安装列表                                                          */
/* ------------------------------------------------------------------ */

/**
 * 扫描 `plugins/<id>/<version>/manifest.json`。
 *
 * 同一 id 装了多个版本时只取目录名最大的那个（按字符串比较即可：
 * 版本号是点分数字，位数不同的情况极少，这里不做 semver 排序，
 * 因为安装流程本身会把旧版本删掉，多版本共存只在开发时出现）。
 */
export function listInstalled(): InstalledPlugin[] {
  const root = pluginsRoot()
  if (!existsSync(root)) return []
  const state = readState()
  const out: InstalledPlugin[] = []

  for (const id of readdirSync(root)) {
    const idDir = join(root, id)
    let versions: string[] = []
    try {
      versions = readdirSync(idDir)
    } catch {
      continue
    }
    if (versions.length === 0) continue
    versions.sort()
    const version = versions[versions.length - 1]
    const dir = join(idDir, version)
    const manifestPath = join(dir, 'manifest.json')
    let manifest: PluginManifest | null = null
    let error: string | undefined

    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PluginManifest
    } catch (e) {
      error = `清单读不出来：${(e as Error).message}`
    }

    if (manifest) {
      const problem = validateManifest(manifest)
      if (problem) {
        error = problem
        manifest = null
      }
    }

    out.push({
      id,
      name: manifest?.name ?? id,
      version: manifest?.version ?? version,
      author: manifest?.author ?? '',
      description: manifest?.description ?? '',
      permissions: manifest?.permissions ?? [],
      allowedHosts: manifest?.allowedHosts ?? [],
      enabled: state.enabled[id] !== false,
      dir,
      error
    })
  }

  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

/** 返回错误文案；没问题返回 null */
export function validateManifest(manifest: PluginManifest): string | null {
  if (!manifest || typeof manifest !== 'object') return '清单不是对象'
  if (typeof manifest.id !== 'string' || !PLUGIN_ID_RE.test(manifest.id)) return 'id 不合法（小写字母/数字/._-，2–64 字符）'
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) return '缺少 name'
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) return 'version 必须是 x.y.z'
  if (manifest.main !== undefined && typeof manifest.main !== 'string') return 'main 必须是字符串'
  if (manifest.permissions !== undefined) {
    if (!Array.isArray(manifest.permissions)) return 'permissions 必须是数组'
    const bad = manifest.permissions.find((p) => !ALLOWED_PERMISSIONS.includes(p as PluginPermission))
    if (bad) return `未知权限 ${String(bad)}`
  }
  if (manifest.allowedHosts !== undefined) {
    if (!Array.isArray(manifest.allowedHosts)) return 'allowedHosts 必须是数组'
    if (manifest.allowedHosts.length > 32) return 'allowedHosts 最多 32 条'
    const bad = manifest.allowedHosts.find(
      (host) => typeof host !== 'string' || host.length > 253 || !HOSTNAME_RE.test(host)
    )
    if (bad !== undefined) return `allowedHosts 里有不合法的主机名：${String(bad)}`
  }
  return null
}

/* ------------------------------------------------------------------ */
/* 安装 / 卸载                                                         */
/* ------------------------------------------------------------------ */

export interface InstallResult {
  ok: boolean
  plugin?: InstalledPlugin
  error?: string
}

/**
 * 从 .qxplugin（zip）安装。
 *
 * 安全线：
 *   · zip 里不允许出现 `..` 或绝对路径（防 zip-slip）；
 *   · 必须先有合法 manifest.json 才落盘；
 *   · 同 id 的旧版本目录整体删掉，避免多个版本互相覆盖。
 */
export function installFromArchive(archivePath: string): InstallResult {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(readFileSync(archivePath)))
  } catch (error) {
    return { ok: false, error: `解压失败：${(error as Error).message}` }
  }

  for (const name of Object.keys(files)) {
    if (name.startsWith('/') || name.includes('..')) {
      return { ok: false, error: `压缩包里有非法路径：${name}` }
    }
  }

  const manifestRaw = files['manifest.json']
  if (!manifestRaw) return { ok: false, error: '压缩包根目录缺少 manifest.json' }

  let manifest: PluginManifest
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestRaw)) as PluginManifest
  } catch (error) {
    return { ok: false, error: `manifest.json 不是合法 JSON：${(error as Error).message}` }
  }

  const problem = validateManifest(manifest)
  if (problem) return { ok: false, error: problem }

  const entry = manifest.main ?? 'main.js'
  if (!files[entry]) return { ok: false, error: `入口文件 ${entry} 不在压缩包里` }

  const idDir = join(pluginsRoot(), manifest.id)
  const target = join(idDir, manifest.version)
  try {
    rmSync(idDir, { recursive: true, force: true })
    mkdirSync(target, { recursive: true })
    for (const [name, bytes] of Object.entries(files)) {
      if (name.endsWith('/')) continue
      const dst = join(target, name)
      // 再查一次：join 之后仍必须落在 target 之内
      if (!resolve(dst).startsWith(resolve(target))) {
        return { ok: false, error: `压缩包里有越界路径：${name}` }
      }
      mkdirSync(join(dst, '..'), { recursive: true })
      writeFileSync(dst, bytes)
    }
  } catch (error) {
    return { ok: false, error: `写入插件目录失败：${(error as Error).message}` }
  }

  const state = readState()
  state.enabled[manifest.id] = true
  writeState(state)

  /*
   * 立刻重载一次：新插件当场就能用，用户不必等重启才看见「插件」组。
   * 重启仍然建议（界面也会提示），因为插件可能注册了定时器或占了资源，
   * 重新加载是唯一干净的起点。
   */
  loadPlugins()

  // 装完立刻给一份新列表，界面不用自己拼
  const installed = listInstalled().find((p) => p.id === manifest.id)
  return { ok: true, plugin: installed }
}

export function uninstall(pluginId: string): { ok: boolean; error?: string } {
  /*
   * ★ 2026-11-09 安全审计 P0：这里以前直接 join 后 rmSync，没有校验 id。
   *   plugin:uninstall('..\\..') 会让 idDir 指到 %APPDATA% 并递归删除 ——
   *   一次 IPC 就能删光用户目录。现在三重校验：形态、父级、resolve 前缀。
   */
  if (!PLUGIN_ID_RE.test(pluginId)) {
    return { ok: false, error: '插件 id 不合法' }
  }
  const root = pluginsRoot()
  const idDir = join(root, pluginId)
  if (dirname(idDir) !== root || !resolve(idDir).startsWith(resolve(root) + sep)) {
    return { ok: false, error: '插件目录越界' }
  }
  if (!existsSync(idDir)) return { ok: false, error: '没有这个插件' }
  try {
    rmSync(idDir, { recursive: true, force: true })
  } catch (error) {
    return { ok: false, error: `删除失败：${(error as Error).message}` }
  }
  const state = readState()
  delete state.enabled[pluginId]
  writeState(state)
  /* 卸掉就把它的命令从表里摘掉，否则工具栏里会留一个点了没反应的按钮 */
  loadPlugins()
  return { ok: true }
}

export function setEnabled(pluginId: string, enabled: boolean): { ok: boolean } {
  const state = readState()
  state.enabled[pluginId] = enabled
  writeState(state)
  return { ok: true }
}

/* ------------------------------------------------------------------ */
/* 运行时：utilityProcess 宿主 + 权限闸门                              */
/* ------------------------------------------------------------------ */

/**
 * 每次 loadPlugins 自增；异步启动完成时如果 token 已经过期，
 * 说明期间又 reload 过（装/卸/启停），这个结果直接丢弃，
 * 否则旧插件的宿主进程会赖在内存里。
 */
let loadSeq = 0

/**
 * 启动时加载全部启用的插件。
 *
 * 这里只做「读清单、拼 spec、交给 broker」三件事；代码执行、api 代理、
 * 权限判断全在子进程 / broker 侧（见 plugin-host.ts、plugin-broker.ts）。
 * 主进程里没有 vm，也没有给插件准备的任何宿主对象。
 */
export function loadPlugins(): void {
  const token = ++loadSeq
  stopAllHosts()
  for (const plugin of listInstalled()) {
    if (!plugin.enabled) continue
    if (plugin.error) {
      console.warn(`[plugin] 跳过 ${plugin.id}：${plugin.error}`)
      continue
    }
    void startOne(plugin, token)
  }
}

async function startOne(plugin: InstalledPlugin, token: number): Promise<void> {
  try {
    const manifestRaw = readFileSync(join(plugin.dir, 'manifest.json'), 'utf8')
    const manifest = JSON.parse(manifestRaw) as PluginManifest
    const problem = validateManifest(manifest)
    if (problem) throw new Error(problem)

    /*
     * manifest.main 是插件作者写的字符串，必须挡住 `../` 越界：
     * 入口只能在插件自己的目录里，否则等于让插件决定主进程去读哪个文件。
     */
    const entry = resolve(join(plugin.dir, manifest.main ?? 'main.js'))
    if (!entry.startsWith(resolve(plugin.dir) + sep)) throw new Error('入口文件越界')

    const code = readFileSync(entry, 'utf8')
    if (token !== loadSeq) return

    // spec 完全来自磁盘清单；子进程之后说什么都不会改变这里的权限
    const spec: PluginHostSpec = {
      id: plugin.id,
      name: manifest.name,
      version: manifest.version,
      permissions: manifest.permissions ?? [],
      allowedHosts: manifest.allowedHosts ?? []
    }
    await startPlugin(spec, code)
  } catch (error) {
    if (token !== loadSeq) return
    console.error(`[plugin] ${plugin.id} 加载失败`, error)
    crashLog('plugin-load-error', {
      pluginId: plugin.id,
      error: (error as Error)?.message ?? String(error)
    })
  }
}

/* 命令表在 broker 里，和宿主进程同生命周期；这里只负责转发给界面 */
export function listCommands(): { id: string; label: string; pluginId: string }[] {
  return listHostedCommands()
}

/**
 * 执行命令。失败由这里弹原生对话框问「禁用还是重试」——
 * 用户选禁用就把插件停用并落盘（同时杀掉宿主进程），选重试就再跑一次
 * （只重试一次，避免死循环）。
 */
export async function runCommand(commandId: string): Promise<{ ok: boolean; error?: string }> {
  const command = findHostedCommand(commandId)
  if (!command) return { ok: false, error: '命令不存在（插件可能没加载）' }

  try {
    await runHostedCommand(commandId)
    return { ok: true }
  } catch (error) {
    const message = (error as Error)?.message ?? String(error)
    console.error(`[plugin] 命令 ${commandId} 抛错`, error)
    const plugin = listInstalled().find((p) => p.id === command.pluginId)
    const choice = await dialog.showMessageBox({
      type: 'error',
      title: '插件出错',
      message: `插件「${plugin?.name ?? command.pluginId}」执行命令时出错`,
      detail: message,
      buttons: ['禁用这个插件', '重试一次'],
      defaultId: 1,
      cancelId: 1
    })
    if (choice.response === 0) {
      setEnabled(command.pluginId, false)
      stopPlugin(command.pluginId)
      return { ok: false, error: `${message}（插件已禁用，重启后生效）` }
    }
    try {
      await runHostedCommand(commandId)
      return { ok: true }
    } catch (again) {
      return { ok: false, error: (again as Error)?.message ?? String(again) }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 商店清单（独立仓库 QX-PluginIndex，与主题清单分开）                  */
/* ------------------------------------------------------------------ */

export interface PluginIndexItem {
  id: string
  name: string
  version: string
  author?: string
  description?: string
  /** 插件包下载地址（GitHub release 或镜像 asset.php） */
  download: string
  sha256?: string
  size?: number
  minAppVersion?: string
  permissions?: PluginPermission[]
  icon?: string
  /** 2.0.0 B9：分类、标签、效果图、依赖、版本历史（原样透传给商店） */
  category?: string
  tags?: string[]
  preview?: string[]
  requires?: string[]
  deps?: string[]
  versions?: { version: string; date?: string; note?: string }[]
}

/**
 * 两条清单地址。
 *
 * 用户第 5 条说的「GitHub 上没有专门的插件市场库」就是指这里：插件清单
 * 应该有自己独立的仓库，不跟主题清单混。默认 GitHub，镜像站兜底。
 */
const PLUGIN_INDEX_SOURCES: Record<'github' | 'mirror', string> = {
  github: 'https://raw.githubusercontent.com/QiuXiYueShiJiu/QX-PluginIndex/main/index.json',
  mirror: 'https://xn--6rso4u4lc86ad09c.top/contact/plugins-index.php'
}

export async function fetchPluginIndex(
  prefer: 'github' | 'mirror' = 'github'
): Promise<{ ok: boolean; items: PluginIndexItem[]; source?: string; error?: string }> {
  const order: ('github' | 'mirror')[] = prefer === 'mirror' ? ['mirror', 'github'] : ['github', 'mirror']
  let lastError = ''
  for (const key of order) {
    try {
      /* Electron 的 net.fetch 不吃 cache 选项；缓存靠地址里的时间戳参数旁路 */
      const res = await net.fetch(`${PLUGIN_INDEX_SOURCES[key]}${PLUGIN_INDEX_SOURCES[key].includes('?') ? '&' : '?'}t=${Date.now()}`)
      if (!res.ok) {
        lastError = `${key} 返回 HTTP ${res.status}`
        continue
      }
      const payload = (await res.json()) as { items?: PluginIndexItem[] }
      const items = Array.isArray(payload?.items) ? payload.items : []
      return { ok: true, items, source: key }
    } catch (error) {
      lastError = `${key} 连不上：${(error as Error).message}`
    }
  }
  return { ok: false, items: [], error: lastError || '插件清单不可用' }
}

/** 插件目录的哈希（调试用：确认装的是哪份包） */export function pluginDirHash(pluginId: string): string {
  const root = join(pluginsRoot(), pluginId)
  if (!existsSync(root)) return ''
  try {
    return createHash('sha1').update(root).digest('hex').slice(0, 12)
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------ */
/* IPC                                                                */
/* ------------------------------------------------------------------ */

export function registerPluginIpc(): void {
  ipcMain.handle('plugin:list', () => listInstalled())

  ipcMain.handle('plugin:index', async (_e, prefer: unknown) =>
    fetchPluginIndex(prefer === 'mirror' ? 'mirror' : 'github')
  )

  /*
   * 宿主是异步启动的：界面一上来就取命令表，必须等这一轮启动落地，
   * 否则会稳定拿到空列表（旧实现同步 vm，没这个窗口）。
   * 某个插件启动失败不影响其他插件，waitForHostsReady 内部吞掉失败。
   */
  ipcMain.handle('plugin:commands', async () => {
    await waitForHostsReady()
    return listCommands()
  })

  ipcMain.handle('plugin:run', async (_e, commandId: unknown) => {
    if (typeof commandId !== 'string') return { ok: false, error: '命令 id 不合法' }
    await waitForHostsReady()
    return runCommand(commandId)
  })

  ipcMain.handle('plugin:install', async (e) => {
    const picked = await dialog.showOpenDialog({
      title: '选择插件包',
      filters: [{ name: '秋夕插件包', extensions: ['qxplugin', 'zip'] }],
      properties: ['openFile']
    })
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true }
    const result = installFromArchive(picked.filePaths[0])
    if (result.ok) {
      // 让安装对话框所在窗口立刻刷新列表
      e.sender.send('plugin:changed', listInstalled())
    }
    return result
  })

  ipcMain.handle('plugin:install-path', (_e, archivePath: unknown) => {
    /* 本地导入的测试通道：界面不用它，验证脚本用它装一个构造好的包 */
    if (typeof archivePath !== 'string') return { ok: false, error: '路径不合法' }
    return installFromArchive(archivePath)
  })

  /**
   * 从商店装：先下载到临时文件，校验 sha256（清单里给了就必须对），再安装。
   * 不给 sha256 也允许，但会在返回里标 `verified:false`，界面上提示「未校验来源」。
   */
  ipcMain.handle('plugin:install-url', async (_e, url: unknown, sha256: unknown) => {
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) {
      return { ok: false, error: '下载地址不合法' }
    }
    /*
     * ★ 审计 P1：原来只要求 https，于是网页里任何地址都能让主进程下载并安装。
     *   现在只放行自己的商店域名与 GitHub（插件清单的两个来源）。
     */
    const host = (() => {
      try {
        return new URL(url).hostname.toLowerCase()
      } catch {
        return ''
      }
    })()
    const ALLOWED_HOSTS = [
      'xn--6rso4u4lc86ad09c.top',
      'github.com',
      'objects.githubusercontent.com',
      'raw.githubusercontent.com'
    ]
    if (!ALLOWED_HOSTS.includes(host)) {
      return { ok: false, error: `不接受来自 ${host || '未知地址'} 的安装包` }
    }
    try {
      const res = await net.fetch(url)
      if (!res.ok) return { ok: false, error: `下载失败：HTTP ${res.status}` }
      const declared = Number(res.headers.get('content-length') ?? 0) || 0
      if (declared > 32 * 1024 * 1024) {
        return { ok: false, error: '安装包过大（插件上限 32 MB）' }
      }
      const bytes = new Uint8Array(await res.arrayBuffer())
      if (bytes.byteLength > 32 * 1024 * 1024) {
        return { ok: false, error: '安装包过大（插件上限 32 MB）' }
      }
      const expect = typeof sha256 === 'string' ? sha256.trim().toLowerCase() : ''
      let verified = false
      if (expect) {
        const actual = createHash('sha256').update(bytes).digest('hex')
        if (actual !== expect) {
          return { ok: false, error: `校验失败：期望 ${expect.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…` }
        }
        verified = true
      }
      const tmp = join(app.getPath('temp'), `qxplugin-${Date.now()}.qxplugin`)
      writeFileSync(tmp, bytes)
      const result = installFromArchive(tmp)
      rmSync(tmp, { force: true })
      return { ...result, verified }
    } catch (error) {
      return { ok: false, error: `下载安装失败：${(error as Error).message}` }
    }
  })

  ipcMain.handle('plugin:uninstall', (_e, pluginId: unknown) => {
    if (typeof pluginId !== 'string') return { ok: false, error: 'id 不合法' }
    return uninstall(pluginId)
  })

  ipcMain.handle('plugin:set-enabled', (_e, pluginId: unknown, enabled: unknown) => {
    if (typeof pluginId !== 'string') return { ok: false, error: 'id 不合法' }
    return setEnabled(pluginId, Boolean(enabled))
  })

  ipcMain.handle('plugin:open-folder', () => {
    mkdirSync(pluginsRoot(), { recursive: true })
    void shell.openPath(pluginsRoot())
    return pluginsRoot()
  })

  ipcMain.handle('plugin:set-document', (_e, path: unknown, text: unknown) => {
    setCurrentDocument(typeof path === 'string' ? path : '', typeof text === 'string' ? text : '')
    return true
  })
}
