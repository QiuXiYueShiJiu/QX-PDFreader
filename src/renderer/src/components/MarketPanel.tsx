// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 主题商店（主题扩展包）。
 *
 * 设计取舍：
 *   · 市场清单由镜像站的 `plugins.php` 提供，主进程代取（渲染层 CSP 不许直连外网）；
 *   · 安装 = 把主题变量写进 settings.customThemes 并切到 theme='custom'，
 *     不需要下载可执行文件，也就不存在「装插件把电脑搞坏」的风险；
 *   · 面板是浮层而不是第三个抽屉：一个屏幕宽的空间足够放下卡片网格。
 */

import { useEffect, useState } from 'react'
import { Download, Github, RefreshCw, Server, X } from 'lucide-react'
import { useViewer } from '../store'

export function MarketPanel(): JSX.Element | null {
  const showThemeStore = useViewer((s) => s.showThemeStore)
  const setShowThemeStore = useViewer((s) => s.setShowThemeStore)
  const items = useViewer((s) => s.marketItems)
  const error = useViewer((s) => s.marketError)
  const loadMarket = useViewer((s) => s.loadMarket)
  const installTheme = useViewer((s) => s.installTheme)
  const marketSource = useViewer((s) => s.settings.marketSource)
  const setMarketSource = useViewer((s) => s.setMarketSource)
  const [busy, setBusy] = useState('')

  useEffect(() => {
    if (showThemeStore && items === null) void loadMarket()
  }, [showThemeStore, items, loadMarket])

  useEffect(() => {
    if (!showThemeStore) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setShowThemeStore(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showThemeStore, setShowThemeStore])

  if (!showThemeStore) return null

  return (
    <div className="market" role="dialog" aria-label="主题商店" data-market="1">
      <div className="market__card">
        <header className="market__head">
          <div>
            <h2 className="market__title">主题商店</h2>
            <p className="market__sub">
              主题扩展包：装完立刻切换，随时可以切回内置的主题。默认从 GitHub 拉清单，连不上时可以在右上角换成镜像源。
            </p>
          </div>
          <div className="market__tools">
            {/*
              清单来源开关（2026-10-27 用户要求：默认 GitHub 源，可选 proxy 镜像源）。
              两个源同一份 schema，切换只改变「先问谁」——另一个仍会兜底。
            */}
            <div className="market__source" role="group" aria-label="清单来源">
              <button
                type="button"
                className={`market__ghost ${marketSource === 'github' ? 'is-active' : ''}`}
                data-tb-id="market-source-github"
                aria-pressed={marketSource === 'github'}
                onClick={() => void setMarketSource('github')}
                title="GitHub 源：仓库里的 plugins/index.json，官方原始清单"
              >
                <Github size={14} /> GitHub
              </button>
              <button
                type="button"
                className={`market__ghost ${marketSource === 'mirror' ? 'is-active' : ''}`}
                data-tb-id="market-source-mirror"
                aria-pressed={marketSource === 'mirror'}
                onClick={() => void setMarketSource('mirror')}
                title="镜像源：国内中转站，访问更快，含尚未同步到 GitHub 的新包"
              >
                <Server size={14} /> 镜像
              </button>
            </div>
            <button
              type="button"
              className="market__ghost"
              data-tb-id="market-refresh"
              onClick={() => void loadMarket()}
            >
              <RefreshCw size={15} /> 刷新
            </button>
            <button
              type="button"
              className="market__ghost"
              data-tb-id="market-close"
              aria-label="关闭主题商店"
              onClick={() => setShowThemeStore(false)}
            >
              <X size={16} />
            </button>
          </div>
        </header>

        {error ? <p className="market__note" data-market-error="1">{error}</p> : null}
        {items === null ? <p className="market__note">正在拉取市场清单…</p> : null}
        {items !== null && items.length === 0 ? (
          <p className="market__note">市场里还没有可用的主题包。</p>
        ) : null}

        <div className="market__grid">
          {(items ?? []).map((item) => (
            <article className="market__item" key={item.id} data-market-item={item.id}>
              <div className="market__preview" style={{ background: `rgb(${item.theme.bg})` }}>
                <span className="market__dot" style={{ background: `rgb(${item.theme.accent})` }} />
                <span className="market__line" style={{ background: `rgb(${item.theme.text})` }} />
                <span className="market__line market__line--short" style={{ background: `rgb(${item.theme.muted})` }} />
              </div>
              <div className="market__body">
                <h3 className="market__name">{item.name}</h3>
                <p className="market__desc">{item.desc ?? '主题扩展包'}</p>
                <p className="market__meta">
                  {item.author ? `${item.author} · ` : ''}
                  {item.version ? `v${item.version}` : ''}
                </p>
              </div>
              <button
                type="button"
                className="market__install"
                data-tb-id="market-install"
                data-market-install={item.id}
                disabled={busy === item.id}
                onClick={async () => {
                  setBusy(item.id)
                  try {
                    await installTheme(item)
                  } finally {
                    setBusy('')
                  }
                }}
              >
                <Download size={14} /> {busy === item.id ? '安装中…' : '安装并启用'}
              </button>
            </article>
          ))}
        </div>
      </div>
    </div>
  )
}
