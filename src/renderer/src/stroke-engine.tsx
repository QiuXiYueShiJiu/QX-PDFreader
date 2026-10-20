// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 笔迹渲染引擎。
 *
 * ── 为什么不用 polyline（原先的做法）──────────────────────────
 * 折线有三个明显缺陷，画出来的东西一眼就"假"：
 *   ① 点与点之间是直线，快速划动时能看到明显的折角
 *   ② 整条线粗细一致，没有起笔收笔，像马克笔不像笔
 *   ③ 无法表达压力，触屏笔的压感数据全被丢掉
 *
 * ── 这一版的做法 ─────────────────────────────────────────────
 *   · **平滑**：用中点二次贝塞尔（quadratic through midpoints）把折线
 *     变成连续曲线。比起 Catmull-Rom，它不需要解方程，实现短且不容易
 *     出现"过冲"（曲线跑到控制点外侧）。
 *   · **笔锋**：把每条曲线细分成小段，逐段算宽度。
 *     宽度由两部分决定：
 *       压力（有笔就用真实压感，鼠标/手指用速度推算）
 *       起笔与收笔的渐细（模拟真实笔尖的提按）
 *   · **快 = 细**：真实书写时划得越快笔画越细，
 *     用相邻点距离 / 时间差估算速度，再做反比映射。
 *
 * 坐标一律是 scale = 1 的页面坐标，渲染时按当前缩放乘算 ——
 * 缩放、旋转后笔迹位置都不会漂移。
 */

import { useMemo } from 'react'

/* ============================================================
 * 数据结构
 * ============================================================ */

/** 笔迹上的一个采样点 */
export interface StrokePoint {
  x: number
  y: number
  /** 采样时间戳（毫秒），用于估算速度 */
  t: number
  /** 压力 0~1；鼠标与手指恒为 0，绘制时由速度推算 */
  p: number
}

/** 在页面上渲染一条笔迹所需的数据 */
export interface StrokeShape {
  id: string
  points: StrokePoint[]
  color: string
  width: number
}

/** 笔迹在 quote 字段里的存储格式 */
export interface StrokePayload {
  v: number
  w?: number
  /** 压缩存储：[x, y, t, p] 四元组数组，减少体积 */
  d: number[][]
}

/** 笔迹数据版本号。加这个是为了以后能升级格式而不破坏已有数据。 */
export const STROKE_VERSION = 2

/** 笔迹在 quote 里的前缀（沿用旧值，保证老数据仍可识别） */
export const STROKE_PREFIX = '[笔迹]'

/* ============================================================
 * 编解码
 * ============================================================ */

/** 把点序列编码成紧凑 JSON（x/y 保留一位小数已足够精确） */
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
 * 要同时兼容两种格式：
 *   v2（当前）：{ v: 2, w, d: [[x,y,t,p],...] }
 *   v1（早期）：{ points: [{x,y},...], width }
 * 老数据不能丢 —— 用户之前画的批注必须照常显示。
 */
export function decodeStroke(quote: string): { points: StrokePoint[]; width: number } | null {
  if (!quote?.startsWith(STROKE_PREFIX)) return null
  try {
    const raw = JSON.parse(quote.slice(STROKE_PREFIX.length)) as Record<string, unknown>

    // v2：四元组数组
    if (Array.isArray(raw.d)) {
      const points: StrokePoint[] = []
      for (const item of raw.d as number[][]) {
        if (!Array.isArray(item) || item.length < 2) continue
        points.push({
          x: Number(item[0]) || 0,
          y: Number(item[1]) || 0,
          // 老数据可能没有 t / p，给一个合理默认值
          t: Number(item[2]) || points.length * 16,
          p: typeof item[3] === 'number' ? item[3] : 0
        })
      }
      if (points.length < 2) return null
      return { points, width: typeof raw.w === 'number' ? raw.w : 3 }
    }

    // v1：对象数组
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
 * 几何计算
 * ============================================================ */

const dist = (a: StrokePoint, b: StrokePoint): number => Math.hypot(b.x - a.x, b.y - a.y)

/**
 * 相邻采样点之间的速度（像素 / 毫秒）。
 *
 * 时间差为 0（同一毫秒内的多个事件）时按 1ms 兜底，
 * 否则会算出 Infinity 把宽度打成 0。
 */
function speedAt(points: StrokePoint[], i: number): number {
  const a = points[Math.max(0, i - 1)]
  const b = points[Math.min(points.length - 1, i + 1)]
  const dt = Math.max(1, b.t - a.t)
  return dist(a, b) / dt
}

/**
 * 由速度推算等效压力（鼠标 / 手指场景）。
 *
 * 映射曲线是试出来的：教学书写速度大致在 0.2~2.5 px/ms，
 * 这个区间内希望粗细变化最明显，因此用开方而不是线性 ——
 * 线性映射会让慢速段变化过陡、快速段几乎无差别。
 */
function pressureFromSpeed(speed: number): number {
  const FAST = 2.2
  const SLOW = 0.25
  const norm = Math.min(1, Math.max(0, (speed - SLOW) / (FAST - SLOW)))
  return 1 - Math.sqrt(norm) * 0.72
}

/** 用压力反推笔宽（相对基准宽度的倍率） */
function widthRatio(p: number): number {
  // 0.38 是极速时的最细倍率：再细就看不见了
  return 0.38 + 0.62 * Math.min(1, Math.max(0, p))
}

/**
 * 起笔 / 收笔的渐细包络。
 *
 * 真实笔尖落纸是逐渐加力的，收笔会提起来，两端因此变细。
 * 包络长度按整条笔迹长度取比例（而不是固定点数）——
 * 长笔画和短笔画的笔锋长度应该看起来差不多，而不是长笔画拖一条长尾巴。
 */
function taperRatio(t: number, totalLen: number): number {
  const taper = Math.min(totalLen * 0.14, 34)
  if (taper <= 0.5) return 1
  const dEnds = Math.min(t, totalLen - t)
  if (dEnds >= taper) return 1
  const k = dEnds / taper
  // 用平方根让过渡更自然，线性会显得很生硬
  return 0.32 + 0.68 * Math.sqrt(k)
}

/* ============================================================
 * 渲染
 * ============================================================ */

interface Segment {
  d: string
  width: number
}

/**
 * 把采样点转成一组「带独立宽度的曲线段」。
 *
 * 平滑算法：中点二次贝塞尔。
 *   对相邻三点 P0/P1/P2，以 P0P1 与 P1P2 的中点为端点，
 *   以 P1 为控制点画二次曲线。这样相邻曲线在中点处切线连续，
 *   接缝处不会有折角，也不需要解任何方程。
 */
function buildSegments(points: StrokePoint[], baseWidth: number): Segment[] {
  if (points.length < 2) return []

  // 累计弧长，用于计算笔锋位置
  const cum: number[] = [0]
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + dist(points[i - 1], points[i]))
  }
  const total = cum[cum.length - 1]

  // 采样点太密时先抽稀，避免生成上千个微段拖慢渲染
  const step = total > 1200 ? 2 : 1
  const pts = step === 1 ? points : points.filter((_, i) => i % step === 0 || i === points.length - 1)

  const segments: Segment[] = []

  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]
    const p1 = pts[i]
    const p2 = pts[Math.min(pts.length - 1, i + 1)]
    const p3 = pts[Math.min(pts.length - 1, i + 2)]

    // 输入中点作为曲线端点
    const mid1 = i === 0 ? p1 : { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2, t: p1.t, p: p1.p }
    const mid2 =
      i === pts.length - 2
        ? p2
        : { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2, t: p2.t, p: p2.p }

    const d = `M ${mid1.x} ${mid1.y} Q ${p1.x} ${p1.y} ${mid2.x} ${mid2.y}`

    const arcPos = cum[Math.min(cum.length - 1, i * step)]
    const speed = speedAt(points, Math.min(points.length - 1, i * step))
    // 有真实压感就用它，否则用速度推算
    const pressure = p1.p > 0 ? p1.p : pressureFromSpeed(speed)

    const width = baseWidth * widthRatio(pressure) * taperRatio(arcPos, total)

    segments.push({ d, width: Math.max(0.4, width) })

    // 用 p3 只是为了让循环边界与 Catmull-Rom 的心智模型一致；
    // 中点二次贝塞尔不需要它，这里显式忽略以免被误认为漏用。
    void p3
  }

  return segments
}

/**
 * 笔迹图层。
 *
 * 每条笔迹渲染成一个 <g>，内部是若干 <path>（逐段变宽）。
 * 分级原因：SVG 的 stroke-width 是整条路径统一的，
 * 想做笔锋只能拆成多段。段数经过抽稀控制，一页几十条笔迹也不卡。
 */
export function StrokeLayer({
  strokes,
  scale,
  interactive = false
}: {
  strokes: StrokeShape[]
  scale: number
  /**
   * 是否让笔迹接收指针事件（橡皮模式为 true）。
   *
   * ★ 必须用内联样式而不是 CSS 类：
   *   本组件渲染在 .anno-layer 内部，而 .anno-layer 设了
   *   pointer-events: none。父元素禁用事件后**子元素会被一并禁用**，
   *   靠外部 CSS 的 `.viewer-scroll.is-erasing .stroke-layer path`
   *   选择器覆盖不到（实测 elementsFromPoint 完全取不到 path，
   *   橡皮因此点不中笔迹）。
   *   直接写在元素上就不受继承影响，也没有选择器优先级问题。
   */
  interactive?: boolean
}): JSX.Element | null {
  const rendered = useMemo(
    () =>
      strokes.map((s) => ({
        id: s.id,
        color: s.color,
        segments: buildSegments(s.points, s.width)
      })),
    [strokes]
  )

  if (rendered.length === 0) return null

  return (
    <svg
      className="stroke-layer"
      aria-hidden="true"
      // 容器本身不吃事件；只在橡皮模式下让每条 path 自己响应
      style={{ pointerEvents: 'none' }}
    >
      {rendered.map((stroke) => (
        <g key={stroke.id} data-stroke-id={stroke.id}>
          {stroke.segments.map((seg, i) => (
            <path
              key={i}
              /*
               * data-anno-id 是橡皮的命中依据，加在每个 path 上：
               * 笔迹被拆成多段后，命中任意一段都要能删掉整条。
               */
              data-anno-id={stroke.id}
              d={seg.d}
              fill="none"
              stroke={stroke.color}
              strokeWidth={seg.width * scale}
              strokeLinecap="round"
              strokeLinejoin="round"
              /*
               * pointer-events 逐条设置：
               *   stroke 只让描边区域可点，比 auto 精确得多 ——
               *   否则笔迹的包围盒内部都会吃事件，点空白处也会误擦。
               */
              style={{ pointerEvents: interactive ? 'stroke' : 'none' }}
            />
          ))}
        </g>
      ))}
    </svg>
  )
}
