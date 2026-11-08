// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 首启设置窗口的 React 入口（2.1 起）。
 *
 * 它跑在一个**独立的 BrowserWindow** 里（主进程用 `?page=onboarding` 打开），
 * 跟主界面完全不共享组件树：主窗口在向导结束前根本不会创建，因此不存在
 * 「启动时闪一下设置页」的时间窗。
 *
 * 这里只做三件事：
 *   ① 从主进程取当前设置（含主题），把主题写到 documentElement 上，
 *      让向导卡片自己就是当前主题的样子；
 *   ② 把 FirstRunWizard 的改动就地合并进本地状态，并同步 `data-theme` /
 *      `data-layout`，这样用户在第 2 步换主题时背景立刻跟着变；
 *   ③ 通过 `app.onboarding-apply` 落盘 —— 主进程收到 onboarded=true 时
 *      会关掉这个窗口并创建主窗口。
 */

import { useEffect, useState } from 'react'
import { FirstRunWizard } from './components/FirstRunWizard'
import type { ReaderSettings } from '../../shared/types'

export function OnboardingWindow() {
  const [settings, setSettings] = useState<ReaderSettings | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const s = await window.pdfApp.settings.get()
        setSettings(s)
        document.documentElement.dataset.theme = s.theme
        document.documentElement.dataset.layout = s.themeLayout ?? 'normal'
      } catch (err) {
        console.warn('[onboarding] 读取设置失败', err)
      }
    })()
  }, [])

  const onChange = async (patch: Partial<ReaderSettings>): Promise<void> => {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev))
    if (patch.theme) document.documentElement.dataset.theme = patch.theme
    if (patch.themeLayout) document.documentElement.dataset.layout = patch.themeLayout
    await window.pdfApp.settings.onboardingApply(patch)
  }

  if (!settings) return null

  return (
    <div className="frw-window">
      <FirstRunWizard settings={settings} onChange={onChange} />
    </div>
  )
}
