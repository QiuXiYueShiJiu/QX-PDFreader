import { useEffect, useRef, useState } from 'react'

/**
 * 加密 PDF 的打开密码框。
 *
 * 为什么单独做一个组件：pdf.js 在密码不对时会抛 PasswordException，
 * 这个信息只有 useDocument 知道，而输入框必须由界面渲染，所以由 App
 * 把这个组件挂在最外层，打开时传 needPassword。
 */
export function PasswordPrompt({
  open,
  wrong,
  onSubmit,
  onCancel
}: {
  open: boolean
  /** 上一次密码错了吗（pdf.js code 2） */
  wrong: boolean
  onSubmit: (password: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open) {
      setValue('')
      return
    }
    /* 打开就聚焦，老师上课时不该还要再点一下输入框 */
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30)
    return () => window.clearTimeout(timer)
  }, [open])

  if (!open) return null

  const submit = (): void => {
    const text = value.trim()
    if (!text) return
    onSubmit(text)
  }

  return (
    <div
      data-tb-id="password-prompt"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 90,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgb(12 14 18 / 0.45)'
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="需要密码"
        style={{
          width: 380,
          padding: '22px 24px 18px',
          borderRadius: 'var(--radius, 12px)',
          background: 'rgb(var(--surface, 255 255 255))',
          boxShadow: '0 18px 46px rgb(0 0 0 / 0.28)'
        }}
      >
        <h2 style={{ margin: '0 0 6px', fontSize: 17, color: 'rgb(var(--text, 24 26 32))' }}>
          这份 PDF 有密码
        </h2>
        <p style={{ margin: '0 0 14px', fontSize: 12.5, color: 'rgb(var(--text, 24 26 32) / 0.62)' }}>
          输入打开密码后就能正常阅读；密码只用于这一次解密，不会被保存。
        </p>

        <input
          ref={inputRef}
          data-tb-id="password-input"
          type="password"
          value={value}
          autoComplete="off"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit()
            if (event.key === 'Escape') onCancel()
          }}
          placeholder="打开密码"
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '9px 11px',
            fontSize: 13,
            borderRadius: 8,
            border: `1px solid ${wrong ? 'rgb(229 72 77 / 0.75)' : 'rgb(var(--text, 24 26 32) / 0.18)'}`,
            background: 'rgb(var(--surface, 255 255 255))',
            color: 'rgb(var(--text, 24 26 32))',
            outline: 'none'
          }}
        />

        <div style={{ marginTop: 8, minHeight: 16, fontSize: 12, color: 'rgb(229 72 77)' }}>
          {wrong ? '密码不对，再试一次' : ''}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 4 }}>
          <button
            type="button"
            data-tb-id="password-cancel"
            onClick={onCancel}
            style={{
              padding: '7px 14px',
              fontSize: 12.5,
              borderRadius: 8,
              border: '1px solid rgb(var(--text, 24 26 32) / 0.16)',
              background: 'transparent',
              color: 'rgb(var(--text, 24 26 32) / 0.78)',
              cursor: 'pointer'
            }}
          >
            取消
          </button>
          <button
            type="button"
            data-tb-id="password-submit"
            onClick={submit}
            style={{
              padding: '7px 16px',
              fontSize: 12.5,
              borderRadius: 8,
              border: 'none',
              background: 'rgb(var(--accent, 46 125 109))',
              color: 'rgb(var(--accent-fg, 255 255 255))',
              cursor: 'pointer'
            }}
          >
            打开
          </button>
        </div>
      </div>
    </div>
  )
}
