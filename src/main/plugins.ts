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
 *       "main": "main.js",
 *       "icon": "icon.png"            // 可选
 *     }
 *   代码入口 `main.js` 里必须导出 `activate(api)`。
 *
 * ── 为什么在主进程 + vm 沙箱 ─────────────────────────────────────
 *   用户选了「在主进程执行」：插件因此能碰本地文件、能联网、能做批量处理，
 *   这些渲染层沙箱做不到。代价是「权限声明」必须**真的拦得住**，
 *   否则那五项权限只是装饰。
 *
 *   做法：插件代码不在全局环境里 `require`，而是用 `vm.runInNewContext`
 *   跑在一个只有 `module` / `exports` / `console` / 受控 `api` 的上下文里，
 *   连 `require` 都不给 —— 想读文件只能走 `api.files`，想联网只能走
 *   `api.net`，两者都先查权限，没声明就抛错。这样即使插件作者写了
 *   `require('fs')`，也只会拿到 `undefined` 而不是真实模块。
 *
 * ── 崩溃策略 ───────────────────────────────────────────────────
 *   用户选了「弹框问禁用还是重试」。命令执行一律包在 try/catch 里，
 *   出错就弹原生对话框：禁用 → 标记该插件禁用并落盘；重试 → 直接再跑一次。
 *
 * ── 生效方式 ───────────────────────────────────────────────────
 *   安装/卸载/启停之后由界面提示「重启应用生效」。宿主在启动时一次性加载，
 *   运行期不再热插拔 —— 用户在选项里选的也是「装完提示重启」，简单可靠。
 */

import { app, dialog, ipcMain, net, shell } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import vm from 'node:vm'
import { unzipSync } from 'fflate'

/* ------------------------------------------------------------------ */
/* 类型                                                               */
/* ------------------------------------------------------------------ */

/** 权限：声明了才有对应能力，没声明调用即抛错 */
export type PluginPermission =
  | 'document.read'
  | 'files.write'
  | 'network'
  | 'ui.dialog'
  | 'settings.write'

export interface PluginManifest {
  id: string
  name: string
  version: string
  author?: string
  description?: string
  minAppVersion?: string
  permissions?: PluginPermission[]
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
  enabled: boolean
  dir: string
  /** 加载失败时的原因（清单坏了、代码抛异常），界面直接显示 */
  error?: string
}

interface PluginState {
  /** id → 是否启用（缺省视为启用） */
  enabled: Record<string, boolean>
}

/** 插件注册给界面的命令 */
interface PluginCommand {
  pluginId: string
  id: string
  label: string
  run: () => void | Promise<void>
}

/* ------------------------------------------------------------------ */
/* 路径与状态                                                          */
/* ------------------------------------------------------------------ */

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/
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
  const idDir = join(pluginsRoot(), pluginId)
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
/* 运行时：vm 沙箱 + 权限闸门                                          */
/* ------------------------------------------------------------------ */

const commands = new Map<string, PluginCommand>()

/** 当前打开的文档（由主进程维护，插件通过 api.document 读） */
let currentDocument: { path: string; text: string } = { path: '', text: '' }

export function setCurrentDocument(path: string, text: string): void {
  currentDocument = { path, text }
}

function hasPermission(plugin: InstalledPlugin, permission: PluginPermission): boolean {
  return plugin.permissions.includes(permission)
}

function deny(plugin: InstalledPlugin, permission: PluginPermission): never {
  throw new Error(`插件 ${plugin.id} 没有声明 ${permission} 权限，已拦截`)
}

/**
 * 给插件用的受控 API。
 *
 * 每个方法都先过权限；没声明就抛错，错误信息里带上插件 id 与权限名，
 * 用户从弹框里能直接看出是哪个插件越权。
 */
function createApi(plugin: InstalledPlugin): Record<string, unknown> {
  const commandsOfPlugin: string[] = []

  return {
    manifest: {
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      permissions: [...plugin.permissions]
    },
    document: {
      /** 当前文档路径（没打开文档返回空串） */
      getPath(): string {
        if (!hasPermission(plugin, 'document.read')) deny(plugin, 'document.read')
        return currentDocument.path
      },
      /** 当前页纯文本（由渲染层在切换页面时推上来） */
      getText(): string {
        if (!hasPermission(plugin, 'document.read')) deny(plugin, 'document.read')
        return currentDocument.text
      }
    },
    files: {
      /** 写文件：只允许写到用户选的目录（这里用保存对话框拿路径） */
      async save(defaultName: string, content: string): Promise<string> {
        if (!hasPermission(plugin, 'files.write')) deny(plugin, 'files.write')
        const picked = await dialog.showSaveDialog({
          title: `${plugin.name} · 保存`,
          defaultPath: defaultName
        })
        if (picked.canceled || !picked.filePath) return ''
        writeFileSync(picked.filePath, content, 'utf8')
        return picked.filePath
      }
    },
    net: {
      /** 联网取文本：走 Electron net（带代理与系统证书），只返回 body */
      async fetchText(url: string): Promise<string> {
        if (!hasPermission(plugin, 'network')) deny(plugin, 'network')
        if (!/^https?:\/\//i.test(url)) throw new Error('只允许 http/https')
        const res = await net.fetch(url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return await res.text()
      }
    },
    ui: {
      /** 弹一个原生提示（插件不能自绘窗口） */
      notify(message: string): void {
        if (!hasPermission(plugin, 'ui.dialog')) deny(plugin, 'ui.dialog')
        void dialog.showMessageBox({ type: 'info', message: String(message), buttons: ['好'] })
      },
      confirm(message: string): Promise<boolean> {
        if (!hasPermission(plugin, 'ui.dialog')) deny(plugin, 'ui.dialog')
        return dialog
          .showMessageBox({ type: 'question', message: String(message), buttons: ['取消', '确定'], defaultId: 1, cancelId: 0 })
          .then((r) => r.response === 1)
      }
    },
    settings: {
      get(): Record<string, unknown> {
        if (!hasPermission(plugin, 'settings.write')) deny(plugin, 'settings.write')
        return {}
      },
      set(): void {
        if (!hasPermission(plugin, 'settings.write')) deny(plugin, 'settings.write')
        throw new Error('修改设置需要在界面上显式确认，当前版本尚未开放写入')
      }
    },
    commands: {
      /**
       * 注册一个命令，它会出现在上栏「工具」选项卡的「插件」组里。
       * 命令 id 全局唯一：`<插件 id>:<名字>`，避免两个插件撞名。
       */
      register(input: { id: string; label: string; run: () => void | Promise<void> }): void {
        if (!input || typeof input.id !== 'string' || typeof input.label !== 'string') {
          throw new Error('commands.register 需要 { id, label, run }')
        }
        if (typeof input.run !== 'function') throw new Error('commands.register 缺少 run')
        const fullId = `${plugin.id}:${input.id}`
        commands.set(fullId, {
          pluginId: plugin.id,
          id: fullId,
          label: input.label,
          run: input.run
        })
        commandsOfPlugin.push(fullId)
      }
    }
  }
}

/** 启动时加载全部启用的插件 */
export function loadPlugins(): void {
  commands.clear()
  for (const plugin of listInstalled()) {
    if (!plugin.enabled) continue
    if (plugin.error) {
      console.warn(`[plugin] 跳过 ${plugin.id}：${plugin.error}`)
      continue
    }
    try {
      const manifestRaw = readFileSync(join(plugin.dir, 'manifest.json'), 'utf8')
      const manifest = JSON.parse(manifestRaw) as PluginManifest
      const entry = join(plugin.dir, manifest.main ?? 'main.js')
      const code = readFileSync(entry, 'utf8')
      const api = createApi(plugin)

      const sandbox: Record<string, unknown> = {
        module: { exports: {} as Record<string, unknown> },
        exports: {},
        console: {
          log: (...args: unknown[]) => console.log(`[plugin:${plugin.id}]`, ...args),
          warn: (...args: unknown[]) => console.warn(`[plugin:${plugin.id}]`, ...args),
          error: (...args: unknown[]) => console.error(`[plugin:${plugin.id}]`, ...args)
        },
        api,
        setTimeout,
        clearTimeout
      }
      sandbox.exports = (sandbox.module as { exports: unknown }).exports

      vm.createContext(sandbox)
      vm.runInContext(code, sandbox, { filename: `${plugin.id}/main.js`, timeout: 5000 })

      const exported = (sandbox.module as { exports: Record<string, unknown> }).exports
      const activate = exported?.activate
      if (typeof activate !== 'function') {
        console.warn(`[plugin] ${plugin.id} 没有导出 activate(api)，已跳过`)
        continue
      }
      void Promise.resolve((activate as (a: unknown) => unknown)(api)).catch((error) => {
        console.error(`[plugin] ${plugin.id} activate 抛错`, error)
      })
      console.log(`[plugin] 已加载 ${plugin.id}@${plugin.version}`)
    } catch (error) {
      console.error(`[plugin] ${plugin.id} 加载失败`, error)
    }
  }
}

export function listCommands(): { id: string; label: string; pluginId: string }[] {
  return [...commands.values()].map((c) => ({ id: c.id, label: c.label, pluginId: c.pluginId }))
}

/**
 * 执行命令。失败由这里弹原生对话框问「禁用还是重试」——
 * 用户选禁用就把插件停用并落盘，选重试就再跑一次（只重试一次，避免死循环）。
 */
export async function runCommand(commandId: string): Promise<{ ok: boolean; error?: string }> {
  const command = commands.get(commandId)
  if (!command) return { ok: false, error: '命令不存在（插件可能没加载）' }

  try {
    await command.run()
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
      commands.forEach((c, key) => {
        if (c.pluginId === command.pluginId) commands.delete(key)
      })
      return { ok: false, error: `${message}（插件已禁用，重启后生效）` }
    }
    try {
      await command.run()
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

  ipcMain.handle('plugin:commands', () => listCommands())

  ipcMain.handle('plugin:run', async (_e, commandId: unknown) => {
    if (typeof commandId !== 'string') return { ok: false, error: '命令 id 不合法' }
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
    try {
      const res = await net.fetch(url)
      if (!res.ok) return { ok: false, error: `下载失败：HTTP ${res.status}` }
      const bytes = new Uint8Array(await res.arrayBuffer())
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
