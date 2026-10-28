// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

import { useState } from 'react'
import { useViewer } from '../store'

/**
 * 启动声明（右下角圆角悬浮提示）。
 *
 * ── 为什么做成浮层而不是弹窗 ───────────────────────────────
 * 这句话（免费提供 / 早期版本 / 到哪反馈）对第一次用的人是必要信息，
 * 但它不阻塞任何操作。做成模态对话框会逼用户先点一下才能翻页，
 * 上课时反而添乱；做成右下角浮层，看到就看到，没看到也不耽误用。
 *
 * ── 三种关闭方式 ──────────────────────────────────────────
 *   1. 点右上角 ×：只对**本次启动**生效（下次还会出现）
 *   2. 勾「知道了，不再提示」再关：写进 settings.json，以后都不出现
 *   3. 设置面板里没有开关（用户要求的入口只有这一个）
 *
 * 颜色全部取主题变量（--surface / --text / --border / --muted / --accent），
 * 所以浅色、深色、米色三套主题下都是「当前主题的圆角提示框」，
 * 不需要为声明单独维护一套配色。
 */
export function DisclaimerToast(): JSX.Element | null {
  const hidden = useViewer((s) => s.settings.disclaimerHidden)
  const dismissed = useViewer((s) => s.disclaimerDismissed)
  const dismissDisclaimer = useViewer((s) => s.dismissDisclaimer)
  const patchSettings = useViewer((s) => s.patchSettings)
  const [muted, setMuted] = useState(false)

  // 勾过「不再提示」或本次已关掉，就直接不渲染
  if (hidden || dismissed) return null

  const close = (): void => {
    if (muted) void patchSettings({ disclaimerHidden: true })
    dismissDisclaimer()
  }

  return (
    <div className="disclaimer" role="status" aria-live="polite" data-disclaimer="1">
      <button
        type="button"
        className="disclaimer__close"
        aria-label="关闭声明"
        data-tb-id="disclaimer-close"
        onClick={close}
      >
        ×
      </button>

      <p className="disclaimer__title">声明</p>
      <ul className="disclaimer__lines">
        <li>本软件免费提供</li>
        <li>目前为早期版本，bug 较多</li>
        <li>如遇问题请报告给开发者</li>
      </ul>

      <label className="disclaimer__mute">
        <input
          type="checkbox"
          checked={muted}
          data-tb-id="disclaimer-mute"
          onChange={(e) => setMuted(e.target.checked)}
        />
        <span>知道了，不再提示</span>
      </label>
    </div>
  )
}
