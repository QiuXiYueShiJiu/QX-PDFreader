// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 插件商店（2.0.0 新增，需求清单 B7 / B8 / B10）。
 *
 * ── 为什么从「主题商店」里拆出来 ──────────────────────────────
 *   1.9.0.0 的「插件商店」其实只是配色包市场：装完改几个颜色变量，
 *   不执行任何代码。真正的插件要跑代码、要权限、会崩，风险等级完全不同，
 *   混在一个面板里既误导用户，也没法做「权限确认」这种必须显眼的交互。
 *   所以：主题商店留在「设置 → 外观」，插件商店搬到右栏，两者各管各的。
 *
 * ── 面板结构 ─────────────────────────────────────────────────
 *   「发现」：来自独立插件库的清单（GitHub 默认，镜像兜底），可装可更新；
 *   「已装」：主进程扫出来的真实安装状态，可启停、卸载、打开目录。
 */

import { useEffect, useState } from 'react'
import { Download, FolderOpen, Github, Package, RefreshCw, Server, ShieldCheck, Trash2, X } from 'lucide-react'
import { useViewer } from '../store'

/** 权限的中文说明：装之前用户得看懂要授权什么 */
const PERMISSION_LABEL: Record<string, string> = {
  'document.read': '读取文档内容',
  'files.write': '保存文件',
  network: '联网',
  'ui.dialog': '弹出提示框',
  'settings.write': '修改设置'
}

function permText(list?: string[]): string {
  if (!list || list.length === 0) return '不需要特殊权限'
  return list.map((p) => PERMISSION_LABEL[p] ?? p).join('、')
}

export function PluginStore(): JSX.Element | null {
  const open = useViewer((s) => s.showPluginStore)
  const setOpen = useViewer((s) => s.setShowPluginStore)
  const shopItems = useViewer((s) => s.pluginShopItems)
  const shopError = useViewer((s) => s.pluginShopError)
  const shopSource = useViewer((s) => s.pluginShopSource)
  const shopLoading = useViewer((s) => s.pluginShopLoading)
  const setShopSource = useViewer((s) => s.setPluginShopSource)
  const loadShop = useViewer((s) => s.loadPluginShop)
  const installed = useViewer((s) => s.installedPlugins)
  const loadPlugins = useViewer((s) => s.loadPlugins)
  const installFromShop = useViewer((s) => s.installPluginFromShop)
  const installing = useViewer((s) => s.pluginInstalling)
  const installLocal = useViewer((s) => s.installPlugin)
  const uninstallPlugin = useViewer((s) => s.uninstallPlugin)
  const setPluginEnabled = useViewer((s) => s.setPluginEnabled)
  const note = useViewer((s) => s.pluginNote)
  const busy = useViewer((s) => s.pluginBusy)
  const [tab, setTab] = useState<'discover' | 'installed'>('discover')
  /*
   * 商店的检索与排序（B10）。
   * 插件库现在还小，但一旦上了十几二十个，没有搜索就是纯翻卡片；
   * 排序只给「默认 / 名称 / 作者」三档 —— 插件没有下载量这种指标，
   * 多给几种排序反而让人犹豫。
   */
  const [keyword, setKeyword] = useState('')
  const [sortBy, setSortBy] = useState<'default' | 'name' | 'author'>('default')
  /*
   * 分类筛选与详情页（B10）。
   * 分类直接取清单里出现过的值，不预设一套固定分类 —— 插件库的分类会变，
   * 写死的话作者就得反过来迁就客户端。详情页放在右侧抽屉里，
   * 因为卡片高度有限，塞不下截图和版本历史。
   */
  const [category, setCategory] = useState('全部')
  const [detailId, setDetailId] = useState('')

  useEffect(() => {
    if (!open) return
    if (shopItems === null) void loadShop()
    void loadPlugins()
  }, [open, shopItems, loadShop, loadPlugins])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  if (!open) return null

  const installedIds = new Set(installed.map((p) => p.id))
  const installedMap = new Map(installed.map((p) => [p.id, p]))

  /* 搜索 + 分类 + 排序后的清单（只影响「发现」页的展示，不动原始数据） */
  const visible = (shopItems ?? [])
    .filter((item) => {
      if (category !== '全部' && (item.category ?? '其它') !== category) return false
      const k = keyword.trim().toLowerCase()
      if (!k) return true
      return (
        item.name.toLowerCase().includes(k) ||
        (item.description ?? '').toLowerCase().includes(k) ||
        (item.author ?? '').toLowerCase().includes(k)
      )
    })
    .sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name, 'zh-Hans-CN')
      if (sortBy === 'author') return (a.author ?? '').localeCompare(b.author ?? '', 'zh-Hans-CN')
      return 0
    })

  /** 清单里出现过的分类，按出现顺序去重（第一项恒为「全部」） */
  const categories = ['全部', ...new Set((shopItems ?? []).map((item) => item.category ?? '其它'))]

  /** 已装版本比商店版本旧 → 有更新 */
  const hasUpdate = (id: string, version: string): boolean => {
    const local = installedMap.get(id)
    if (!local) return false
    return local.version !== version
  }

  /** 有更新的插件（「一键更新全部」用） */
  const updatable = (shopItems ?? []).filter((item) => hasUpdate(item.id, item.version))

  const detail = detailId ? (shopItems ?? []).find((item) => item.id === detailId) : undefined

  /** 顺序装完所有可更新项（串行：主进程一次只处理一个安装） */
  const updateAll = async (): Promise<void> => {
    for (const item of updatable) await installFromShop(item)
  }

  return (
    <div className="plugin-store" role="dialog" aria-label="插件商店" data-plugin-store="1">
      <div className="plugin-store__card">
        <header className="plugin-store__head">
          <div>
            <h2 className="plugin-store__title">插件商店</h2>
            <p className="plugin-store__sub">
              插件能扩展功能，也可能读写文件或联网 —— 装之前请看清它要哪些权限。主题配色在「设置 → 外观 → 主题商店」。
            </p>
          </div>
          <div className="plugin-store__tools">
            <button
              type="button"
              className="plugin-store__ghost"
              data-tb-id="plugin-store-refresh"
              onClick={() => void loadShop()}
              disabled={shopLoading}
            >
              <RefreshCw size={15} /> 刷新
            </button>
            <button
              type="button"
              className="plugin-store__ghost"
              data-tb-id="plugin-store-close"
              aria-label="关闭插件商店"
              onClick={() => setOpen(false)}
            >
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="plugin-store__tabs" role="tablist" aria-label="插件商店分页">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'discover'}
            className={`plugin-store__tab ${tab === 'discover' ? 'is-active' : ''}`}
            data-tb-id="plugin-tab-discover"
            onClick={() => setTab('discover')}
          >
            <Package size={15} /> 发现
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'installed'}
            className={`plugin-store__tab ${tab === 'installed' ? 'is-active' : ''}`}
            data-tb-id="plugin-tab-installed"
            onClick={() => setTab('installed')}
          >
            <ShieldCheck size={15} /> 已装 {installed.length > 0 ? `(${installed.length})` : ''}
          </button>
        </div>

        {note ? (
          <p className="plugin-store__note" data-plugin-note="1">
            {note}
          </p>
        ) : null}

        {tab === 'discover' ? (
          <>
            <div className="plugin-store__row">
              <div className="plugin-store__source" role="group" aria-label="清单来源">
                <button
                  type="button"
                  className={`plugin-store__ghost ${shopSource === 'github' ? 'is-active' : ''}`}
                  data-tb-id="plugin-source-github"
                  aria-pressed={shopSource === 'github'}
                  onClick={() => void setShopSource('github')}
                >
                  <Github size={14} /> GitHub
                </button>
                <button
                  type="button"
                  className={`plugin-store__ghost ${shopSource === 'mirror' ? 'is-active' : ''}`}
                  data-tb-id="plugin-source-mirror"
                  aria-pressed={shopSource === 'mirror'}
                  onClick={() => void setShopSource('mirror')}
                >
                  <Server size={14} /> 镜像
                </button>
              </div>
              <button
                type="button"
                className="plugin-store__ghost"
                data-tb-id="plugin-install-local"
                onClick={() => void installLocal()}
                disabled={busy}
                title="从本地选一个 .qxplugin 文件安装"
              >
                <FolderOpen size={15} /> 从文件安装
              </button>
            </div>

            {/* 搜索与排序（B10）：装了十几个插件以后没有检索就只能翻卡片 */}
            <div className="plugin-store__filter">
              <input
                className="plugin-store__search"
                data-tb-id="plugin-search"
                type="search"
                value={keyword}
                placeholder="搜插件名、说明或作者"
                aria-label="搜索插件"
                onChange={(e) => setKeyword(e.target.value)}
              />
              <label className="plugin-store__sort">
                排序
                <select
                  data-tb-id="plugin-sort"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as 'default' | 'name' | 'author')}
                >
                  <option value="default">默认</option>
                  <option value="name">名称</option>
                  <option value="author">作者</option>
                </select>
              </label>
              {updatable.length > 0 ? (
                <button
                  type="button"
                  className="plugin-store__ghost"
                  data-tb-id="plugin-update-all"
                  onClick={() => void updateAll()}
                  disabled={Boolean(installing)}
                  title="把这个清单里所有已装且有新版本的插件依次更新"
                >
                  <RefreshCw size={14} /> 更新全部 ({updatable.length})
                </button>
              ) : null}
            </div>

            {/* 分类筛选（B10）：分类来自清单本身，作者加新分类不用改客户端 */}
            {categories.length > 1 ? (
              <div className="plugin-store__cats" role="group" aria-label="插件分类">
                {categories.map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    className={`plugin-store__cat ${category === cat ? 'is-active' : ''}`}
                    data-tb-id={`plugin-cat-${cat}`}
                    aria-pressed={category === cat}
                    onClick={() => setCategory(cat)}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            ) : null}

            {shopError ? (
              <p className="plugin-store__note" data-plugin-shop-error="1">
                插件清单暂时取不到（GitHub 与镜像都没连上），可以过一会儿点「刷新」再试，或者用右上角「从文件安装」。
                <br />
                <span className="plugin-store__note-detail">{shopError}</span>
              </p>
            ) : null}
            {shopLoading && shopItems === null ? <p className="plugin-store__note">正在拉取插件清单…</p> : null}
            {shopItems !== null && shopItems.length === 0 && !shopError ? (
              <p className="plugin-store__note">插件库里还没有可用的插件。</p>
            ) : null}
            {shopItems !== null && shopItems.length > 0 && visible.length === 0 ? (
              <p className="plugin-store__note" data-plugin-search-empty="1">
                没有匹配「{keyword}」的插件。
              </p>
            ) : null}

            <div className="plugin-store__grid">
              {visible.map((item) => {
                const has = installedIds.has(item.id)
                const update = hasUpdate(item.id, item.version)
                return (
                  <article className="plugin-store__item" key={item.id} data-plugin-shop-item={item.id}>
                    <div className="plugin-store__item-head">
                      <h3 className="plugin-store__name">
                        {item.name}
                        {update ? (
                          <span className="plugin-store__bad plugin-store__bad--update">可更新</span>
                        ) : has ? (
                          <span className="plugin-store__tag">已装</span>
                        ) : null}
                      </h3>
                      <span className="plugin-store__ver">v{item.version}</span>
                    </div>
                    <p className="plugin-store__desc">{item.description ?? '没有说明'}</p>
                    <p className="plugin-store__perm">
                      <ShieldCheck size={13} /> {permText(item.permissions)}
                    </p>
                    <div className="plugin-store__item-foot">
                      <span className="plugin-store__author">{item.author ?? '佚名'}</span>
                      <button
                        type="button"
                        className="plugin-store__ghost"
                        data-tb-id={`plugin-detail-${item.id}`}
                        onClick={() => setDetailId(item.id)}
                      >
                        详情
                      </button>
                      <button
                        type="button"
                        className="plugin-store__install"
                        data-tb-id={`plugin-install-${item.id}`}
                        disabled={installing === item.id}
                        onClick={() => void installFromShop(item)}
                      >
                        <Download size={14} />{' '}
                        {installing === item.id ? '安装中…' : update ? '更新' : has ? '重新安装' : '安装'}
                      </button>
                    </div>
                  </article>
                )
              })}
            </div>
          </>
        ) : (
          <div className="plugin-store__list">
            {installed.length === 0 ? (
              <p className="plugin-store__note">还没有装任何插件。切到「发现」看看，或者从文件安装。</p>
            ) : null}
            {installed.map((plugin) => (
              <article className="plugin-store__row-item" key={plugin.id} data-plugin-installed={plugin.id}>
                <div className="plugin-store__row-main">
                  <h3 className="plugin-store__name">
                    {plugin.name}
                    <span className="plugin-store__ver">v{plugin.version}</span>
                    {plugin.error ? <span className="plugin-store__bad">加载失败</span> : null}
                  </h3>
                  <p className="plugin-store__desc">{plugin.error ?? plugin.description ?? '没有说明'}</p>
                  <p className="plugin-store__perm">
                    <ShieldCheck size={13} /> {permText(plugin.permissions)}
                  </p>
                </div>
                <div className="plugin-store__row-actions">
                  <button
                    type="button"
                    className="plugin-store__ghost"
                    data-tb-id={`plugin-toggle-${plugin.id}`}
                    aria-pressed={plugin.enabled}
                    onClick={() => void setPluginEnabled(plugin.id, !plugin.enabled)}
                  >
                    {plugin.enabled ? '停用' : '启用'}
                  </button>
                  <button
                    type="button"
                    className="plugin-store__danger"
                    data-tb-id={`plugin-uninstall-${plugin.id}`}
                    onClick={() => void uninstallPlugin(plugin.id)}
                    title="卸载这个插件"
                  >
                    <Trash2 size={14} /> 卸载
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}

        {/* 详情抽屉（B10）：截图、说明、版本历史、依赖都放这儿 */}
        {detail ? (
          <aside className="plugin-store__detail" data-plugin-detail={detail.id} role="dialog" aria-label={`${detail.name} 详情`}>
            <header className="plugin-store__detail-head">
              <h3 className="plugin-store__name">
                {detail.name} <span className="plugin-store__ver">v{detail.version}</span>
              </h3>
              <button
                type="button"
                className="plugin-store__ghost"
                data-tb-id="plugin-detail-close"
                aria-label="关闭详情"
                onClick={() => setDetailId('')}
              >
                <X size={15} />
              </button>
            </header>
            <p className="plugin-store__desc">{detail.description ?? '这个插件没有写说明。'}</p>
            {(detail.preview ?? []).length > 0 ? (
              <div className="plugin-store__shots">
                {(detail.preview ?? []).map((src) => (
                  <img key={src} className="plugin-store__shot" src={src} alt={`${detail.name} 效果图`} />
                ))}
              </div>
            ) : null}
            <dl className="plugin-store__meta">
              <dt>作者</dt>
              <dd>{detail.author ?? '佚名'}</dd>
              <dt>分类</dt>
              <dd>{detail.category ?? '其它'}</dd>
              <dt>权限</dt>
              <dd>{permText(detail.permissions)}</dd>
              {detail.minAppVersion ? (
                <>
                  <dt>最低版本</dt>
                  <dd>{detail.minAppVersion}</dd>
                </>
              ) : null}
              {(detail.requires ?? []).length > 0 ? (
                <>
                  <dt>依赖环境</dt>
                  <dd>{(detail.requires ?? []).join('、')}</dd>
                </>
              ) : null}
              {(detail.deps ?? []).length > 0 ? (
                <>
                  <dt>依赖插件</dt>
                  <dd>{(detail.deps ?? []).join('、')}</dd>
                </>
              ) : null}
            </dl>
            {(detail.versions ?? []).length > 0 ? (
              <ul className="plugin-store__versions">
                {(detail.versions ?? []).map((v) => (
                  <li key={v.version}>
                    <span className="plugin-store__ver">v{v.version}</span>
                    {v.date ? <span className="plugin-store__date">{v.date}</span> : null}
                    {v.note ? <span>{v.note}</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            <button
              type="button"
              className="plugin-store__install"
              data-tb-id={`plugin-detail-install-${detail.id}`}
              disabled={installing === detail.id}
              onClick={() => void installFromShop(detail)}
            >
              <Download size={14} />{' '}
              {installing === detail.id ? '安装中…' : hasUpdate(detail.id, detail.version) ? '更新' : installedIds.has(detail.id) ? '重新安装' : '安装'}
            </button>
          </aside>
        ) : null}
      </div>
    </div>
  )
}
