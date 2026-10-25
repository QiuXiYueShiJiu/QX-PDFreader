// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 新建空白 PDF。
 *
 * 设计取舍：
 *   · 只给"马上要写字/投影白板"的老师用，所以默认值就是最常用的一叠 A4：
 *     1 页、纵向、纯白，点开直接回车也能建；
 *   · 纸张与方向用分段按钮而不是下拉框 —— 一体机上点一下就行，不弹列表；
 *   · 底色三项（白 / 米黄 / 浅灰）是为打印与投影场景准备的：
 *     米黄纸打印省墨、浅灰适合投影时不刺眼；
 *   · 真实页数上限 200，与主进程的 normalizeBlankSpec 保持一致，改一边要改另一边。
 */

import { useEffect, useRef, useState } from 'react'
import { FilePlus2, X } from 'lucide-react'

const MAX_PAGES = 200
const PAPER_SIZES = ['A4', 'A3', 'Letter'] as const
const BACKGROUNDS = [
  { value: '#ffffff', label: '纯白' },
  { value: '#fdf9f0', label: '米黄纸' },
  { value: '#f2f4f7', label: '浅灰' }
] as const

type PaperSize = (typeof PAPER_SIZES)[number]

interface NewPdfDialogProps {
  onClose: () => void
  /** 创建成功后回调，交给上层刷新最近列表 / 提示 */
  onCreated?: (path: string, pages: number) => void
}

export function NewPdfDialog({ onClose, onCreated }: NewPdfDialogProps): JSX.Element {
  const [pages, setPages] = useState(1)
  const [size, setSize] = useState<PaperSize>('A4')
  const [landscape, setLandscape] = useState(false)
  const [background, setBackground] = useState<string>('#ffffff')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.select()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function create(): Promise<void> {
    const api = window.pdfApp
    if (!api) {
      setNotice('无法调用系统接口，请重启应用')
      return
    }
    setBusy(true)
    setNotice(null)
    try {
      const result = await api.create.blank({
        pages: clampPages(pages),
        size,
        landscape,
        background
      })
      if (!result.ok || !result.path) {
        setNotice(result.error ?? '新建失败，请重试')
        return
      }
      onCreated?.(result.path, clampPages(pages))
      onClose()
    } catch (error) {
      setNotice(`新建失败：${String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="newpdf" role="dialog" aria-label="新建空白 PDF" data-newpdf="1">
      <div className="newpdf__card">
        <header className="newpdf__head">
          <div>
            <h2 className="newpdf__title">
              <FilePlus2 size={17} /> 新建空白 PDF
            </h2>
            <p className="newpdf__sub">建好后可以直接在上面写批注、贴图、导出；要留档就点「导出 PDF」另存为。</p>
          </div>
          <button type="button" className="newpdf__ghost" onClick={onClose} title="关闭（Esc）">
            <X size={16} />
          </button>
        </header>

        <div className="newpdf__row">
          <span className="newpdf__label">页数</span>
          <div className="newpdf__pages">
            <button
              type="button"
              className="newpdf__step"
              data-tb-id="newpdf-pages-down"
              onClick={() => setPages((value) => clampPages(value - 1))}
              disabled={pages <= 1}
              title="少一页"
            >
              −
            </button>
            <input
              ref={inputRef}
              className="newpdf__input"
              data-tb-id="newpdf-pages"
              value={pages}
              inputMode="numeric"
              onChange={(event) => {
                const next = Number(event.target.value.replace(/[^\d]/g, ''))
                setPages(Number.isFinite(next) ? clampPages(next) : 1)
              }}
            />
            <button
              type="button"
              className="newpdf__step"
              data-tb-id="newpdf-pages-up"
              onClick={() => setPages((value) => clampPages(value + 1))}
              disabled={pages >= MAX_PAGES}
              title="多一页"
            >
              +
            </button>
            <span className="newpdf__hint">1 ~ {MAX_PAGES} 页</span>
          </div>
        </div>

        <div className="newpdf__row">
          <span className="newpdf__label">纸张</span>
          <div className="newpdf__seg" role="group" aria-label="纸张">
            {PAPER_SIZES.map((item) => (
              <button
                key={item}
                type="button"
                className={`newpdf__seg-btn${size === item ? ' is-on' : ''}`}
                data-tb-id={`newpdf-size-${item}`}
                aria-pressed={size === item}
                onClick={() => setSize(item)}
              >
                {item}
              </button>
            ))}
          </div>
        </div>

        <div className="newpdf__row">
          <span className="newpdf__label">方向</span>
          <div className="newpdf__seg" role="group" aria-label="方向">
            <button
              type="button"
              className={`newpdf__seg-btn${!landscape ? ' is-on' : ''}`}
              data-tb-id="newpdf-portrait"
              aria-pressed={!landscape}
              onClick={() => setLandscape(false)}
            >
              纵向
            </button>
            <button
              type="button"
              className={`newpdf__seg-btn${landscape ? ' is-on' : ''}`}
              data-tb-id="newpdf-landscape"
              aria-pressed={landscape}
              onClick={() => setLandscape(true)}
            >
              横向
            </button>
          </div>
        </div>

        <div className="newpdf__row">
          <span className="newpdf__label">底色</span>
          <div className="newpdf__seg" role="group" aria-label="底色">
            {BACKGROUNDS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={`newpdf__seg-btn${background === item.value ? ' is-on' : ''}`}
                data-tb-id={`newpdf-bg-${item.value.slice(1)}`}
                aria-pressed={background === item.value}
                onClick={() => setBackground(item.value)}
              >
                <span className="newpdf__swatch" style={{ background: item.value }} />
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {notice && <p className="newpdf__notice">{notice}</p>}

        <footer className="newpdf__foot">
          <button type="button" className="newpdf__ghost newpdf__ghost--text" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="newpdf__ok"
            data-tb-id="newpdf-create"
            onClick={() => void create()}
            disabled={busy}
          >
            {busy ? '正在创建…' : '创建并打开'}
          </button>
        </footer>
      </div>
    </div>
  )
}

function clampPages(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(MAX_PAGES, Math.max(1, Math.round(value)))
}
