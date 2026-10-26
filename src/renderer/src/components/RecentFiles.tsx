// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 最近打开列表。
 *
 * 设计取舍：
 *   · 整个条目是一个 <button>，点哪都能打开，一体机上不用瞄准小图标；
 *     「在文件夹中显示 / 用系统程序打开 / 删除」做成绝对定位在右侧的浮动小组件，
 *     避免按钮套按钮（HTML 不允许，读屏也会念乱）。
 *   · 只做展示与回调，不自己拉最近列表：数据由 props 传入，
 *     防止面板里的列表和主界面各存一份、删除后对不上。
 */

import { useEffect, useRef, useState } from 'react'
import { ExternalLink, FileText, FolderOpen, FolderSearch, Trash2 } from 'lucide-react'
import type { RecentFile } from '@shared/types'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
/** 一天以内说「N 天前」更自然，超过就显示具体日期 */
const DAY = 24 * HOUR

interface RecentFilesProps {
  /** 已经取好的最近列表 */
  items: RecentFile[]
  onOpen: (filePath: string, page: number) => void
  onRemove?: (filePath: string) => void
}

/** 导出形式与同目录的 Sidebar / Toolbar / RightPanel 保持一致，统一用具名导出 */
export function RecentFiles({ items, onOpen, onRemove }: RecentFilesProps): JSX.Element {
  /** 等待系统面板 / 快捷键返回时禁掉按钮，防止连点弹出多个系统对话框 */
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  // 系统文件对话框要几百毫秒才返回，期间组件可能已经被卸载，这里挡掉卸载后的 setState
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  async function runPick(): Promise<void> {
    const api = window.pdfApp
    if (!api) {
      setNotice('无法调用系统接口，请重启应用')
      return
    }
    setBusy(true)
    setNotice(null)
    try {
      const result = await api.open.pick()
      if (!aliveRef.current) return
      if (!result) return // 用户取消，不是错误，静默返回
      if (!result.ok || !result.path) {
        setNotice(result.error ?? '打开失败，请重试')
        return
      }
      // 新选的文档没有历史位置，页码固定回第 1 页
      onOpen(result.path, 1)
    } catch (error) {
      if (aliveRef.current) setNotice(`打开失败：${String(error)}`)
    } finally {
      if (aliveRef.current) setBusy(false)
    }
  }

  // 下面两个是「一次性动作」，直接把结果落到界面提示上，不改动 items
  async function reveal(path: string): Promise<void> {
    const api = window.pdfApp
    if (!api) {
      setNotice('无法调用系统接口，请重启应用')
      return
    }
    const ok = await api.open.reveal(path).catch(() => false)
    if (aliveRef.current && !ok) setNotice('在文件夹中显示失败')
  }

  async function openExternal(path: string): Promise<void> {
    const api = window.pdfApp
    if (!api) {
      setNotice('无法调用系统接口，请重启应用')
      return
    }
    const ok = await api.open.external(path).catch(() => false)
    if (aliveRef.current && !ok) setNotice('用系统程序打开失败')
  }

  return (
    <div className="sb-recent">
      {notice ? (
        <p className="sb-recent-alert" role="alert">
          {notice}
        </p>
      ) : null}

      {items.length === 0 ? (
        /* 空列表给一条明确的出路，而不是只留一句「暂无数据」 */
        <div className="sb-empty">
          <span className="sb-empty-icon" aria-hidden="true">
            <FileText size={30} />
          </span>
          <p className="sb-empty-title">还没有打开过文档</p>
          <p className="sb-empty-hint">选择一份 PDF 开始阅读，之后这里会保留打开记录和上次看到第几页</p>
          <button
            type="button"
            className="sb-btn sb-btn-primary sb-empty-action"
            disabled={busy}
            onClick={() => void runPick()}
          >
            <FolderOpen size={17} aria-hidden="true" />
            {busy ? '正在打开…' : '打开 PDF'}
          </button>
        </div>
      ) : (
        <ul className="sb-recent-list">
          {items.map((item) => (
            <li key={item.path} className="sb-recent-row">
              <button
                type="button"
                className="sb-recent-open"
                title={`打开：${item.path}`}
                onClick={() => onOpen(item.path, item.page)}
              >
                <span className="sb-recent-icon" aria-hidden="true">
                  <FileText size={18} />
                </span>
                <span className="sb-recent-main">
                  <span className="sb-recent-name" title={item.name}>
                    {item.name}
                  </span>
                  {/* 不显示完整目录：公开场景/截图里不该出现本机路径 */}
                </span>
              </button>

              <span className="sb-recent-meta">
                <span className="sb-recent-page">第 {item.page} 页</span>
                <span className="sb-recent-time" title={formatAbsolute(item.at)}>
                  {formatRelative(item.at)}
                </span>
              </span>

              <span className="sb-recent-actions">
                <button
                  type="button"
                  className="sb-btn sb-btn-icon"
                  title="在文件夹中显示"
                  aria-label={`在文件夹中显示：${item.name}`}
                  onClick={() => void reveal(item.path)}
                >
                  <FolderSearch size={16} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="sb-btn sb-btn-icon"
                  title="用系统程序打开"
                  aria-label={`用系统程序打开：${item.name}`}
                  onClick={() => void openExternal(item.path)}
                >
                  <ExternalLink size={16} aria-hidden="true" />
                </button>
                {onRemove ? (
                  <button
                    type="button"
                    className="sb-btn sb-btn-icon sb-btn-danger"
                    title="从列表中移除"
                    aria-label={`从最近列表中移除：${item.name}`}
                    onClick={() => onRemove(item.path)}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* ============================================================
 * 工具函数
 * ============================================================ */

/**
 * 相对时间。
 *
 * 手写而不引第三方库：这里只需要「刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / 日期」几档，
 * dayjs、date-fns 为了这几行要多带几十 KB，还给课堂一体机的启动添负担。
 *
 * 注意这里按**自然日**判断「昨天 / 前天」，而不是按 24 小时：
 * 上午 9 点看「昨天晚上 22 点打开的文件」，说「昨天」才符合人的直觉，
 * 若按 24 小时算会得到「11 小时前」，反而不好定位。
 */
export function formatRelative(ts: number): string {
  const then = new Date(ts)
  // 时间戳坏了或来自未来时退回绝对时间，不要显示「NaN 分钟前」
  if (Number.isNaN(then.getTime())) return '时间未知'

  const now = new Date()
  const diff = now.getTime() - then.getTime()
  if (diff < 0) return formatAbsolute(ts)
  if (diff < MINUTE) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfThatDay = new Date(then.getFullYear(), then.getMonth(), then.getDate())
  const dayDiff = Math.round((startOfToday.getTime() - startOfThatDay.getTime()) / DAY)

  if (dayDiff <= 0) return `${Math.floor(diff / HOUR)} 小时前`
  if (dayDiff === 1) return '昨天'
  if (dayDiff === 2) return '前天'
  if (dayDiff < 7) return `${dayDiff} 天前`

  const sameYear = then.getFullYear() === now.getFullYear()
  const date = `${then.getMonth() + 1} 月 ${then.getDate()} 日`
  return sameYear ? date : `${then.getFullYear()} 年 ${date}`
}

/** 悬停时给出的完整时间，避免相对时间说不清具体时刻 */
function formatAbsolute(ts: number): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '时间未知'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 取出文件所在目录（用于列表里的次要信息行）。
 *
 * 目录过长时由 CSS 在中间打省略号：文件名往往比中间层级更有辨识度，
 * 所以保留开头的盘符/共享目录和结尾的文件夹名。
 */
