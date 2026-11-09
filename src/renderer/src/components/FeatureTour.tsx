// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 功能介绍（首启/更新后弹一次）。
 *
 * ★ 用户要求（2026-11-09）：
 *   「开启显示功能介绍（只介绍批注进行绘画 / 掌心擦除（含示意图））嵌入界面，
 *     可点击『知道了』关闭，或勾选『以后不再显示』。」
 *
 * 设计取舍：
 *   · 只讲两件事。功能列表式的导览没人看，两件「上课必用」的动作才值得占一次打断。
 *   · 示意图用内联 SVG，不依赖截图资源 —— 换主题时颜色跟着 CSS 变量走，不会出现
 *     「深色主题里贴一张白底截图」那种突兀感。
 *   · 默认勾选「以后不再显示」：绝大多数人装完只想赶紧打开文档，第二次打断是负体验；
 *     想看回来在「设置 → 关于」里有入口（后续再加，先留 flag 语义）。
 */

import { useState } from 'react'

interface FeatureTourProps {
  /** 是否显示 */
  open: boolean
  /** 关闭；remember 表示是否写「以后不再显示」 */
  onClose: (remember: boolean) => void
}

/** 笔迹示意图：一笔画出来的弧线 + 起笔点 */
function InkIllustration(): React.JSX.Element {
  return (
    <svg className="ft-art" viewBox="0 0 120 64" role="img" aria-label="用笔在页面上画线">
      <rect x="1" y="1" width="118" height="62" rx="6" className="ft-paper" />
      <path
        d="M14 44 C 30 12, 52 12, 66 30 S 96 52, 108 26"
        className="ft-ink"
        fill="none"
      />
      <circle cx="14" cy="44" r="3.5" className="ft-dot" />
    </svg>
  )
}

/**
 * 掌心擦除示意图。
 *
 * ★ 用户要求（2026-11-09）：「掌心擦除提示改一下，图片里面改成一个几何圆」。
 *   原来画的是手掌轮廓（仿生形状），缩小到 120×64 就看不清是什么；改成
 *   一个**几何圆**代表接触面，中间被擦断的一段笔迹直接表达「抹掉」。
 */
function PalmIllustration(): React.JSX.Element {
  return (
    <svg className="ft-art" viewBox="0 0 120 64" role="img" aria-label="用掌心圆面擦掉笔迹">
      <rect x="1" y="1" width="118" height="62" rx="6" className="ft-paper" />
      {/* 被擦断的两段笔迹：中间留白就是擦掉的部分 */}
      <path d="M12 32 L 42 32" className="ft-ink" fill="none" />
      <path d="M78 32 L 108 32" className="ft-ink" fill="none" />
      {/* 几何圆：代表按上去的手掌面 */}
      <circle cx="60" cy="32" r="17" className="ft-palm" />
      <circle cx="60" cy="32" r="17" className="ft-palm-ring" fill="none" />
    </svg>
  )
}

export function FeatureTour({ open, onClose }: FeatureTourProps): React.JSX.Element | null {
  const [remember, setRemember] = useState(true)
  if (!open) return null

  return (
    <div className="ft-mask" role="dialog" aria-modal="true" aria-labelledby="ft-title">
      <div className="ft-card">
        <h2 className="ft-title" id="ft-title">
          上课常用的两个手势
        </h2>
        <p className="ft-sub">半分钟看完，剩下的摸两下就会了。</p>

        <div className="ft-item">
          <InkIllustration />
          <div className="ft-text">
            <h3>直接用笔在页面上画</h3>
            <p>
              底部调到 <b>画笔</b>，在页面上按住就能写。要圈重点、批作业、写板书都行，
              笔迹跟着手指走，不飘。
            </p>
          </div>
        </div>

        <div className="ft-item">
          <PalmIllustration />
          <div className="ft-text">
            <h3>写错了，用手掌擦</h3>
            <p>
              不用切橡皮，巴掌直接按在屏幕上抹一下就擦掉了——擦到哪儿断到哪儿，
              想反悔按 <b>Ctrl+Z</b>。
            </p>
          </div>
        </div>

        <div className="ft-foot">
          <label className="ft-remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.currentTarget.checked)}
            />
            以后不再显示
          </label>
          <button type="button" className="ft-ok" onClick={() => onClose(remember)}>
            知道了
          </button>
        </div>
      </div>
    </div>
  )
}
