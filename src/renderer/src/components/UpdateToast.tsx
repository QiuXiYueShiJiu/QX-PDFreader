// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

import { useEffect, useRef, useState } from 'react'
import { useViewer } from '../store'

/**
 * 更新提示（右下角圆角浮层）。
 *
 * ── 交互流程（按用户要求）────────────────────────────────────
 *   1. 启动时主进程静默查一次；查到新版本 → 推 app:update-available
 *   2. 本组件一出现就**自动开始下载**，边下边显示百分比
 *   3. 下完不擅自安装，改成「立即安装 / 稍后」——安装会关掉当前窗口，
 *      上课中途被强退是最糟的体验
 *   4. 「稍后」只是关掉浮层，安装包留在 userData\updates 里，
 *      下次启动还会再提示（版本没变就还是它）
 *
 * ── 为什么不用模态框 ──────────────────────────────────────────
 *   和启动声明同一个理由：更新不阻塞翻页/批注。用户正在讲题时弹个
 *   必须点掉的框很讨厌，右下角浮层不挡正文，也随时能关。
 *
 * 颜色取主题变量（--surface/--text/--border/--muted/--accent），
 * 三套主题下自动适配，不单独维护配色。
 */
export function UpdateToast(): JSX.Element | null {
  const updateInfo = useViewer((s) => s.updateInfo)
  const updateProgress = useViewer((s) => s.updateProgress)
  const updateStage = useViewer((s) => s.updateStage)
  const updateDismissed = useViewer((s) => s.updateDismissed)
  const updateFile = useViewer((s) => s.updateFile)
  const setUpdateInfo = useViewer((s) => s.setUpdateInfo)
  const setUpdateProgress = useViewer((s) => s.setUpdateProgress)
  const setUpdateStage = useViewer((s) => s.setUpdateStage)
  const dismissUpdate = useViewer((s) => s.dismissUpdate)
  const [error, setError] = useState('')
  const [backingUp, setBackingUp] = useState(false)
  const started = useRef(false)

  // 主进程推来的「有新版本」事件
  useEffect(() => {
    return window.pdfApp.update.onAvailable((info) => {
      setUpdateInfo(info)
      setUpdateStage('downloading')
      setError('')
      started.current = false
    })
  }, [setUpdateInfo, setUpdateStage])

  // 下载进度
  useEffect(() => {
    return window.pdfApp.update.onProgress((p) => setUpdateProgress(p))
  }, [setUpdateProgress])

  /**
   * 浮层出现后自动开下。
   *
   * 用 started ref 而不是 stage 判断：React 18 严格模式下 effect 会跑两次，
   * 没有这个闸门就会发两次下载请求（第二次被主进程的「已有一个下载任务」挡掉，
   * 但白白多跑一次 invoke）。
   */
  useEffect(() => {
    if (!updateInfo?.newer || !updateInfo.asset || updateDismissed) return
    if (started.current) return
    started.current = true
    void (async () => {
      const result = await window.pdfApp.update.download(updateInfo.asset!)
      if (result.ok) {
        setUpdateStage('ready', result.path)
      } else {
        setError(result.error ?? '下载失败')
        setUpdateStage('error')
      }
    })()
  }, [updateInfo, updateDismissed, setUpdateStage])

  if (!updateInfo?.newer || updateDismissed) return null

  const percent = updateProgress.fraction >= 0 ? Math.round(updateProgress.fraction * 100) : -1
  const totalMb = updateProgress.total > 0 ? (updateProgress.total / 1024 / 1024).toFixed(1) : ''
  const gotMb = (updateProgress.received / 1024 / 1024).toFixed(1)

  const install = (): void => {
    void (async () => {
      /* 装之前先把偏好与阅读位置备份一份：新版本起不来时用户还能把 settings.json 拷回去 */
      setBackingUp(true)
      try {
        await window.pdfApp.update.backup()
      } finally {
        setBackingUp(false)
      }
      const result = await window.pdfApp.update.install(updateFile)
      if (!result.ok) setError(result.error ?? '打不开安装包')
    })()
  }

  return (
    <div className="update-toast" role="status" aria-live="polite" data-update-toast="1">
      <button
        type="button"
        className="update-toast__close"
        aria-label="关闭更新提示"
        data-tb-id="update-close"
        onClick={dismissUpdate}
      >
        ×
      </button>

      <p className="update-toast__title">
        发现新版本 <span className="update-toast__version">v{updateInfo.latest}</span>
      </p>
      <p className="update-toast__sub">
        当前 v{updateInfo.current}
        {updateInfo.source ? (
          <span className="update-toast__source" data-update-source={updateInfo.source}>
            {' · '}
            {updateInfo.source === 'github'
              ? '来自 GitHub'
              : updateInfo.source === 'special'
                ? '来自部署服务器'
                : '来自镜像站'}
          </span>
        ) : null}
      </p>

      {updateStage === 'downloading' && (
        <>
          <div className="update-toast__bar" aria-hidden="true">
            <span
              className="update-toast__bar-fill"
              style={{ width: percent >= 0 ? `${percent}%` : '35%' }}
              data-update-percent={percent}
            />
          </div>
          <p className="update-toast__hint" data-update-stage="downloading">
            {percent >= 0
              ? `正在下载 ${percent}%（${gotMb} / ${totalMb} MB）`
              : `正在下载（${gotMb} MB）`}
          </p>
        </>
      )}

      {updateStage === 'ready' && (
        <>
          <p className="update-toast__hint" data-update-stage="ready">
            下载完成，关闭程序后即可安装
          </p>
          <div className="update-toast__actions">
            <button
              type="button"
              className="update-toast__btn update-toast__btn--primary"
              data-tb-id="update-install"
              disabled={backingUp}
              onClick={install}
            >
              {backingUp ? '备份数据中…' : '立即安装'}
            </button>
            <button
              type="button"
              className="update-toast__btn"
              data-tb-id="update-later"
              onClick={dismissUpdate}
            >
              稍后
            </button>
          </div>
        </>
      )}

      {updateStage === 'error' && (
        <>
          <p className="update-toast__hint update-toast__hint--error" data-update-stage="error">
            {error || '更新下载失败'}
          </p>
          <div className="update-toast__actions">
            {updateInfo.page && (
              <button
                type="button"
                className="update-toast__btn"
                data-tb-id="update-open-page"
                onClick={() => void window.pdfApp.update.openPage(updateInfo.page!)}
              >
                手动下载
              </button>
            )}
            <button
              type="button"
              className="update-toast__btn"
              data-tb-id="update-later"
              onClick={dismissUpdate}
            >
              关闭
            </button>
          </div>
        </>
      )}
    </div>
  )
}
