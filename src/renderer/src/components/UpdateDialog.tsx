// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

import { useEffect, useRef, useState } from 'react'
import { useViewer } from '../store'

/**
 * 更新提示（居中弹框）。
 *
 * 用户 2026-11-10 定的交互：
 *   「发现新更新不自动下载，而是先弹出提示框
 *     🔔 发现新版本 xxx / 立即更新 · 七天不通知 · 跳过这个版本 · 不再通知」
 *
 * 和旧版 UpdateToast 的区别：
 *   · 旧版一出现就自动下载；现在必须用户点「立即更新」才动网络
 *   · 旧版只有「现在就装 / 知道了」；现在多了三种「别再烦我」的粒度
 *   · 四种选择都写进 settings，主进程下次自动检查时按这些字段过滤
 *
 * 为什么用模态框：旧版做成浮层的理由是「不挡正文」，但用户明确要「先弹提示框」，
 * 而且这里只是问一句，点一下就没；更新本身仍然不会打断正在讲的页面。
 */
export function UpdateDialog(): JSX.Element | null {
  const info = useViewer((s) => s.updateInfo)
  const progress = useViewer((s) => s.updateProgress)
  const stage = useViewer((s) => s.updateStage)
  const file = useViewer((s) => s.updateFile)
  const dismissed = useViewer((s) => s.updateDismissed)
  const setStage = useViewer((s) => s.setUpdateStage)
  const dismiss = useViewer((s) => s.dismissUpdate)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const started = useRef(false)

  useEffect(() => {
    return window.pdfApp.update.onProgress((p) => useViewer.getState().setUpdateProgress(p))
  }, [])

  if (!info?.newer || dismissed) return null

  const percent = progress.fraction >= 0 ? Math.round(progress.fraction * 100) : -1
  const gotMb = (progress.received / 1024 / 1024).toFixed(1)
  const totalMb = progress.total > 0 ? (progress.total / 1024 / 1024).toFixed(1) : ''

  const patch = (p: Record<string, unknown>): void => {
    void useViewer.getState().patchSettings(p)
  }

  const startDownload = (): void => {
    if (started.current || !info.asset) return
    /* 有未导出的批注就先别下：下完要退出安装，未保存的内容会跟着一起没 */
    if (useViewer.getState().exportDirty) {
      setError('有未导出的批注：先导出 PDF，再点一次「立即更新」')
      return
    }
    started.current = true
    setBusy(true)
    setStage('downloading')
    setError('')
    void (async () => {
      const result = await window.pdfApp.update.download(info.asset!)
      if (!result.ok || !result.path) {
        setError(result.error ?? '下载失败')
        setStage('error')
        setBusy(false)
        started.current = false
        return
      }
      setStage('ready', result.path)
      /* 登记后由主进程在退出时用 /S 静默装；这里直接把应用关掉，用户不用再点一次 */
      /* 有未导出的批注就别退出：静默安装会带着未保存的内容一起关掉 */
      if (useViewer.getState().exportDirty) {
        setError('有未导出的批注：先导出 PDF，再点一次「立即更新」')
        setStage('ready', result.path)
        setBusy(false)
        started.current = false
        return
      }
      const staged = await window.pdfApp.update.stage(result.path)
      if (!staged.ok) {
        setError(staged.error ?? '登记安装包失败')
        setStage('error')
        setBusy(false)
        return
      }
      await window.pdfApp.app.quitNow()
    })()
  }

  const snooze7 = (): void => {
    patch({ updateSnoozeUntil: Date.now() + 7 * 24 * 60 * 60 * 1000 })
    dismiss()
  }
  const skipVersion = (): void => {
    patch({ updateSkipVersion: info.latest })
    dismiss()
  }
  const neverAgain = (): void => {
    patch({ updateNotify: 'never' })
    dismiss()
  }

  return (
    <div className="upd-mask" role="dialog" aria-modal="true" aria-labelledby="upd-title">
      <div className="upd-card" data-update-dialog="1">
        <h2 className="upd-title" id="upd-title">
          <span aria-hidden="true">🔔</span> 发现新版本 v{info.latest}
        </h2>
        <p className="upd-sub">
          当前 v{info.current}
          {info.source ? ` · ${info.source === 'special' ? '来自部署服务器' : info.source === 'github' ? '来自 GitHub' : '来自镜像站'}` : ''}
        </p>

        {stage === 'downloading' ? (
          <>
            <div className="upd-bar" aria-hidden="true">
              <span className="upd-bar-fill" style={{ width: percent >= 0 ? `${percent}%` : '35%' }} />
            </div>
            <p className="upd-hint">
              {percent >= 0 ? `正在下载 ${percent}%（${gotMb} / ${totalMb} MB）` : `正在下载（${gotMb} MB）`}
            </p>
          </>
        ) : null}

        {error ? <p className="upd-hint upd-hint--error">{error}</p> : null}

        <div className="upd-actions">
          <button
            type="button"
            className="upd-btn upd-btn--primary"
            data-tb-id="update-now"
            disabled={busy}
            onClick={startDownload}
          >
            {busy ? '正在下载…' : '立即更新'}
          </button>
          <button type="button" className="upd-btn" data-tb-id="update-snooze" disabled={busy} onClick={snooze7}>
            七天不通知
          </button>
          <button type="button" className="upd-btn" data-tb-id="update-skip" disabled={busy} onClick={skipVersion}>
            跳过这个版本
          </button>
          <button type="button" className="upd-btn" data-tb-id="update-never" disabled={busy} onClick={neverAgain}>
            不再通知
          </button>
        </div>

        <p className="upd-note">
          这些选项以后都能在「设置 → 更新」里改回来。选「立即更新」会先下载，下载完自动退出并安装。
        </p>
        {file ? null : null}
      </div>
    </div>
  )
}
