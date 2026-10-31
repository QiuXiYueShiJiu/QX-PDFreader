// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 触屏手势。
 *
 * 教学一体机是触摸屏，手势是主要操作方式之一。浏览器自带的
 * `touch-action: pinch-zoom` 只能缩放**整个页面**（视觉视口），
 * 对阅读器没用 —— 我们要缩放的是 PDF 页面的渲染比例。
 * 因此必须自己接管触摸事件。
 *
 * 支持的手势：
 *   双指捏合   → 缩放（以手指中心为锚点，符合直觉）
 *   双击轻点   → 在「适应宽度」与 200% 之间切换
 *   单指拖动   → 交给浏览器滚动（不接管，避免破坏自然滚动）
 *
 * 关键实现约束：
 *   · 两指捏合期间 touchmove 必须 preventDefault，否则浏览器会尝试滚动页面
 *   · 监听必须用 { passive: false }，否则 preventDefault 无效
 *   · 缩放要用「相对倍率」而不是绝对尺度，避免手指抬起再放下时跳变
 *
 * ★ 2026-10-16 修正「快速滑动时缩放突然乱跳（适应宽度变成 200%/363%）」：
 *   旧实现的双击判定只看两次 `touchstart` 的**落点**（相距 <30px）与间隔
 *   （<300ms），于是「连续两次快速滑动」也被当成双击 → 缩放到 200%；
 *   捏合也没有任何约束，滑动中第二根手指蹭上来就立刻缩放。
 *   现在三重收紧，视图比例只会在用户「明确想缩放」时才变：
 *     1. 双击 = 两次**真轻点**：按下到抬起 ≤250ms、位移 ≤10px、
 *        期间滚动容器位移 ≤8px，且不是在惯性滑动中（250ms 内有过滚动事件）。
 *     2. 捏合 = 两指**几乎同时**按下（间隔 ≤150ms），且滑动中不认；
 *        还要越过 8% 死区才生效，越过时把起点重设到当前位置，避免第一下跳动。
 *     3. 任何一次「滑动」都会清掉上一拍的记录，滑动与轻点不会被拼成双击。
 */

import { useEffect, useRef } from 'react'

/** 双击判定窗口（毫秒）：上一拍抬起 到 这一拍落下 的间隔上限 */
const DOUBLE_TAP_MS = 300
/** 双击允许的位移（像素）：两拍轻点的落点距离上限 */
const DOUBLE_TAP_SLOP = 30
/** 轻点判定：单指按下到抬起的最长时间（毫秒） */
const TAP_MAX_MS = 250
/** 轻点判定：单指允许的最大位移（像素），超过就算滑动 */
const TAP_SLOP = 10
/** 轻点判定：这一拍期间滚动容器允许的最大位移（像素） */
const TAP_SCROLL_SLOP = 8
/** 捏合判定：两根手指「先后按下」的最大间隔（毫秒），晚于它就不是捏合 */
const PINCH_JOIN_MS = 150
/** 捏合死区：缩放幅度小于这个比例不生效（避免蹭到手指就跳比例） */
const PINCH_DEADZONE = 0.08
/** 惯性滑动判定：距上一次滚动事件多久之内算「还在滑动」（毫秒） */
const SCROLL_QUIET_MS = 250
/** 缩放范围（与工具栏的档位保持一致） */
const MIN_SCALE = 0.25
const MAX_SCALE = 6

export interface TouchGestureOptions {
  /** 当前缩放倍数（由页面尺寸推算得出） */
  getScale: () => number
  /**
   * 请求以某个倍数缩放。
   *
   * @param scale       目标倍数
   * @param anchorClient 以哪个屏幕坐标为中心缩放（双指时为两指中点）
   */
  onZoom: (scale: number, anchorClient: { x: number; y: number }) => void
  /** 是否禁用手势（例如手绘模式下要独占触摸） */
  disabled?: () => boolean
  /**
   * 双击缩放的开关。
   *
   * 返回 false 时双击**不缩放**，但上一拍记录会被清空（见 onTouchEnd）。
   * 「选择」工具用它把双击让给「选中该词」，否则用户选字时页面会突然放大。
   */
  allowDoubleTap?: () => boolean
}

export function useTouchGestures(
  targetRef: React.RefObject<HTMLElement>,
  options: TouchGestureOptions
): void {
  // 用 ref 保存回调，避免每次渲染重新绑定监听（重绑定会打断进行中的手势）
  const optsRef = useRef(options)
  optsRef.current = options

  useEffect(() => {
    const el = targetRef.current
    if (!el) return

    /** 双指缩放手势开始时的状态 */
    let gesture: {
      startDistance: number
      startScale: number
      /** 缩放过程中累计的目标倍数，避免反复读取 DOM 造成抖动 */
      currentScale: number
      center: { x: number; y: number }
      /** 手势开始时的滚动位置 */
      startScroll: { left: number; top: number }
      /** 是否已越过死区（越过前不缩放） */
      armed: boolean
    } | null = null

    /** 当前这一根手指的状态（用于「真轻点」判定） */
    let single: {
      x: number
      y: number
      at: number
      scrollLeft: number
      scrollTop: number
      moved: boolean
    } | null = null

    /** 上一拍**有效轻点**抬起的时间与落点（双击判定） */
    let lastTap = { at: 0, x: 0, y: 0 }

    /** 最近一次滚动事件的时间戳（用于识别「还在滑动」） */
    let lastScrollAt = 0

    /** 第一根手指按下的时间（用于判断第二根手指是不是「同时」按下） */
    let firstTouchAt = 0

    const distance = (t1: Touch, t2: Touch): number =>
      Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY)

    const midpoint = (t1: Touch, t2: Touch): { x: number; y: number } => ({
      x: (t1.clientX + t2.clientX) / 2,
      y: (t1.clientY + t2.clientY) / 2
    })

    /** 是否处于滑动中（手指拖动中或惯性未停） */
    const isScrolling = (): boolean => Date.now() - lastScrollAt < SCROLL_QUIET_MS

    const onScroll = (): void => {
      lastScrollAt = Date.now()
    }

    const onTouchStart = (e: TouchEvent): void => {
      const now = Date.now()
      if (optsRef.current.disabled?.()) return

      if (e.touches.length === 1) {
        const t = e.touches[0]
        firstTouchAt = now
        single = {
          x: t.clientX,
          y: t.clientY,
          at: now,
          scrollLeft: el.scrollLeft,
          scrollTop: el.scrollTop,
          moved: false
        }
        gesture = null
        return
      }

      if (e.touches.length === 2) {
        const [a, b] = [e.touches[0], e.touches[1]]
        // 两指是否「几乎同时」按下：同一帧一起落下的（firstTouchAt 还是 0）算同时
        const joined = firstTouchAt === 0 || now - firstTouchAt <= PINCH_JOIN_MS
        firstTouchAt = 0
        single = null
        // 双指一出现，之前记录的单指轻点作废（避免拼成双击）
        lastTap = { at: 0, x: 0, y: 0 }

        // 滑动中蹭上来的第二根手指不缩放；晚到的第二根手指也不缩放
        if (!joined || isScrolling()) {
          gesture = null
          return
        }

        const scale = optsRef.current.getScale()
        gesture = {
          startDistance: Math.max(1, distance(a, b)),
          startScale: scale,
          currentScale: scale,
          center: midpoint(a, b),
          startScroll: { left: el.scrollLeft, top: el.scrollTop },
          armed: false
        }
      }
    }

    const onTouchMove = (e: TouchEvent): void => {
      if (optsRef.current.disabled?.()) return

      // 单指：只记录有没有被拖走（真轻点判定），滚动交给浏览器
      if (e.touches.length === 1) {
        if (single) {
          const t = e.touches[0]
          if (
            Math.abs(t.clientX - single.x) > TAP_SLOP ||
            Math.abs(t.clientY - single.y) > TAP_SLOP
          ) {
            single.moved = true
          }
        }
        return
      }

      if (e.touches.length !== 2 || !gesture) return

      // ★ 必须阻止默认行为，否则浏览器会尝试滚动/缩放整个页面
      e.preventDefault()

      const [a, b] = [e.touches[0], e.touches[1]]
      const dist = Math.max(1, distance(a, b))
      const ratio = dist / gesture.startDistance

      if (!gesture.armed) {
        // 死区：幅度没超过阈值就什么都不做
        if (Math.abs(ratio - 1) <= PINCH_DEADZONE) return
        // 越过死区：把起点重设到当前位置再开始缩放，避免第一下跳变
        gesture.armed = true
        gesture.startDistance = dist
        gesture.startScale = optsRef.current.getScale()
        gesture.currentScale = gesture.startScale
        return
      }

      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, gesture.startScale * ratio))

      // 位移很小就不重复触发（减少重渲染）
      if (Math.abs(next - gesture.currentScale) / gesture.currentScale < 0.01) return
      gesture.currentScale = next
      optsRef.current.onZoom(next, midpoint(a, b))
    }

    const onTouchEnd = (e: TouchEvent): void => {
      const now = Date.now()
      /*
       * 双击判定改用事件时钟（v2.0.1.1）：Date.now() 量的是「处理函数跑起来的
       * 时刻」，主线程一忙就会把两次轻点的间隔算大，窗口被吃掉，双击退化成两次单击。
       */
      const evt = Number.isFinite(e.timeStamp) && e.timeStamp > 0 ? e.timeStamp : now

      // 少于两指就结束缩放手势
      if (e.touches.length < 2) gesture = null

      // 还剩一根手指：重新开始计时，避免残留时间戳让下一次按下被当成「同时」
      if (e.touches.length === 1) firstTouchAt = now

      if (!single || e.touches.length !== 0) return

      const t = e.changedTouches[0]
      const x = t?.clientX ?? single.x
      const y = t?.clientY ?? single.y
      const tap =
        now - single.at <= TAP_MAX_MS &&
        !single.moved &&
        Math.abs(el.scrollLeft - single.scrollLeft) <= TAP_SCROLL_SLOP &&
        Math.abs(el.scrollTop - single.scrollTop) <= TAP_SCROLL_SLOP &&
        !isScrolling()

      const prev = lastTap
      single = null

      if (!tap) {
        // 不是轻点（滑动/长按/惯性中）→ 清掉上一拍，滑动绝不会被拼成双击
        lastTap = { at: 0, x: 0, y: 0 }
        return
      }

      const isDouble =
        evt - prev.at <= DOUBLE_TAP_MS && Math.hypot(x - prev.x, y - prev.y) <= DOUBLE_TAP_SLOP

      if (isDouble && optsRef.current.allowDoubleTap?.() === false) {
        /*
         * ★ 双击被交给别处处理（「选择」工具下双击 = 选中该词，见
         *   DocumentView.startTouchSelect）。这里只清掉上一拍，
         *   不再缩放 —— 否则选字的同时页面还会突然放大。
         */
        lastTap = { at: 0, x: 0, y: 0 }
        return
      }

      if (isDouble) {
        // 双击：在适应宽度与 200% 之间切换
        const current = optsRef.current.getScale()
        const target = current > 1.4 ? 1 : 2
        optsRef.current.onZoom(target, { x, y })
        lastTap = { at: 0, x: 0, y: 0 }
      } else {
        lastTap = { at: evt, x, y }
      }
    }

    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    el.addEventListener('touchcancel', onTouchEnd, { passive: true })

    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [targetRef])
}
