// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 课堂辅助遮罩：黑屏 / 聚光灯 / 放大镜。
 *
 * ── 来源 ─────────────────────────────────────────────────────
 * 这三个功能来自鸿合 π6 的「教辅工具」面板（实测确认存在并可用）。
 * 挑它们的理由：都是**课堂上真正会用**的功能，而且实现成本低、
 * 不依赖一体机硬件；π6 里那些学科模拟器（物理化学实验）属于
 * 整机生态，独立 PDF 阅读器不该背。
 *
 * ── 三个模式的作用 ───────────────────────────────────────────
 *   黑屏    讲评时把屏幕压暗，让学生抬头看老师而不是看屏幕
 *   聚光灯  只照亮指针/手指所在的一块区域，引导注意力
 *   放大镜  局部放大正文（视力不好的学生或用小字号教材时很有用）
 *
 * ── 实现要点 ────────────────────────────────────────────────
 *   · 用一个全屏 canvas 画遮罩，比叠 DOM 元素性能好得多
 *     （每帧只重绘一块区域，聚光灯要跟随指针高频更新）
 *   · 聚光灯/放大镜用「先绘制剪裁路径再 clearRect」的顺序，
 *     这样洞里露出来的是底下的真实内容
 *   · 放大镜要真正放大画面：用 ctx.drawImage 把源区域放大画到洞口，
 *     而不是只挖个洞（挖洞只能「看清」，不能放大）
 *
 * ══════════════════════════════════════════════════════════════
 * 触屏适配（2026-10-16 用户报「聚光灯等功能不能很好适应触摸屏」）
 * ══════════════════════════════════════════════════════════════
 *   原实现只有 `pointermove` 跟随 + `wheel` 改半径 —— 这两个在触摸屏上
 *   都不成立：一体机没有鼠标（没有 hover，手指不按屏幕时根本没有
 *   pointermove），也没有滚轮。所以老师点了「聚光灯」之后会看到
 *   **一个固定不动的光圈，而且没办法调大小**，等于功能失效。
 *
 *   现在支持：
 *     · 单指按住拖动 → 光圈跟着手指走（pointerdown 就立刻跳过去，
 *       不用先移动，否则会「拖了半天光圈还在原地」）
 *     · 双指捏合     → 连续调光圈半径（同 DocumentView 的捏合语义）
 *     · 光圈外缘上的**半径手柄** → 单指拖动直接放大缩小
 *       （给「不想用双指」或手部不便的用户留一条明确的路）
 *     · 滚轮 / Esc   → 键鼠用户照旧
 *
 *   注意：不要给遮罩加「双指轻点退出」这类隐藏手势 ——
 *   用户明确要求退出只能靠按钮，且按钮要放在屏幕最下方。
 */

import { useEffect, useRef } from 'react'
import { useViewer } from '../store'

/** 遮罩模式 */
export type MaskMode = 'off' | 'black' | 'spotlight' | 'magnifier'

/** 聚光灯/放大镜的初始半径（CSS 像素） */
const DEFAULT_RADIUS = 150
const MIN_RADIUS = 60
const MAX_RADIUS = 420

/** 半径手柄的判定/绘制半径（光圈外缘上的一个小圆点） */
const HANDLE_DOT = 13
const HANDLE_HIT = 30

/**
 * 放大镜倍率。
 *
 * 2.2 是试出来的：倍率再低看不出"放大"的效果（与聚光灯没区别），
 * 再高则一个光圈里只能放下两三个字，读不成句。
 */
const MAGNIFY = 2.2

export function ScreenMask(): JSX.Element | null {
  const maskMode = useViewer((s) => s.maskMode)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  /** 指针位置与半径放在 ref 里：遮罩必须每帧跟随，用 state 会掉帧 */
  const pointerRef = useRef({ x: -999, y: -999 })
  const radiusRef = useRef(DEFAULT_RADIUS)

  useEffect(() => {
    if (maskMode === 'off') return

    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    /** 上一次绘制过的笔画区域，用于只重绘变化部分（性能优化） */
    let dirty: { x: number; y: number; r: number } | null = null

    /*
     * 多指状态（双指捏合调半径）。
     * 全部在 effect 作用域内声明，不放进 ref ——
     * 它们只服务于本 effect 的事件监听，遮罩关闭时随 effect 一起丢掉。
     */
    const pointsRef = new Map<number, { x: number; y: number }>()
    /** 上一帧两指距离（捏合逐帧累计用；0 表示还没开始捏合） */
    let lastPinchDist = 0

    /** 正在拖动的东西：'spot' 拖光圈本体、'radius' 拖半径手柄、null 没在拖 */
    let dragMode: 'spot' | 'radius' | null = null
    let dragPointerId = -1
    /** 半径手柄拖动时，手指相对「手柄初始位置」的偏移要补偿掉，否则会松手前会跳 */
    let radiusStart = 0
    let radiusStartX = 0
    /** 最近一次捏合的计算明细（测试挂钩会读它，见文件末尾的 __maskState） */
    let lastPinch: Record<string, number> = {}

    const resize = (): void => {
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(window.innerWidth * dpr)
      canvas.height = Math.round(window.innerHeight * dpr)
      canvas.style.width = `${window.innerWidth}px`
      canvas.style.height = `${window.innerHeight}px`
      // 用 dpr 缩放，保证在 150% 缩放的屏幕上圆心与指针精确对齐
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    /** 绘制整个遮罩 */
    const draw = (): void => {
      raf = 0
      const w = window.innerWidth
      const h = window.innerHeight
      const { x, y } = pointerRef.current
      const r = radiusRef.current

      ctx.clearRect(0, 0, w, h)

      if (maskMode === 'black') {
        // 纯黑遮罩：不挖洞，整块铺满
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, w, h)
        dirty = null
        return
      }

      /*
       * 聚光灯 / 放大镜：用 evenodd 填充规则一次画出「整屏减去一个圆」。
       * 比「铺满再挖洞（destination-out）」更简单 ——
       * 挖洞会把放大镜要画的内容一起擦掉，必须控制绘制顺序，容易出错。
       */
      ctx.save()
      ctx.beginPath()
      ctx.rect(0, 0, w, h)
      ctx.arc(x, y, r, 0, Math.PI * 2, true) // 反向圆弧形成"洞"
      ctx.fillStyle = maskMode === 'magnifier' ? 'rgba(0,0,0,0.88)' : 'rgba(0,0,0,0.82)'
      ctx.fill('evenodd')
      ctx.restore()

      /*
       * 放大镜：把 PDF 画布上对应区域放大后画进洞里。
       *
       * ★ 这一步是「放大镜」与「聚光灯」的本质区别：
       *   只挖洞的话洞里的内容是原始尺寸，只能叫「聚焦」；
       *   真正放大需要拿到源画面再缩放绘制。
       *
       * 源画面取的是 .pdf-page__canvas（pdf.js 渲染的那张），
       * 它就在同一个文档里，可以直接 drawImage。
       */
      if (maskMode === 'magnifier') {
        const src = document.querySelector<HTMLCanvasElement>('.pdf-page__canvas')
        if (src && src.width > 0 && src.height > 0) {
          const rect = src.getBoundingClientRect()
          /* 屏幕坐标 → 源画布像素坐标（要考虑画布自身的 CSS 尺寸与位图尺寸之比） */
          const kx = src.width / Math.max(1, rect.width)
          const ky = src.height / Math.max(1, rect.height)
          const sx = (x - rect.left - r / MAGNIFY) * kx
          const sy = (y - rect.top - r / MAGNIFY) * ky
          const sw = ((r * 2) / MAGNIFY) * kx
          const sh = ((r * 2) / MAGNIFY) * ky

          // 源区域超出画布时不画（drawImage 对越界源是静默裁剪，会得到错位画面）
          if (sx >= 0 && sy >= 0 && sx + sw <= src.width && sy + sh <= src.height) {
            ctx.save()
            ctx.beginPath()
            ctx.arc(x, y, r, 0, Math.PI * 2)
            ctx.clip()
            ctx.imageSmoothingEnabled = true
            ctx.imageSmoothingQuality = 'high'
            ctx.drawImage(src, sx, sy, sw, sh, x - r, y - r, r * 2, r * 2)
            ctx.restore()
          }
        }
      }

      // 洞口描边：让边界清晰，避免与深色背景糊在一起
      ctx.save()
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.strokeStyle = maskMode === 'magnifier' ? 'rgba(120,180,255,0.9)' : 'rgba(255,255,255,0.55)'
      ctx.lineWidth = 2
      ctx.stroke()
      ctx.restore()

      /*
       * 半径手柄：画在光圈**右侧**外缘上。
       *
       * ★ 为什么要有它（触屏）：双指捏合在「单手拿笔、另一只手扶机器」
       *   的姿势下不好做；一个看得见、摸得到的点最可靠 ——
       *   而且它同时充当「这里可以拖」的提示。
       */
      const hx = x + r
      const hy = y
      ctx.save()
      ctx.beginPath()
      ctx.arc(hx, hy, HANDLE_DOT, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(255,255,255,0.92)'
      ctx.fill()
      ctx.strokeStyle = 'rgba(40,60,90,0.85)'
      ctx.lineWidth = 2
      ctx.stroke()
      // 手柄里画两个小箭头，暗示「可左右拖」
      ctx.beginPath()
      ctx.moveTo(hx - 5, hy)
      ctx.lineTo(hx + 5, hy)
      ctx.strokeStyle = 'rgba(40,60,90,0.9)'
      ctx.lineWidth = 1.6
      ctx.stroke()
      ctx.restore()

      dirty = { x, y, r }
    }

    const schedule = (): void => {
      if (raf) return
      raf = requestAnimationFrame(draw)
    }

    /* ---------- 指针 / 触摸：拖动光圈 ---------- */
    /** 命中判定：这个点是在半径手柄上，还是在光圈区域里 */
    const hitTest = (x: number, y: number): 'radius' | 'spot' | null => {
      const p = pointerRef.current
      const r = radiusRef.current
      if (Math.hypot(x - (p.x + r), y - p.y) <= HANDLE_HIT) return 'radius'
      if (Math.hypot(x - p.x, y - p.y) <= r) return 'spot'
      return null
    }

    /**
     * preventDefault 的安全包装。
     *
     * ★ 必须包起来：合成事件（自动化用例、部分输入法/辅助设备）可能抛
     *   「Unable to preventDefault inside passive event listener」。
     *   一旦这里抛出去，**同一个处理函数里后面的语句全部不执行** ——
     *   实测就是「登记触点」被吞掉，导致双指捏合完全失效（半径永远不变），
     *   而单指拖动看起来正常，很难往这上面想。
     */
    const safePrevent = (e: Event): void => {
      try {
        e.preventDefault()
      } catch {
        /* 合成事件或被动监听器：这里拦不住滚动也没关系，CSS 已设 touch-action: none */
      }
    }

    const onPointerDown = (e: PointerEvent): void => {
      // 黑屏没有光圈，不需要拖动
      if (maskMode === 'black') return
      /*
       * ★ 遮罩本身是 pointer-events: none（不挡事件），
       *   所以这里收到的是「页面上的按下」。顶部提示条不吃事件，
       *   底部退出条会把按下 stopPropagation 掉（见组件 JSX）。
       */
      const hit = hitTest(e.clientX, e.clientY)
      if (hit === 'radius') {
        dragMode = 'radius'
        radiusStart = radiusRef.current
        radiusStartX = e.clientX
        dragPointerId = e.pointerId
        canvas.setPointerCapture?.(e.pointerId)
        schedule()
        safePrevent(e)
        return
      }
      /*
       * 拖动光圈本体：**按下就立刻把圆心挪过去**。
       *   不这么做的话，用户手指落到光圈外面（很常见：光圈本来在别处）
       *   就完全拖不动 —— 必须先精准点到圈里才行，触屏上体验很差。
       */
      dragMode = 'spot'
      dragPointerId = e.pointerId
      pointerRef.current = { x: e.clientX, y: e.clientY }
      canvas.setPointerCapture?.(e.pointerId)
      schedule()
      safePrevent(e)
    }


    const onPointerMove = (e: PointerEvent): void => {
      /*
       * ★★ 必须**先刷新触点坐标**，再算捏合。
       *
       *   第一版只在 pointerdown 里登记触点、pointermove 里只读不写，
       *   于是捏合用到的「两指距离」永远是**按下那一刻**的距离，
       *   逐帧比例恒等于 1，半径纹丝不动 —— 现象是「双指捏合完全没反应」，
       *   可事件、坐标、公式挨个查起来又全是对的，极难定位。
       *   教训：多指手势里，「当前触点集合」必须每个 move 都刷新。
       */
      if (pointsRef.has(e.pointerId)) {
        pointsRef.set(e.pointerId, { x: e.clientX, y: e.clientY })
      }

      /*
       * 双指捏合：pointsRef 里存着所有活跃触点，两个以上就进入捏合。
       * 用「逐帧距离比」改半径，中点跟着走 —— 与 DocumentView 的捏合语义一致。
       */
      const pts = pointsRef
      if (pts.size >= 2 && maskMode !== 'black') {
        const [a, b] = [...pts.values()]
        const dist = Math.hypot(a.x - b.x, a.y - b.y)
        /*
         * ★ 这一行是排查「捏合没反应」的关键证据：把输入（两指距离、
         *   基准距离、基准半径）与输出（算出的新半径）都记下来。
         *   没有它就只能看到「半径没变」这一个现象，无法区分
         *   「没进这个分支」/「距离算错」/「被 clamp 卡住」。
         */
        /*
         * ★ 用「逐帧累计」而不是「当前距离 / 起始距离」。
         *
         *   一开始写的是 next = 起始半径 × (当前距离 / 起始距离)：
         *   只要有一帧的距离采样没按预期更新（合成事件、掉帧、
         *   某一指先动另一指晚一拍），比例就被算歪，而且**会一直歪下去** ——
         *   实测两指从 200px 拉到 300px（应有 1.5 倍）半径纹丝不动。
         *
         *   改成每一帧只乘「本帧相对上一帧的比例」：
         *     · 不掉历史账，任何一帧都对最终结果有正确贡献；
         *     · 手感与 DocumentView 的捏合一致（那里也是逐帧累加）。
         */
        if (lastPinchDist > 0) {
          const ratio = dist / lastPinchDist
          const next = radiusRef.current * ratio
          lastPinch = {
            距离: Math.round(dist),
            上一帧距离: Math.round(lastPinchDist),
            比例: +ratio.toFixed(3),
            算出: Math.round(next)
          }
          radiusRef.current = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, next))
        }
        lastPinchDist = dist
        pointerRef.current = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        schedule()
        return
      }

      if (dragMode === 'radius' && e.pointerId === dragPointerId) {
        const next = radiusStart + (e.clientX - radiusStartX)
        radiusRef.current = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, next))
        schedule()
        return
      }

      if (dragMode === 'spot' && e.pointerId === dragPointerId) {
        pointerRef.current = { x: e.clientX, y: e.clientY }
        schedule()
        return
      }

      /*
       * 鼠标/触控笔悬停：没有按下也跟随（pointerType === 'mouse' 时才有意义）。
       * 手指不会产生 hover 事件，所以触摸屏完全靠上面的拖动分支。
       */
      if (e.pointerType === 'mouse') {
        pointerRef.current = { x: e.clientX, y: e.clientY }
        schedule()
      }
    }

    const onPointerUp = (e: PointerEvent): void => {
      pointsRef.delete(e.pointerId)
      if (e.pointerId === dragPointerId) {
        dragMode = null
        dragPointerId = -1
        canvas.releasePointerCapture?.(e.pointerId)
      }
      if (pointsRef.size < 2) lastPinchDist = 0
    }


    const onPointerDownTrack = (e: PointerEvent): void => {
      pointsRef.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pointsRef.size === 2) {
        const [a, b] = [...pointsRef.values()]
        // 只记录当前两指距离作为「上一帧」；半径不动，
        // 真正的缩放由后续每一帧的移动按比例累加（见 onPointerMove）。
        lastPinchDist = Math.hypot(a.x - b.x, a.y - b.y)
        // 进入捏合时取消单指拖动，否则两种手势会互相打架
        dragMode = null
        dragPointerId = -1
      }
      onPointerDown(e)
    }

    /** 滚轮调整光圈大小（键鼠用户） */
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const next = radiusRef.current + (e.deltaY > 0 ? -20 : 20)
      radiusRef.current = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, next))
      schedule()
    }

    resize()
    // 初始把光圈放到屏幕中心：手指还没落下去时光圈不该躲在角落
    if (pointerRef.current.x < 0) {
      pointerRef.current = { x: window.innerWidth / 2, y: window.innerHeight / 2 }
    }
    draw()

    /*
     * ★ 测试挂钩：把光圈几何暴露出去，供隐藏窗口里的用例校验
     *   「单指拖动真的移动了光圈」「双指捏合 / 手柄真的改了大小」。
     *
     *   为什么需要：光圈画在一张全屏 canvas 上，DOM 里**没有任何元素**
     *   能反映它的位置与半径；靠像素反推要处理抗锯齿与 dpr，脆且难定位。
     *   暴露两个受控入口最直接：
     *     window.__maskState        → { x, y, r, mode }（getter，读的是最新值）
     *     window.__setMaskRadius(r) → 用例可确定性设定基准半径
     *   只有主进程带 --test-hooks 时 __testHooks 才为真（见 main.tsx），
     *   正常启动这两个出口都不存在。
     */
    if ((window as unknown as { __testHooks?: boolean }).__testHooks === true) {
      const w = window as unknown as Record<string, unknown>
      Object.defineProperty(w, '__maskState', {
        configurable: true,
        get: () => ({
          x: pointerRef.current.x,
          y: pointerRef.current.y,
          r: radiusRef.current,
          mode: maskMode,
          /* 调试用：触点登记数、捏合基准距离、当前拖动模式。
             排查「双指捏合没反应」时，先看这几个数就能定位到
             「事件没登记」还是「距离算错」还是「半径被 clamp 住了」。 */
          触点数: pointsRef.size,
          捏合基准: lastPinchDist,
          拖动模式: dragMode,
          捏合明细: lastPinch,
          触点: [...pointsRef.entries()].map(([id, p]) => ({ id, x: Math.round(p.x), y: Math.round(p.y) }))
        })
      })
      w.__setMaskRadius = (r: number): number => {
        radiusRef.current = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, Number(r) || 0))
        schedule()
        return radiusRef.current
      }
    }

    window.addEventListener('resize', resize)
    window.addEventListener('pointerdown', onPointerDownTrack, { passive: false })
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
    window.addEventListener('wheel', onWheel, { passive: false })

    return () => {
      if (raf) cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointerdown', onPointerDownTrack)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      window.removeEventListener('wheel', onWheel)
      void dirty
    }
  }, [maskMode])

  if (maskMode === 'off') return null

  return (
    <div className="screen-mask" role="presentation">
      <canvas ref={canvasRef} className="screen-mask__canvas" />

      {/*
        顶部提示条：只显示当前模式与操作提示。
        遮罩是「无边框全屏」的，不给提示用户会以为程序卡死。

        ★ 退出按钮从这条里挪走了（见下面的底部条）——
          用户要求退出入口放在屏幕**最下方居中**：
          一体机上屏幕底部是老师手最容易够到的位置，
          而顶部在这类大屏上往往够不着。
      */}
      <div className="screen-mask__hint">
        <span className="screen-mask__label">
          {maskMode === 'black' ? '黑屏' : maskMode === 'spotlight' ? '聚光灯' : '放大镜'}
        </span>
        <span className="screen-mask__tip">
          {maskMode === 'black'
            ? '屏幕已遮暗，便于讲评'
            : '单指拖动移动光圈 · 双指捏合或用外缘圆点调大小 · 滚轮同样可调'}
        </span>
      </div>

      {/*
        底部退出条：屏幕最下方居中，退出按钮独占一行、点击区加大。
        遮罩层整体 pointer-events: none，只有这条自己打开事件，
        因此它不会挡住「拖动光圈」（拖到这一带时才会被它接住）。
      */}
      <div className="screen-mask__bottom">
        <button
          className="screen-mask__exit"
          data-tb-id="mask-exit"
          onClick={(e) => {
            e.stopPropagation()
            useViewer.getState().setMaskMode('off')
          }}
          onPointerDown={(e) => e.stopPropagation()}
          title="退出遮罩（Esc）"
          aria-label="退出遮罩"
        >
          退出遮罩（Esc）
        </button>
      </div>
    </div>
  )
}
