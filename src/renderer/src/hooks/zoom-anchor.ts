// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 缩放锚点计算。
 *
 * 问题：缩放时如果只是改变页面尺寸，滚动位置不变，
 *   用户正在看的内容会「跑掉」—— 手感很差。
 *   正确做法是：让某个屏幕点对应的内容点在缩放前后保持不动。
 *
 * 数学推导（设缩放前后倍数 k0 → k1，比率 r = k1 / k0）：
 *   设内容坐标为 c，页面在滚动容器里的偏移为 off（含内边距），
 *   则屏幕位置 s = off - scroll + c · k
 *   要求锚点的屏幕位置不变：
 *     off - scroll0 + c · k0 = off - scroll1 + c · k1
 *   ⇒ scroll1 = scroll0 + c · (k1 - k0)
 *   其中 c = (scroll0 + s - off) / k0
 *   合并后：scroll1 = (scroll0 + s - off) · (k1 / k0) + off - s
 *
 * 注意 off 是「页面左上角在滚动内容坐标系里的位置」，
 * 它本身与缩放无关（由容器内边距与页面居中决定），因此可以直接代入。
 */

export interface ZoomAnchorInput {
  /** 缩放前的滚动位置 */
  scroll: { left: number; top: number }
  /** 锚点在视口中的坐标（相对滚动容器左上角） */
  anchor: { x: number; y: number }
  /** 页面（内容）左上角在滚动内容坐标系里的位置，含居中偏移 */
  contentOffset: { x: number; y: number }
  /** 缩放前后倍数 */
  fromScale: number
  toScale: number
}

/** 算出缩放后应设置的滚动位置，使锚点在屏幕上保持不动 */
export function anchoredScroll(input: ZoomAnchorInput): { left: number; top: number } {
  const { scroll, anchor, contentOffset, fromScale, toScale } = input
  const ratio = fromScale > 0 ? toScale / fromScale : 1

  return {
    left: (scroll.left + anchor.x - contentOffset.x) * ratio + contentOffset.x - anchor.x,
    top: (scroll.top + anchor.y - contentOffset.y) * ratio + contentOffset.y - anchor.y
  }
}

/**
 * 取页面元素左上角在滚动内容坐标系里的位置。
 *
 * 用 offsetLeft/offsetTop 而不是 getBoundingClientRect：
 *   rect 会随滚动变化，而 offset 相对的是最近的定位祖先（.viewer-pages），
 *   两者正好构成我们需要的「内容坐标系」。
 */
export function pageContentOffset(pageEl: HTMLElement | null): { x: number; y: number } {
  if (!pageEl) return { x: 0, y: 0 }
  // 用 rect 推算更稳：滚动容器的 scrollTop 已经包含了所有偏移
  const container = pageEl.closest<HTMLElement>('.viewer-scroll')
  if (!container) return { x: pageEl.offsetLeft, y: pageEl.offsetTop }
  const pageRect = pageEl.getBoundingClientRect()
  const containerRect = container.getBoundingClientRect()
  return {
    x: pageRect.left - containerRect.left + container.scrollLeft,
    y: pageRect.top - containerRect.top + container.scrollTop
  }
}
