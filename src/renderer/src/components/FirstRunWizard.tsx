// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 首次设置向导（2.1 起）。
 *
 * 什么时候弹：`settings.onboarded === false`。全新安装是这个值，
 * 从 2.0.x 升到 2.1 第一次打开也是这个值 —— 走完一次写 true，之后
 * 无论再升多少个版本都不再出现。判据只看这一个布尔值，不跟版本号比，
 * 免得「升 2.1.0 弹一次、升 2.1.1 又弹一次」。
 *
 * 为什么不做成独立的 BrowserWindow：主窗口已经在了，再开一个窗口要处理
 * 焦点、置顶、双窗口主题同步；用全屏遮罩 + 卡片，样式跟着 data-theme 走，
 * 主题一换卡片立刻跟着变，用户能当场看到效果。
 *
 * 五步的文案是用户逐条指定的（m29394），改字之前先问，别自作主张润色。
 */

import { useState } from 'react'
import { Check, Palette, Paperclip, Power } from 'lucide-react'
import type { ReaderSettings, ThemeMode, ThemePackId } from '../../../shared/types'
import { PACK_IDS } from '../../../shared/settings'

/** 关联候选项：与设置页保持一致，改这里记得同步 SettingsPanel 的 ASSOC_EXTS */
const ASSOC_EXTS = [
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.bmp',
  '.gif',
  '.ico',
  '.tif',
  '.tiff'
] as const

const PACK_REST: Record<ThemePackId, { label: string; tip: string; fallback: ThemeMode }> = {
  classic: {
    label: '默认',
    tip: '圆角面板，三套里最接近传统阅读器',
    fallback: 'sepia'
  },
  metro: {
    label: 'Metro',
    tip: '直角磁贴、单一强调色，Windows 10 的味道',
    fallback: 'metro'
  },
  glass: {
    label: '液态玻璃',
    tip: '半透明磨砂 + 大圆角，背景图能透出来',
    fallback: 'glass'
  }
}

const COLOR_OPTIONS: ReadonlyArray<{ value: ThemeMode; label: string; swatch: string }> = [
  { value: 'light', label: '浅色', swatch: '#f3f4f7' },
  { value: 'warm', label: '暖灰', swatch: '#ece9e3' },
  { value: 'sepia', label: '米色', swatch: '#ece0c8' },
  { value: 'forest', label: '护眼绿', swatch: '#ddeade' },
  { value: 'dark', label: '深色', swatch: '#1a1d24' },
  { value: 'night', label: '深夜', swatch: '#131a26' },
  { value: 'contrast', label: '高对比', swatch: '#000000' },
  { value: 'paper', label: '纸墨', swatch: '#f4f0e8' },
  { value: 'midnight', label: '午夜蓝', swatch: '#0e1626' }
]

interface Props {
  settings: ReaderSettings
  onChange: (patch: Partial<ReaderSettings>) => Promise<void> | void
}

/** 每步的大标题/副标题，文案由用户指定 */
const STEPS = [
  {
    key: 'welcome',
    label: '欢迎',
    title: 'Ciallo～(∠・ω< )⌒☆',
    sub: '欢迎使用秋夕-PDF阅读器下面先进行简单的设置'
  },
  {
    key: 'theme',
    label: '主题',
    title: '工欲善其事，必先美其器。',
    sub: '下面先调整主题'
  },
  {
    key: 'assoc',
    label: '关联',
    title: '设置软件文件关联',
    sub: '点「下一步」时静默写入，不需要再到系统里确认一次'
  },
  {
    key: 'fast',
    label: '快速启动',
    title: '是否启用快速启动？',
    sub: '开机后让它在后台待命，双击文件直接拉到前台，省掉冷启动那几秒'
  },
  {
    key: 'done',
    label: '完成',
    title: '设置完成点击完成结束',
    sub: '这些以后都能在「设置」里改'
  }
] as const

export function FirstRunWizard({ settings, onChange }: Props) {
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [exts, setExts] = useState<string[]>(settings.associatedExts)
  const [autoStart, setAutoStart] = useState(settings.autoStart)

  const pack: ThemePackId = PACK_IDS.includes(settings.theme as ThemePackId)
    ? (settings.theme as ThemePackId)
    : 'classic'

  const pickPack = (id: ThemePackId) => {
    if (busy) return
    void onChange({
      theme: PACK_REST[id].fallback,
      themeLayout: id === 'metro' ? 'office' : 'normal'
    })
  }

  const toggleExt = (ext: string) => {
    setExts((prev) => (prev.includes(ext) ? prev.filter((e) => e !== ext) : [...prev, ext]))
  }

  /**
   * 结束向导。
   *
   * 顺序很重要：先把 onboarded 落盘让遮罩消失，再去动注册表。
   * 之前是「先写注册表、成功后才落 onboarded」，关联那一步只要抛错，
   * 遮罩就永远关不掉 —— 用户点了「完成」还停在那儿。
   */
  const close = async () => {
    if (busy) return
    setBusy(true)
    try {
      await onChange({ associatedExts: exts, autoStart, onboarded: true })
    } finally {
      setBusy(false)
    }
    /* 注册表写入放到遮罩关掉之后，失败也不该把用户卡住 */
    void (async () => {
      try {
        if (exts.length > 0) await window.pdfApp.app.assocApply(exts)
        await window.pdfApp.app.assocAutoStart(autoStart)
      } catch {
        /* 关联失败不影响使用，用户之后可以在设置页重试 */
      }
    })()
  }

  const skip = async () => {
    if (busy) return
    setBusy(true)
    try {
      /* 直接跳过也要落 onboarded，否则每次开都弹 */
      await onChange({ onboarded: true })
    } finally {
      setBusy(false)
    }
  }

  const cur = STEPS[step]
  const last = step === STEPS.length - 1

  return (
    <div className="frw-mask" role="dialog" aria-modal="true" aria-label="首次设置">
      <div className="frw-card">
        <header className="frw-head">
          <ol className="frw-steps">
            {STEPS.map((s, i) => (
              <li key={s.key} className={i === step ? 'is-now' : i < step ? 'is-done' : ''}>
                <span>{i + 1}</span>
                {s.label}
              </li>
            ))}
          </ol>
          <div className="frw-hero">
            <h3 className="frw-hero-title">{cur.title}</h3>
            <p className="frw-hero-sub">{cur.sub}</p>
          </div>
        </header>

        <div className="frw-body">
          {cur.key === 'welcome' ? (
            <section className="frw-block">
              <p className="frw-hint">
                接下来只有四步：挑主题、定关联、决定要不要常驻后台。全部可以跳过，
                装完也能随时在「设置」里改。
              </p>
            </section>
          ) : null}

          {cur.key === 'theme' ? (
            <>
              <section className="frw-block">
                <h4>
                  <Palette size={16} /> 主题包
                </h4>
                <div className="frw-packs">
                  {PACK_IDS.map((id) => (
                    <button
                      key={id}
                      type="button"
                      className={pack === id ? 'frw-pack is-on' : 'frw-pack'}
                      data-pack={id}
                      onClick={() => pickPack(id)}
                    >
                      <strong>{PACK_REST[id].label}</strong>
                      <span>{PACK_REST[id].tip}</span>
                    </button>
                  ))}
                </div>
              </section>

              <section className="frw-block">
                <h4>配色</h4>
                <div className="frw-colors">
                  {COLOR_OPTIONS.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      className={settings.theme === c.value ? 'frw-color is-on' : 'frw-color'}
                      onClick={() => void onChange({ theme: c.value })}
                      title={c.label}
                    >
                      <i style={{ background: c.swatch }} />
                      <span>{c.label}</span>
                    </button>
                  ))}
                </div>
                <p className="frw-hint">选中的立刻生效，你可以边看边换。</p>
              </section>
            </>
          ) : null}

          {cur.key === 'assoc' ? (
            <section className="frw-block">
              <h4>
                <Paperclip size={16} /> 让秋夕打开这些文件
              </h4>
              <p className="frw-hint">
                勾上的后缀，双击文件会直接用秋夕打开，不再弹「你要用什么程序」。
              </p>
              <div className="frw-exts">
                {ASSOC_EXTS.map((ext) => (
                  <label key={ext} className={exts.includes(ext) ? 'frw-ext is-on' : 'frw-ext'}>
                    <input
                      type="checkbox"
                      checked={exts.includes(ext)}
                      onChange={() => toggleExt(ext)}
                    />
                    {ext}
                  </label>
                ))}
              </div>
              <div className="frw-inline">
                <button type="button" onClick={() => setExts([...ASSOC_EXTS])}>
                  全选
                </button>
                <button type="button" onClick={() => setExts([])}>
                  全部取消
                </button>
              </div>
            </section>
          ) : null}

          {cur.key === 'fast' ? (
            <section className="frw-block">
              <h4>
                <Power size={16} /> 快速启动
              </h4>
              <label className="frw-switch">
                <input
                  type="checkbox"
                  checked={autoStart}
                  onChange={(e) => setAutoStart(e.target.checked)}
                />
                <span>开机后在后台待命，双击 PDF 立刻能开</span>
              </label>
              <p className="frw-hint">
                后台进程与主程序不是同一个文件，只在你自己主动打开时才拉起到前台；
                不想让它常驻，取消勾选就行。
              </p>
            </section>
          ) : null}

          {cur.key === 'done' ? (
            <section className="frw-block frw-done">
              <div className="frw-badge">
                <Check size={22} />
              </div>
              <p className="frw-hint">
                主题包：{PACK_REST[pack].label} · 关联 {exts.length} 种后缀
                {autoStart ? ' · 已开快速启动' : ' · 未开快速启动'}
              </p>
              <p className="frw-hint">以后想改，按 Ctrl+，或者右栏「设置」。</p>
            </section>
          ) : null}
        </div>

        <footer className="frw-foot">
          <button type="button" className="frw-ghost" onClick={() => void skip()} disabled={busy}>
            跳过
          </button>
          <div className="frw-nav">
            {step > 0 ? (
              <button type="button" onClick={() => setStep(step - 1)} disabled={busy}>
                上一步
              </button>
            ) : null}
            {last ? (
              <button
                type="button"
                className="frw-primary"
                onClick={() => void close()}
                disabled={busy}
              >
                {busy ? '保存中…' : '完成'}
              </button>
            ) : (
              <button
                type="button"
                className="frw-primary"
                onClick={() => setStep(step + 1)}
                disabled={busy}
              >
                下一步
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}
