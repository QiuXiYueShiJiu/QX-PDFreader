// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 自绘标题栏。
 *
 * 为什么不用系统标题栏：
 *   教学一体机是触摸屏，系统标题栏的按钮太小、拖动区域也窄。
 *   自绘后可以把窗口控制按钮放大到 44×36，并整条支持拖动。
 *
 * 窗口拖动用 CSS 的 `-webkit-app-region: drag`（Electron 原生支持），
 * 按钮区域必须显式设成 `no-drag`，否则点不动。
 */

import { useEffect, useState } from 'react'
import { Minus, Square, X, Copy } from 'lucide-react'

export function TitleBar({ subtitle }: { subtitle?: string }): JSX.Element {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.pdfApp.win.isMaximized().then(setMaximized)

    // 双击标题栏切换最大化是通用直觉，这里同步状态
    const onResize = (): void => {
      void window.pdfApp.win.isMaximized().then(setMaximized)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return (
    <header className="titlebar">
      <div className="titlebar__brand">
        <span className="titlebar__logo" aria-hidden="true">
          PDF
        </span>
        <span className="titlebar__name">秋夕-PDF阅读器</span>
        {subtitle ? <span className="titlebar__subtitle">{subtitle}</span> : null}
      </div>

      <div className="titlebar__controls">
        <button
          className="titlebar__btn"
          onClick={() => void window.pdfApp.win.minimize()}
          title="最小化"
          aria-label="最小化"
        >
          <Minus size={15} />
        </button>
        <button
          className="titlebar__btn"
          onClick={() => void window.pdfApp.win.toggleMaximize().then(setMaximized)}
          title={maximized ? '向下还原' : '最大化'}
          aria-label={maximized ? '向下还原' : '最大化'}
        >
          {maximized ? <Copy size={13} /> : <Square size={13} />}
        </button>
        <button
          className="titlebar__btn titlebar__btn--close"
          onClick={() => void window.pdfApp.win.close()}
          title="关闭"
          aria-label="关闭"
        >
          <X size={16} />
        </button>
      </div>
    </header>
  )
}
