// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 位图墨迹引擎。
 *
 * ── 与旧的 SVG 矢量方案的区别 ────────────────────────────────
 * 矢量方案：笔迹是 path，每次缩放都按新比例重新计算坐标与线宽，
 *   因此**任何缩放级别下都绝对清晰**，看起来像 UI 元素而不是墨迹。
 * 位图方案（本文件）：笔迹在固定分辨率下被光栅化成像素，
 *   缩放时整块位图被拉伸放大，**放大越多样越糊** ——
 *   这才是「写在纸上的墨迹」应有的表现。
 *
 * ── 具体做法 ─────────────────────────────────────────────────
 *   · 每页一张离屏画布，分辨率固定为参考宽度 × INK_SCALE
 *     （不随缩放变化，保证放大时确实变糊）
 *   · 笔迹坐标属于 scale = 1 的页面坐标系，
 *     光栅化时按 (参考比例 / INK_SCALE) 落笔 ——
 *     与缩放无关，所以墨迹「长」在页面的固定位置上
 *   · 显示时用 CSS 尺寸把画布铺满页面容器，
 *     页面放大画布跟着放大，像素被插值拉宽
 *
 * ── 为什么保留点序列 ──────────────────────────────────────────
 *   位图本身不好存（体积大、改不了），因此磁盘上仍存矢量点序列，
 *   打开文件时再光栅化一遍。这样既有位图的观感，又保留可编辑、
 *   可无损缩放存储的好处。
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react'
import type { Annotation } from '@shared/types'

/* ============================================================
 * 常量
 * ============================================================ */


/* ============================================================
 * 数据结构
 * ============================================================ */

export interface StrokePoint {
  x: number
  y: number
  /** 采样时间戳（毫秒），用于按速度估算笔锋 */
  t: number
  /** 压力 0~1；鼠标与手指恒为 0，绘制时由速度推算 */
  p: number
}

export interface StrokeShape {
  id: string
  points: StrokePoint[]
  color: string
  width: number
}

/* ============================================================
 * 编解码
 * ============================================================ */

export interface StrokePayload {
  v: number
  w?: number
  /** 压缩存储：[x, y, t, p] 四元组 */
  d: number[][]
}

export const STROKE_VERSION = 2
export const STROKE_PREFIX = '[笔迹]'

/** 编码成紧凑 JSON。x/y 保留一位小数已足够精确，体积能省三成左右。 */
export function encodeStroke(points: StrokePoint[], width: number): string {
  const d = points.map((p) => [
    Math.round(p.x * 10) / 10,
    Math.round(p.y * 10) / 10,
    Math.round(p.t),
    Math.round(p.p * 100) / 100
  ])
  const payload: StrokePayload = { v: STROKE_VERSION, w: width, d }
  return STROKE_PREFIX + JSON.stringify(payload)
}

/**
 * 解析笔迹。
 *
 * 同时兼容两代格式，老数据不能丢：
 *   v2（当前）：{ v: 2, w, d: [[x,y,t,p],…] }
 *   v1（早期）：{ points: [{x,y},…], width }
 */
export function decodeStroke(quote: string): { points: StrokePoint[]; width: number } | null {
  if (!quote?.startsWith(STROKE_PREFIX)) return null
  try {
    const raw = JSON.parse(quote.slice(STROKE_PREFIX.length)) as Record<string, unknown>

    if (Array.isArray(raw.d)) {
      const points: StrokePoint[] = []
      for (const item of raw.d as number[][]) {
        if (!Array.isArray(item) || item.length < 2) continue
        points.push({
          x: Number(item[0]) || 0,
          y: Number(item[1]) || 0,
          t: Number(item[2]) || points.length * 16,
          p: typeof item[3] === 'number' ? item[3] : 0
        })
      }
      if (points.length < 2) return null
      return { points, width: typeof raw.w === 'number' ? raw.w : 3 }
    }

    if (Array.isArray(raw.points)) {
      const points: StrokePoint[] = []
      for (const item of raw.points as Array<{ x: number; y: number }>) {
        points.push({
          x: Number(item.x) || 0,
          y: Number(item.y) || 0,
          t: points.length * 16,
          p: 0
        })
      }
      if (points.length < 2) return null
      return { points, width: typeof raw.width === 'number' ? raw.width : 3 }
    }

    return null
  } catch {
    return null
  }
}

/* ============================================================
 * 笔锋计算
 * ============================================================ */

const dist = (a: StrokePoint, b: StrokePoint): number => Math.hypot(b.x - a.x, b.y - a.y)

/** 相邻点的速度（像素 / 毫秒）；时间差为 0 时按 1ms 兜底避免 Infinity */
function speedAt(points: StrokePoint[], i: number): number {
  const a = points[Math.max(0, i - 1)]
  const b = points[Math.min(points.length - 1, i + 1)]
  const dt = Math.max(1, b.t - a.t)
  return dist(a, b) / dt
}

/**
 * 由速度推算等效压力。
 *
 * 教学书写大致在 0.2~2.5 px/ms，这个区间内希望粗细变化最明显，
 * 因此用开方而不是线性 —— 线性会让慢速段变化过陡、快速段几乎无差别。
 */
function pressureFromSpeed(speed: number): number {
  const FAST = 2.2
  const SLOW = 0.25
  const norm = Math.min(1, Math.max(0, (speed - SLOW) / (FAST - SLOW)))
  return 1 - Math.sqrt(norm) * 0.72
}

/** 由压力反推笔宽倍率；0.38 是极速时的最细倍率，再细就看不见了 */
function widthRatio(p: number): number {
  return 0.38 + 0.62 * Math.min(1, Math.max(0, p))
}

/**
 * 起笔 / 收笔的渐细包络。
 *
 * 笔尖落纸是逐渐加力的、收笔会提起来，两端因此变细。
 * 包络长度按整条笔迹长度取比例而不是固定点数 ——
 * 长笔画和短笔画的笔锋长度才会看起来一致，而不是长笔画拖一条长尾巴。
 */
function taperRatio(t: number, totalLen: number): number {
  const taper = Math.min(totalLen * 0.14, 34)
  if (taper <= 0.5) return 1
  const dEnds = Math.min(t, totalLen - t)
  if (dEnds >= taper) return 1
  const k = dEnds / taper
  return 0.32 + 0.68 * Math.sqrt(k)
}

/* ============================================================
 * 光栅化
 * ============================================================ */

/**
 * 把点序列画进 2D 上下文。
 *
 * ── 渲染方式（第三轮重构，最终方案）──────────────────────────
 * 用**变宽轮廓填充**，而不是逐段描边。
 *
 * 【第一轮】每段单独 `ctx.stroke()`，宽度逐段算。
 *   问题：相邻段的宽度是常数、阶跃变化，而且每段的圆头端点
 *   在接缝处互相叠加，看起来是一串小珠子 —— 这就是「笔迹不够顺」
 *   的根源。宽度变化越剧烈越明显。
 *
 * 【现在】把整条笔迹当成一个**有面积的形状**：
 *   沿中心线走一遍，按每点的宽度算出左右两条边界，
 *   首尾加圆帽，组成一个闭合多边形，最后**一次 fill**。
 *   这样：
 *     · 宽度沿笔画连续渐变，没有阶跃
 *     · 只有一次填充，不存在接缝重叠 → 没有珠子感
 *     · 抗锯齿由 canvas 的填充光栅化统一处理，边缘干净
 *
 * ── 平滑 ────────────────────────────────────────────────────
 *   沿用中点二次贝塞尔：对相邻三点取中点作为端点、中间点作为控制点，
 *   相邻曲线在中点处切线连续，因此中心线本身是光滑的。
 *   这里先把它**离散成密集的折线**（每段 8 小步），
 *   因为变宽轮廓需要逐点算法线，曲线方程不好直接求偏置。
 *
 * ctx 的变换由调用方设好，这里只负责落笔。
 */
function paintStroke(
  ctx: CanvasRenderingContext2D,
  points: StrokePoint[],
  width: number,
  color: string
): void {
  if (points.length < 2) return

  // 累计弧长，用于定位笔锋在笔画上的位置
  const cum: number[] = [0]
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + dist(points[i - 1], points[i]))
  }
  const total = cum[cum.length - 1]
  if (total <= 0) return

  /* ---------- ① 生成密集的中心线点列 ---------- */
  type Dense = { x: number; y: number; w: number }
  const dense: Dense[] = []
  const last = points.length - 1

  /** 取某点的宽度（含压感与笔锋衰减） */
  const widthAt = (i: number): number => {
    const speed = speedAt(points, i)
    const pressure = points[i].p > 0 ? points[i].p : pressureFromSpeed(speed)
    return Math.max(0.3, width * widthRatio(pressure) * taperRatio(cum[i], total))
  }

  for (let i = 0; i < last; i++) {
    const p0 = points[Math.max(0, i - 1)]
    const p1 = points[i]
    const p2 = points[i + 1]
    const m1 = i === 0 ? p1 : { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 }
    const m2 = i === last - 1 ? p2 : { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
    const w1 = widthAt(i)
    const w2 = widthAt(Math.min(last, i + 1))

    /*
     * 每段细分成 STEPS 小步。
     * 8 步是精度与开销的折中：进一步细分对手感已无可见改善，
     * 但点数会线性增长，影响长笔画的绘制耗时。
     */
    const STEPS = 8
    for (let k = 0; k < STEPS; k++) {
      const t = k / STEPS
      // 二次贝塞尔在参数 t 处的坐标
      const mt = 1 - t
      const x = mt * mt * m1.x + 2 * mt * t * p1.x + t * t * m2.x
      const y = mt * mt * m1.y + 2 * mt * t * p1.y + t * t * m2.y
      dense.push({ x, y, w: w1 + (w2 - w1) * t })
    }
  }
  // 收尾点用最后一小段的宽度，避免轮廓末端突然变粗
  dense.push({ x: points[last].x, y: points[last].y, w: widthAt(last) })

  if (dense.length < 2) return

  /* ---------- ② 沿中心线求左右边界 ---------- */
  const left: { x: number; y: number }[] = []
  const right: { x: number; y: number }[] = []

  for (let i = 0; i < dense.length; i++) {
    const prev = dense[Math.max(0, i - 1)]
    const next = dense[Math.min(dense.length - 1, i + 1)]
    let tx = next.x - prev.x
    let ty = next.y - prev.y
    const len = Math.hypot(tx, ty)
    if (len < 1e-6) {
      // 重合点无法求切线，沿用上一个方向（否则法线会变成 NaN）
      tx = 1
      ty = 0
    } else {
      tx /= len
      ty /= len
    }
    // 法线 = 切线逆时针转 90°
    const nx = -ty
    const ny = tx
    const half = dense[i].w / 2
    left.push({ x: dense[i].x + nx * half, y: dense[i].y + ny * half })
    right.push({ x: dense[i].x - nx * half, y: dense[i].y - ny * half })
  }

  /* ---------- ③ 组成闭合多边形并一次填充 ---------- */
  ctx.fillStyle = color
  ctx.beginPath()

  const r0 = dense[0].w / 2
  const rN = dense[dense.length - 1].w / 2

  /*
   * 起点圆帽：从右侧起点画半圆到左侧起点。
   * 用 arc 而不是 lineTo，笔迹两端才是圆头（像真实笔尖）。
   */
  ctx.moveTo(right[0].x, right[0].y)
  const t0x = dense[1].x - dense[0].x
  const t0y = dense[1].y - dense[0].y
  const a0 = Math.atan2(t0y, t0x)
  ctx.arc(dense[0].x, dense[0].y, r0, a0 - Math.PI / 2, a0 + Math.PI / 2, false)

  // 左侧边界：反向走（终点 → 起点）以形成闭合回路
  for (let i = 0; i < left.length; i++) ctx.lineTo(left[i].x, left[i].y)

  // 终点圆帽
  const tNx = dense[dense.length - 1].x - dense[dense.length - 2].x
  const tNy = dense[dense.length - 1].y - dense[dense.length - 2].y
  const aN = Math.atan2(tNy, tNx)
  ctx.arc(dense[dense.length - 1].x, dense[dense.length - 1].y, rN, aN + Math.PI / 2, aN - Math.PI / 2, false)

  // 右侧边界：正向走回起点
  for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i].x, right[i].y)

  ctx.closePath()
  ctx.fill()
}

/**
 * 点到线段的距离。
 *
 * 橡皮命中判定要用：笔迹是一条折线，
 * 不能只用「点到点的距离」判断（点落在两个采样点中间时会漏判），
 * 必须算到线段的垂直距离。
 */
function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(px - ax, py - ay)
  // 把点投影到线段上，t 限制在 [0,1] 内保证落在线段上而不是延长线
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/**
 * 找出坐标 (x, y) 命中的笔迹 id。
 *
 * 位图墨迹只有一个 canvas，无法像矢量方案那样逐条挂 data-anno-id，
 * 因此橡皮改为直接算几何距离。
 *
 * @param tolerance 用户选的橡皮大小（像素）。
 *   实际容差取 max(笔宽, tolerance)：
 *     细笔按实际宽度算会几乎点不中，用 tolerance 兜底保证能擦到；
 *     粗笔则按真实宽度，避免点到旁边就误删。
 *
 * 返回最接近的一条（而不是最先命中的）——
 * 笔迹交叠时用户想擦的通常是离点击点最近的那条。
 */
export function hitTestStroke(
  strokes: StrokeShape[],
  x: number,
  y: number,
  tolerance = 14
): { id: string; distance: number } | null {
  let best: { id: string; distance: number } | null = null

  for (const stroke of strokes) {
    const tol = Math.max(stroke.width, tolerance)
    const pts = stroke.points

    for (let i = 1; i < pts.length; i++) {
      const d = distToSegment(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y)
      if (d > tol) continue
      if (!best || d < best.distance) best = { id: stroke.id, distance: d }
    }
  }

  return best
}

/**
 * 把一条批注还原成可绘制的笔迹。
 *
 * 放在这里（而不是 AnnotationLayer）是为了**避免循环依赖**：
 *   store 需要它来把批注还原成几何做橡皮切分，
 *   而 AnnotationLayer 依赖 store 的数据 ——
 *   若定义在 AnnotationLayer，就会形成
 *   store → AnnotationLayer → ink-engine → store 的环。
 * ink-engine 只依赖 @shared/types，是干净的底层模块。
 *
 * 非笔迹类批注（高亮、便签）返回 null。
 */
export function toStrokeShape(item: Annotation): StrokeShape | null {
  if (item.type !== 'note') return null
  const decoded = decodeStroke(item.quote)
  if (!decoded) return null
  return {
    id: item.id,
    points: decoded.points,
    color: item.color,
    width: decoded.width
  }
}

/* ============================================================
 * 橡皮：按几何把笔迹切段
 * ============================================================ */

/**
 * 找出**所有**与橡皮圆相交的笔迹。
 *
 * 与 hitTestStroke 的区别：
 *   hitTestStroke 只返回最近的一条 —— 适合「点一下删一条」的旧逻辑。
 *   真实橡皮是一个面，范围内所有笔迹都该被擦到，
 *   因此这里返回全部相交项。
 *
 * @param radius 橡皮半径（页面坐标）。判定用「点到线段的距离 ≤ 半径 + 笔宽一半」，
 *   这样贴着粗笔边缘也能擦到，符合真实橡皮的手感。
 */
export function strokesInEraser(
  strokes: StrokeShape[],
  x: number,
  y: number,
  radius: number
): StrokeShape[] {
  const out: StrokeShape[] = []

  for (const stroke of strokes) {
    // 笔宽算进去：橡皮边界碰到笔迹边缘就该生效
    const r = radius + stroke.width / 2
    const pts = stroke.points

    if (pts.length === 1) {
      if (Math.hypot(pts[0].x - x, pts[0].y - y) <= r) out.push(stroke)
      continue
    }

    for (let i = 1; i < pts.length; i++) {
      const d = distToSegment(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y)
      if (d <= r) {
        out.push(stroke)
        break // 一条笔迹只收一次
      }
    }
  }

  return out
}

/** 一段被擦除后的残段（点列 + 该段的原始索引范围） */
export interface StrokeFragment {
  points: StrokePoint[]
  /** 该段首点在原笔迹里的下标（用于生成稳定的 id） */
  startIndex: number
}

/**
 * 用橡皮圆切掉笔迹上的一段，返回剩余的残段。
 *
 * ── 为什么不做「命中即整条删除」（原来的做法）────────────────
 *   真实橡皮是**局部**擦除：铅笔划过的地方被磨掉一块，
 *   剩下的仍然在。整条删除的问题是稍微碰到一点，
 *   用户辛苦画的一整条长线就没了 —— 实测被反馈为不符合直觉。
 *
 * ── 算法 ────────────────────────────────────────────────────
 *   把笔迹看成折线，逐点判断是否落在橡皮圆内：
 *     · 圆外的点保留
 *     · 圆内的点丢弃
 *   连续被丢弃的一段就形成「切缝」，把笔迹切成若干残段。
 *
 *   为了让切缝边缘不留毛刺，对**跨越边界的那一小段**做线性插值，
 *   把交点算出来补进残段端点 —— 否则切口会是锯齿状，
 *   在放大后尤其明显。
 *
 * ── 参数 ────────────────────────────────────────────────────
 * @param x,y      橡皮圆心（页面坐标系）
 * @param radius   橡皮半径（页面坐标系，已含笔宽补偿）
 * @returns 残段数组。空数组表示整条被擦光。
 */
export function splitStrokeByEraser(
  points: StrokePoint[],
  x: number,
  y: number,
  radius: number
): StrokeFragment[] {
  if (points.length === 0) return []

  const r2 = radius * radius
  const inside = (p: StrokePoint): boolean => {
    const dx = p.x - x
    const dy = p.y - y
    return dx * dx + dy * dy <= r2
  }

  /** 求线段 AB 与圆的交点（A 在圆外、B 在圆内时用），返回靠近 A 的交点 */
  const entryPoint = (a: StrokePoint, b: StrokePoint): StrokePoint => {
    // 参数化 P(t) = A + t(B-A)，解 |P-C|² = r²
    const dx = b.x - a.x
    const dy = b.y - a.y
    const fx = a.x - x
    const fy = a.y - y
    const A = dx * dx + dy * dy
    if (A === 0) return a
    const B = 2 * (fx * dx + fy * dy)
    const C = fx * fx + fy * fy - r2
    const disc = B * B - 4 * A * C
    if (disc < 0) return a // 理论上不会发生（B 在圆内必有交点）
    const sq = Math.sqrt(disc)
    // 取较小的根（先进入圆的那一个）
    let t = (-B - sq) / (2 * A)
    if (t < 0 || t > 1) t = (-B + sq) / (2 * A)
    t = Math.max(0, Math.min(1, t))
    return {
      x: a.x + dx * t,
      y: a.y + dy * t,
      t: a.t + (b.t - a.t) * t,
      p: a.p + (b.p - a.p) * t
    }
  }

  const fragments: StrokeFragment[] = []
  let current: StrokePoint[] = []
  let currentStart = 0

  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const isIn = inside(p)

    if (!isIn) {
      /*
       * 当前点在圆外。
       * 若上一个点在圆内，说明这是「出圆」—— 要把与圆的交点
       * 作为这一段的起点补上，切口才平整。
       */
      if (i > 0 && inside(points[i - 1])) {
        const cross = entryPoint(points[i - 1], p)
        if (current.length === 0) currentStart = i
        current.push(cross)
      }
      if (current.length === 0) currentStart = i
      current.push(p)
    } else {
      /*
       * 当前点在圆内。
       * 若上一个点在圆外，说明这是「入圆」—— 把交点作为上一段的终点收尾。
       */
      if (i > 0 && !inside(points[i - 1]) && current.length > 0) {
        const cross = entryPoint(points[i - 1], p)
        current.push(cross)
        fragments.push({ points: current, startIndex: currentStart })
        current = []
      }
    }
  }

  if (current.length > 0) fragments.push({ points: current, startIndex: currentStart })

  /*
   * 丢掉只剩一个点的碎片：
   * 单点画出来是一个圆点，视觉上像是「没擦干净」，
   * 而它其实只是切缝边缘的插值产物。
   */
  return fragments.filter((f) => f.points.length >= 2)
}

/**
 * 实时预览画布的对外句柄。
 *
 * ── 为什么要命令式接口（这是「书写延迟 + 笔迹被吞」的根治办法）──
 *   原先每来一个 pointermove 就 `setDraft(新点数组)`，
 *   触发一次 React 全量重渲染。实测书写较快时：
 *     · 明显延迟 —— 每次渲染都要过一遍组件树
 *     · 部分笔迹被吞 —— React 把同一帧内的多次 setState 批处理合并，
 *       中间的点直接丢失，曲线出现断口
 *
 *   改为命令式后：移动时只把新点追加进内部数组并**立即绘制**，
 *   完全不经过 React。React 只在起笔（挂载画布）与
 *   收笔（结算批注）时各渲染一次。
 *   每帧开销只剩「画一笔」本身，与已积累的点数无关。
 */
export interface PreviewInkHandle {
  /** 追加一批点并立即重绘 */
  drawMore(points: StrokePoint[]): void
  /** 清空画布（收笔后调用） */
  clear(): void
}

/**
 * 实时预览画布。
 *
 * 正在画的那一笔单独渲染在一张覆盖全页的画布上，
 * 与成品共用 paintStroke 与**同一套坐标换算** ——
 * 松手时笔迹不会突然变样、也不会跳位置。
 *
 * ── 为什么必须与成品严格同源（血的教训）──────────────────────
 *   曾经这里用「显示尺寸 × dpr」分配位图、变换取 dpr；
 *   而成品用「原始尺寸 × dpr × 超采样」分配、变换取 dpr×超采样。
 *   两者相差一个倍率，于是**预览画得准、一松手笔迹就跳走**。
 *   现在两边都按「原始尺寸 × dpr × 超采样」分配位图、
 *   变换都取同一个系数，物理上不可能再出现差异。
 *
 * ── 为什么不按缩放重设位图 ───────────────────────────────────
 *   位图分辨率固定后，缩放只改 CSS 尺寸（GPU 合成，零重绘）——
 *   这既消除了缩放白屏，也让缩放变得流畅。
 */
export const PreviewInk = forwardRef<
  PreviewInkHandle,
  {
    /** 起笔时的颜色与粗细；同一笔期间不会变 */
    color: string
    width: number
    /**
     * 该笔迹所属页面左上角在 .viewer-pages 坐标系里的偏移。
     *
     * ★ 水平偏移也必须传（踩坑记录）：
     *   原来只传了纵向，横向写死 left: 0。
     *   但 .viewer-pages 有 16px 内边距，页面实际从 16px 开始 ——
     *   于是预览整体左移 16px，用户看到的「实时落笔」位置是偏的，
     *   松手落盘后回到正确位置，观感就成了「画完笔迹跳走了」。
     */
    offsetX: number
    offsetY: number
    /** 页面原始宽度（scale = 1 的 PDF 单位） */
    baseWidth: number
    /** 页面原始高度（scale = 1 的 PDF 单位） */
    baseHeight: number
    /** 页面当前显示宽度（CSS 像素） */
    displayWidth: number
    /** 页面当前显示高度（CSS 像素） */
    displayHeight: number
    /** 起笔的第一个点，挂载时先画出笔尖 */
    initialPoints: StrokePoint[]
  }
>(function PreviewInk(
  {
    color,
    width,
    offsetX,
    offsetY,
    baseWidth,
    baseHeight,
    displayWidth,
    displayHeight,
    initialPoints
  },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  /**
   * 当前这一笔的全部点。
   *
   * 用 ref 而不是 state：它是**绘制数据**，不参与渲染决策。
   * 放进 state 只会让每个点都触发重渲染 —— 正是要避免的问题。
   */
  const pointsRef = useRef<StrokePoint[]>(initialPoints)

  /* 与成品 InkCanvas 完全相同的分辨率公式 */
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
  const bitmapW = Math.max(1, Math.round(baseWidth * dpr * INK_SUPERSAMPLE))
  const bitmapH = Math.max(1, Math.round(baseHeight * dpr * INK_SUPERSAMPLE))

  /** 重绘当前这一笔 */
  const redraw = useCallback((): void => {
    const canvas = canvasRef.current
    if (!canvas) return

    if (canvas.width !== bitmapW || canvas.height !== bitmapH) {
      canvas.width = bitmapW
      canvas.height = bitmapH
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    // 与成品同一个变换系数：位图像素 / 页面原始单位
    const s = baseWidth > 0 ? bitmapW / baseWidth : 1
    ctx.setTransform(s, 0, 0, s, 0, 0)
    paintStroke(ctx, pointsRef.current, width, color)
  }, [bitmapW, bitmapH, baseWidth, width, color])

  /* 暴露命令式接口给父组件 */
  useImperativeHandle(
    ref,
    () => ({
      drawMore: (more) => {
        if (more.length === 0) return
        pointsRef.current = [...pointsRef.current, ...more]
        redraw()
      },
      clear: () => {
        pointsRef.current = []
        const canvas = canvasRef.current
        const ctx = canvas?.getContext('2d')
        if (canvas && ctx) {
          ctx.setTransform(1, 0, 0, 1, 0, 0)
          ctx.clearRect(0, 0, canvas.width, canvas.height)
        }
      }
    }),
    [redraw]
  )

  /*
   * 只在挂载与参数变化时重绘一次。
   * 注意依赖里**没有点数组** —— 点的追加走 drawMore，
   * 不触发 React，这正是性能提升的来源。
   */
  useEffect(() => {
    pointsRef.current = initialPoints
    redraw()
  }, [initialPoints, redraw])

  return (
    <canvas
      ref={canvasRef}
      className="ink-preview"
      aria-hidden="true"
      style={{
        // 覆盖整页并按所属页面的位置偏移（含 .viewer-pages 的内边距）
        width: displayWidth > 0 ? `${displayWidth}px` : '100%',
        height: displayHeight > 0 ? `${displayHeight}px` : '100%',
        transform: `translate(${offsetX}px, ${offsetY}px)`
      }}
    />
  )
})

/* ============================================================
 * 画布组件
 * ============================================================ */

/**
 * 墨迹位图的超采样倍率。
 *
 * 位图是**固定分辨率**的，缩放时靠 CSS 拉伸 ——
 * 这是「与底图位置严格对齐」的代价（位置与锐利不可兼得，
 * 要位置绝对准，就必须让位图足够大以覆盖放大后的清晰度需求）。
 *
 *   位图 = 页面原始尺寸 × 设备像素比 × 本倍率
 *
 * 3 是权衡结果：A4 页面约得 2400×3400 位图（单页约 32MB），
 * 放大到 300% 仍清晰；再往上内存与首次绘制时间都明显变差。
 */
const INK_SUPERSAMPLE = 3

/**
 * 位图墨迹层。
 *
 * ── 架构（按市面阅读器的通行做法，第三轮重写）──────────────
 * 本组件渲染在 .pdf-page **内部**，与底图 canvas 是兄弟节点，
 * 两者共用同一个布局盒、随页面一起被 CSS 缩放。
 *   位图尺寸 = 页面原始尺寸 × dpr × INK_SUPERSAMPLE（**固定**）
 *   显示尺寸 = 100% × 100%（随页面盒子缩放）
 *
 * 位置因此**物理上不可能错位**：墨迹与底图在同一坐标系、
 * 由同一个布局盒决定位置，不存在「两层各自异步更新」的窗口。
 *
 * ── 前两轮为什么不行 ─────────────────────────────────────────
 * 【一轮】位图分辨率写死且与缩放无关 → 放大就糊。
 * 【二轮】改成分辨率跟随缩放 → 清晰了，但每次缩放都要重设
 *   canvas 尺寸并重绘，与底图的重绘**各自异步**，
 *   中间几帧两层尺寸不一致 → 用户看到「位置不同步」；
 *   且 250% 下每帧要生成 700 万像素位图，缩放直接卡住。
 *
 * ── 为什么不再按缩放重设位图 ─────────────────────────────────
 * 固定高分辨率 + CSS 拉伸之后：
 *   · 缩放只改 CSS 尺寸，由 GPU 合成，**零重绘开销** → 流畅
 *   · 墨迹始终与底图同盒 → 位置永远对齐
 *   · 超采样 3 倍保证放大后的清晰度
 * 三个问题一次解决。
 */
export function InkCanvas({
  strokes,
  baseWidth,
  baseHeight,
  erasing = false
}: {
  strokes: StrokeShape[]
  /** 页面在 scale = 1 坐标系下的原始宽度（PDF 单位） */
  baseWidth: number
  /** 页面在 scale = 1 坐标系下的原始高度（PDF 单位） */
  baseHeight: number
  /**
   * 橡皮模式：墨迹层需要接收点击才能做命中判定。
   *
   * ★ 必须真的把类加到 canvas 上。
   *   之前只在 CSS 里写了 `.ink-canvas.is-erasing` 规则，
   *   却忘了传这个状态，结果橡皮点了没反应
   *   （实测墨迹层的 pointer-events 始终是 none）。
   */
  erasing?: boolean
}): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)

  /*
   * 位图尺寸**固定**，不随窗口缩放变化。
   * 用 dpr 提升基础清晰度，再乘超采样倍率覆盖放大后的需求。
   */
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
  const bitmapW = Math.max(1, Math.round(baseWidth * dpr * INK_SUPERSAMPLE))
  const bitmapH = Math.max(1, Math.round(baseHeight * dpr * INK_SUPERSAMPLE))

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return

    /*
     * 尺寸变化时重设会清空画布 —— 紧接着必须同步重绘，
     * 否则浏览器会在两次之间把空白帧画到屏幕上（白闪）。
     * 下面的重绘就在同一个 effect 里同步执行，不经过任何异步边界。
     */
    if (canvas.width !== bitmapW || canvas.height !== bitmapH) {
      canvas.width = bitmapW
      canvas.height = bitmapH
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    // 笔迹按「页面原始单位」描述，这里换算到位图像素
    const s = baseWidth > 0 ? bitmapW / baseWidth : 1
    ctx.setTransform(s, 0, 0, s, 0, 0)

    /*
     * 逐条绘制。
     * 每条之间不叠加透明度 —— 交叠处如果做半透明会越叠越深，
     * 看起来像脏点。整层透明度由 CSS 统一给（见 ink.css）。
     */
    for (const stroke of strokes) {
      paintStroke(ctx, stroke.points, stroke.width, stroke.color)
    }
  }, [strokes, bitmapW, bitmapH, baseWidth])

  return (
    <canvas
      ref={ref}
      className={`ink-canvas ${erasing ? 'is-erasing' : ''}`}
      /*
       * 命中检测用的标记放在 canvas 上：
       * 位图墨迹只有一个 canvas，没法像矢量那样逐条给 data-anno-id。
       * 橡皮改为按坐标精确判断（见 DocumentView 的命中逻辑）。
       */
      data-ink-layer="1"
    />
  )
}
