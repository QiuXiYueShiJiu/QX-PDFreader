// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 工具箱与「Acrobat 级」各分区共用的小件。
 *
 * 从 ToolsPanel.tsx 里抽出来的原因：
 *   这些操作（选文件、列文件、跑任务并回填结果）在合并/表单/签名/导出等
 *   十几个分区里长得一模一样。留在 ToolsPanel 里会导致
 *   「ToolsPanel 引用高级分区、高级分区又回头引用 ToolsPanel」的循环依赖。
 */

import { FilePlus2, Trash2, X } from 'lucide-react'

/** 一次操作的结果提示 */
export interface Feedback {
  kind: 'ok' | 'error' | 'info'
  text: string
  /** 可以直接「在文件夹中显示」的产物路径 */
  path?: string
}

/** 各分区共用的运行状态（由面板统一持有，切换分区不丢进度显示） */
export interface TaskApi {
  busy: boolean
  setBusy: (text: string | null) => void
  setProgress: (value: number | null) => void
  setFeedback: (value: Feedback | null) => void
}

/** 把 info 表拼成一行「页数：3 · 文件数：2」 */
export function describeInfo(info: Record<string, string | number> | undefined): string {
  if (!info) return ''
  return Object.entries(info)
    .map(([key, value]) => {
      const text =
        key === '原大小' || key === '新大小' || key === '大小'
          ? formatSize(value)
          : String(value)
      return `${key}：${text}`
    })
    .join(' · ')
}

/** 文件大小显示 */
export function formatSize(bytes: number | string | undefined): string {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '—'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(2)} MB`
}

export function baseName(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? filePath
  return name.replace(/\.[^.]+$/, '')
}

export function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath
}

/** 源文件选择：默认取当前打开的文档 */
export function SourcePicker({
  value,
  onChange,
  label = '源 PDF',
  disabled
}: {
  value: string
  onChange: (path: string) => void
  label?: string
  disabled?: boolean
}): JSX.Element {
  const pick = async (): Promise<void> => {
    const picked = await window.pdfApp.tools.pickPdfs()
    if (picked.length > 0) onChange(picked[0])
  }
  return (
    <div className="sb-field">
      <div className="sb-field-text">
        <span className="sb-field-label">{label}</span>
        <span className="sb-field-hint" title={value || undefined}>
          {value ? fileName(value) : '还没选择文件（不选也可以直接执行，会弹选择框）'}
        </span>
      </div>
      <div className="sb-field-control tools-inline">
        <button type="button" className="sb-btn" onClick={() => void pick()} disabled={disabled}>
          <FilePlus2 size={15} />
          选择 PDF
        </button>
        {value ? (
          <button
            type="button"
            className="sb-btn sb-btn-icon"
            title="清除（改用执行时弹出选择框）"
            onClick={() => onChange('')}
            disabled={disabled}
          >
            <X size={15} />
          </button>
        ) : null}
      </div>
    </div>
  )
}

/** 多文件列表（合并 / 图片→PDF / Office / 附件用） */
export function FileList({
  files,
  onChange,
  disabled,
  showOrder
}: {
  files: string[]
  onChange: (files: string[]) => void
  disabled?: boolean
  showOrder?: boolean
}): JSX.Element {
  const move = (index: number, delta: number): void => {
    const target = index + delta
    if (target < 0 || target >= files.length) return
    const next = [...files]
    const [item] = next.splice(index, 1)
    next.splice(target, 0, item)
    onChange(next)
  }

  if (files.length === 0) return <p className="tools-empty">还没选择文件</p>

  return (
    <ul className="tools-filelist">
      {files.map((file, index) => (
        <li key={`${file}-${index}`} className="tools-filelist__item">
          {showOrder ? <span className="tools-filelist__index">{index + 1}</span> : null}
          <span className="tools-filelist__name" title={file}>
            {fileName(file)}
          </span>
          {showOrder ? (
            <>
              <button
                type="button"
                className="sb-btn sb-btn-icon"
                title="上移"
                disabled={disabled || index === 0}
                onClick={() => move(index, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="sb-btn sb-btn-icon"
                title="下移"
                disabled={disabled || index === files.length - 1}
                onClick={() => move(index, 1)}
              >
                ↓
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="sb-btn sb-btn-icon"
            title="移除"
            disabled={disabled}
            onClick={() => onChange(files.filter((_, i) => i !== index))}
          >
            <Trash2 size={14} />
          </button>
        </li>
      ))}
    </ul>
  )
}

/** 统一处理「执行 → 反馈」的样板 */
export async function runTask(
  task: TaskApi,
  busyLabel: string,
  action: () => Promise<{
    ok: boolean
    canceled?: boolean
    error?: string
    path?: string
    paths?: string[]
    info?: Record<string, string | number>
  }>,
  successLabel: string
): Promise<void> {
  if (task.busy) return
  task.setFeedback(null)
  task.setBusy(busyLabel)
  try {
    const result = await action()
    if (result.ok) {
      const info = describeInfo(result.info)
      const paths = result.paths ?? (result.path ? [result.path] : [])
      const suffix =
        paths.length > 1 ? `（共 ${paths.length} 个文件）` : paths[0] ? `：${paths[0]}` : ''
      task.setFeedback({
        kind: 'ok',
        text: `${successLabel}${suffix}${info ? ` · ${info}` : ''}${result.error ? `；${result.error}` : ''}`,
        path: paths[0]
      })
    } else if (result.canceled) {
      task.setFeedback({ kind: 'info', text: '已取消' })
    } else {
      task.setFeedback({ kind: 'error', text: result.error ?? '操作失败' })
    }
  } catch (error) {
    task.setFeedback({
      kind: 'error',
      text: error instanceof Error ? error.message : String(error)
    })
  } finally {
    task.setBusy(null)
  }
}

/** 开关（与设置面板同款外观） */
export function Switch({
  checked,
  onChange,
  label,
  disabled
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  disabled?: boolean
}): JSX.Element {
  return (
    <label className="sb-switch">
      <input
        type="checkbox"
        className="sb-switch-input"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="sb-switch-track" aria-hidden="true" />
    </label>
  )
}
