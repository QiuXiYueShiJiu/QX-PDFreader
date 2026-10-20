// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 弹簧式滑动清屏。
 *
 * 交互来自鸿合 π6 的「滑动清页」（现场调研确认）：
 *   一条轨道，圆钮在左端；按住往右拖，拖到底触发清屏；
 *   松手后圆钮**弹回原位** —— 所以叫「弹簧式」。
 *
 * 为什么用滑动确认而不是点一下或弹对话框：
 *   · 直接点：清掉整页批注不可撤销，误触代价太大
 *   · 对话框：课堂上多一次「确认」点击很打断节奏，而且一体机上弹窗难看
 *   · 滑动：既需要明确的意图（拖到底是刻意动作），又不打断（不用看弹窗）
 *
 * 实现要点：
 *   · 用 Pointer Events 而不是鼠标事件 —— 一体机是触摸屏，
 *     必须同时支持手指、触屏笔与鼠标
 *   · setPointerCapture 让手指滑出轨道也继续跟踪，不会中途断掉
 *   · 进度用 0~1 表示，拖动时实时回显文字，让用户知道要拖多远
 */

import { useCallback, useRef, useState } from 'react'
import { ChevronsRight, Trash2 } from 'lucide-react'

export function SlideToClear({
  label,
  onConfirm,
  disabled = false
}: {
  /** 轨道上的提示文字，默认「滑动清屏」 */
  label?: string
  onConfirm: () => void
  disabled?: boolean
}): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  const [progress, setProgress] = useState(0)
  const [dragging, setDragging] = useState(false)

  /** 松手后回弹：清空进度，CSS 过渡负责动画 */
  const release = useCallback(() => {
    setDragging(false)
    setProgress(0)
  }, [])

  const handleDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (disabled) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
  }

  const handleMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging || disabled) return
    const track = trackRef.current
    if (!track) return

    const rect = track.getBoundingClientRect()
    // 圆钮直径按轨道高度算，可拖动的行程要扣掉它
    const knob = rect.height
    const travel = Math.max(1, rect.width - knob)
    const x = e.clientX - rect.left - knob / 2
    setProgress(Math.min(1, Math.max(0, x / travel)))
  }

  const handleUp = (): void => {
    if (!dragging) return

    /*
     * 阈值 0.92 而不是 1.0：
     *   要求严格拖到最右端很难，手指稍微差一点就白拖一次，体验很差。
     *   留一点余量，同时仍然需要「几乎拖到底」才算确认，不会误触。
     */
    if (progress >= 0.92) {
      onConfirm()
    }
    release()
  }

  /* 拖动到 80% 以上时给一个「快到了」的视觉提示 */
  const nearEnd = progress >= 0.8

  return (
    <div
      ref={trackRef}
      className={`slideclear ${dragging ? 'is-dragging' : ''} ${nearEnd ? 'is-near' : ''} ${
        disabled ? 'is-disabled' : ''
      }`}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
      onPointerCancel={release}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={`${label ?? '滑动清屏'}：按住圆钮向右拖到底以清空本页批注`}
      aria-disabled={disabled}
      title="按住圆钮向右拖到底，清空本文档全部批注"
    >
      {/* 进度填充：跟着圆钮走，给出「已完成多少」的反馈 */}
      <span className="slideclear__fill" style={{ width: `${progress * 100}%` }} aria-hidden="true" />

      <span className="slideclear__text">
        {progress === 0 ? (
          <>
            {label ?? '滑动清屏'}
            <ChevronsRight size={14} aria-hidden="true" />
          </>
        ) : nearEnd ? (
          <>
            松手清空
            <Trash2 size={14} aria-hidden="true" />
          </>
        ) : (
          `${Math.round(progress * 100)}%`
        )}
      </span>

      <span className="slideclear__knob" style={{ left: `calc(${progress * 100}% - ${progress * 34}px)` }}>
        <Trash2 size={14} aria-hidden="true" />
      </span>
    </div>
  )
}
