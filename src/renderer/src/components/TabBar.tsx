// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 标签栏：单窗口打开多个 PDF（浏览器式的标签页）。
 *
 * 为什么单独占一条 34px 的横栏，而不是挤进标题栏：
 *   标题栏是自绘无边框窗口的拖拽区（-webkit-app-region: drag），
 *   在里面塞可点击的标签既要逐个 no-drag，又要处理拖拽与点击的冲突；
 *   单独一条栏在任何窗口尺寸下语义都清楚，出问题也好整体摘掉。
 *
 * 「关闭最后一个标签就退出应用」是用户明确要求（保证前台只有一个窗口）：
 *   这里直接调 app.quitNow()，不再弹一次「确定退出吗」——
 *   关闭前的「有未保存编辑」确认已经走过一遍了。
 */
import { useCallback, useEffect } from 'react'
import { Plus, X } from 'lucide-react'
import { useViewer } from '../store'
import { guardUnsaved } from '../close-guard'

export function TabBar(): JSX.Element | null {
  const tabs = useViewer((s) => s.tabs)
  const activeTabId = useViewer((s) => s.activeTabId)
  const switchTab = useViewer((s) => s.switchTab)
  const closeTab = useViewer((s) => s.closeTab)

  /** 关标签：先过「未保存」守卫再关；关掉最后一个标签就退出应用 */
  const closeWithGuard = useCallback(
    async (id: string) => {
      if (!id) return
      const before = useViewer.getState()
      const target = before.tabs.find((t) => t.id === id)

      /*
       * 关的是**后台**标签、而它自己还有没导出的编辑时，先切过去。
       * 守卫读的是「当前文档」的脏标记，直接关会把后台那份默默丢掉；
       * 切过去之后 close-guard 会等导出实现换成这份文档再动手。
       */
      if (target && target.exportDirty && id !== before.activeTabId) {
        before.switchTab(id)
      }

      if (!(await guardUnsaved('关闭标签'))) return
      closeTab(id)
      if (useViewer.getState().tabs.length === 0) {
        void window.pdfApp?.app.quitNow()
      }
    },
    [closeTab]
  )

  /* 键盘：Ctrl+W 关当前标签、Ctrl+T 新标签、Ctrl+Tab 轮换（浏览器习惯） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      const s = useViewer.getState()

      if (e.key === 'Tab') {
        if (s.tabs.length < 2) return
        e.preventDefault()
        const index = s.tabs.findIndex((t) => t.id === s.activeTabId)
        const step = e.shiftKey ? -1 : 1
        const next = s.tabs[(index + step + s.tabs.length) % s.tabs.length]
        s.switchTab(next.id)
        return
      }

      const key = e.key.toLowerCase()
      if (key === 'w') {
        e.preventDefault()
        void closeWithGuard(s.activeTabId)
      } else if (key === 't') {
        e.preventDefault()
        void s.pickFile()
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeWithGuard])

  // 没有打开任何文件时不占高度
  if (tabs.length === 0) return null

  return (
    <div className="tabbar" role="tablist" aria-label="已打开的文件" data-tab-count={tabs.length}>
      <div className="tabbar__list">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId
          const name = tab.name || tab.path.split(/[\\/]/).pop() || '未命名'
          return (
            <div
              key={tab.id}
              className={`tabbar__tab${active ? ' is-active' : ''}`}
              role="tab"
              aria-selected={active}
              title={tab.path}
              data-tab-id={tab.id}
              data-tab-path={tab.path}
              data-tab-dirty={tab.exportDirty ? '1' : '0'}
              onClick={() => switchTab(tab.id)}
              // 中键关闭：浏览器用户的老习惯，成本极低
              onAuxClick={(e) => {
                if (e.button === 1) void closeWithGuard(tab.id)
              }}
            >
              <span className="tabbar__name">{name}</span>
              {tab.exportDirty ? (
                <span className="tabbar__dot" title="有编辑还没导出成 PDF" aria-hidden="true" />
              ) : null}
              <button
                type="button"
                className="tabbar__close"
                data-tab-close={tab.id}
                aria-label={`关闭 ${name}`}
                title="关闭标签（Ctrl+W）"
                onClick={(e) => {
                  e.stopPropagation()
                  void closeWithGuard(tab.id)
                }}
              >
                <X size={13} strokeWidth={2.4} />
              </button>
            </div>
          )
        })}
      </div>
      <button
        type="button"
        className="tabbar__add"
        data-tb-id="tab-new"
        title="打开文件（新标签，Ctrl+T）"
        aria-label="打开文件"
        onClick={() => void useViewer.getState().pickFile()}
      >
        <Plus size={15} />
      </button>
    </div>
  )
}
