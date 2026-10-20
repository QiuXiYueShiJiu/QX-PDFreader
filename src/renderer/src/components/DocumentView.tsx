// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * PDF 渲染核心。
 *
 * 设计要点（都是踩坑后的选择）：
 *
 *  1. **worker 必须走绝对路径**：pdf.js 靠 Worker 解析文档，主线程解析会卡死界面。
 *     构建脚本把 pdf.worker.min.mjs 复制到 public/，运行时用 `/pdf.worker.min.mjs`
 *     加载 —— 开发态与打包态路径一致，不受 Vite 资源指纹影响。
 *
 *  2. **文本层与 canvas 分离**：canvas 画内容，上层铺一层透明文本 span 负责选中与复制。
 *     pdf.js 的 TextLayer 需要 CSS 配合（见 viewer.css），漏了样式会导致文字错位。
 *
 *  3. **取消进行中的渲染**：翻页/缩放很快时，前一次的 render 任务必须 cancel，
 *     否则 pdf.js 会抛 "Cannot use the same canvas during multiple render() operations"。
 *
 *  4. **当前页用 IntersectionObserver 判定**：连续滚动模式下靠滚动位置算页码在
 *     快速滚动时会抖，用观察者取「可见面积最大」的页最稳。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
// 用 Vite 的 ?url 导入，让打包器把路径重写成产物里的真实位置。
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { CONTENT_ANNOTATION_TYPES, type Annotation } from '@shared/types'
import { useViewer } from '../store'
import { useTouchGestures } from '../hooks/useTouchGestures'
import {
  encodeStroke,
  PreviewInk,
  type PreviewInkHandle,
  type StrokePoint
} from '../ink-engine'
import { anchoredScroll, pageContentOffset } from '../hooks/zoom-anchor'
import {
  AnnotationLayer,
  DEFAULT_ANNOTATION_COLOR,
  SelectionToolbar,
  selectionText,
  selectionToRects,
  type FloatingAnchor
} from './AnnotationLayer'
import { useContentEdit } from './edit/useContentEdit'
import { disposeOcr, recognizePage, warmUpOcr, type OcrLine } from '../ocr/ocr'

/**
 * pdf.js worker 路径。
 *
 * ★ 必须用打包器解析出的 URL，**不能写死 '/pdf.worker.min.mjs'**。
 *   踩坑记录：写死绝对路径时，打包产物用 file:// 加载，
 *   `/pdf.worker.min.mjs` 会被解析成 `file:///D:/pdf.worker.min.mjs`
 *   —— 即「当前盘符的根目录」，而文件实际在 out/renderer/ 下。
 *   结果是 pdf.js 静默回退到 fake worker 并报
 *   "Setting up fake worker failed: Failed to fetch dynamically imported module"。
 *   ?url 让 Vite 在构建时算出正确相对路径，开发态与打包态都成立。
 */
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

/**
 * 把磁盘路径转成自定义协议 URL（不能用 file://，理由见主进程注释）。
 *
 * ★ 盘符里的冒号**必须保持原样**，不能编码成 %3A。
 *   踩坑记录：把 `C:` 编码成 `C%3A` 后，浏览器报
 *     Failed to parse URL from pdf-file:///C%3A/Users/...
 *   pdf.js 收到无法解析的 URL 会抛出
 *     "Invalid PDF url data: either string or URL-object is expected"
 *   ——这个错误信息完全没提编码问题，排查时极易误判成参数没传。
 *   因此这里逐段编码时显式放开冒号。
 */
function toPdfUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const encoded = normalized
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ':'))
    .join('/')
  return `pdf-file:///${encoded}`
}

/** 判断路径是否可用于加载（空串与纯空白都算无效） */
function isLoadablePath(filePath: string): boolean {
  return typeof filePath === 'string' && filePath.trim().length > 0
}

interface DocState {
  doc: PDFDocumentProxy | null
  error: string | null
  loading: boolean
}

/** 加载文档 */
export function useDocument(filePath: string): DocState {
  const [state, setState] = useState<DocState>({ doc: null, error: null, loading: false })
  const setLoading = useViewer((s) => s.setLoading)
  const setError = useViewer((s) => s.setError)

  useEffect(() => {
    /**
     * ★ 必须守卫空路径。
     *
     * 踩坑记录：pdf.js 的 getDocument 在 url 为空字符串时会**同步抛出**
     *   Error: Invalid PDF url data: either string or URL-object is expected...
     * 同步异常发生在 React 的 effect 里，会让整个组件树崩溃、页面全白
     * （现象是 #root 没有任何子元素），而主进程日志完全看不到痕迹。
     * 因此这里先判空直接返回，绝不把空值交给 getDocument。
     */
    if (!isLoadablePath(filePath)) {
      setState({ doc: null, error: null, loading: false })
      return
    }

    let cancelled = false
    let loaded: PDFDocumentProxy | null = null

    setState({ doc: null, error: null, loading: true })
    setLoading('正在解析文档…')

    let task: ReturnType<typeof pdfjsLib.getDocument> | null = null
    try {
      task = pdfjsLib.getDocument({
        url: toPdfUrl(filePath),
        // 允许按 Range 分块读取，大文件不必整份载入内存
        disableAutoFetch: false,
        // 关闭字体警告噪音
        verbosity: 0
      })
    } catch (error) {
      // 同步抛出（例如参数非法）也要兜住，不能让渲染崩掉
      const message = error instanceof Error ? error.message : String(error)
      setState({ doc: null, error: message, loading: false })
      setLoading(null)
      setError(`无法打开文档：${message}`)
      return
    }

    task.promise
      .then((doc) => {
        if (cancelled) {
          void doc.destroy()
          return
        }
        loaded = doc
        setState({ doc, error: null, loading: false })
        setLoading(null)
        // 回填页数，供状态栏与翻页使用
        useViewer.setState({ pageCount: doc.numPages })
        /*
         * ★ 测试挂钩：把 pdf.js 文档对象挂到 window，供 tools/ 下的用例
         *   校验夹具本身（页数 / 每页 viewport / 书签 / 内嵌图像 / 文字层）。
         *   这些东西 store 里没有（doc 只在组件内），不给出口就只能靠
         *   DOM 反推，既脆又测不准「文档层面」的事实。
         *   只有主进程带 --test-hooks 时 __testHooks 才为真（见 main.tsx），
         *   正常启动等于没有这个出口。
         */
        if ((window as unknown as { __testHooks?: boolean }).__testHooks) {
          ;(window as unknown as { __pdfDoc?: unknown }).__pdfDoc = doc
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return
        const message = error instanceof Error ? error.message : String(error)
        setState({ doc: null, error: message, loading: false })
        setLoading(null)
        setError(`无法打开文档：${message}`)
      })

    return () => {
      cancelled = true
      /*
       * 切换文件 / 卸载时要把测试出口一起清掉：留着会被用例读成
       * 「当前文档」，而它其实已经 destroy 了 —— 用例会拿到已销毁对象的
       * 报错，看起来像产品 bug。顺序上先清出口再销毁。
       */
      if ((window as unknown as { __testHooks?: boolean }).__testHooks) {
        ;(window as unknown as { __pdfDoc?: unknown }).__pdfDoc = null
      }
      // 切换文件时销毁旧文档，释放内存（大文件不销毁会持续占用）
      if (loaded) void loaded.destroy()
      void task?.destroy()
    }
  }, [filePath, setLoading, setError])

  return state
}

/* ============================================================
 * 单页渲染
 * ============================================================ */

interface PageProps {
  doc: PDFDocumentProxy
  pageNumber: number
  /** 目标宽度（CSS 像素）；0 表示按高度自适应 */
  width: number
  height: number
  /**
   * 用来决定「位图该按多大渲染」的尺寸，通常等于 width/height。
   *
   * ★ 为什么要和 width/height 分开（缩放流畅化的关键）：
   *   width/height 是**版面尺寸**，缩放时立刻变 —— 纯 CSS 改动，
   *   由合成器把旧位图拉伸显示，几乎不花钱，画面还一直有内容。
   *   renderWidth/renderHeight 是**落定后的尺寸**，滞后 400ms ——
   *   只有它变了才真的重新光栅化一次。
   *
   *   两者绑在一起时，拖动滑块一秒几十次缩放就变成几十次整页渲染，
   *   主线程必堵。拆开之后，手势期间零渲染，停手才画一次。
   */
  renderWidth: number
  renderHeight: number
  rotation: number
  /** 是否已经接近视口（懒渲染，只画可见页，翻页才画后面的） */
  active: boolean
  /** 本页的批注 */
  annotations: Annotation[]
  /** 页面缩放倍数（scale=1 坐标 → 屏幕坐标） */
  scale: number
  /** 橡皮模式：位图墨迹层要接收点击才能命中笔迹 */
  erasing: boolean
  /**
   * 本页的 OCR 文字行（v2.1.3）。
   *
   * 扫描件没有文字层，`caretRangeFromPoint` 拿不到字符，选中/改文字全失效。
   * 识别结果以**透明可选文字**叠在页面上，上层逻辑完全复用原生文字层那一套。
   */
  ocrLines?: OcrLine[]
  /**
   * 把页面 DOM 节点登记到父组件的 pageRefs。
   *
   * ★ 为什么需要它（这是一个真实的连锁 bug）：
   *   父组件用 `pageRefs: Map<number, HTMLElement>` 做两件事 ——
   *     ① IntersectionObserver 观察每一页，决定哪些页要渲染（visible 集合）
   *     ② 「跳页」时按页码取出元素、量出它的位置再 scrollTo
   *   但那个 Map 此前**只被读、从未被写**，于是：
   *     · 观察器遍历空集合 → 一页都没被观察 → 滚动过去的页永远不进
   *       visible → canvas 一直空着（画布 alpha:false，空就是黑）→ 快翻黑页
   *     · 跳页时 get(page) 恒为 undefined → 直接 return → 左侧导航点了不动
   *   所以这个 ref 回调不是可选的优化，而是那两个功能的前提。
   */
  registerRef: (pageNumber: number, el: HTMLDivElement | null) => void
  /**
   * 内容编辑层（涂白 / 文字 / 图片 / 矩形 / 椭圆）。
   *
   * ★ 为什么由父组件以「节点」形式传进来而不是在这里自己订阅 store：
   *   这一层要处理拖动、缩放、就地输入，交互状态必须集中在一处
   *   （每页各持一份会互相看不见对方的选中项与草稿）。
   *   父组件把整个状态机放在 useContentEdit 里，这里只负责摆位置。
   */
  editLayer?: React.ReactNode
}

/* ============================================================
 * 渲染并发闸门
 *
 * 为什么需要：
 *   冷启动瞬间（或快速连续翻页时）观察器可能在几何还没稳定时
 *   一次性把十几页都判为「接近视口」，于是十几个 pdf.js 渲染
 *   同时启动。每个渲染都要跑光栅化 + 占主线程，十几个一起上
 *   就是互相拖慢、大批任务被取消，最后留下几页没画上（黑屏）。
 *
 *   加一个闸门，最多同时渲染 MAX_CONCURRENT_RENDERS 页，
 *   其余的在队列里**等**而不是一起抢 —— 抢的结果是全都画不完。
 *
 * 为什么放在模块级而不是组件里：
 *   闸门是「整个应用同时能跑几个光栅化」的全局约束，
 *   每一页各自持有一份计数器就失去意义了。
 *
 * 排队而不是丢弃：被排队的页最终一定会轮到，
 * 因此不会出现「因为太忙所以这一页永远不画」的情况。
 * ============================================================ */

/** 同时进行的 pdf.js 渲染上限。3 页足以让滚动不掉帧，又不会压满主线程。 */
const MAX_CONCURRENT_RENDERS = 3

let activeRenders = 0
const renderQueue: Array<() => void> = []

/** 取一个渲染名额；满了就排队，返回的 Promise 在轮到时兑现 */
function acquireRenderSlot(): Promise<void> {
  if (activeRenders < MAX_CONCURRENT_RENDERS) {
    activeRenders++
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    renderQueue.push(() => {
      activeRenders++
      resolve()
    })
  })
}

/** 归还名额，并把位置让给队列里的下一个 */
function releaseRenderSlot(): void {
  activeRenders = Math.max(0, activeRenders - 1)
  const next = renderQueue.shift()
  if (next) next()
}

/**
 * 渲染结果为空白的重试上限。
 *
 * 定为 1：空白要么是偶发（重试一次就好），要么是这一页本身有问题
 * （重试一百次也一样）。留 1 次既覆盖了偶发，又不会在真出错时
 * 陷入「渲染→判定空白→再渲染」的无限循环。
 */
const MAX_RENDER_RETRIES = 1

/**
 * 缩放手势结束后，等多久才真正重渲染位图。
 *
 * 出处：PDF.js 官方 viewer 的同名参数 `defaultZoomDelay`，
 * 默认就是 400ms（`web/app_options.js:168`）。它的做法值得照搬 ——
 * 缩放期间**一次都不碰位图**，只让 CSS 把旧画面拉伸；
 * 用户停手 400ms 后才按最终比例重画一次。
 *
 * 为什么这样做才流畅：
 *   拖动滑块一秒能产生几十次 zoom 变化。若每次都重渲染，
 *   就是把「一次渲染」的成本乘上事件频率，主线程必然堵住。
 *   而 CSS 拉伸由合成器完成，几乎不要钱，画面还始终有内容。
 *
 * 为什么是 400 而不是更长：
 *   再长用户会明显觉得「停手了怎么还糊着」；
 *   再短则连点两下缩放按钮（间隔通常 200~300ms）会被打断重来，
 *   反而多渲染一次。
 */
const ZOOM_SETTLE_MS = 400

/**
 * Ctrl+滚轮的「手势窗口」长度。
 *
 * 出处：SumatraPDF 的 `src/Canvas.cpp:3296-3308`，源码注释自承这是启发值。
 * 含义是：这 150ms 内的滚动算**同一次手势**，把 delta 累加起来
 * 相对手势起点算一次缩放，而不是每个事件各乘一次。
 *
 * 为什么必须有：没有窗口时，缩放总量取决于事件频率而非手势幅度。
 * 触控板一次捏合派发几百个小 delta，鼠标一格只派发一个大 delta，
 * 同样「滚一下」的结果能差几倍 —— 手感不可预测，也正是
 * 用户反馈「缩放不流畅」最直接的来源。
 */
const WHEEL_GESTURE_MS = 150

/**
 * 「渲染完成后回头巡检」的重画上限（配合 400ms 起的指数退避）。
 *
 * 定为 4：首轮 400ms 覆盖绝大多数情况（正常页一两百毫秒就画完了），
 * 退避到第四轮时单次等待已 3200ms、累计约 6 秒。六秒还没把一页
 * 画出来，就不是「慢」而是「画不出来」，再重试只会白烧 CPU。
 * 注意这是**每一页各自**的计数，且一旦巡检发现画布正常就清零。
 */
const POST_CHECK_MAX_RETRIES = 4

/**
 * 把 computedStyle 里的颜色（`rgb()` / `rgba()` / 已是 `#rrggbb`）转成十六进制。
 *
 * 为什么要转：批注的 color 字段全项目都按 `#rrggbb` 存，
 * 颜色选择器的「当前色」也是拿字符串相等去比对的；
 * 把 `rgb(63, 63, 63)` 直接存进去，用户点开格式面板会看不到任何选中项，
 * 导出的 PDF 里也没法复用同一套取色逻辑。
 * 取不到（比如 `currentColor`）就返回 undefined，让渲染端走默认色。
 */
function cssColorToHex(value: string): string | undefined {
  const text = value.trim()
  if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase()
  if (/^#[0-9a-f]{3}$/i.test(text)) {
    return `#${text
      .slice(1)
      .split('')
      .map((c) => c + c)
      .join('')
      .toLowerCase()}`
  }
  const m = /^rgba?\(([^)]+)\)$/i.exec(text)
  if (!m) return undefined
  const parts = m[1]
    .split(/[,\s/]+/)
    .map((p) => Number.parseFloat(p))
    .filter((n) => Number.isFinite(n))
  if (parts.length < 3) return undefined
  const hex = parts
    .slice(0, 3)
    .map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0'))
    .join('')
  return `#${hex}`
}

/**
 * 从选区起点读出原文的字体长相（v2.1.3）。
 *
 * 为什么不能只靠「首行矩形高度 × 0.92」推字号：
 *   那一招只解决大小，颜色/字重/斜体/字体族全靠猜。
 *   实测把 `QiuXi`（24px、#3f3f3f、常规）改成新文字时，
 *   字号算对了，颜色却用上了当前绘图色（红色），
 *   用户看到的是「替换出来的字变成红的」。
 *
 * computedStyle 给的是**渲染后**的字号（已经乘过缩放），
 * 所以这里除掉 scale 才是页面坐标系里的字号。
 */
function textStyleFromNode(node: Node, scale: number): FloatingAnchor['style'] {
  const el =
    node.nodeType === Node.TEXT_NODE
      ? node.parentElement
      : node instanceof Element
        ? node
        : null
  const host =
    el?.closest<HTMLElement>('.textLayer span, .ocr-text-layer span') ??
    el?.closest<HTMLElement>('.textLayer, .ocr-text-layer')
  if (!host) return undefined
  const cs = getComputedStyle(host)
  const safeScale = scale > 0 ? scale : 1
  const rawSize = Number.parseFloat(cs.fontSize)
  const style: NonNullable<FloatingAnchor['style']> = {
    color: cssColorToHex(cs.color),
    fontWeight: Number.parseInt(cs.fontWeight, 10) || 400,
    fontStyle: cs.fontStyle === 'italic' ? 'italic' : 'normal'
  }
  if (Number.isFinite(rawSize) && rawSize > 0) {
    style.fontSize = Math.max(6, Math.round((rawSize / safeScale) * 10) / 10)
  }
  if (cs.fontFamily) style.fontFamily = cs.fontFamily
  return style
}
/**
 * 判断画布上到底有没有画出东西。
 *
 * 做法：把画布缩到很小（约 24×24）画到一张离屏画布上再读像素。
 * 为什么要缩小：直接 getImageData 读原图，在 2000×2800 的画布上
 * 会产生几十 MB 的中间数据，每页都做一遍会明显卡顿；
 * 缩到 24×24 后每个采样点覆盖一大片区域，
 * 「整页都是空白」和「哪怕只有一条细线」都能可靠区分。
 *
 * 注意画布是 alpha:false 的，因此背景恒为不透明 ——
 * 空白画布的像素只会是白色（我们自己铺的白底）或黑色
 * （铺白底之前的旧路径），两种都算「没内容」。
 */
function hasVisibleContent(canvas: HTMLCanvasElement): boolean {
  try {
    const N = 24
    const probe = document.createElement('canvas')
    probe.width = N
    probe.height = N
    const pctx = probe.getContext('2d', { willReadFrequently: true })
    if (!pctx) return true /* 判断不了就当它没问题，不要误触发重试 */
    pctx.drawImage(canvas, 0, 0, N, N)
    const data = pctx.getImageData(0, 0, N, N).data
    let bright = 0
    let dark = 0
    const total = data.length / 4
    for (let i = 0; i < data.length; i += 4) {
      const v = (data[i] + data[i + 1] + data[i + 2]) / 3
      if (v > 240) bright++
      else if (v < 60) dark++
    }
    /*
     * ★ 判据必须是「既不是一片白、也不是一片黑」。
     *
     *   踩坑记录（切缩放后整页死黑，且永不自愈 —— 找了很久的真凶）：
     *   原判据是「任一通道 < 240 就算有内容」。这等于说**纯黑 = 有内容**，
     *   因为 0 < 240 恒成立。而画布是 alpha:false 的，被清空之后
     *   显示出来就是纯黑 —— 于是每一张「被清空过」的画布都被判成
     *   「已经画好了」，guard 直接跳过渲染，页面永远停在黑色，
     *   而且因为 rendered 一直是 true，没有任何机制能让它自愈。
     *
     *   实测对照（tools/verify-sample-fn.mjs）：
     *     纯黑 800×1100 画布 → 旧判据返回 true（错误）
     *     纯白画布           → false
     *     白底 + 黑线        → false（这条也对，说明不能只反转阈值）
     *   所以既不能只看「有没有暗像素」，也不能只看「有没有亮像素」，
     *   必须两头都排除：全白 = 空白页，全黑 = 被清空的画布，两者都算「没内容」。
     *
     *   为什么不用「中间灰阶占比」做判据：真实页面大量是白底黑字，
     *   中间灰阶本来就少，容易被误判成「没内容」而陷入无限重绘。
     */
    const brightRatio = bright / total
    const darkRatio = dark / total
    if (darkRatio > 0.95) return false /* 一片黑：一定是被清空的画布 */
    if (brightRatio > 0.995) return false /* 一片白：空白页或还没画 */
    return true
  } catch {
    /* 读像素失败（比如画布被跨域污染）时不作判断，交给正常流程 */
    return true
  }
}


/**
 * 渲染一页。
 *
 * 用 devicePixelRatio 放大 canvas 后备缓冲，否则在高分屏（本机 150% 缩放）
 * 上文字会发虚 —— canvas 的 CSS 尺寸与像素尺寸必须分开设置。
 */
function PdfPage({
  doc,
  pageNumber,
  width,
  height,
  renderWidth,
  renderHeight,
  rotation,
  active,
  annotations,
  scale,
  erasing,
  ocrLines,
  editLayer,
  registerRef
}: PageProps): JSX.Element {
  const textRef = useRef<HTMLDivElement>(null)
  const [rendered, setRendered] = useState(false)

  /*
   * 渲染重试计数。
   *
   * 被取消的渲染（翻页太快、离屏）会把画布留在「已清空」状态，
   * 而 alpha:false 的画布清空后显示为纯黑。这里每取消一次就 +1，
   * 让渲染 effect 重跑一次把画面补上 —— 见 effect 里
   * RenderingCancelledException 分支的说明。
   */
  const [renderTick, setRenderTick] = useState(0)

  /*
   * 「画完了但是空白」的重试次数。
   *
   * 与上面的 renderTick 是两回事：
   *   · renderTick 处理的是**渲染被取消**（异常路径，pdf.js 会抛
   *     RenderingCancelledException），重试次数不限 —— 那种情况
   *     重试一定会成功，放任它多试几次没有风险。
   *   · renderRetryRef 处理的是**渲染成功但结果空白**（没有任何异常，
   *     只是像素不对）。这种必须限次，否则真遇到一页渲染不出来时
   *     会无限重试把主线程占满。
   */
  const renderRetryRef = useRef(0)

  /**
   * 「回头巡检」已经喊过几次重画。
   *
   * 为什么必须封顶：巡检是**延时回看**，如果画布恰好卡在「已改尺寸、
   * pdf.js 还没画完」的窗口里，回看就会看到一片黑而喊重画；
   * 重画又要改尺寸、又被回看到黑 —— 两者互相喂养就是无限重画，
   * 表现成页面一直闪、主线程被占满。封顶之后最坏情况退化成
   * 「这一页停在当前状态」，不再自我放大。
   *
   * 退避的原因是给慢帧留出余量：首轮 400ms（正常页面足够画完），
   * 之后每轮翻倍（800 / 1600 / 3200），四轮共约 6 秒还没画好，
   * 说明不是「慢」而是「画不出来」，继续重试没有意义。
   */
  const postCheckRetryRef = useRef(0)

  /**
   * 「渲染完成后回头巡检」的定时器。
   *
   * 为什么需要单独存着：巡检要看的是**延迟之后**的画布状态，
   * 而这期间用户可能又缩放了一次、或翻走了这一页。
   * 不取消旧定时器的话，过期的巡检会把已经画好的页面判成「变空了」，
   * 触发一轮无意义的重画（表现为闪一下）。
   */
  const pendingVerifyRef = useRef<number | null>(null)

  /*
   * 诊断挂钩：仅供自动化测试使用。
   *
   * 为什么要把采样函数暴露出去：这一轮排查里，测试脚本只能「事后」看快照，
   * 而画布是在渲染 effect 跑完之后才被清空的 —— 事后采样永远看不到
   * 「它曾经有内容」这个事实，于是所有证据都指向错误的方向。
   * 挂出来之后，测试可以高频轮询，捕捉「从有内容变成全黑」的**那一瞬间**。
   * 生产环境没人调用，代价可忽略。
   */
  useEffect(() => {
    ;(window as unknown as { __sbSampleCanvas?: unknown }).__sbSampleCanvas = (
      n: number
    ): string => {
      const el = document.querySelector<HTMLElement>(`.pdf-page[data-page="${n}"]`)
      const cv = el?.querySelector<HTMLCanvasElement>('canvas.pdf-page__canvas')
      if (!cv) return 'no-canvas'
      /* 逐点统计整张画布，不用降采样 —— 降采样会把细线条平均没了 */
      const ctx = cv.getContext('2d', { willReadFrequently: true })
      if (!ctx) return 'no-ctx'
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data
      let bright = 0
      let dark = 0
      let other = 0
      let clear = 0
      for (let i = 0; i < d.length; i += 4 * 7) {
        const a = d[i + 3]
        const v = (d[i] + d[i + 1] + d[i + 2]) / 3
        /*
         * ★ 透明像素单独归类，不能算进「暗」。
         *
         *   新建的 <canvas> 像素全是 0，而 0 有两种含义：
         *     · alpha = 0  → 透明，用户看到的是底下垫的白纸（正常，正在加载）
         *     · alpha = 255 → 不透明黑，用户看到黑板（真故障）
         *   RGB 完全一样，只有 alpha 能区分。
         *   早先把两者混为一谈，于是「页面还没画好」被一路误报成全黑，
         *   修了好几轮 CSS 症状都不变 —— 因为量错了对象。
         */
        if (a < 8) clear++
        else if (v > 200) bright++
        else if (v < 60) dark++
        else other++
      }
      const total = bright + dark + other + clear || 1
      return `${cv.width}x${cv.height} 亮${Math.round((bright / total) * 100)}% 暗${Math.round(
        (dark / total) * 100
      )}% 中${Math.round((other / total) * 100)}% 透${Math.round((clear / total) * 100)}%`
    }
  }, [])

  /**
   * 画布容器。缩放期间作为「上一帧背景图」的载体，
   * 避免画布清空时露出页面底色（即白屏）。
   */
  const wrapRef = useRef<HTMLDivElement>(null)

  /**
   * 当前的底图画布。
   *
   * ★ 必须用查询而不是 ref 保存引用。
   *
   *   渲染完成后我们会用 `oldCanvas.replaceWith(newCanvas)` 换上新画布
   *   （原子替换，见渲染 effect），React 并不知道这件事。此后任何一次
   *   重渲染，React 都可能以「旧那个 canvas」为参数回调 ref，
   *   把已经换上去的新画布从记录里抹掉 —— 于是 guard 读到 null，
   *   误判成「没画过」而反复重渲染。
   *
   *   每次都从容器里查一次，拿到的永远是屏幕上真正显示的那一张。
   */
  const getCanvas = (): HTMLCanvasElement | null =>
    wrapRef.current?.querySelector<HTMLCanvasElement>('canvas.pdf-page__canvas') ?? null

  /**
   * 消除缩放白屏（最终方案，第三版）。
   *
   * ── 完整思路 ────────────────────────────────────────────────
   * 缩放时必须重设 canvas 尺寸（否则清晰度不够），而重设会清空画布。
   * 空白期无法避免，但**可以让它不被看见**：
   *
   *   ① 尺寸变化前：把当前画面存成 dataURL 贴到**容器背景**上
   *      （useLayoutEffect 同步做，此时画面还在）
   *   ② 把这期间画布的 opacity 设为 0 —— 画布空着也看不见，
   *      透出来的是容器背景上的旧画面（会被拉伸，形成连续过渡）
   *   ③ pdf.js 渲染完成后把 opacity 恢复为 1，新内容一次性出现
   *
   *   `data-rendering` 属性驱动 ② ③，由 CSS 控制透明度。
   *
   * ── 为什么前两版失败 ────────────────────────────────────────
   *   ① 在异步渲染里抓快照 —— 那时画布已清空，抓到空白
   *   ② 在 useLayoutEffect 里「抓 → 改尺寸 → 填回」——
   *      填回这一步与浏览器的合成时机不同步，仍会漏出空白帧
   *      （实测 8 次切换里 7 次采到全白）
   *   本版不再依赖「填回」的时序，而是**让空白层不可见**。
   */
  useLayoutEffect(() => {
    const canvas = getCanvas()
    const wrap = wrapRef.current
    if (!canvas || !wrap || canvas.width < 2 || canvas.height < 2) return

    /*
     * ★ 只有**已经画好内容**的画布才值得抓快照。
     *
     *   踩坑记录（「页 2/3 永久黑屏」的真凶）：
     *   这个 effect 原本无条件抓快照并置 data-rendering='1'。
     *   首次拿到真实尺寸时，画布还停留在 pdf.js 默认的 300×150、
     *   像素是**空的** —— 于是快照抓到一张全黑图，贴到容器背景上，
     *   而画布又被 data-rendering='1' 隐藏（opacity: 0）。
     *   若这一页的渲染随后被取消（快速翻页时必然发生），
     *   rendered 永远不会变成 true，那个「结束隐藏」的 effect
     *   也就永远不会跑 —— 页面就永久停在全黑状态：
     *   画布尺寸是对的（1563×2210）、像素也是全黑的。
     *
     *   加上 rendered 判断后：首次渲染前不抓快照、不隐藏画布，
     *   渲染完成后画布正常显示；之后每次缩放才用上一帧做过渡。
     */
    /*
     * ★ 抓快照前还要确认画布**就是当前该有的尺寸**。
     *
     *   只判断 rendered 仍不够。踩坑记录：
     *     ① fit-width 画好第 1 页，rendered = true；
     *     ② 用户切到 90%，页面宽度变 536；
     *     ③ 「撑到显示尺寸」那支 effect 把画布改成 803×1136 ——
     *        改尺寸立即把画布清空成纯黑（alpha:false 的画布清空即黑）；
     *     ④ 本 effect 因为 width 变化而重跑，rendered 仍是 true，
     *        于是**对着这块刚被清空的画布抓快照** —— 得到一张全黑图，
     *        贴到容器背景上。
     *
     *   结果：即使后来画布被重新画好，容器背景上那张黑图也还在，
     *   一旦画布再次进入渲染态被隐藏，露出来的就是那块黑。
     *   尺寸不符时直接跳过更新，容器背景会保留**上一次真正画好**的画面，
     *   过渡效果反而更正确。
     */
    const dpr = window.devicePixelRatio || 1
    const canvasIsCurrent =
      canvas.width === Math.max(1, Math.floor(width * dpr)) &&
      canvas.height === Math.max(1, Math.floor(height * dpr))

    /*
     * ★ 光比尺寸还不够，必须确认画布上**真的有像素**。
     *
     *   踩坑记录（切缩放后整页死黑）：
     *   尺寸比对挡不住这条路径 —— 画布确实是 803×1136（尺寸对），
     *   rendered 也是 true，可像素全是 0（纯黑）。实测抓到过这种状态：
     *   容器背景贴着一张全黑的 JPEG 快照，画布又被本 effect 加上
     *   data-rendering='1' 隐藏（opacity: 0）→ 用户看到的就是那块黑。
     *
     *   所以这里改成直接采样画布像素：没有内容就**不要**把它当快照，
     *   并且把可能已经贴上去的黑图撤掉（置 none）。
     *   宁可少一次过渡动画，也不能留一张黑底图盖住页面。
     */
    const usable = rendered && canvasIsCurrent && hasVisibleContent(canvas)

    if (usable) {
      try {
        // JPEG + 0.6 质量：快照只用于过渡，体积小、转换快
        wrap.style.backgroundImage = `url(${canvas.toDataURL('image/jpeg', 0.6)})`
        // 标记进入渲染态：CSS 会把画布隐藏，露出背景上的旧画面
        wrap.dataset.rendering = '1'
      } catch {
        /* 画布被污染等情况下忽略，最多闪一下 */
      }
    } else {
      /*
       * 还没画过内容、或画布已被清空：不要隐藏画布，也不要把空快照当背景。
       * 同时把可能残留的 rendering 标记与旧快照清掉 —— 否则一次被取消的
       * 渲染、或一次「先画好又被清空」的缩放，会把画布永久藏起来
       * 或让用户一直看着一张黑底图。
       */
      delete wrap.dataset.rendering
      if (wrap.style.backgroundImage) wrap.style.backgroundImage = 'none'
    }
  }, [width, height, rendered])

  /* 渲染完成后结束「隐藏画布」的状态 */
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    if (!rendered) return
    delete wrap.dataset.rendering
  }, [rendered, width, height])

  /*
   * ★ 布局尺寸与位图尺寸从此彻底分离。
   *
   *   踩坑记录（这条 effect 曾经是「切缩放后整页死黑」的元凶）：
   *   它原先在这里写 `canvas.width = width * dpr` 与
   *   `canvas.style.width = width + 'px'`。前者是**位图分辨率**，
   *   后者是**显示尺寸** —— 把两者绑在同一个 width 上带来两个后果：
   *
   *   ① 缩放必须整页重渲染。改位图尺寸 = 清空画布，
   *      所以每一档缩放都得重新光栅化一遍，拖动滑块必卡。
   *   ② 改尺寸的瞬间画布变纯黑（alpha:false），而渲染是被防抖挡住的，
   *      中间这几百毫秒用户看到的就是一块黑 —— 正是那个「死黑」。
   *
   *   PDF.js 官方 viewer 的解法是把两者拆开
   *   （web/pdf_viewer.css:80-99 里 canvas 恒为容器 100%，
   *    页面尺寸另由 --scale-factor 驱动）。这里照做：
   *      · 显示尺寸交给 CSS（.pdf-page__canvas { width/height: 100% }）；
   *      · 位图分辨率只在真正重画时设定，见下面的渲染 effect。
   *
   *   于是缩放变成纯合成器操作：旧画面被拉伸显示，画布本身一动没动，
   *   既不可能黑屏，也不需要为每一档缩放付渲染成本。
   */
  useLayoutEffect(() => {
    const canvas = getCanvas()
    if (!canvas || width <= 0 || height <= 0) return
    const t = (window as unknown as { __sbInkTrace?: string[] }).__sbInkTrace
    t?.push(
      `p${pageNumber} layoutEffect w=${Math.round(width)} h=${Math.round(height)} ` +
        `bitmap=${canvas.width}x${canvas.height}（只改布局，不动位图） @${Math.round(performance.now())}`
    )
    if (t && t.length > 60) t.splice(0, t.length - 60)
    /* 诊断：记录这支 effect 每次运行时的输入与结果 */
    if (wrapRef.current) {
      wrapRef.current.dataset.dbgSize = JSON.stringify({
        wIn: Math.round(width),
        hIn: Math.round(height),
        bitmap: `${canvas.width}x${canvas.height}`
      })
    }
  }, [width, height, pageNumber])

  useEffect(() => {
    /*
     * 诊断：把每次 effect 运行**按时间顺序**记进一个全局数组。
     *
     * 为什么需要：这一轮排查反复栽在「只看最后一次状态」上 ——
     *   profile 显示「尺寸相符已画好，跳过」，可画布是黑的。
     *   静态快照无法回答「谁在什么时候把画布清掉的」，
     *   只有事件序列能。上限 60 条，避免长跑把内存吃掉。
     *   生产环境这个数组没人读，代价可忽略。
     */
    const trace = (window as unknown as { __sbInkTrace?: string[] }).__sbInkTrace
    const log = (m: string): void => {
      trace?.push(`p${pageNumber} ${m} @${Math.round(performance.now())}`)
      if (trace && trace.length > 60) trace.splice(0, trace.length - 60)
    }
    log(
      `renderEffect w=${Math.round(width)} h=${Math.round(height)} active=${active} ` +
        `rendered=${rendered} tick=${renderTick} cw=${getCanvas()?.width ?? -1}`
    )

    /*
     * 诊断：记录本次 effect 运行的全部输入与「为什么退出」。
     *
     * 为什么需要：黑页只有三种可能的成因，而它们的外部表现完全一样 ——
     *   · 这一页不 active，effect 直接返回，从未尝试渲染
     *   · active 但被 guard 判定「已按当前尺寸画好」而跳过
     *   · 真正跑了渲染但结果不对
     * 只有把「哪一行 return 的」记下来，才能区分。
     */
    const dbgWhy = (why: string): void => {
      log(`exit=${why} cw=${getCanvas()?.width ?? -1}`)
      if (wrapRef.current) {
        const cvNow = getCanvas()
        wrapRef.current.dataset.dbgWhy = JSON.stringify({
          why,
          w: Math.round(width),
          h: Math.round(height),
          active,
          rendered,
          tick: renderTick,
          cw: cvNow?.width ?? -1,
          ch: cvNow?.height ?? -1,
          /*
           * 诊断：ref 指向的画布是否还挂在文档里、文档里共有几张画布。
           * 为什么需要：如果 guard 读到的是一张**已被替换/卸载**的旧画布
           * （它当然尺寸正确、像素也有内容），就会出现
           * 「guard 说已画好、屏幕上那张却是黑的」这种自相矛盾。
           */
          ref已挂载: cvNow ? cvNow.isConnected : null,
          同页画布数: wrapRef.current.querySelectorAll('canvas.pdf-page__canvas').length
        })
      }
    }

    if (!active) {
      dbgWhy('非active直接返回')
      return
    }
    /*
     * 已经按当前尺寸画好了就不用重画。
     *
     * rendered 与 renderTick 都进了依赖数组：
     *   · rendered —— 渲染成功后从 false 变 true，会再触发一次本 effect，
     *     这里直接挡掉，避免同一页被重复渲染一遍（白费一次光栅化）。
     *   · renderTick —— 渲染被取消时 +1，强制重跑补画面，
     *     这条路径下 rendered 仍是 false，所以不会被这个 guard 拦住。
     *
     * ★ 光看 rendered 是不够的，必须连**画布尺寸**一起判断。
     *
     *   踩坑记录（「切到某个缩放比例后整页死黑」的元凶）：
     *     ① fit-width 下第 1 页按 1052 宽画好，画布 1578×2231，
     *        rendered 变成 true；
     *     ② 用户切到 90%，页面宽度变成 536，width 这个 prop 跟着变；
     *     ③ 上面那支「撑到显示尺寸」的 useLayoutEffect 依赖 [width, height]，
     *        于是把画布改成 803×1136 —— **改尺寸就会把画布清空成纯黑**
     *        （alpha:false 的画布清空后就是黑，不是透明）；
     *     ④ 本 effect 因为 width 变化而重跑，却在这里被 `rendered`
     *        直接挡回去了 —— 于是画布永远停在「已清空、没重画」的黑状态，
     *        而且 rendered 一直是 true，再也不会自愈。
     *
     *   把判断改成「已画过 **且** 画布就是当前该有的尺寸」之后，
     *   第 ③ 步造成的黑画布会在第 ④ 步被重新画上。
     *   代价固定为两次 floor，可以忽略。
     */
    if (rendered) {
      const cv = getCanvas()
      const dpr = window.devicePixelRatio || 1
      /*
       * ★ 期望尺寸按**落定尺寸**算，不是版面尺寸。
       *   版面尺寸在缩放过程中每帧都变，拿它当期望值会让 guard
       *   每次都判「尺寸不符」→ 每次缩放事件都重渲染一次，
       *   防抖就白做了。落定尺寸在手势期间不动，guard 自然跳过。
       */
      const expectW = Math.max(1, Math.floor(renderWidth * dpr))
      const expectH = Math.max(1, Math.floor(renderHeight * dpr))
      /*
       * ★ 最终判据是**画布上有没有内容**，而不是「尺寸对不对」。
       *
       *   踩坑记录（切缩放后整页死黑，且永不自愈）：
       *   原先只比尺寸。但画布被清空的路径不止一条 ——
       *   「撑到显示尺寸」的 useLayoutEffect、pdf.js 内部重设尺寸、
       *   被取消的渲染任务，都会把画布清成纯黑，而 rendered 仍是 true。
       *   实测抓到过这种状态：尺寸完全正确（803×1136）、
       *   rendered=true、guard 判定「已画好」直接跳过，
       *   可画布上一个亮点都没有。
       *
       *   改成采样像素之后，只要画布是空的就一定会重画，
       *   不再依赖「谁清空的、什么时候清空的」这类时序假设。
       */
      const looksPainted =
        cv && cv.width === expectW && cv.height === expectH && hasVisibleContent(cv)
      if (looksPainted) {
        dbgWhy('尺寸相符且像素有内容，跳过')
        return
      }
      log(
        `guard不通过 cv=${cv ? cv.width + 'x' + cv.height : 'null'} ` +
          `expect=${expectW}x${expectH} 采样=${cv ? String(hasVisibleContent(cv)) : 'n/a'}`
      )
    }
    dbgWhy('进入渲染')
    let cancelled = false
    let renderTask: { cancel: () => void } | null = null
    /* 槽位是否已经拿到手 —— 只有拿到了才需要归还，否则会把计数减错 */
    let gotSlot = false

    /*
     * 诊断：把这一页渲染走到了哪一步写到 DOM 上。
     *
     * 为什么不能只靠 console：黑页有三种完全不同的成因
     * （从没开始渲染 / 渲染被取消 / 渲染完成了但没显示），
     * 而日志是时序性的、自动化测试里很难对齐。
     * 把阶段名直接挂在元素上，测试脚本一次读取就能分清。
     * 生产环境这个属性没人读，代价可忽略。
     */
    const stage = (s: string): void => {
      if (wrapRef.current) wrapRef.current.dataset.stage = s
    }
    /*
     * 诊断：把本次 effect 实际看到的输入量也挂上去。
     *
     * 为什么需要：只看「阶段 = painted」无法区分两种完全不同的事故 ——
     *   · 渲染根本没跑（被 guard 挡住）
     *   · 渲染跑了、也画完了，但画布尺寸与 props 对不上
     * 两者都会表现成黑色页面，而修法完全相反。
     * 把 width/height/rendered 和画布当时的尺寸记下来，
     * 一次读取就能分清是哪一种。
     */
    if (wrapRef.current) {
      wrapRef.current.dataset.dbg = JSON.stringify({
        w: Math.round(width),
        h: Math.round(height),
        rw: Math.round(renderWidth),
        rh: Math.round(renderHeight),
        r: rendered,
        tick: renderTick,
        cw: getCanvas()?.width ?? -1,
        ch: getCanvas()?.height ?? -1,
        dpr: window.devicePixelRatio || 1
      })
    }
    stage('starting')

    const run = async (): Promise<void> => {
      try {
        /*
         * ★ 先排队领一个渲染名额，再开始干活。
         *
         *   冷启动时观察器可能一次把十几页都判为「接近视口」，
         *   十几个光栅化同时启动会互相拖慢，最后大批任务被取消、
         *   留下几页空着（黑屏）。闸门把并发压到 3，
         *   多出来的在这里**等**——等到名额就一定画得完。
         *
         *   注意 await 之后要重新确认 cancelled：排队期间这一页
         *   可能已经滚出视口了，那就别再浪费一次光栅化。
         */
        stage('queued')
        await acquireRenderSlot()
        gotSlot = true
        if (cancelled) return
        stage('slot-acquired')

        /*
         * 用局部常量而不是外层可变量：外层变量是 `PDFPageProxy | null`
         * 且会被闭包修改，TS 无法在 await 之后继续窄化它，
         * 每次访问都得写非空断言。局部常量一次拿到位就没有这个问题。
         */
        const page = await doc.getPage(pageNumber)

        /**
         * 计算视口。
         *
         * pdf.js 的 scale 是相对 PDF 自身单位（1 单位 = 1/72 英寸）。
         * 先取 scale=1 的视口得到基准尺寸，再按目标像素宽/高反推 scale。
         */
        const base = page.getViewport({ scale: 1, rotation })
        /* 用**落定尺寸**反推渲染 scale —— 手势期间这个值不动，所以不重渲染 */
        const scale =
          renderHeight > 0 ? renderHeight / base.height : renderWidth / base.width
        const viewport = page.getViewport({ scale, rotation })
        stage(`viewport ${Math.round(viewport.width)}x${Math.round(viewport.height)}`)

        const oldCanvas = getCanvas()
        if (!oldCanvas || cancelled) {
          stage(cancelled ? 'aborted-before-canvas' : 'no-canvas-ref')
          return
        }

        const dpr = window.devicePixelRatio || 1
        const newW = Math.max(1, Math.floor(viewport.width * dpr))
        const newH = Math.max(1, Math.floor(viewport.height * dpr))

        /*
         * ★ 画到**离屏画布**里，成功之后再原子换上去。
         *
         *   踩坑记录（缩放切换时整页死黑）：
         *   原先是直接在当前画布上改尺寸再画 —— 而「改尺寸」这一步
         *   会**立刻把画布清空**（alpha:false，清空就是纯黑）。
         *   于是从这一刻到 pdf.js 真正画完之间，屏幕上是一整块黑，
         *   几十到几百毫秒不等，缩放时尤其明显。
         *
         *   PDF.js 官方 viewer 的做法正是先画后换
         *   （web/pdf_page_view.js:972-1013，源码注释写着
         *    "Don't add the canvas until the first draw callback …
         *     to prevent black flickering"）：
         *   新 canvas 在后场画好才 replaceWith 进场，
         *   旧位图全程留在屏幕上。这样从原理上就不存在黑屏窗口，
         *   而不是靠「铺白底」「贴上一帧快照」去遮。
         */
        const canvas = document.createElement('canvas')
        canvas.className = oldCanvas.className
        /*
         * ★ 先把透明度写死在行内，画好了再放开（见下面 is-painted）。
         *
         *   新画布一旦挂进 DOM 就立刻参与合成，而此时它是一张
         *   全零的位图；`getContext('2d', { alpha: false })` 又让它
         *   以「不透明黑」解释这些零 —— 于是从挂上到画完之间，
         *   屏幕上是一块黑板。
         *
         *   行内样式而不是只靠 CSS 类：把先后顺序写死在代码里，
         *   不依赖样式表的加载时机与优先级，读代码的人也能一眼看到
         *   「默认透明、画好才显形」这条规则。
         */
        canvas.style.opacity = '0'
        canvas.width = newW
        canvas.height = newH

        const ctx = canvas.getContext('2d', { alpha: false })
        if (!ctx) return
        /*
         * 铺白底：万一这次渲染被取消，离屏画布也不会被换上，
         * 但若真换上了，露出的也是一张干净白纸而不是黑块。
         * 代价一次 fillRect，可忽略。
         */
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, newW, newH)

        renderTask = page.render({
          canvasContext: ctx,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined
        })
        stage('rendering')

        await (renderTask as unknown as { promise: Promise<void> }).promise
        if (cancelled) {
          stage('done-but-cancelled')
          return
        }

        /*
         * ★ 画完了不等于画对了：验证像素，空白就重试一次。
         *
         *   高压下出现过「渲染任务正常结束、画布却一个亮点都没有」
         *   的情况（大画布光栅化中途被系统回收，pdf.js 不报错）。
         *   这种事没法从 API 层面察觉，只能看像素。
         *
         *   判定刻意保守：只在**整幅画找不到任何深色像素**时才认为
         *   出错。真实页面哪怕全白，也总有页边、页眉线或一点噪点；
         *   而空白页本来就该是纯白，重试一次也不会更糟。
         */
        if (!hasVisibleContent(canvas)) {
          if (renderRetryRef.current < MAX_RENDER_RETRIES) {
            renderRetryRef.current += 1
            stage(`blank-retrying ${renderRetryRef.current}`)
            console.warn(
              `[pdf] 第 ${pageNumber} 页渲染结果为空，第 ${renderRetryRef.current} 次重试`
            )
            /*
             * 先把画布藏起来露出白底，再让 effect 重跑。
             * 不藏的话用户会先看到一整块空白画布闪一下。
             */
            setRenderTick((t) => t + 1)
            return
          }
          stage('blank-given-up')
          console.warn(`[pdf] 第 ${pageNumber} 页重试 ${MAX_RENDER_RETRIES} 次后仍为空`)
        }

        /*
         * ★ 换上去 —— 这一步之后用户才看得到新画面。
         *
         *   换之前先确认这张离屏画布还挂在同一个容器下：
         *   期间若发生了重挂载（换文档、切视图模式），
         *   oldCanvas 已经被 React 摘掉，此刻 replaceWith 会把
         *   新画布插到一个游离节点旁边，等于什么也没显示。
         */
        if (oldCanvas.parentNode) {
          /*
           * ★ 打上 is-painted 才让它不透明。
           *
           *   画布默认是透明的（见 viewer.css 的 .pdf-page__canvas），
           *   底下垫着 .pdf-page__cwrap 的白底；只有这一笔白色底子
           *   连同内容都画完了，才允许它遮住白底。
           *   顺序不能反：先加类再 replaceWith 的话，从「加上类」
           *   到「真正换上去」之间没有任何东西被渲染出来，
           *   但万一 replaceWith 抛异常，页面上就留着一张不透明的
           *   白画布，用户会以为页面是空的。
           */
          canvas.classList.add('is-painted')
          canvas.style.opacity = ''
          oldCanvas.replaceWith(canvas)
          /* 旧位图留着占显存没有任何意义，主动释放 */
          oldCanvas.width = 0
          oldCanvas.height = 0
        } else {
          stage('swap-skipped-detached')
          return
        }

        stage('painted')

        /*
         * 新画面已经画上，立刻结束「隐藏画布」状态。
         * 直接操作 DOM 而不用 React state：
         *   rendered 是布尔值，第二次缩放时它仍为 true，
         *   React 不会重渲染，副作用也就不会跑 —— 画布会一直藏着。
         *   这里每次渲染完成都显式清除，逻辑最简单也最可靠。
         */
        if (wrapRef.current) delete wrapRef.current.dataset.rendering

        setRendered(true)

        /*
         * ★ 巡检：确认这块画布在**稍后**依然有内容，没有就重画。
         *
         *   踩坑记录（切缩放后整页死黑，安装了正式版还能复现）：
         *   画布被清空未必发生在渲染之前。实测时间线是这样的 ——
         *     t0  fit-width 画好，画布 1578×2231，亮度 100%；
         *     t1  切到 90%，「撑尺寸」effect 把画布改成 803×1136
         *         → 改尺寸立即清空成纯黑（alpha:false，清空即黑）；
         *     t2  渲染 effect 重跑，guard 判断「尺寸相符已画好」而跳过；
         *     t3  渲染 effect 的依赖（width/height/rendered/active）
         *         **从此再也不变** —— 没有任何机制能把它叫醒，
         *         于是这块画布黑到用户关掉应用为止。
         *
         *   为什么不能在清空的当场补救：清空发生在别处的 effect 里，
         *   而我们无法可靠拦截「谁在什么时候动过画布尺寸」。
         *   反过来做 —— 渲染完成后延迟一小会儿**回头看一眼**，
         *   只要发现画布变空了就让 effect 重跑 —— 才不依赖时序假设。
         *
         *   用 400ms：足够让同一轮缩放带来的尺寸变更全部落地，
         *   又短到用户察觉不出（这段时间图案还在，不是白屏）。
         */
        const verifyDelay = 400 * 2 ** postCheckRetryRef.current
        const verifyTimer = window.setTimeout(() => {
          if (cancelled) return
          const cv = getCanvas()
          if (!cv) return
          const wantW = Math.max(1, Math.floor(renderWidth * dpr))
          const wantH = Math.max(1, Math.floor(renderHeight * dpr))

          /* 修复：画布已经好了就清零计数，下次再有风吹草动从头退避 */
          const sizeStale = cv.width !== wantW || cv.height !== wantH
          const blank = !sizeStale && !hasVisibleContent(cv)
          if (!sizeStale && !blank) {
            postCheckRetryRef.current = 0
            return
          }

          if (postCheckRetryRef.current >= POST_CHECK_MAX_RETRIES) {
            /*
             * 到顶了：不再重画，只留一条日志。
             * 不继续加 tick 是因为依赖数组没变的话 React 也不会重跑，
             * 真正要防的是「重画 → 又被判空 → 再重画」的自激循环。
             */
            stage(`post-check-giveup ${sizeStale ? 'size-stale' : 'blank'}`)
            console.warn(
              `[pdf] 第 ${pageNumber} 页巡检连续 ${postCheckRetryRef.current} 次异常（` +
                `${sizeStale ? '尺寸不符' : '画布为空'}），停止重画`
            )
            return
          }

          postCheckRetryRef.current += 1
          stage(`post-check-${sizeStale ? 'size-stale' : 'blank'}-${postCheckRetryRef.current}`)
          console.warn(
            `[pdf] 第 ${pageNumber} 页画布${sizeStale ? '尺寸不符' : '在渲染完成后变空'}，` +
              `第 ${postCheckRetryRef.current} 次重画（退避 ${verifyDelay}ms）`
          )
          setRenderTick((t) => t + 1)
        }, verifyDelay)
        pendingVerifyRef.current = verifyTimer

        // ---- 文本层在下面独立的 effect 里渲染（见 textRenderDep）----
      } catch (error) {
        // 取消渲染会抛出 RenderingCancelledException，这是正常流程，不当错误
        const name = (error as { name?: string })?.name
        if (name === 'RenderingCancelledException') {
          /*
           * ★ 被取消的渲染必须安排一次重试，否则这一页会永久空着。
           *
           *   原因：canvas 是「先定尺寸（=清空成透明）再画」，
           *   而画布是 alpha:false，清空后透出来就是**纯黑**。
           *   如果渲染在画上之前被取消，画布就停在黑屏状态。
           *   此时若 `active` 没有再次变化，effect 不会重跑，
           *   这一页就永远是黑的 —— 这正是「快速翻页卡成黑色页面」。
           *
           *   抖动计数每次变化都会让 effect 重跑一次，
           *   而成功后 rendered 变 true、不再进入这个分支，不会死循环。
           */
          if (!cancelled) {
            setRenderTick((t) => t + 1)
            stage('cancelled-retrying')
            /*
             * 取消后必须立刻解除「隐藏画布」状态。
             * 否则画布一直是 opacity: 0，用户看到的是容器背景上的
             * 空快照 —— 也就是一块纯黑。
             */
            if (wrapRef.current) delete wrapRef.current.dataset.rendering
          } else {
            stage('cancelled-unmounted')
          }
        } else if (!cancelled) {
          stage(`failed ${(error as { message?: string })?.message ?? ''}`.slice(0, 60))
          console.warn(`[pdf] 第 ${pageNumber} 页渲染失败：`, error)
        } else {
          stage('cancelled-unmounted')
        }
      } finally {
        /*
         * 无论成功、失败还是被取消，都必须归还名额 ——
         * 漏还一次，闸门就会永久少一个通道；
         * 漏还三次，整个应用就再也渲染不出任何页面了。
         */
        if (gotSlot) {
          gotSlot = false
          releaseRenderSlot()
        }
      }
    }

    void run()

    return () => {
      cancelled = true
      try {
        renderTask?.cancel()
      } catch {
        /* 已结束时 cancel 会抛，忽略 */
      }
      /*
       * 撤掉还没到点的「巡检」定时器。
       * 不清的话，用户翻页或再次缩放之后，过期的巡检会对着
       * 已经画好的页面报告「变空了」，白白触发一轮重画（闪一下）。
       */
      if (pendingVerifyRef.current !== null) {
        window.clearTimeout(pendingVerifyRef.current)
        pendingVerifyRef.current = null
      }
      /*
       * 组件卸载时如果这一页还卡在队列里等名额，它永远不会被唤醒，
       * 名额也就永远收不回来 —— 直接在这里判断并归还。
       * （已经在跑的路径由 run() 的 finally 负责，两处不会重复归还：
       *   归还后 gotSlot 立刻置回 false。）
       */
      if (gotSlot) {
        gotSlot = false
        releaseRenderSlot()
      }
      /*
       * ★ 这里**不能**调 page.cleanup()。
       *
       *   踩坑记录（「快速翻页所有页面卡成黑色页面」的直接元凶）：
       *   冷启动时每页 canvas 都还是默认的 300×150，内容总高很小，
       *   于是 rootMargin '150%' 把全部 10 页都判为「接近视口」，
       *   10 个渲染任务同时启动。等真实尺寸算出来、内容撑高之后，
       *   观察器把中间几页移出视口，它们的 effect cleanup 立即执行 ——
       *   而 cleanup 里的 page.cleanup() 会**释放这一页的渲染资源、
       *   清掉已经画好的位图**。此时 rendered 仍为 false，
       *   但 effect 依赖里没有 rendered，于是永远不会重画，
       *   该页就永久停在黑屏（尺寸是对的、像素是全黑的）。
       *
       *   pdf.js 的缓存本来就是文档级的，doc.destroy() 会统一释放，
       *   逐页 cleanup 既无必要、又和「离屏后还要靠已渲染位图
       *   当背景」的滚动体验相冲突。故删除。
       */
    }
  }, [doc, pageNumber, renderWidth, renderHeight, rotation, active, rendered, renderTick])

  /*
   * ══════════════════════════════════════════════════════════════════
   *  文本层：单独一个 effect，只跟「文档 / 页码 / 落定尺寸 / 旋转」变
   * ══════════════════════════════════════════════════════════════════
   *
   * ★ 为什么不能和画布渲染写在同一个 effect 里（v2.1.4 真因）：
   *
   *   画布那个 effect 的依赖里有 `active`（是否接近视口）与 `rendered`
   *   —— 这两个值在滚动、浮条出现、批注增删时都会抖一下。而它的第一步
   *   就是 `container.innerHTML = ''` 重建全部字符 span。
   *
   *   于是用户刚拖选完一串文字、浮条一出现触发重渲染，字符 span 就被
   *   换成了新节点：**浏览器选区锚在旧节点上，节点一移除，选区立刻塌成
   *   0 个字符**。实测（CDP 真鼠标）：松手瞬间 86 字，350ms 后 0 字，
   *   span 节点身份也变了。用户描述就是「选不中 / 选完自己没了」。
   *
   *   拆开之后，文本层只在真正需要时重建（换文档、换页、缩放落定），
   *   选区不会被无关渲染抹掉。
   */
  useEffect(() => {
    const container = textRef.current
    if (!doc || !container || renderWidth <= 0 || renderHeight <= 0) return

    let cancelled = false

    const run = async (): Promise<void> => {
      try {
        const page = await doc.getPage(pageNumber)
        if (cancelled) return

        const base = page.getViewport({ scale: 1, rotation })
        const scale = renderHeight > 0 ? renderHeight / base.height : renderWidth / base.width
        const viewport = page.getViewport({ scale, rotation })

        /*
         * 尺寸没变就不重建。React 18 的 StrictMode 之外，
         * effect 也可能因为父组件重渲染而重跑；重建一次就丢一次选区。
         */
        const signature = `${Math.floor(viewport.width)}x${Math.floor(viewport.height)}|${rotation}`
        container.dataset.textDiag = JSON.stringify({
          sig: signature,
          prev: container.dataset.textSig ?? '',
          kids: container.children.length,
          rw: Math.round(renderWidth),
          rh: Math.round(renderHeight)
        })
        if (container.dataset.textSig === signature && container.children.length > 0) return

        const textContent = await page.getTextContent()
        if (cancelled) return

        container.innerHTML = ''
        container.style.width = `${Math.floor(viewport.width)}px`
        container.style.height = `${Math.floor(viewport.height)}px`

        const itemCount = Array.isArray(textContent.items) ? textContent.items.length : -1
        const layer = new pdfjsLib.TextLayer({
          textContentSource: textContent,
          container,
          viewport
        })
        await layer.render()
        if (cancelled) return

        /*
         * ★ 让 DOM 顺序 = 阅读顺序（v2.1.3 晚期，2026-10-19）。
         *
         *   为什么必须重排：
         *     pdf.js 的 TextLayer 是按**内容流顺序**生成 span 的，而 PDF 里
         *     页眉、图注、页码常常是正文之后才画 → 它们在 DOM 里排到正文后面。
         *     浏览器的跨节点选区是「按 DOM 顺序取两个位置之间的全部内容」，
         *     于是「从页眉拖到正文」会瞬间选中整页（实测 2915 字、70 个高亮块），
         *     用户看到的就是「选错范围」。
         *
         *   排法：直接子 span 按 (top, left) 升序——与眼睛看到的行顺序一致。
         *   只动直接子 span；<br> 之类的节点保持相对位置。
         */
        const kids = [...container.querySelectorAll<HTMLElement>(':scope > span')]
        if (kids.length > 1) {
          const sorted = [...kids].sort((a, b) => {
            const ra = a.getBoundingClientRect()
            const rb = b.getBoundingClientRect()
            if (Math.abs(ra.top - rb.top) > 2) return ra.top - rb.top
            return ra.left - rb.left
          })
          if (sorted.some((el, i) => el !== kids[i])) {
            for (const el of sorted) container.appendChild(el)
          }
        }

        container.dataset.textSig = signature

        // 文本层是批注功能的基础（选区依赖它），因此渲染结果必须可观测：
        // 一旦为 0 说明选区、复制、高亮全都不可用，需要立刻发现。
        console.log(
          `[pdf] 第 ${pageNumber} 页文本层：内容项 ${itemCount}，生成 span ${container.children.length}`
        )
        if (itemCount > 0 && container.children.length === 0) {
          console.warn(`[pdf] 第 ${pageNumber} 页文本层渲染为空（选区与批注将不可用）`)
        }
      } catch (error) {
        if (!cancelled) console.warn(`[pdf] 第 ${pageNumber} 页文本层渲染失败：`, error)
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [doc, pageNumber, renderWidth, renderHeight, rotation])

  return (
    <div
      /*
       * 用回调 ref 把节点登记进父组件的 pageRefs。
       * React 会在卸载时以 null 调用一次，正好用来 delete —— 
       * 不能只 set 不 delete，否则 Map 里会留下已经卸载的节点，
       * IntersectionObserver 继续观察它们，visible 集合永远清不掉。
       */
      ref={(el) => registerRef(pageNumber, el)}
      className="pdf-page"
      data-page={pageNumber}
      style={{ width: width > 0 ? width : undefined, minHeight: height > 0 ? height : undefined }}
    >
      <div
        ref={wrapRef}
        className="pdf-page__cwrap"
        style={{ width: width > 0 ? `${width}px` : undefined, height: height > 0 ? `${height}px` : undefined }}
      >
        <canvas className="pdf-page__canvas" />
      </div>
      <div ref={textRef} className="pdf-page__text textLayer" />
      {/*
        OCR 文字层（v2.1.3）。
        ★ 为什么是「叠一层文字」而不是直接把识别结果画到画布上：
          选中、复制、改文字、高亮全都要一个真实的 DOM 文字节点；
          画到画布上就只能看不能选。这一层的 span 与 pdf.js 的文字层同构，
          于是 `caretRangeFromPoint`、`selectionToRects` 都不用改。
        ★ 字号按行高反推（height * 0.78）：tesseract 只给 bbox，
          给不了原字体大小；0.78 是中文方块字「字身小于行高」的经验比例，
          偏小一点宁可选中框略窄，也不要溢出到相邻行。
      */}
      {ocrLines && ocrLines.length > 0 ? (
        <div className="pdf-page__ocr ocr-text-layer">
          {ocrLines.map((line, idx) => {
            const fontSize = Math.max(8, Math.round(line.height * 0.78))
            return (
              <span
                key={`${idx}-${Math.round(line.x)}-${Math.round(line.y)}`}
                style={{
                  left: `${line.x}px`,
                  top: `${line.y}px`,
                  width: `${line.width}px`,
                  height: `${line.height}px`,
                  fontSize: `${fontSize}px`,
                  lineHeight: `${Math.max(fontSize, Math.round(line.height))}px`
                }}
              >
                {line.text}
              </span>
            )
          })}
        </div>
      ) : null}
      {/* 批注层叠在文本层之上：pointer-events 为 none，不挡文字选择 */}
      <AnnotationLayer
        items={annotations}
        scale={scale}
        pageWidth={width}
        pageHeight={height}
        erasing={erasing}
      />
      {/*
        内容编辑层（涂白 / 文字 / 图片 / 矩形 / 椭圆）。
        ★ 位置在批注层**之后**、占位图之前：
          涂白的语义是「盖住这里的原文」，所以它必须叠在文字层与
          标记类批注之上（层级由 edit.css 的 z-index 4 保证）。
          占位图是兜底的预览，被盖住无所谓，因此留在最后。
      */}
      {editLayer}
      {/*
        渲染完成前显示缩略图占位。
        ★ 这是「快速翻页卡成黑页」的修法之一：
          canvas 用 alpha:false 创建，未渲染时是一张**全黑**的空位图。
          快速翻页时渲染跟不上，用户就看到黑页。
          叠一张低分辨率缩略图上去，黑页立刻变成「略糊但能看」的预览，
          渲染完成后自动被高清内容盖住。
      */}
      {!rendered && active ? <PageGhost doc={doc} pageNumber={pageNumber} /> : null}
    </div>
  )
}

/**
 * 页面占位预览（低分辨率）。
 *
 * ── 为什么需要 ──────────────────────────────────────────────
 *   主画布用 `alpha: false` 创建（为了渲染性能与不透明纸张底色），
 *   代价是**未渲染时它是一张全黑的空位图**。
 *   快速翻页时 pdf.js 渲染跟不上，用户就看到一片黑页 ——
 *   这正是被反馈的「快速翻页所有页面卡成黑色」。
 *
 * ── 做法 ────────────────────────────────────────────────────
 *   用很低的 scale（0.25）先把这一页画到一张小画布上，
 *   再用 CSS 拉伸铺满页面区域。
 *   它只有几十毫秒的开销，却能让用户在等待期间看到
 *   「略糊但完整」的页面，而不是黑屏。
 *   主画布渲染完成后会叠在它上面（主画布 z-index 更高）。
 *
 * 为什么不复用缩略图栏的图：那一份是在侧栏里按需生成的，
 * 未打开缩略图标签时并不存在，取不到。
 */
function PageGhost({
  doc,
  pageNumber
}: {
  doc: PDFDocumentProxy
  pageNumber: number
}): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    let task: { cancel: () => void } | null = null

    const run = async (): Promise<void> => {
      try {
        const page = await doc.getPage(pageNumber)
        if (cancelled) return

        /*
         * 0.25 倍：A4 页面约 149×211 像素。
         * 足够看清版面结构（哪块是图、哪块是文字），
         * 又小到几乎瞬间完成 —— 占位的意义就在于快。
         */
        const viewport = page.getViewport({ scale: 0.25 })
        const canvas = ref.current
        if (!canvas || cancelled) return

        canvas.width = Math.max(1, Math.floor(viewport.width))
        canvas.height = Math.max(1, Math.floor(viewport.height))

        const ctx = canvas.getContext('2d', { alpha: false })
        if (!ctx) return

        // 先铺白底：PDF 页面本来就是白纸，避免出现黑边
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)

        task = page.render({ canvasContext: ctx, viewport })
        await (task as unknown as { promise: Promise<void> }).promise
        if (!cancelled) setReady(true)
      } catch (error) {
        const name = (error as { name?: string })?.name
        if (name !== 'RenderingCancelledException' && !cancelled) {
          console.warn(`[pdf] 第 ${pageNumber} 页占位图生成失败：`, error)
        }
      }
    }

    void run()
    return () => {
      cancelled = true
      try {
        task?.cancel()
      } catch {
        /* 忽略 */
      }
    }
  }, [doc, pageNumber])

  return (
    <canvas
      ref={ref}
      className="pdf-page__ghost"
      aria-hidden="true"
      /* 还没画出内容时不显示，免得又露出一张黑画布 */
      style={{ opacity: ready ? 1 : 0 }}
    />
  )
}

/* ============================================================
 * 连续滚动视图
 * ============================================================ */

interface ViewerProps {
  doc: PDFDocumentProxy
  /** 阅读区尺寸（用于计算自适应缩放） */
  viewWidth: number
  viewHeight: number
  /** 单页模式下只渲染当前页 */
  singlePage: boolean
  /** 双页并排 */
  facing: boolean
  /** 当前文档的全部批注（已按页排序） */
  annotations: Annotation[]
  /**
   * 请求创建一条批注。
   * 由父组件负责落盘，这里只负责把「页 + 坐标 + 类型 + 颜色 + 原文」算好交出去。
   */
  onCreateAnnotation: (input: {
    page: number
    type: Annotation['type']
    rects: Annotation['rects']
    color: string
    quote: string
    note: string
  }) => void
  /**
   * 用橡皮在页面坐标 (x, y) 处以 radius 半径擦一下。
   *
   * 半径是**页面坐标**（调用方已从屏幕像素换算好）。
   * 擦除是局部的：半径内的笔迹会被切成若干残段，
   * 而不是整条删除 —— 与真实橡皮一致。
   */
  onEraseAt: (page: number, x: number, y: number, radius: number) => void
}

/**
 * 连续缩放的上下限。
 *
 * 与 useTouchGestures 里的 MIN_SCALE/MAX_SCALE 保持一致 ——
 * 两条输入路径若能缩到的范围不同，用户会觉得「捏合能到、
 * Ctrl+滚轮到不了」，很困惑。
 */
const ZOOM_MIN = 0.25
const ZOOM_MAX = 6

/**
 * 连续滚动视图。
 *
 * 页码同步策略：
 *   用 IntersectionObserver 观察每一页，取「可见比例 × 面积」最大的页作为当前页。
 *   比用 scrollTop 除以页高更稳 —— 页面高度不一致（横竖混排）时不会算错。
 */
export function DocumentView({
  doc,
  viewWidth,
  viewHeight,
  singlePage,
  facing,
  annotations,
  onCreateAnnotation,
  onEraseAt
}: ViewerProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const pageRefs = useRef<Map<number, HTMLElement>>(new Map())
  const [visible, setVisible] = useState<Set<number>>(() => new Set([1, 2, 3]))

  /*
   * 视图模式。
   *
   * 原先这个值只被 Toolbar 自己读写，DocumentView 从来没消费过它 ——
   * 于是「单页 / 双页并排 / 双页连续」三个按钮点了只有图标变蓝，
   * 版面纹丝不动。这里才是它真正生效的地方。
   */
  const viewMode = useViewer((s) => s.viewMode)

  /**
   * 页面节点登记表。
   *
   * 用 useCallback 固定引用：它会被传给每一页当 ref 回调，
   * 每次渲染都换个新函数的话 React 会先以 null 调旧的、再以节点调新的，
   * 白白触发一轮「注销 + 注册」，观察器也会被反复重建。
   *
   * 卸载时以 null 调用 —— 必须 delete，否则 Map 里留下已卸载的节点，
   * IntersectionObserver 持续观察它们，visible 集合里会永远留着旧页码。
   */
  /**
   * 已登记的页面节点数量。
   *
   * ★ 为什么需要这个 state：
   *   两个 IntersectionObserver 在 useEffect 里创建，依赖是
   *   [pageCount, pageSize.width, pageSize.height]。
   *   而 ref 回调是在**这次 render 的 DOM 提交阶段**才跑的，
   *   即 useEffect 先执行、节点后登记 —— 首次渲染时 Map 还是空的，
   *   观察器一个元素都没观察到。若不在节点登记后重跑 effect，
   *   这个 Map 补了写也仍然没用（观察器还是空的）。
   *
   *   这里只存数量、不存节点本身：数量在幂等登记的稳态下不变，
   *   不会引起额外的渲染循环。
   */
  const [registeredCount, setRegisteredCount] = useState(0)

  const registerPageRef = useCallback((num: number, el: HTMLDivElement | null) => {
    const map = pageRefs.current
    const had = map.has(num)

    if (el) map.set(num, el)
    else map.delete(num)

    // 只在「有无」真的变化时更新计数，避免无谓的重渲染
    if (had !== Boolean(el)) setRegisteredCount(map.size)
  }, [])

  const page = useViewer((s) => s.page)
  /*
   * 扫描件文字识别（v2.1.3）。
   *
   * ★ 为什么状态放在「当前页」上而不是每页各存一份：
   *   识别一页要 2~5 秒（首次还要加载 6 MB 语言包），缓存多页既占内存
   *   也没有意义 —— 老师通常是「翻到这一页 → 认出来 → 就地改错字」。
   *   换页即丢弃，行为可预期。
   */
  const ocrRequest = useViewer((s) => s.ocrRequest)
  const [ocr, setOcr] = useState<{ page: number; lines: OcrLine[] } | null>(null)
  const [ocrBusy, setOcrBusy] = useState(false)
  const ocrPageRef = useRef(1)
  ocrPageRef.current = page
  const zoom = useViewer((s) => s.zoom)
  const rotation = useViewer((s) => s.rotation)
  const pageCount = useViewer((s) => s.pageCount)
  const setPage = useViewer((s) => s.setPage)
  const setActualScale = useViewer((s) => s.setActualScale)

  /*
   * 缩放值的「落定版」。
   *
   * zoom 每次变化都立刻反映到版面尺寸（纯 CSS，不花钱），
   * 但**位图重渲染**只认这个延迟 400ms 的值 —— 用户还在拖滑块时，
   * 它一直停在手势开始前的那一档，旧的清晰画面被拉大显示，
   * 停手后才按最终比例重画一次。
   *
   * 这就是 PDF.js viewer 的 `defaultZoomDelay` 策略
   * （web/app_options.js:168，默认 400ms）：缩放路径上从不触碰位图，
   * 所以既不可能黑屏也不可能卡顿。
   */
  const [settledZoom, setSettledZoom] = useState(zoom)

  useEffect(() => {
    if (settledZoom === zoom) return
    const timer = window.setTimeout(() => setSettledZoom(zoom), ZOOM_SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [zoom, settledZoom])

  /** 由于滚轮/键盘引起的滚动，不希望反过来触发页码同步 */
  const syncingRef = useRef(false)

  /*
   * 缩放前的阅读位置快照。
   *
   * 【为什么需要】换档位 / 适应宽度这类**非手势**缩放会整体改变版面高度，
   *   而 scrollTop 本身不会跟着变 —— 同一个滚动距离就落到了另一页上。
   *   实测（已装实例上同样复现）：第 3 页切到 125%，250ms 内页码就被
   *   可见面积观察器改写成 4；标签切回时同理，读的那一页会往前跑一页。
   *
   *   手势缩放（捏合 / 双击）有自己的锚点修正（见 pendingAnchorRef 那段），
   *   这里只负责其余入口：记录「视口顶部落在当前页的什么比例处」，
   *   版面换完之后按同一比例把画布放回去，页码就不会被版面高度带跑。
   */
  const scaleAnchorRef = useRef<{
    doc: unknown
    page: number
    scale: number
    scrollTop: number
    pageTop: number
    pageHeight: number
  } | null>(null)

  /**
   * 上一次渲染时的缩放倍数，用来识别「这次渲染是缩放引起的」。
   *
   * 初值 0 表示「还没量过」：第一次跑那条修正 effect 时只记下基准、不滚动，
   * 因为此时 pageSize 还在用异步量出来的初始值，没有「上一档」可比。
   */
  const prevScaleRef = useRef(0)

  /* ---------- 批注交互状态 ---------- */

  /** 选中文字后浮动工具条的定位与内容；null 表示不显示 */
  const [anchor, setAnchor] = useState<FloatingAnchor | null>(null)

  /*
   * editTool 的 ref 版本。
   *
   * 为什么需要：下面那个 selectionchange 的 effect 依赖
   * [pageSize.scale]，闭包里拿到的 editTool 可能是**挂载时那一份**；
   * 而「选择工具下不要因选区塌陷清空锚点」这个判断必须读到**当前**工具，
   * 否则切到选择工具后它仍然是旧的 'none'，判断失效。
   */
  const editToolRef = useRef<string>('none')
  /** 当前选中的标记颜色（跨次标记记忆，避免每次都重选） */
  const [annoColor, setAnnoColor] = useState<string>(DEFAULT_ANNOTATION_COLOR)

  /* ---------- 计算页面尺寸 ---------- */

  /**
   * 页面尺寸。
   *
   * scale 一并存下来：批注坐标是按 scale=1 存的，
   * 渲染与选区换算都需要当前 scale，集中放在这里避免各处置算不一致。
   */
  const [pageSize, setPageSize] = useState<{ width: number; height: number; scale: number }>({
    width: 0,
    height: 0,
    scale: 1
  })

  /**
   * 页面在 scale=1 时的原始尺寸（含旋转）。
   *
   * ★ 为什么单独存一份（这是一个真实的连锁缺陷）：
   *   pageSize 是异步算出来的（`doc.getPage(1).then(...)`），连续缩放时
   *   它可能还停在上一档。原先「落定尺寸」是拿 pageSize 乘 settled/live 倍率，
   *   在 pageSize 落后的瞬间会得出两边都不等于的中间值 ——
   *   实测缩放从 1.1 跳到 1.2 时算成 595×(1.1/1.2)=545，
   *   于是手势期间白跑一次整页重渲染（画布被换成 545×1.5=818 宽），
   *   正是防抖要避免的事。有了原始尺寸就可以只按倍率现算，不依赖页尺寸的新旧。
   */
  const [baseSize, setBaseSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0
  })

  useEffect(() => {
    let cancelled = false
    void doc.getPage(1).then((first) => {
      if (cancelled) return
      const base = first.getViewport({ scale: 1, rotation })
      const gap = 16

      /*
       * 可用宽度必须扣掉滚动条。
       *
       * ★ 踩坑记录：原先只减了 .viewer-pages 的左右内边距（gap*2），
       *   但 viewWidth 取的是 .app__viewer 的宽度，其中还包含垂直滚动条
       *   （本机 10px）。结果「适应宽度」算出的页面比可用区域宽 10px，
       *   页面下方出现横向滚动条、内容还会轻微偏移。
       *   这里从滚动容器实测 clientWidth，拿到的是真正可用的内容宽度，
       *   不必猜滚动条有多宽（不同缩放比例下宽度不一样）。
       */
      const scrollEl = scrollRef.current
      const contentW = scrollEl ? scrollEl.clientWidth : viewWidth
      const contentH = scrollEl ? scrollEl.clientHeight : viewHeight

      /*
       * 给垂直滚动条预留固定宽度。
       *
       * ★ 踩坑记录（这一步绕了三次）：
       *   「适应宽度」算出来的页面会让内容刚好不再溢出 → 滚动条消失 →
       *   可用宽度变大 → 下次重算页面又变宽 → 滚动条再次出现……
       *   实测同一份文档在 fit-page 下 clientWidth=1084、
       *   切到 fit-width 后变成 1094，差的正是那条 10px 滚动条，
       *   于是页面比可用区域宽 10px，出现不该有的横向滚动。
       *
       * 修法：不依赖「当前有没有滚动条」，而是量出滚动条实际占宽并恒定扣除。
       *   用 offsetWidth - clientWidth 得到真实宽度（不同 DPI / 主题下不一定 10px），
       *   当前为 0（无滚动条）时退回一个保守默认值，
       *   保证计算基准稳定、不会来回抖。
       */
      const SCROLLBAR_FALLBACK = 10
      const measured =
        scrollEl && scrollEl.offsetWidth > scrollEl.clientWidth
          ? scrollEl.offsetWidth - scrollEl.clientWidth
          : 0
      const scrollbarW = measured > 0 ? measured : SCROLLBAR_FALLBACK

      const availW = Math.max(120, (contentW || viewWidth) - scrollbarW - gap * 2) / (facing ? 2 : 1)
      const availH = Math.max(120, (contentH || viewHeight) - gap * 2)

      // 诊断：window.__sbDebugScale = true 时输出尺寸计算全过程
      if ((window as unknown as { __sbDebugScale?: boolean }).__sbDebugScale) {
        console.log(
          `[scale] viewW=${viewWidth} scrollClientW=${contentW} scrollbar=${scrollbarW} ` +
            `availW=${availW.toFixed(1)} baseW=${base.width.toFixed(1)} zoom=${String(zoom)}`
        )
      }

      let scale: number
      if (typeof zoom === 'number') {
        scale = zoom
      } else if (zoom === 'actual') {
        // 实际大小：按 CSS 英寸（96dpi）换算，PDF 单位是 72dpi
        scale = 96 / 72
      } else if (zoom === 'fit-page') {
        scale = Math.min(availW / base.width, availH / base.height)
      } else {
        scale = availW / base.width
      }

      setActualScale(scale)
      setBaseSize({ width: base.width, height: base.height })
      setPageSize({ width: base.width * scale, height: base.height * scale, scale })
    })
    return () => {
      cancelled = true
    }
  }, [doc, zoom, rotation, viewWidth, viewHeight, facing, setActualScale])

  /* ---------- 懒渲染：只画接近视口的页 ---------- */
  useEffect(() => {
    const root = scrollRef.current
    if (!root) return

    const observer = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          const next = new Set(prev)

          /*
           * ① 把交集状态**如实同步**（进出都要处理）。
           *
           * ★ 「只加不减」是「快速翻页越来越卡、最后卡成黑页」的根因：
           *   原来的代码只在 isIntersecting 时 add，
           *   于是滚动过的页永远留在集合里、永远保持 active，
           *   pdf.js 就一直为几十上百页同时持有渲染任务与位图，
           *   内存和主线程都被占满，新页再也渲染不出来 → 黑页。
           */
          const changed: Array<{ num: number; on: boolean }> = []
          for (const entry of entries) {
            const num = Number((entry.target as HTMLElement).dataset.page)
            if (!Number.isFinite(num)) continue
            if (entry.isIntersecting) next.add(num)
            else changed.push({ num, on: false })
          }
          for (const c of changed) if (!c.on) next.delete(c.num)
          return next
        })
      },
      {
        root,
        /*
         * 提前 1.5 屏开始渲染，滚动时不会看到空白。
         *
         * 这个余量同时决定了「最多同时活跃多少页」：
         * 1.5 屏 ≈ 前后各一页多，对内存是安全的。
         * 调大能让快翻更从容，但会线性增加同时渲染的页数 ——
         * 而这正是刚才那个「越滚越卡」问题的成因，故保持克制。
         */
        rootMargin: '150% 0px'
      }
    )

    for (const el of pageRefs.current.values()) observer.observe(el)
    return () => observer.disconnect()
    // registeredCount 入依赖：节点登记完要重新观察一遍（见其定义处注释）
  }, [pageCount, pageSize.width, pageSize.height, registeredCount])

  /* ---------- 页码同步（取可见面积最大的页） ---------- */
  useEffect(() => {
    const root = scrollRef.current
    if (!root) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (syncingRef.current) return

        // 收集当前所有可见页的可见面积
        let bestPage = 0
        let bestRatio = 0
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const ratio = entry.intersectionRatio
          if (ratio > bestRatio) {
            bestRatio = ratio
            bestPage = Number((entry.target as HTMLElement).dataset.page)
          }
        }
        if (bestPage > 0 && bestPage !== page) setPage(bestPage)
      },
      { root, threshold: [0.1, 0.35, 0.6, 0.9] }
    )

    for (const el of pageRefs.current.values()) observer.observe(el)
    return () => observer.disconnect()
    // registeredCount 同上：节点登记完成后才能观察到它们
  }, [pageCount, pageSize.width, pageSize.height, page, setPage, registeredCount])

  /* ---------- 记录「视口顶部落在本页的比例」 ---------- */
  useEffect(() => {
    const root = scrollRef.current
    if (!root) return

    let raf = 0
    const record = (): void => {
      raf = 0
      const el = pageRefs.current.get(page)
      if (!el) return
      const rootRect = root.getBoundingClientRect()
      const elRect = el.getBoundingClientRect()
      scaleAnchorRef.current = {
        doc,
        page,
        scale: pageSize.scale,
        scrollTop: root.scrollTop,
        pageTop: elRect.top - rootRect.top + root.scrollTop,
        pageHeight: elRect.height
      }
    }
    const schedule = (): void => {
      if (raf) return
      raf = window.requestAnimationFrame(record)
    }

    // 先记一次：打开后还没滚动过时，也要有可用的初始位置
    record()
    root.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      root.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      if (raf) window.cancelAnimationFrame(raf)
    }
    // 页面尺寸/页码/文档变了都要重记：比例是相对「当前这一页」的
  }, [doc, page, pageSize.scale, registeredCount])

  /* ---------- 页码变化 → 滚动到该页 ---------- */
  useLayoutEffect(() => {
    if (!page) return
    const el = pageRefs.current.get(page)
    const root = scrollRef.current
    if (!el || !root) return

    // 如果该页已经大部分可见就不动，避免轻微抖动
    const rootRect = root.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    const visibleH =
      Math.min(elRect.bottom, rootRect.bottom) - Math.max(elRect.top, rootRect.top)
    if (visibleH > elRect.height * 0.6) return

    /*
     * ★ 手指正按在屏幕上（拖动平移 / 长按选字）时一律不动。
     *
     *   踩坑记录（2.1.2.0，verify-touch-real 在整套里红）：
     *   页面滚动到新位置会让懒渲染补登记页面节点 → registeredCount 变 →
     *   本 effect 重跑；此时目标页已经不满足「60% 可见」，于是它把
     *   滚动位置又拽回目标页页顶。表现在真机上是「拖着拖着，页面自己弹回去」，
     *   用合成事件单跑很难复现（单跑时页面节点早已登记完，registeredCount 不变）。
     */
    if (touchSelectRef.current || panRef.current) return
    if (Date.now() - panSettledAtRef.current < 900) return

    /*
     * ★ 用 getBoundingClientRect 实测偏移，不要用 el.offsetTop。
     *
     *   踩坑记录：原来写的是 `root.scrollTo({ top: el.offsetTop - 16 })`，
     *   而 offsetTop 相对的是**最近的定位祖先**，不是滚动容器 ——
     *   .viewer-scroll 是 position: absolute（自身是定位元素），
     *   但 .pdf-page 是 position: relative，它俩之间还隔着
     *   .viewer-pages（position: relative）。
     *   于是 offsetTop 相对的是 .viewer-pages 的顶边，
     *   而 scrollTo 需要的是相对 .viewer-scroll 内容顶边的偏移 ——
     *   两者差着 .viewer-pages 的上边界，落点因此偏掉，
     *   表现为「点缩略图跳不到指定页」。
     *
     *   实测公式：目标页顶相对滚动内容的距离
     *     = (页顶视口坐标 − 容器顶视口坐标) + 当前已滚动距离
     *   这个式子对任意嵌套层级都成立，不依赖定位祖先是谁。
     */
    const offsetInContent = elRect.top - rootRect.top + root.scrollTop

    syncingRef.current = true
    // 顶部留 16px 呼吸空间（与 .viewer-pages 的内边距一致）
    root.scrollTo({ top: Math.max(0, offsetInContent - 16), behavior: 'auto' })
    // 让滚动稳定后再恢复观察
    const timer = setTimeout(() => {
      syncingRef.current = false
    }, 160)
    return () => clearTimeout(timer)
    /*
     * registeredCount 也入依赖：首次渲染时节点还没登记，
     * 若此时页码已被外部改过（例如「打开时定位到上次页码」），
     * 这次 effect 会因为 get(page) 为空而放弃滚动；
     * 等节点登记完再跑一次才能补上这一跳。
     * 已在目标页时会走上面的 60% 可见性判断提前返回，不会多滚。
     */
  }, [page, registeredCount])

  /* ---------- 选区 → 批注 ---------- */

  /** 把当前选区转成「页 + 矩形 + 原文」，交给父组件去创建 */
  const applySelection = (type: Annotation['type'], color: string, note = ''): void => {
    const root = scrollRef.current
    if (!root) return

    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return

    const range = selection.getRangeAt(0)
    // 找到选区所在的那一页（.pdf-page 元素）
    const startEl =
      range.startContainer.nodeType === Node.ELEMENT_NODE
        ? (range.startContainer as HTMLElement)
        : range.startContainer.parentElement
    const pageEl = startEl?.closest<HTMLElement>('.pdf-page')
    if (!pageEl) return

    const pageNum = Number(pageEl.dataset.page)
    if (!Number.isFinite(pageNum)) return

    const rects = selectionToRects(pageEl, pageSize.scale)
    if (rects.length === 0) return

    onCreateAnnotation({
      page: pageNum,
      type,
      rects,
      color,
      quote: selectionText(),
      note
    })

    // 标记完成后清除选区，避免误触重复标记
    selection.removeAllRanges()
  }

  /**
   * 监听选区变化，弹出手工工具条。
   *
   * 用 document 的 selectionchange 而不是 mouseup：
   *   selectionchange 也能覆盖键盘选择（Shift+方向键）与双击选词，
   *   覆盖面更广；再配合一个短延时避开拖动过程中的抖动。
   */
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null

    const onSelectionChange = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const root = scrollRef.current
        const selection = window.getSelection()
        /*
         * ★ 「选择」工具下**不因为选区塌陷就清掉锚点**。
         *
         *   选区塌陷最典型的触发就是「点了浮动工具条上的按钮」——
         *   浏览器把焦点移走、原生选区随之消失。
         *   如果这里跟着 setAnchor(null)，工具条会在用户点下去的
         *   同一帧被卸载，表现就是「点『改文字』什么也没发生」
         *   （面板 state 设在已被卸载的组件上）。
         *
         *   锚点由兜底选字（beginSelectDrag 的 onUp）用字符 span 的
         *   几何自己算，不依赖浏览器选区，所以这里保持它即可；
         *   真正要清空的时机是用户点了「取消」或切了工具。
         */
        if (editToolRef.current === 'select') {
          if (!selection || selection.isCollapsed || selection.rangeCount === 0) return
        }
        if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) {
          setAnchor(null)
          return
        }

        const range = selection.getRangeAt(0)
        /*
         * ★ 这里**不再**要求选区的公共祖先必须在本容器内。
         *
         *   跨页拖选时公共祖先是 `.viewer-pages`（在所有页之外），
         *   以前会走到 setAnchor(null) —— 用户刚拖过页边界，工具条就没了。
         *   现在只要求「起点落在一页里」，矩形由 selectionToRects 裁到该页。
         */
        const startEl =
          range.startContainer.nodeType === Node.ELEMENT_NODE
            ? (range.startContainer as HTMLElement)
            : range.startContainer.parentElement
        const pageEl = startEl?.closest<HTMLElement>('.pdf-page')
        if (!root.contains(pageEl ?? range.commonAncestorContainer) || !pageEl) {
          setAnchor(null)
          return
        }

        const pageNum = Number(pageEl.dataset.page)
        const rects = selectionToRects(pageEl, pageSize.scale)
        if (rects.length === 0 || !Number.isFinite(pageNum)) {
          setAnchor(null)
          return
        }

        // 工具条定位在选区上方居中
        const box = range.getBoundingClientRect()
        setAnchor({
          left: Math.min(Math.max(12, box.left + box.width / 2), window.innerWidth - 12),
          top: Math.max(60, box.top - 8),
          quote: selectionText(),
          page: pageNum,
          rects,
          style: textStyleFromNode(range.startContainer, pageSize.scale)
        })
      }, 160)
    }

    document.addEventListener('selectionchange', onSelectionChange)
    return () => {
      if (timer) clearTimeout(timer)
      document.removeEventListener('selectionchange', onSelectionChange)
    }
  }, [pageSize.scale])

  /**
   * 浮动工具条跟随页面滚动 / 窗口缩放。
   *
   * ★ 用户报「选中文字后一翻页，工具条就浮在别的地方了」。
   *   锚点原本只在选区出现时算一次（屏幕坐标），页面一滚它就是过期数据。
   *   这里在滚动时按「页码 + 页面坐标 rect」重新算屏幕位置（rAF 节流），
   *   用完仍然写回同一个 anchor 对象 —— 工具条是相对于窗口 fixed 定位的。
   *
   *   只在 rects 有值时跟随；纯文本选区没算出矩形时不干预。
   */
  const anchorRect = anchor?.rects[0]
  const anchorPage = anchor?.page
  useEffect(() => {
    if (!anchorRect || anchorPage === undefined) return
    const container = scrollRef.current
    if (!container) return
    let frame = 0

    const follow = (): void => {
      frame = 0
      const el = scrollRef.current
      const pageEl = el?.querySelector<HTMLElement>(`.pdf-page[data-page="${anchorPage}"]`)
      if (!el || !pageEl) return
      const pageBox = pageEl.getBoundingClientRect()
      const scale = pageSize.scale
      const top = pageBox.top + anchorRect.y * scale
      const bottom = top + anchorRect.height * scale
      let nextTop = Math.max(60, top - 8)
      /* 选区贴顶（滚到工具条/标签栏下面）时翻到选区下方 */
      if (nextTop < 62 && bottom + 10 < window.innerHeight - 80) nextTop = bottom + 10
      const nextLeft = Math.min(
        Math.max(12, pageBox.left + (anchorRect.x + anchorRect.width / 2) * scale),
        window.innerWidth - 12
      )
      setAnchor((prev) =>
        prev && prev.page === anchorPage ? { ...prev, left: nextLeft, top: nextTop } : prev
      )
    }

    const request = (): void => {
      if (!frame) frame = requestAnimationFrame(follow)
    }

    container.addEventListener('scroll', request, { passive: true })
    window.addEventListener('resize', request)
    return () => {
      container.removeEventListener('scroll', request)
      window.removeEventListener('resize', request)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [anchorPage, anchorRect, pageSize.scale])

  /**
   * 按页把批注分组，渲染时直接取用，避免每页都过滤一遍全量列表。
   *
   * ★ 内容编辑类批注（涂白 / 文字 / 图片 / 矩形 / 椭圆）**不进这一份**：
   *   AnnotationLayer 只认高亮/下划线/删除线/便签与笔迹，
   *   其余类型会被它统一渲染成 `.anno-mark--{type}` 的色块 ——
   *   涂白会变成一块用 --anno-color 上色的方块（而不是白色），
   *   文字与图片更是只剩一个空框。它们由下面的 contentByPage 交给编辑层。
   */
  const byPage = new Map<number, Annotation[]>()
  const contentByPage = new Map<number, Annotation[]>()
  for (const item of annotations) {
    const isContent = CONTENT_ANNOTATION_TYPES.includes(item.type)
    const bucket = isContent ? contentByPage : byPage
    const list = bucket.get(item.page)
    if (list) list.push(item)
    else bucket.set(item.page, [item])
  }

  /* ---------- 手绘 ---------- */

  /**
   * 手绘笔迹。
   *
   * 交互设计：
   *   开启手绘模式后，指针按下即开始记录点，移动时追加，
   *   抬起时把整条笔迹转成一条 note 类型的批注（rects 存包围盒，
   *   实际笔迹用 quote 字段以 JSON 形式保存，避免再改一次数据结构）。
   *
   *   为什么复用 note 类型而不是新增 'draw' 类型：
   *     数据层已经稳定（主进程、侧栏、持久化都按现有类型实现），
   *     为了不改动这些已完成的代码，用 note + 约定字段承载笔迹。
   *     代价是侧栏会把它显示成「便签」，因此额外用 quote 前缀区分。
   */
  /*
   * 正在绘制中的笔迹（尚未落成批注）。
   *
   * 点里带时间戳与压力：
   *   时间戳用于估算书写速度 → 推出笔锋的粗细变化；
   *   压力在触屏笔上有真实值，鼠标/手指为 0，渲染时再按速度补。
   * 没有这两个字段就只能画出等宽的线，看起来像马克笔而不是笔。
   */
  /*
   * ---------- 多指绘画：一根手指一个「笔迹会话」 ----------
   *
   * ★ 为什么要按指针建会话，而不是像原来那样「全局只有一个草稿」：
   *   原实现用 draftPointsRef 一个点数组 + 一对**不区分 pointerId**
   *   的 window 监听器。第二根手指按下时会出现三件事：
   *     · 同一个数组被清空重来 —— 第一根手指刚画的点凭空消失；
   *     · 第二根手指的移动点被追加进**同一条**笔迹 ——
   *       两指之间被拉起一条横跨屏幕的折线；
   *     · 任何一根手指抬起都会结算整条笔迹 —— 另一根还在动，
   *       剩下的点落成第二条半截笔迹。
   *   这就是用户报的「单指绘画中途切多指，批注渲染出问题」。
   *   改成一指一会话之后，几根手指就是几条互不干扰的笔迹，
   *   谁抬起来只结算谁。
   *
   * ★ 点数组仍然放在会话对象里、不参与 React 渲染：
   *   每个 pointermove 都 setState 会触发 React 全量重渲染，
   *   书写快时既延迟又会因批处理丢点（曲线断口）。
   *   React 只在这一笔**起笔（挂载预览画布）与收笔（结算批注）**
   *   时各渲染一次，中途的点走 PreviewInk 的命令式 drawMore()。
   */
  const [drafts, setDrafts] = useState<DraftSession[]>([])
  const sessionsRef = useRef<Map<number, DraftSession>>(new Map())

  /** 正在擦除的会话（多指同时擦 / 掌心大面积擦） */
  const eraseSessionsRef = useRef<Map<number, EraseSession>>(new Map())

  /**
   * 把会话表同步成一份渲染快照。
   *
   * 只在起笔/收笔时调用 —— 移动中每帧调用就退回了「每点一次全量重渲染」，
   * 那正是书写延迟与丢点的来源。
   */
  const syncDrafts = (): void => {
    setDrafts(Array.from(sessionsRef.current.values()))
  }

  /*
   * 诊断开关与轨迹：window.__sbDebugDraw = true 时输出关键字段，
   * window.__sbDrawTrace 数组则把判定结果挂到 window 上供自动化测试读回
   * （派发合成事件时控制台日志可能因监听连接时机收不到）。
   * 生产环境两者都不存在，函数体里只多一次属性读取。
   */
  const drawDbg = (): boolean =>
    Boolean((window as unknown as { __sbDebugDraw?: boolean }).__sbDebugDraw)
  const drawTrace = (msg: string): void => {
    const sink = (window as unknown as { __sbDrawTrace?: string[] }).__sbDrawTrace
    if (!sink) return
    sink.push(msg)
    if (sink.length > 40) sink.shift()
  }

  /*
   * ---------- 扫描件文字识别（OCR，v2.1.3） ----------
   *
   * 触发链路：溢出菜单「识别扫描页文字」→ store.ocrRequest +1 → 这里。
   *
   * ★ 为什么不做「打开就自动识别」：
   *   识别一页 2~5 秒（首次还要加载约 6 MB 语言包），一本 100 页的扫描书
   *   自动识别就是十几分钟的风扇狂转。老师的真实动作是「这一页我要改字」，
   *   按按钮才识别，既省电也符合预期。
   */
  useEffect(() => {
    if (ocrRequest <= 0) return
    let cancelled = false
    void (async () => {
      const container = scrollRef.current
      const targetPage = ocrPageRef.current
      const pageEl = container?.querySelector<HTMLElement>(`.pdf-page[data-page="${targetPage}"]`)
      const canvas = pageEl?.querySelector<HTMLCanvasElement>('canvas')
      if (!pageEl || !canvas || canvas.width === 0) {
        drawTrace(`OCR：第 ${targetPage} 页还没渲染完，先滚动到该页再试`)
        return
      }
      setOcrBusy(true)
      try {
        /* 图片像素 ÷ CSS 像素：识别框要靠它换算回页面坐标 */
        const rect = pageEl.getBoundingClientRect()
        const ratio = canvas.width / Math.max(1, rect.width)
        const lines = await recognizePage(canvas.toDataURL('image/png'), ratio)
        if (cancelled) return
        setOcr({ page: targetPage, lines })
        drawTrace(`OCR：第 ${targetPage} 页识别出 ${lines.length} 行文字`)
      } catch (err) {
        if (!cancelled) drawTrace(`OCR 失败：${(err as Error).message}`)
      } finally {
        if (!cancelled) setOcrBusy(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [ocrRequest])

  /* 换文档即丢弃识别结果：不同 PDF 的页码没有可比性 */
  useEffect(() => {
    setOcr(null)
  }, [doc])

  /* 空闲预热 + 卸载释放：worker 线程不释放会一直占着两三百 MB */
  useEffect(() => {
    warmUpOcr()
    return () => {
      void disposeOcr()
    }
  }, [])
  /*
   * 测试钩子（v2.1.3，仅 `--test-hooks` 启动时挂载）。
   *
   * ★ 为什么需要：真实扫描件动辄十几 MB，不适合塞进 tests/fixture；
   *   而「资源路径 / wasm 核心 / 语言包」恰恰是打包后最容易坏的一环
   *   （dev 能跑、file:// 下 404 是最典型的翻车方式）。
   *   这里把识别函数与「注入识别结果」暴露给用例，就能在隐藏实例里
   *   端到端验证：画一张带中文的图 → 识别 → 叠成可选文字层 → 选中改字。
   */
  useEffect(() => {
    const host = window as unknown as {
      __testHooks?: boolean
      __ocrTest?: {
        recognize: typeof recognizePage
        inject: (lines: OcrLine[]) => void
        clear: () => void
        page: () => number
      }
    }
    if (!host.__testHooks) return
    host.__ocrTest = {
      recognize: recognizePage,
      inject: (lines) => setOcr({ page: ocrPageRef.current, lines }),
      clear: () => setOcr(null),
      page: () => ocrPageRef.current
    }
    return () => {
      host.__ocrTest = undefined
    }
  }, [])
  const drawMode = useViewer((s) => s.drawMode)
  const drawColor = useViewer((s) => s.drawColor)
  const drawWidth = useViewer((s) => s.drawWidth)
  const eraserMode = useViewer((s) => s.eraserMode)
  const eraserSize = useViewer((s) => s.eraserSize)

  /**
   * ---------- 漫游（拖动平移） ----------
   *
   * 工具栏的第三个工具：既没在画也没在擦时就是漫游态。
   * 触摸屏上「拖着页面走」本来由浏览器原生滚动负责（touch-action: pan-x pan-y），
   * 但**鼠标/触控笔**拖页面时浏览器只会去选文字，页面一动不动 ——
   * 一体机上接了鼠标的老师会觉得「漫游这个按钮没用」。
   * 所以这里补一段指针拖动平移：
   *   · 只接管鼠标/触控笔（触摸交给原生滚动，接管反而会把惯性滚动弄坏）
   *   · 起点落在文字层上时不接管 —— 那里拖动是**选字**（高亮批注的入口）
   *   · 位移直接写 scrollLeft/scrollTop，与拖动方向反向（抓住纸张的手感）
   */
  const panRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    left: number
    top: number
    /** 会话序号：同一指针上先后开过两个会话时，靠它区分「这组监听是谁的」 */
    sid: number
  } | null>(null)
  /** 正在拖动（只驱动光标样式，不影响布局） */
  const [panning, setPanning] = useState(false)

  /* ============================================================
   * 「选择」工具下的**兜底选字**
   *
   * ── 为什么需要自己建选区 ────────────────────────────────────
   *   依赖浏览器原生选字在这套界面里不可靠：应用根设了
   *   `user-select: none`（触屏防长按高亮），文字层虽然逐层覆盖成
   *   `text`，但实测（隐藏实例里发真鼠标事件）依然出现
   *   「pointerdown / mousedown / selectstart 都触发了，拖完
   *     getSelection().toString() 却是空」的情况 ——
   *   用户看到的就是「有时候选不中」。
   *
   *   所以这里加一条确定性的路径：选择工具下自己按指针位置
   *   在**字符 span** 上建 Range。原生能选时它是幂等的补充，
   *   原生不灵时它就是唯一可行的路径。
   *
   * ── 只在「原生没选出东西」时才接管 ──────────────────────────
   *   按下时不动；拖动过程中若已有原生选区（长度 > 0）就完全让位，
   *   避免和原生双击选词、Shift+方向键等行为打架。
   * ============================================================ */

  /** 选择工具下，按屏幕坐标找最近的字符 span 与其文本偏移 */
  const glyphAt = useCallback(
    (clientX: number, clientY: number): { node: Text; offset: number; host: HTMLElement } | null => {
      /*
       * caretRangeFromPoint 对「透明文字叠在 canvas 上」这种结构最合适：
       * 它按排版取最近的插入点，正是我们想选的字符位置。
       */
      const doc = document as Document & {
        caretRangeFromPoint?: (x: number, y: number) => Range | null
      }
      const range = doc.caretRangeFromPoint?.(clientX, clientY)
      if (!range) return null
      const container = range.startContainer

      /*
       * 多数位置返回 TEXT_NODE；但拖过行间空隙时 Chromium 会返回**元素**
       * （实测跨行拖选 6 个采样点里 5 个是元素容器）。以前这里直接判空，
       * 于是「自己扩选」在行间必断 —— 用户看到的是拖到一半就不动了。
       * 现在按「先找最近的字 span、再按左右半区取首/尾偏移」兜底。
       */
      /**
       * 元素容器（行间空隙）时按几何估一个插入点。
       *
       * ★ 为什么要「先挑行、再挑 span、最后按比例算偏移」：
       *   以前只取「最近的 span + 左右半区给 0/末尾」，跨行拖动时
       *   指针落在两行之间，最近 span 往往还是上一行，于是每一下都
       *   算成「行首」或「行尾」，拖出来只有一两个字。
       *   这里先按 y 定位到**行**（span 的 top 聚成一簇），再按 x
       *   找到该行里的 span，偏移量按字符数比例插值 —— 跨行拖动
       *   就能连续往右/往下扩。
       */
      const geometricGlyph = (): { text: Text; offset: number } | null => {
        const hit = document.elementFromPoint(clientX, clientY) as HTMLElement | null
        const pageEl = hit?.closest<HTMLElement>('.pdf-page') ?? null
        if (!pageEl) return null
        const spans = [...pageEl.querySelectorAll<HTMLElement>('.textLayer span, .ocr-text-layer span')]
        if (spans.length === 0) return null

        /* 1) 按「行」聚合：top 相差 < 6px 视为同一行 */
        const lines: Array<{ top: number; bottom: number; spans: HTMLElement[] }> = []
        for (const span of spans) {
          const box = span.getBoundingClientRect()
          if (box.width <= 0 || box.height <= 0) continue
          const line = lines.find((l) => Math.abs(l.top - box.top) <= 6)
          if (line) {
            line.spans.push(span)
            line.bottom = Math.max(line.bottom, box.bottom)
          } else {
            lines.push({ top: box.top, bottom: box.bottom, spans: [span] })
          }
        }
        if (lines.length === 0) return null

        /* 2) 选行：纵向包含指针的行最优，否则取纵向最近的 */
        let bestLine = lines[0]
        let bestDy = Number.POSITIVE_INFINITY
        for (const line of lines) {
          const dy = clientY < line.top ? line.top - clientY : clientY > line.bottom ? clientY - line.bottom : 0
          if (dy < bestDy) {
            bestDy = dy
            bestLine = line
          }
        }

        /* 3) 行内选 span：横向包含指针的最优，否则取最近的 */
        let bestSpan: HTMLElement | null = null
        let bestDx = Number.POSITIVE_INFINITY
        for (const span of bestLine.spans) {
          const box = span.getBoundingClientRect()
          const dx = clientX < box.left ? box.left - clientX : clientX > box.right ? clientX - box.right : 0
          if (dx < bestDx) {
            bestDx = dx
            bestSpan = span
          }
        }
        if (!bestSpan) return null
        const node = bestSpan.firstChild
        if (!node || node.nodeType !== Node.TEXT_NODE) return null
        const data = (node as Text).data
        const box = bestSpan.getBoundingClientRect()
        let offset = 0
        if (clientX >= box.right) offset = data.length
        else if (clientX > box.left) {
          const ratio = (clientX - box.left) / Math.max(1, box.width)
          offset = Math.min(data.length, Math.max(0, Math.round(ratio * data.length)))
        }
        return { text: node as Text, offset }
      }

      let text: Text | null = null
      let offset = range.startOffset
      if (container.nodeType === Node.TEXT_NODE) {
        text = container as Text
      } else {
        const el =
          container instanceof HTMLElement ? container : (container.parentElement as HTMLElement | null)
        const span = el?.closest<HTMLElement>('.textLayer span, .ocr-text-layer span') ?? null
        const node = span?.firstChild
        if (span && node && node.nodeType === Node.TEXT_NODE) {
          text = node as Text
          const box = span.getBoundingClientRect()
          offset = clientX < box.left + box.width / 2 ? 0 : text.data.length
        } else {
          const guess = geometricGlyph()
          if (guess) {
            text = guess.text
            offset = guess.offset
          }
        }
      }
      if (!text) return null

      /* 只认文字层里的字符节点，避免选到界面文案 */
      const host = text.parentElement
      if (!host || !host.closest('.textLayer, .ocr-text-layer')) return null
      return { node: text, offset, host }
    },
    []
  )

  /**
   * 由**页面上的字符 span 自己**算浮动锚点。
   *
   * ★ 为什么不复用 selectionchange 那条路：
   *   选择工具的浮动条是挂在原生选区上的：一旦选区塌陷
   *   （点工具条上的按钮就会塌），selectionchange 立刻把 anchor 置空、
   *   工具条整个卸载 —— 于是「点改文字 → 面板还没展开就没了」。
   *   这里直接从 span 的几何算 rects，锚点不再依赖浏览器选区。
   *
   *   rects 用**并集**而不是逐行分段：改文字只需要一个覆盖原文的块，
   *   分段是给高亮/下划线批注用的。
   */
  const anchorFromHost = useCallback(
    (host: HTMLElement, quoteText?: string): FloatingAnchor | null => {
      const pageEl = host.closest<HTMLElement>('.pdf-page')
      if (!pageEl) return null
      const pageNum = Number(pageEl.dataset.page)
      if (!Number.isFinite(pageNum)) return null
      const scale = pageSize.scale > 0 ? pageSize.scale : 1
      const pageBox = pageEl.getBoundingClientRect()

      /* 选区涉及的所有 span：从起点到终点之间的字符 span */
      const spans = [...pageEl.querySelectorAll<HTMLElement>('.textLayer span')]
      const boxes: DOMRect[] = []
      const parts: string[] = []
      const from = spans.indexOf(host)
      if (from < 0) return null
      /*
       * 目前只处理「同一行走到底」与「从起点 span 到指针所在 span」两种。
       * 这里先给单 span 与同页连续 span 的并集，够改文字用；
       * 真正的多行选区仍由原生 selectionchange 那条路提供（它更精确）。
       */
      for (let i = from; i < spans.length; i++) {
        const el = spans[i]
        const r = el.getBoundingClientRect()
        if (r.width <= 0) continue
        boxes.push(r)
        parts.push(el.textContent ?? '')
        /* 换行（下一个 span 明显更靠下）就停，避免把整页都圈进来 */
        const next = spans[i + 1]
        if (next) {
          const nr = next.getBoundingClientRect()
          if (nr.top > r.bottom + 1) break
        }
      }
      if (boxes.length === 0) return null

      const left = Math.min(...boxes.map((b) => b.left))
      const top = Math.min(...boxes.map((b) => b.top))
      const right = Math.max(...boxes.map((b) => b.right))
      const bottom = Math.max(...boxes.map((b) => b.bottom))
      const toPage = (v: number): number => v / scale
      return {
        left: Math.min(Math.max(12, left + (right - left) / 2), window.innerWidth - 12),
        top: Math.max(60, top - 8),
        quote: (quoteText ?? parts.join('')).trim(),
        page: pageNum,
        rects: [
          {
            x: toPage(left - pageBox.left),
            y: toPage(top - pageBox.top),
            width: toPage(right - left),
            height: toPage(bottom - top)
          }
        ],
        style: textStyleFromNode(host, scale)
      }
    },
    [pageSize.scale]
  )

  /**
   * 指向「用当前浏览器选区定锚点」的稳定引用。
   *
   * 为什么用 ref 而不是直接调 anchorFromSelection：
   *   那个回调定义在下面（依赖 pageSize.scale），而 beginSelectDrag
   *   的 useCallback 依赖数组在 render 期间求值，直接引用会落进 TDZ。
   */
  const anchorFromSelectionRef = useRef<() => void>(() => {})

  /**
   * 鼠标「两次点击」的记账（双击选词用）。
   *
   * ★ 为什么不用 dblclick：
   *   选择工具下按下时会 preventDefault 到底（否则浏览器原生拖选会和我们
   *   抢同一份选区，实测拖两行只选中 1~2 个字）。副作用是把兼容鼠标事件
   *   一起掐掉了 —— 原生 mousedown / click / **dblclick 全都不再派发**，
   *   于是「双击选词」只能自己按「两次按下的时间 + 距离」判。
   */
  const mouseTapRef = useRef<{ at: number; x: number; y: number }>({ at: 0, x: 0, y: 0 })

  const selectDragRef = useRef<{
    pointerId: number
    /* host = 起点所在的字符 span；onUp 用它算锚点，不依赖浏览器选区 */
    from: { node: Text; offset: number; host: HTMLElement }
    /** 按下点：用来判「这次是拖动还是单纯点了一下」 */
    startX: number
    startY: number
    /** 位移是否超过 4px（超过就算拖动，不再按「点击清空」处理） */
    moved: boolean
    /** 这次按下是不是「双击的第二下」——是的话松手要保留选中的词 */
    word: boolean
    /** 会话流水号（仅用于诊断轨迹） */
    sid: number
  } | null>(null)

  const dragSeqRef = useRef(0)
  /**
   * 上一个手势会话的「拆收尾」函数（摘监听 / 清计时器）。
   *
   * ★ 为什么需要它：会话靠 `pointerup` 收尾，可一旦抬起事件没送到
   *   （合成事件打在已被替换的节点上、指针被系统抢走、窗口失焦），
   *   那组 window 监听就永远留在页面上。下一次手势开始时先执行这里的
   *   收尾，等于把「漏挂」变成「最多漏一个手势」。
   *   实测症状：跑完触摸用例再跑选择用例，鼠标空移一下页面就自己滚
   *   （旧会话的 onMove 还在按旧起点写 scrollTop）。
   */
  const gestureCleanupRef = useRef<(() => void) | null>(null)

  const beginSelectDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      /* 上一会话若没收到抬起，监听还挂着：先收掉，避免累积 */
      gestureCleanupRef.current?.()
      gestureCleanupRef.current = null
      const sid = ++dragSeqRef.current
      const from = glyphAt(e.clientX, e.clientY)
      if (!from) {
        return
      }

      /*
       * 双击检测：两次按下间隔 < 400ms、位移 < 12px 就当双击 → 选中该词。
       * 时序见上面 mouseTapRef 的注释（我们掐掉了原生 dblclick）。
       */
      const now = Date.now()
      const prevTap = mouseTapRef.current
      const isDouble = now - prevTap.at < 400 && Math.abs(e.clientX - prevTap.x) < 12 && Math.abs(e.clientY - prevTap.y) < 12
      mouseTapRef.current = { at: now, x: e.clientX, y: e.clientY }
      const pickedWord = isDouble ? selectWordAt(e.clientX, e.clientY) : false

      selectDragRef.current = {
        pointerId: e.pointerId,
        from,
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
        word: pickedWord,
        sid
      }

      /*
       * ★ 选字由我们负责，不让浏览器抢（v2.1.3 晚期改）。
       *
       *   实测（CDP 真鼠标 + 隐藏实例，2026-10-19）：
       *   文字层的每一行是**绝对定位的 span**，行间是空隙；
       *   指针滑到空隙时 `caretRangeFromPoint` 返回的是 textLayer **div**
       *   的元素位置（nodeType=1），Chromium 自己的拖选在这种位置上
       *   只扩到 1~2 个字就停（真实现场：拖过两行只选出「er」）。
       *
       *   所以只要按下点在字上，就直接 preventDefault 掉浏览器的
       *   选区启动（pointerdown 的默认动作包含 mousedown/selectstart），
       *   后面每一步都由 apply() 自己 setBaseAndExtent —— 偏移量走
       *   glyphAt 的几何兜底（先挑行、再挑 span、按 x 比例算偏移）。
       *
       *   双击选词不受影响：dblclick 与 pointerdown 的默认动作无关，
       *   handleViewerDoubleClick 里另有 selectWordAt。
       */
      e.preventDefault()

      /*
       * ★ 鼠标拖选：原生优先、自己兜底（v2.1.3）。
       *
       *   实测（CDP 真鼠标 + 隐藏实例）两种失败都出现过：
       *     · 原生一路正常 → 不要插手，插手反而会把选字掐掉；
       *     · 原生全程不建选区（换了输入设备 / 远程桌面 / 某些
       *       Chrome 版本）→ 拖动一个字符都选不上，用户只会说
       *       「选不中」。
       *   所以这里按每次 pointermove 检查：原生已经有选区就完全让位，
       *   还是空的就用起点 + 当前字符自己 setBaseAndExtent。
       */
      const apply = (glyph: { node: Text; offset: number }): void => {
        const s = window.getSelection()
        if (!s) return
        try {
        s.setBaseAndExtent(from.node, from.offset, glyph.node, glyph.offset)
        } catch {
          try {
            s.setBaseAndExtent(glyph.node, glyph.offset, from.node, from.offset)
          } catch {
            /* 跨文档等极端情况：忽略，下一次移动再试 */
          }
        }
      }

      /*
       * owned：选区是**我们自己**建的。
       *   以前只看「原生选区是否非空」就永久让位，于是第一下移动自己
       *   建出 1 个字之后，后面每一下都以为「原生已经选好了」直接 return，
       *   拖多远都只有 1 个字（实测正是这个现象）。自建之后必须由自己
       *   负责继续扩，直到松手。
       */
      let owned = false

      const onMove = (ev: PointerEvent): void => {
        const session = selectDragRef.current
        /* 会话身份（sid）不一致 = 上一次拖选的监听漏在 window 上，直接忽略 */
        if (!session || session.sid !== sid || ev.pointerId !== session.pointerId) return

        if (!session.moved && Math.abs(ev.clientX - session.startX) + Math.abs(ev.clientY - session.startY) > 4) {
          session.moved = true
        }
        if (!session.moved) return

        const sel = window.getSelection()
        if (!owned && sel && sel.toString().length > 0) return /* 原生已经选出来了：让位 */

        const glyph = glyphAt(ev.clientX, ev.clientY)
        if (!glyph) return
        apply(glyph)
        owned = true
      }

      const onUp = (ev: PointerEvent): void => {
        /*
         * ★ 先无条件摘掉自己的三个监听，再判断这次抬起是否属于自己。
         *   以前先判 pointerId 再摘：同一指针上先后开两个会话时，
         *   后一个把 selectDragRef 置空，前一个的抬起就「判不匹配」
         *   直接 return，监听永久漏在 window 上 —— 之后每一次鼠标移动
         *   都被上一会话的闭包拿去 setBaseAndExtent
         *   （实测：反向拖选只出 1 个字）。
         */
        window.removeEventListener('pointermove', onMove, true)
        window.removeEventListener('pointerup', onUp, true)
        window.removeEventListener('pointercancel', onUp, true)
        gestureCleanupRef.current = null
        const last = selectDragRef.current
        if (!last || last.sid !== sid || ev.pointerId !== last.pointerId) return
        selectDragRef.current = null

        const sel = window.getSelection()
        const picked = sel?.toString().trim() ?? ''

        /*
         * 拖出了内容：锚点取真实选区（逐行矩形、精确引用）。
         * 以前一律用起点 span 的几何，高亮/改文字会按整行算。
         */
        if (picked.length > 0) {
          anchorFromSelectionRef.current()
          return
        }

        /*
         * 只是点了一下（没拖动、也没选出字）：清掉旧选区与浮条。
         * 与触摸端「轻点取消选区」保持同一套手感。
         */
        if (!last?.moved) {
          sel?.removeAllRanges()
          setAnchor(null)
          return
        }

        /* 拖动过但没拿到字符（页边/图片上）：退回 span 几何兜底 */
        const to = glyphAt(ev.clientX, ev.clientY)
        const host = to?.host ?? last?.from.host
        if (host) {
          const next = anchorFromHost(host)
          if (next) setAnchor(next)
        }
      }

      /*
       * 挂 window 且用捕获：与 startRoamPan 同一套约定 ——
       * 指针划出元素/窗口都要跟得住。
       */
      window.addEventListener('pointermove', onMove, true)
      window.addEventListener('pointerup', onUp, true)
      window.addEventListener('pointercancel', onUp, true)
      /* 下一次手势开始时会调用它兜底（见 gestureCleanupRef 注释） */
      gestureCleanupRef.current = (): void => {
        window.removeEventListener('pointermove', onMove, true)
        window.removeEventListener('pointerup', onUp, true)
        window.removeEventListener('pointercancel', onUp, true)
      }
    },
    [glyphAt]
  )

  /* ============================================================
   * 触摸屏上的选字（长按选词 / 双击选词 / 拖动扩选 / 拖动平移）
   *
   * ── 为什么触摸必须自己实现 ─────────────────────────────────
   *   上面的 beginSelectDrag 只对鼠标与触控笔生效：startRoamPan 在
   *   `pointerType === 'touch'` 时一律 return（触摸交给浏览器原生滚动）。
   *   于是「选择」工具在一体机上等于只能看：手指按在字上拖，
   *   页面跟着滚，一个字都选不出来。Chromium 自带的长按选词在
   *   Windows 触摸屏上又时灵时不灵（只在部分设备/输入法下出选词手柄）。
   *
   * ── 手指下的分工 ───────────────────────────────────────────
   *   · 轻点             → 取消选区（工具条收起）
   *   · 快速连点两下     → 选中该处这个词
   *   · 长按 360ms       → 选中该处这个词，继续拖动**扩选**
   *   · 一按就拖（>10px）→ 平移页面（选择工具下也要能翻页）
   *
   *   所以 CSS 里选择工具会把 .viewer-scroll 的 touch-action 设成 none
   *   （见 styles/edit.css），滚动由这里自己算，不与原生滚动打架。
   * ============================================================ */

  /**
   * 长按判定时长（毫秒）。
   *
   * ★ 2.1.2.0 二次调优：400 → **360**。触屏用户对「按住不动」的耐心很短，
   *   400ms 出来条明显有「等一下」的顿感；360ms 既够躲开误触，
   *   又和系统长按（约 500ms）拉开距离，不会和 Chromium 原生长按打架。
   */
  const TOUCH_LONGPRESS_MS = 360
  /**
   * 「按住这么久再松手」也算长按。
   *
   * ★ 真机上大多数人按 300ms 左右就抬起来了，卡在 400ms 的计时器上
   *   一次都选不中 —— 这是「长按选不中」的主要来源。
   *   所以松手时再看一眼按了多久，够久就补一次选词。
   */
  const TOUCH_TAP_HOLD_MS = 260
  /** 长按认定前允许的手指抖动（像素），超过就算「要平移」 */
  const TOUCH_PAN_SLOP = 10
  /**
   * 连点选词的时间窗（毫秒）与落点容差（像素）。
   *
   * ★ 真机双击间隔常见 300~450ms，原先 320ms 太紧 →「双击不灵」。
   *   放宽到 420ms，同时把落点容差放到 40px（手指不可能点在同一点上）。
   */
  const TOUCH_DOUBLE_MS = 420
  const TOUCH_DOUBLE_SLOP = 40

  const lastTouchTapRef = useRef<{ at: number; x: number; y: number }>({ at: 0, x: 0, y: 0 })
  /**
   * 触摸会话正在生效（用来挡掉 Chromium 自己的长按选字/右键菜单）。
   *
   * ★ 真机上手指按住 500ms，Chromium 的**原生**长按选字会自己开始，
   *   把我们刚选好的词覆盖成一大段 ——「选错范围」的真正来源。
   *   touch-action:none 只挡滚动，挡不住原生长按选字，得靠 selectstart / contextmenu。
   */
  const touchArmedRef = useRef(false)
  const lastTouchAtRef = useRef(0)

  /** 判断一个字符算不算「词的一部分」：空白与中英文常用标点都是边界 */
  const isWordChar = (ch: string): boolean => {
    if (ch === '' || /\s/.test(ch)) return false
    return !/[\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(
      ch
    )
  }

  /** 一个「词」最多取多少字符：中文词远短于此，英文长串也不会整行拖走 */
  const WORD_MAX_LEN = 12

  /**
   * 中英文分词器（Chromium/Node 都带 Intl.Segmenter）。
   *
   * ★ 为什么不能只按「连续非空白」切：中文没有空格，
   *   `wordRangeAt` 会把整句/整行当成一个词，长按一下选中一大段 ——
   *   用户报的「选错范围」就是这个。Segmenter 对中文按词切（北京/市/海淀区），
   *   对英文按词切，正好是长按该选中的粒度。
   */
  const wordSegmenter = ((): Intl.Segmenter | null => {
    try {
      return new Intl.Segmenter('zh-Hans', { granularity: 'word' })
    } catch {
      return null
    }
  })()

  /** 文本节点里的插入点 → 该处词的起止偏移 */
  const wordRangeAt = (node: Text, offset: number): { start: number; end: number } => {
    const text = node.data
    const at = Math.min(Math.max(0, offset), text.length)

    if (wordSegmenter && text.length > 0) {
      try {
        for (const seg of wordSegmenter.segment(text)) {
          const segStart = seg.index
          const segEnd = segStart + seg.segment.length
          /* 插入点可能落在词尾边界上，两种都算命中 */
          if (at < segStart || at > segEnd) continue
          if (!seg.segment.trim() || ![...seg.segment].some(isWordChar)) break
          return { start: segStart, end: Math.min(segEnd, segStart + WORD_MAX_LEN) }
        }
      } catch {
        /* 分词失败就退回字符扫描 */
      }
    }

    /* 兜底：按「连续非标点」扩，但整段长度封顶，避免中文整行被吞 */
    let start = at
    let end = at
    while (start > 0 && at - start < WORD_MAX_LEN && isWordChar(text[start - 1])) start -= 1
    while (end < text.length && end - at < WORD_MAX_LEN && isWordChar(text[end])) end += 1
    if (start === end) {
      /* 落在空白或标点上：退化成选一个字符，保证「长按总有反应」 */
      if (at < text.length) end = at + 1
      else if (at > 0) start = at - 1
    }
    return { start, end }
  }

  /** 选中屏幕上某点处的词；点不到字返回 false */
  const selectWordAt = useCallback(
    (clientX: number, clientY: number): boolean => {
      const glyph = glyphAt(clientX, clientY)
      if (!glyph) return false
      const { start, end } = wordRangeAt(glyph.node, glyph.offset)
      if (start === end) return false
      try {
        const range = document.createRange()
        range.setStart(glyph.node, start)
        range.setEnd(glyph.node, end)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
        return true
      } catch {
        return false
      }
    },
    [glyphAt]
  )

  /**
   * 用**当前浏览器选区**定锚点（触摸选词用）。
   *
   * 与 anchorFromHost 的分工：那个取单个字符 span 的盒子，词/多行时会偏小；
   * 这里直接取 Range 的包围盒，工具条贴得更准，rects 也按页裁好。
   * 选区没了就什么都不做（避免把已经正确的锚点清掉）。
   */
  const anchorFromSelection = useCallback((): void => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    if (range.collapsed) return
    const box = range.getBoundingClientRect()
    if (box.width < 1 && box.height < 1) return

    const startEl =
      range.startContainer.nodeType === Node.ELEMENT_NODE
        ? (range.startContainer as HTMLElement)
        : range.startContainer.parentElement
    const pageEl = startEl?.closest<HTMLElement>('.pdf-page')
    if (!pageEl) return
    const pageNum = Number(pageEl.dataset.page)
    if (!Number.isFinite(pageNum)) return

    let top = Math.max(60, box.top - 8)
    /* 选区贴顶（或页面滚到工具条下面）时翻到选区下方 */
    if (box.top - 8 < 62 && box.bottom + 10 < window.innerHeight - 80) top = box.bottom + 10

    setAnchor({
      left: Math.min(Math.max(12, box.left + box.width / 2), window.innerWidth - 12),
      top,
      quote: sel.toString().trim(),
      page: pageNum,
      rects: selectionToRects(pageEl, pageSize.scale),
      style: textStyleFromNode(range.startContainer, pageSize.scale)
    })
  }, [pageSize.scale])

  /* 让上面的 beginSelectDrag（定义在更早）能拿到这个回调 */
  anchorFromSelectionRef.current = anchorFromSelection

  /** 触摸选字会话：pending → panning | selecting */
  const touchSelectRef = useRef<{
    /** 会话序号（与 panRef/selectDragRef 共用 dragSeqRef），用于识别「这组监听是谁的」 */
    sid: number
    pointerId: number
    startX: number
    startY: number
    /** 手指按下的时刻，用来判「按了够久才松手」也算长按 */
    startAt: number
    left: number
    top: number
    mode: 'pending' | 'panning' | 'selecting'
    timer: number | null
    from: { node: Text; offset: number } | null
    /** 平移速度（px/ms，正数 = 内容向下滚），松手时用来做惯性 */
    vTop: number
    /** 上一次采样：scrollTop 与时刻 */
    lastTop: number
    lastAt: number
  } | null>(null)

  /**
   * 触摸平移的惯性帧（rAF 句柄）。
   *
   * ★ 为什么要有：选择工具下 `touch-action: none` 把原生滚动关掉了，
   *   手一抬页面立刻钉住 —— 一体机上「滑一下能滑出去很远」的直觉落空，
   *   手感比漫游工具（走原生滚动，有惯性）差一大截。
   *   这里补一条 1:1 跟手 + 松手衰减的惯性：初速取松手前最后一段的平均速度，
   *   每帧 ×0.94，低于 0.02px/ms 或触到边界就停。
   */
  const touchMomentumRef = useRef(0)

  const cancelTouchMomentum = useCallback((): void => {
    if (touchMomentumRef.current !== 0) {
      window.cancelAnimationFrame(touchMomentumRef.current)
      touchMomentumRef.current = 0
    }
  }, [])

  const startTouchMomentum = useCallback(
    (el: HTMLElement, vTop: number): void => {
      cancelTouchMomentum()
      if (Math.abs(vTop) < 0.15) return
      let vy = vTop
      const step = (): void => {
        vy *= 0.94
        if (Math.abs(vy) < 0.02) {
          touchMomentumRef.current = 0
          return
        }
        const before = el.scrollTop
        el.scrollTop = before + vy * 16
        if (el.scrollTop === before) {
          /* 到边界了，别再空转 */
          touchMomentumRef.current = 0
          return
        }
        touchMomentumRef.current = window.requestAnimationFrame(step)
      }
      touchMomentumRef.current = window.requestAnimationFrame(step)
    },
    [cancelTouchMomentum]
  )

  useEffect(() => cancelTouchMomentum, [cancelTouchMomentum])

  /**
   * 刚刚结束一次拖动平移的时刻（触摸 / 漫游鼠标都算）。
   *
   * ★ 为什么要单独记：拖动会触发懒渲染补登记页面 → `registeredCount` 变 →
   *   「页码变化 → 滚动到该页」的 effect 重跑；拖动结束的下一帧 `touchSelectRef`
   *   已经清空，守卫失效，于是它在松手后把 `scrollTop` 拽回页顶 ——
   *   用户看到「拖到一半，页面自己弹回去」。实测整套跑到后半段时必现。
   */
  const panSettledAtRef = useRef(0)

  /**
   * 选择工具下的触摸接管。
   *
   * ★ 移动超过 TOUCH_PAN_SLOP 就判为「想滚动」，长按计时器立刻取消 ——
   *   「想滚动」和「想选字」不会互相抢。
   * ★ 长按/双击之后进入 selecting：指针移动用 setBaseAndExtent 扩选，
   *   松手用 anchorFromSelection 定锚点（此时原生选区还活着）。
   */
  const startTouchSelect = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      const container = scrollRef.current
      if (!container) {
        drawTrace('选择（触摸）：滚动容器还没就绪，本次触摸不接管')
        return
      }

      cancelTouchMomentum()
      gestureCleanupRef.current?.()
      gestureCleanupRef.current = null
      const session = {
        sid: ++dragSeqRef.current,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startAt: Date.now(),
        left: container.scrollLeft,
        top: container.scrollTop,
        mode: 'pending' as 'pending' | 'panning' | 'selecting',
        timer: null as number | null,
        from: null as { node: Text; offset: number } | null,
        vTop: 0,
        lastTop: container.scrollTop,
        lastAt: Date.now()
      }
      touchSelectRef.current = session
      /* 手指按下的这一刻起，Chromium 的原生长按选字/右键菜单都得让路 */
      touchArmedRef.current = true
      lastTouchAtRef.current = Date.now()

      const clearTimer = (): void => {
        if (session.timer !== null) {
          window.clearTimeout(session.timer)
          session.timer = null
        }
      }

      /** 长按/双击：把落点的词选出来并进入扩选模式 */
      const beginWordSelect = (x: number, y: number): void => {
        if (!selectWordAt(x, y)) return
        session.mode = 'selecting'
        const glyph = glyphAt(x, y)
        session.from = glyph ? { node: glyph.node, offset: glyph.offset } : null
        anchorFromSelection()
        drawTrace('选择（触摸）：长按/双击 → 选中该词，可继续拖动扩选')
      }

      /** 平移一步：同时维护速度采样（pointermove / touchmove 共用一条路径） */
      const panTo = (x: number, y: number): void => {
        const s = touchSelectRef.current
        const el = scrollRef.current
        if (!s || !el) return
        el.scrollLeft = s.left - (x - s.startX)
        el.scrollTop = s.top - (y - s.startY)
        const now = Date.now()
        const dt = now - s.lastAt
        if (dt >= 8) {
          const v = (el.scrollTop - s.lastTop) / dt
          s.vTop = s.vTop * 0.55 + v * 0.45
          s.lastTop = el.scrollTop
          s.lastAt = now
        }
      }

      /** 从「还没决定」切到「平移」：撤掉长按计时器、收起选区与浮动条 */
      const beginPan = (): void => {
        const s = touchSelectRef.current
        if (!s) return
        clearTimer()
        s.mode = 'panning'
        s.vTop = 0
        s.lastTop = scrollRef.current?.scrollTop ?? s.top
        s.lastAt = Date.now()
        /*
         * 拖动 = 想翻着看，不是在批注：顺手把上一次的选区与浮动条收掉。
         *
         * ★ 长按已经进入 selecting 的情况不会走到这里 —— 那是「选字后拖着扩选」，
         *   选区必须留着；两条路径靠 mode 分得很清楚。
         */
        window.getSelection()?.removeAllRanges()
        setAnchor(null)
        drawTrace(`选择（触摸）：移动超过 ${TOUCH_PAN_SLOP}px → 改为平移页面`)
      }

      const onMove = (ev: PointerEvent): void => {
        const s = touchSelectRef.current
        if (!s || s.sid !== session.sid) return
        if (ev.pointerId !== s.pointerId) {
          /* 只有异常路径才记：正常触摸里 pointerId 在整个手势中不变 */
          drawTrace(`触摸移动：pointerId 不匹配（事件 ${ev.pointerId} / 会话 ${s.pointerId}）`)
          return
        }
        const dx = ev.clientX - s.startX
        const dy = ev.clientY - s.startY

        if (s.mode === 'pending') {
          if (Math.hypot(dx, dy) <= TOUCH_PAN_SLOP) return
          beginPan()
        }

        if (s.mode === 'panning') {
          panTo(ev.clientX, ev.clientY)
          return
        }

        /* selecting：拖动扩选 */
        if (!s.from) return
        const glyph = glyphAt(ev.clientX, ev.clientY)
        if (!glyph) return
        try {
          window.getSelection()?.setBaseAndExtent(s.from.node, s.from.offset, glyph.node, glyph.offset)
        } catch {
          /* 跨节点越界：忽略，等下一次移动再试 */
        }
      }

      /**
       * ★ 未合并的指针更新（pointerrawupdate）：见到就立即用来判「拖动」。
       *
       *   Chromium 的 pointermove 会按帧合并后派发；隐藏窗口/渲染层忙的时候，
       *   一次 108px 的拖动只送来 1~2 个 pointermove，而且**晚于 400ms 的
       *   长按计时器** —— 应用先「选中词」再收到移动，拖动变成扩选。
       *   pointerrawupdate 不合并、不受 rAF 排帧影响，能早一步取消长按。
       *   Electron 33（Chromium 130）支持；不支持的环境自动退回 pointermove。
       */
      const onRawMove = (ev: PointerEvent): void => {
        /*
         * 只看「还悬而未决」的按下：已经进入 selecting（长按选词成功）时不再插手，
         * 扩选交给合并后的 pointermove，避免 rawupdate 高频 setBaseAndExtent。
         */
        const s = touchSelectRef.current
        if (!s || s.sid !== session.sid || s.mode !== 'pending') return
        onMove(ev)
      }

      /**
       * ★ 触摸版「移动」：尽早判定「这是拖动，不是长按」。
       *
       *   与 pointerrawupdate 双保险：某些环境（含 CDP 触摸注入）只送
       *   touchmove 不给 pointerrawupdate，两条都挂上，谁先到谁取消计时器。
       */
      const onTouchMove = (ev: TouchEvent): void => {
        const s = touchSelectRef.current
        if (!s || s.sid !== session.sid) return
        const t = ev.touches[0] ?? ev.changedTouches[0]
        if (!t) return
        /* 已经在平移：用触摸坐标直接跟手（比按帧合并的 pointermove 更及时） */
        if (s.mode === 'panning') {
          panTo(t.clientX, t.clientY)
          return
        }
        if (s.mode !== 'pending') return
        const dx = t.clientX - s.startX
        const dy = t.clientY - s.startY
        if (Math.hypot(dx, dy) <= TOUCH_PAN_SLOP) return
        beginPan()
        panTo(t.clientX, t.clientY)
      }

      const onUp = (ev: PointerEvent): void => {
        /*
         * ★ 先无条件摘监听，再判断是不是自己的会话（与 panRef/beginSelectDrag 同一类坑）。
         *
         *   触摸会话的 pointerId 在 Chromium 上可能就是 1，和鼠标一样；
         *   一旦「上一次会话的抬起」因为 pointerId 不匹配提前 return，
         *   那组 pointermove 监听就会永久留在 window 上 ——
         *   之后**任何鼠标移动**都会按旧会话的起点把页面拖走。
         *   整套里 verify-touch-real 跑完再跑 verify-select，
         *   双击用例就是被这个泄漏拖到灰底上（b74 记录）。
         */
        window.removeEventListener('pointermove', onMove, true)
        window.removeEventListener('pointerrawupdate', onRawMove as EventListener, true)
        window.removeEventListener('pointerup', onUp, true)
        window.removeEventListener('pointercancel', onUp, true)
        window.removeEventListener('touchmove', onTouchMove, true)
        const s = touchSelectRef.current
        if (!s || s.sid !== session.sid) return
        if (ev.pointerId !== s.pointerId) {
          drawTrace(`触摸抬起：pointerId 不匹配（事件 ${ev.pointerId} / 会话 ${s.pointerId}）`)
          return
        }
        clearTimer()
        touchSelectRef.current = null
        /* 正常收尾：清掉自己登记的兜底函数，避免下次手势重复摘监听 */
        gestureCleanupRef.current = null

        /*
         * ★ 抬起这一刻也要记「刚刚摸过屏」。
         *
         *   Chromium 会在 touchend 之后 ~5ms 补发一套**兼容鼠标事件**
         *   （pointerdown/mousedown → selectstart → contextmenu → mouseup）；
         *   它们走鼠标路径：选择工具下命中文字 → beginSelectDrag →
         *   anchorFromHost(整行 span) 把锚点改成「整行的中点」，
         *   浮动条就会在松手后**先偏半条宽、再跳正**（真机上表现为
         *   「刚长按出来的工具条，手指还没到它就挪走了」→ 点空）。
         *
         *   以前只在 pointerdown 里记时间，按住超过 800ms 的长按正好让
         *   窗口过期，于是长按 100% 被兼容鼠标事件二次改写。
         *   抬起时刷新时间戳，之后所有 `lastTouchAtRef` 守卫（兼容鼠标
         *   按下 800ms、contextmenu 2500ms、双击 800ms）都能覆盖到。
         */
        lastTouchAtRef.current = Date.now()

        /*
         * 被系统打断（手势仲裁、手掌误触被拒）时别做任何决定：
         * 既不要「轻点取消选区」，也不要把这半次触摸算进连点窗口 ——
         * 否则下一次真正想选字的双击会被当成「第二击」。
         */
        if (ev.type === 'pointercancel') {
          touchArmedRef.current = false
          return
        }

        if (s.mode === 'pending') {
          const at = Date.now()
          /*
           * 按了够久才松手 → 也当长按选词。
           * 真机上手指按下 ~300ms 就抬起来是常态，只认 400ms 计时器会「一次都选不中」。
           */
          if (at - s.startAt >= TOUCH_TAP_HOLD_MS) {
            beginWordSelect(ev.clientX, ev.clientY)
            /* 用选区是否真的选出内容判断成功，而不是读 s.mode：
               TS 在 `if (s.mode === 'pending')` 分支里已经把 s.mode 收窄，
               读它做比较会被判成「不可能成立」。 */
            if ((window.getSelection()?.toString() ?? '') !== '') {
              touchArmedRef.current = false
              return
            }
          }
          const last = lastTouchTapRef.current
          const isDouble =
            at - last.at <= TOUCH_DOUBLE_MS &&
            Math.hypot(ev.clientX - last.x, ev.clientY - last.y) <= TOUCH_DOUBLE_SLOP
          if (isDouble) {
            lastTouchTapRef.current = { at: 0, x: 0, y: 0 }
            beginWordSelect(ev.clientX, ev.clientY)
            touchArmedRef.current = false
            drawTrace('选择（触摸）：双击 → 选中该词')
            return
          }
          lastTouchTapRef.current = { at, x: ev.clientX, y: ev.clientY }
          /* 单次轻点：取消选区（与桌面端「点空白处取消」一致） */
          window.getSelection()?.removeAllRanges()
          setAnchor(null)
          touchArmedRef.current = false
          drawTrace('选择（触摸）：轻点 → 取消选区')
          return
        }

        touchArmedRef.current = false
        if (s.mode === 'selecting') anchorFromSelection()
        /* 松手后 900ms 内不许「自动跳页」把刚拖到的位置拽回去（同 panSettledAtRef） */
        if (s.mode === 'panning') {
          panSettledAtRef.current = Date.now()
          const el = scrollRef.current
          /*
           * ★ 松开前补算一次速度。
           *
           *   事件被浏览器合并时（隐藏窗口/渲染层忙、或设备高刷），整段拖动
           *   可能只送来 1~2 个 pointermove，采样间隔全部 < 8ms，`s.vTop`
           *   一直是 0 —— 用户看到「拖得很快，松手却立刻停住」，没有惯性。
           *   这里用「最后一次采样以来的总位移 / 经过时间」兜底；
           *   dt 封顶 60ms：抬起事件本身可能晚到（CDP/触摸仲裁），
           *   但不能因为晚到就把刚才那一下的速度抹平成 0。
           */
          if (el) {
            const now = Date.now()
            const dt = Math.min(Math.max(now - s.lastAt, 2), 60)
            const v = (el.scrollTop - s.lastTop) / dt
            if (Math.abs(v) > Math.abs(s.vTop)) s.vTop = v * 0.9
          }
          if (el) startTouchMomentum(el, s.vTop)
        }
      }

      session.timer = window.setTimeout(() => {
        const s = touchSelectRef.current
        if (!s || s.sid !== session.sid || s.mode !== 'pending') return
        beginWordSelect(s.startX, s.startY)
      }, TOUCH_LONGPRESS_MS)

      window.addEventListener('pointermove', onMove, true)
      window.addEventListener('pointerrawupdate', onRawMove as EventListener, true)
      window.addEventListener('pointerup', onUp, true)
      window.addEventListener('pointercancel', onUp, true)
      window.addEventListener('touchmove', onTouchMove, { capture: true, passive: true })
      /* 抬起事件可能永远送不到（合成手势/指针被抢）：下次手势开始时兜底清掉 */
      gestureCleanupRef.current = (): void => {
        clearTimer()
        window.removeEventListener('pointermove', onMove, true)
        window.removeEventListener('pointerrawupdate', onRawMove as EventListener, true)
        window.removeEventListener('pointerup', onUp, true)
        window.removeEventListener('pointercancel', onUp, true)
        window.removeEventListener('touchmove', onTouchMove, true)
      }
    },
    [anchorFromSelection, glyphAt, selectWordAt, setAnchor]
  )

  /**
   * 触摸会话期间挡掉 Chromium 自己的「长按选字」。
   *
   * ★ 真机现象：手指按住 ~500ms，Chromium 原生选中它自己判定的词/段落，
   *   把我们 400ms 时选好的词覆盖掉 —— 用户看到的是「选错范围」。
   *   `touch-action: none` 只挡滚动，挡不住原生长按选字；
   *   `selectstart` 是浏览器**开始用户选区**时派发的，preventDefault 即可拦下。
   *   注意：脚本自己 setBaseAndExtent / addRange 不走 selectstart，不会被误挡。
   */
  useEffect(() => {
    const onSelectStart = (ev: Event): void => {
      /*
       * touchArmed 只在「按下 → 抬起」之间为真；抬起后紧接着到来的兼容
       * selectstart（Chromium 在 touchend 后补发 mousedown → selectstart）
       * 会绕过它，把 400ms 时选好的词扩成整行。
       * 所以时间窗口也要算上：刚摸过屏 1.2s 内一律不允许开启原生选区。
       */
      if (touchArmedRef.current || Date.now() - lastTouchAtRef.current < 1200) ev.preventDefault()
    }
    /*
     * ★ 兼容鼠标 mousedown 也要挡（光挡 selectstart 不够）。
     *
     *   mousedown 的默认动作之一是「在落点处塌陷选区」——
     *   它不派发 selectstart，所以上面的拦截看不到它；
     *   结果就是长按选好的词在松手后立刻变空（真机表现为「闪一下没选上」）。
     *   这里只针对**刚摸过屏**且落点在阅读区里的 mousedown，
     *   浮动工具条 / 编辑面板 / 顶部工具栏 / 输入框里的按下照常放行，
     *   否则「点改文字、点替换」这些按钮会被一起挡掉。
     */
    const onMouseDown = (ev: MouseEvent): void => {
      if (Date.now() - lastTouchAtRef.current >= 1200) return
      const target = ev.target instanceof HTMLElement ? ev.target : null
      if (target?.closest('.edit-selbar, .edit-bar, .edit-menu, .app__toolbar, input, textarea, select, button')) return
      ev.preventDefault()
    }
    document.addEventListener('selectstart', onSelectStart, true)
    document.addEventListener('mousedown', onMouseDown, true)
    return () => {
      document.removeEventListener('selectstart', onSelectStart, true)
      document.removeEventListener('mousedown', onMouseDown, true)
    }
  }, [])

  /**

  /**
   * 把屏幕坐标换算成 scale = 1 的页面坐标。
   *
   * ── 这里踩过两次坑，最终方案是「与底图同源」────────────────
   *
   * 【第一次】用 pageSize.scale（React state）做除数。
   *   缩放时页面 DOM 尺寸立即变、state 要等重渲染才更新，
   *   中间几帧不一致 → 落笔偏移。
   *
   * 【第二次】改成从 .pdf-page 的 rect 反推 scale。
   *   仍然不准，而且**与等待时间无关**（用户反馈「缩放后过一会儿画也不准」）。
   *   根因：渲染底图用的 scale 是
   *     height / base.height（用传入的 CSS 尺寸算）
   *   而这里反推出的 liveScale 走的是
   *     rect.width / (pageSize.width / pageSize.scale)
   *   两者**来源不同**。只要 pageSize 与实际渲染尺寸有任何偏差，
   *   换算就整体偏移 —— 不是时序问题，永远修不好。
   *
   * 【现在】基准直接取**底图 canvas 的实测尺寸**：
   *   底图是用户看到的东西，墨迹必须与它像素级重合，
   *   所以用它的 rect 做唯一基准，物理上不可能不一致。
   */
  const toPagePoint = (
    clientX: number,
    clientY: number,
    pageEl: HTMLElement
  ): { x: number; y: number } | null => {
    /*
     * 以底图 canvas 为基准。
     * 取不到时退回页面盒子（例如底图尚未挂载的极端时序）。
     */
    const canvasEl = pageEl.querySelector<HTMLCanvasElement>('.pdf-page__canvas')
    const refEl: HTMLElement = canvasEl ?? pageEl
    const rect = refEl.getBoundingClientRect()
    if (rect.width <= 0) return null

    /*
     * baseWidth 是 PDF 在 scale = 1 时的宽度。
     * 从 pageSize 反推而不是再查一次 pdf.js ——
     * 这里只用它把「屏幕像素」换算成「PDF 单位」，
     * 比值与渲染时的 scale 严格对应：
     *   屏幕宽度 / baseWidth = 实际渲染 scale
     */
    const baseWidth = pageSize.scale > 0 ? pageSize.width / pageSize.scale : 0
    if (baseWidth <= 0) return null

    const liveScale = rect.width / baseWidth
    if (!Number.isFinite(liveScale) || liveScale <= 0) return null

    return {
      x: (clientX - rect.left) / liveScale,
      y: (clientY - rect.top) / liveScale
    }
  }

  /** 指针位置 → 页面坐标系（scale = 1） */
  const pointToPage = (
    e: React.PointerEvent<HTMLDivElement>
  ): { page: number; x: number; y: number } | null => {
    const target = e.target as HTMLElement
    const pageEl = target.closest<HTMLElement>('.pdf-page')
    if (!pageEl) return null
    const pageNum = Number(pageEl.dataset.page)
    if (!Number.isFinite(pageNum)) return null

    const p = toPagePoint(e.clientX, e.clientY, pageEl)
    if (!p) return null
    return { page: pageNum, x: p.x, y: p.y }
  }

  /* ============================================================
   * 覆盖式内容编辑（选择 / 文字 / 图片 / 涂白 / 矩形 / 椭圆）
   *
   * ★ 为什么整套交互状态集中在一个 hook 里而不是每页一份：
   *   选中项、拖拽会话、待放置的图片、正在输入的文本框都是**跨页唯一**的，
   *   每页各持一份会出现「第 1 页的选中框还亮着，人在第 3 页拖动」这种情况。
   * ============================================================ */

  /** 当前内容编辑工具；'none' 表示没进编辑态，页面行为与改造前完全一致 */
  const editTool = useViewer((s) => s.editTool)
  editToolRef.current = editTool

  /**
   * 挂在根节点上的编辑态 class。
   *
   * ★ 为什么用 class 而不是给每个元素写内联样式：
   *   文字层的 user-select 开关、各工具的十字/文本光标、
   *   触摸拖动是否交给绘制 —— 全是 CSS 最擅长的事（见 styles/edit.css）。
   *   editTool === 'none' 时这里是空串，一条编辑样式都不会生效。
   */
  const editClass =
    editTool === 'none'
      ? ''
      : `is-edit-tool is-edit-${editTool} ${editTool === 'select' ? 'is-edit-select' : 'is-edit-content'}`

  const contentEdit = useContentEdit({
    doc,
    scale: pageSize.scale,
    pageWidth: pageSize.width,
    pageHeight: pageSize.height,
    /*
     * ★ 复用上面那个 toPagePoint，不另起一套换算。
     *   它是按「墨迹必须与底图像素重合」写出来的（以底图 canvas 的
     *   实测尺寸为基准）；编辑层若自己算，缩放过程中拖框就会与手指错开。
     */
    toPagePoint,
    anchor,
    /* 开始编辑动作时收掉「选中文字」浮动条，否则它浮在文本框上面点不着 */
    dismissSelection: () => setAnchor(null)
  })

  /**
   * 漫游态：按住左键拖动 = 平移页面。
   *
   * ★ 移动/抬起同样挂 window 并按 pointerId 过滤（与绘画会话一致）：
   *   拖到窗口外面还要跟得住，否则松手后页面会「粘」在拖动状态。
   */
  const startRoamPan = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (drawMode || eraserMode) return
    if (e.button !== 0) return

    /*
     * ★ 触摸屏：选择工具下自己接管（长按选词 / 双击选词 / 拖动平移），
     *   其它工具仍然交给原生滚动（touch-action: pan-x pan-y + 惯性）。
     *
     *   为什么选择工具必须自己接管：见 startTouchSelect 的注释。
     *
     * ★ 笔（pointerType === 'pen'）也走这条：一部分一体机的**手指会报成 pen**
     *   （我们拿不到 touch 事件，只能按 pen 处理），同一块屏上笔和手指没区别。
     *   判据是 navigator.maxTouchPoints > 0 —— 有触摸能力才这么干，
     *   纯数位板/桌面鼠标的笔仍然走原生选字。
     */
    const touchLike =
      e.pointerType === 'touch' || (e.pointerType === 'pen' && navigator.maxTouchPoints > 0)
    if (touchLike) {
      drawTrace(`触摸按下：pointerType=${e.pointerType} editTool=${editTool} 滚动容器=${Boolean(scrollRef.current)}`)
      if (editTool === 'select') startTouchSelect(e)
      return
    }

    /*
     * ★ 「选择」工具下**不接管**选字，整件事交给浏览器原生选字。
     *
     *   用户报「选一串文字有时候选不中」就是这里：以前只要按下就接管，
     *   而接管后立刻在捕获阶段给 pointermove 挂上 preventDefault
     *   （见下面的 onMove），等于把浏览器的选字手势掐掉了。
     *
     *   实测证据（隐藏实例）：文字层的 user-select 已是 text、
     *   脚本用 Range 建选区能拿到 82 个字符，但 CDP 真鼠标拖拽
     *   一个字符都选不出来 —— 说明不是 CSS 的问题，是事件被吃了。
     *
     *   现在的分工：
     *     · 选择工具 + 起点在字上 → 原生选字（另有兜底选字）
     *     · 选择工具 + 起点在空白处 → 拖动平移（否则「整页都是文字时
     *       页面纹丝不动」，用户会以为卡住了）
     *     · 漫游工具 → 一律平移（用户明确要求「漫游只滑动、不碰文本」）
     */
    if (editTool === 'select') {
      /*
       * ★ 判据只看「落点是否真的压着字符 span」，不再看 glyphAt 的结果。
       *
       *   glyphAt 现在带「几何兜底」：页面内任何一点都能换算到最近的字符上
       *   （为了让跨行拖选在不规整的文字层里也能接上）。副作用是「点页面
       *   灰底 / 画布」也会返回一个字符 → 被当成起一次拖选，旧选区与浮条
       *   清不掉（实测：点灰底后仍残留 33 字、浮条不消失）。
       *
       *   所以这里改用真实命中测试：压着字符 span 才算字，否则一律当空白
       *   （清掉旧选区 + 浮条，然后按拖动平移处理）。
       */
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const onText = !!el?.closest('.textLayer span, .ocr-text-layer span')
      if (onText) {
        drawTrace('选择工具：起点在字上 → 原生选字 + 兜底选字')
        beginSelectDrag(e)
      } else {
        drawTrace('选择工具：起点不在字上 → 清选区并拖动平移')
        /*
         * 点空白 = 放弃这次选择：把旧选区与浮条一起收掉。
         * 不收的话，用户在别处点一下，上一次的浮条还挂在那里，
         * 看起来就像「选完没反应 / 选的是上一次的」。
         */
        window.getSelection()?.removeAllRanges()
        setAnchor(null)
        startPanSession(e)
      }
      return
    }

    const target = e.target as HTMLElement

    /*
     * ★ 漫游 = 只滑动页面，**不选字**（用户 2026-10-17 明确要求）。
     *
     *   这里原来有一句「起点落在文字字符上就让给浏览器选字」的特殊处理，
     *   理由是「整页都是文字时也要能选字」。但实际用起来很别扭：
     *   漫游是一体机上的主力操作，手指按在字上就开始拉蓝框、
     *   页面纹丝不动，用户以为卡住了。
     *
     *   现在按工具分工（选字走上面的「选择」工具分支）。
     */
    if (target.closest('.textLayer')) {
      drawTrace('漫游：起点在文字层上，仍按平移处理（选字请切到「选择」工具）')
    }
    startPanSession(e)
  }

  /**
   * 起一次「拖动平移」（漫游工具、以及选择工具按在空白处时）。
   *
   * ★ 移动/抬起挂在 window 上并按 pointerId 过滤（与绘画会话一致）：
   *   拖到窗口外面还要跟得住，否则松手后页面会「粘」在拖动状态。
   */
  const startPanSession = useCallback((e: { pointerId: number; clientX: number; clientY: number }): void => {
    const container = scrollRef.current
    if (!container) return

    gestureCleanupRef.current?.()
    gestureCleanupRef.current = null
    const pointerId = e.pointerId
    const sid = ++dragSeqRef.current
    panRef.current = {
      pointerId,
      startX: e.clientX,
      startY: e.clientY,
      left: container.scrollLeft,
      top: container.scrollTop,
      sid
    }
    setPanning(true)
    drawTrace(`开始拖动平移 pointerId=${pointerId} 会话=${sid}`)

    const teardown = (): void => {
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
    }

    const onMove = (ev: PointerEvent): void => {
      const session = panRef.current
      if (!session || session.sid !== sid || ev.pointerId !== session.pointerId) return
      /*
       * ★ 自愈：抬起事件丢了（合成手势、指针被系统抢走、窗口失焦）时，
       *   panRef 会一直留着旧会话，而这组监听也永远挂在 window 上 ——
       *   之后**每次鼠标移动**都按旧起点把页面拖走（实测症状）。
       *   判断依据：拖动中按键必然是按下的，buttons === 0 就说明手指/鼠标早抬了。
       */
      if (ev.buttons === 0) {
        panRef.current = null
        setPanning(false)
        teardown()
        if (gestureCleanupRef.current === teardown) gestureCleanupRef.current = null
        return
      }
      const el = scrollRef.current
      if (!el) return
      /* 反向：手往右拖，纸跟着往右走（scrollLeft 减小） */
      el.scrollLeft = session.left - (ev.clientX - session.startX)
      el.scrollTop = session.top - (ev.clientY - session.startY)
      /* 拖动期间不要触发文字选择（划过去会选中） */
      ev.preventDefault()
    }

    const onUp = (ev: PointerEvent): void => {
      /*
       * ★ 先无条件摘监听，再判断是不是自己的会话。
       *
       * 和「兜底选字」那边同一个坑（见 beginSelectDrag 的 sid 注释）：
       * 双击会在一秒内起两次平移会话，第二次把 panRef 覆盖成自己的；
       * 第一次的 pointerup 走到这里时 `panRef.current` 已经不是它 →
       * 旧写法直接 return，三个 window 监听就永久留在页面上。
       * 之后任何一次鼠标移动都会把页面拖走。
       */
      teardown()
      if (gestureCleanupRef.current === teardown) gestureCleanupRef.current = null
      const session = panRef.current
      if (!session || session.sid !== sid || ev.pointerId !== session.pointerId) return
      panRef.current = null
      setPanning(false)
      /* 松手后的 900ms 内不许「自动跳页」把位置拽回去（见 panSettledAtRef） */
      panSettledAtRef.current = Date.now()
    }

    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
    gestureCleanupRef.current = teardown
  }, [])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    /*
     * 诊断开关：window.__sbDebugDraw = true 时输出关键字段。
     *
     * 之所以把 drawMode / button / buttons 都打出来：
     * 排查「手绘点了没反应」时，需要区分是「事件没到」、
     * 「模式没开」还是「按键判断被挡」—— 只看一句 pointerdown 无法判断。
     */
    drawTrace(
      `pointerdown drawMode=${String(drawMode)} eraser=${String(eraserMode)} button=${e.button}` +
        ` buttons=${e.buttons} pointerType=${e.pointerType} 触点=${contactSize(e).toFixed(0)}px` +
        ` target=${(e.target as HTMLElement).className}`
    )
    if (drawDbg()) {
      console.log(
        `[draw] pointerdown drawMode=${String(drawMode)} button=${e.button} buttons=${e.buttons}` +
          ` pointerType=${e.pointerType} target=${(e.target as HTMLElement).className}`
      )
    }

    /*
     * ---------- 内容编辑工具优先接管 ----------
     *
     * ★ 必须放在掌心/橡皮/漫游判断**之前**：
     *   编辑工具激活时 drawMode 与 eraserMode 必为 false（store 里三个
     *   设置函数互相清空），因此不可能与下面的分支同时命中；
     *   放在最前面是为了让「点了页面却没反应」这种情况只可能来自编辑层。
     *
     * ★ handlePointerDown 返回 false = 这次按下不归编辑管：
     *   选择工具下在空白处或文字上按下要留给漫游平移与浏览器原生选字，
     *   否则拖选文字、拖动页面这两个现有行为就没了。
     */
    if (editTool !== 'none' && contentEdit.handlePointerDown(e)) return

    /*
     * ---------- 触摸之后的「兼容鼠标事件」一律忽略 ----------
     *
     * Chrome 在一体机/触摸仿真下，会在 touchend 之后再补发一套
     * pointerdown/mousedown（pointerType 记为 mouse）。那套事件会走
     * 鼠标路径：选择工具下命中文字 → beginSelectDrag（原生拖选）→
     * 与我们刚做的触摸选字互相覆盖，表现为「轻点/双击偶发没反应、
     * 选完又冒出一个旧选区」。所以触摸后 800ms 内的 mouse 按下直接丢弃。
     */
    /*
     * ★ 只 `return` 不够：必须在 pointerdown 上 preventDefault。
     *
     *   兼容鼠标事件的默认动作是「mousedown 落点处塌陷选区」——
     *   长按选好的词会在松手后立刻消失（selectionchange 变空），
     *   用户看到的是「长按没选上 / 闪一下就没」。
     *   取消 pointerdown 才会连带取消这套兼容鼠标事件（含 mousedown、
     *   selectstart 与随后的选区塌陷），点工具条不受影响：它在滚动区外。
     */
    if (e.pointerType === 'mouse' && Date.now() - lastTouchAtRef.current < 800) {
      e.preventDefault()
      return
    }

    /*
     * ---------- 掌心：大面积触点 = 大面积擦除 ----------
     *
     * 写字时手掌侧面搭在屏上是常态，用户明确要求把它按「擦掉一片」处理，
     * 而不是留下一道粗线；绘画模式与橡皮模式都要生效。
     * 判定只看触点尺寸（见 isPalmContact）—— 一体机上报的压力值普遍不可靠，
     * 用压力判掌心在真机上会时灵时不灵。
     */
    const contact = contactSize(e)
    rememberContact(e.pointerType, contact)
    if (isPalmContact(e)) {
      drawTrace(`掌心触点 size=${contact.toFixed(0)}px → 大面积擦除`)
      if (!drawMode && !eraserMode) {
        // 浏览模式下不擦：用户只是在翻页，手指压得大一点不该改文档
        drawTrace('掌心：当前不是绘画/擦除模式，忽略')
        return
      }
      startEraseSession(e, true)
      return
    }

    if (eraserMode) {
      if (e.button !== 0) return
      startEraseSession(e, false)
      return
    }

    if (!drawMode || e.button !== 0) {
      drawTrace(`提前返回① drawMode=${String(drawMode)} button=${e.button}`)
      if (drawDbg()) console.log('[draw] 提前返回（drawMode 未开 或 非左键）')
      /* 漫游态（既没在画也没在擦）：左键拖动平移页面 */
      startRoamPan(e)
      return
    }

    startDrawSession(e)
  }

  /**
   * 起一笔（一个指针一个会话）。
   *
   * ★ 移动与抬起事件挂在 window 上、并且**按 pointerId 过滤**。
   *
   *   挂 window 是上一轮排查「起笔了但一个移动点都收不到」时定下的：
   *   原先用组件的 onPointerMove + setPointerCapture，实测 pointerdown
   *   到达、pointermove 一次都没到、pointerup 只有 1 个点 ——
   *   指针捕获把后续移动定向到捕获元素，而合成/派发的移动事件未必
   *   命中该元素；且指针一旦划出元素边界，组件级监听就收不到事件。
   *
   *   按 pointerId 过滤则是多指绘画的关键：事件是全局的（划出页面、
   *   划出窗口都要跟得住），但每个会话只认自己那根手指。
   */
  const startDrawSession = (e: React.PointerEvent<HTMLDivElement>): void => {
    const pointerId = e.pointerId
    if (sessionsRef.current.has(pointerId)) return

    /*
     * 上限 4 指（用户指定）。超出就忽略新来的那根手指，
     * 已经在画的笔迹不受影响 —— 让第 5 根手指去搅乱别人的点更糟。
     */
    if (sessionsRef.current.size >= MAX_DRAW_POINTERS) {
      drawTrace(`忽略：并行笔迹已达上限 ${MAX_DRAW_POINTERS} 指`)
      return
    }

    const p = pointToPage(e)
    if (!p) {
      drawTrace('提前返回② pointToPage 返回 null')
      if (drawDbg()) console.log('[draw] pointToPage 返回 null（指针不在 .pdf-page 内？）')
      return
    }
    drawTrace(`pointToPage ok page=${p.page} x=${p.x.toFixed(1)} y=${p.y.toFixed(1)}`)

    const pageEl = (e.target as HTMLElement).closest<HTMLElement>('.pdf-page')
    if (!pageEl) return
    e.preventDefault()

    /*
     * 页面在 .viewer-pages 坐标系里的**实测偏移**，预览层靠它叠在页面上。
     *
     * 横向不能用「内边距」推算：容器是 flex 居中，页面比内容区窄时
     * 实际偏移会大于内边距（实测差 16px），用户看到的是「画完笔迹跳走」。
     * 纵向同样不能用 `(页码 − 1) × (页高 + 间距)` 的公式：连续滚动下
     * 恰好相等，一到双页模式就把第二页的预览多下移一整行。
     * offsetLeft/offsetTop 相对 offsetParent、与滚动无关，正是需要的值；
     * 起笔时记一次即可 —— 同一笔期间布局不变，每帧读 DOM 反而拖慢书写。
     */
    const session: DraftSession = {
      pointerId,
      page: p.page,
      /*
       * 颜色与粗细在**起笔时快照**：多指同时书写时，
       * 中途改色/改粗细不该影响已经在写的那一笔。
       */
      color: drawColor,
      width: drawWidth,
      // 压力取真实值（触屏笔有），没有就给 0，渲染时按速度补笔锋
      points: [{ x: p.x, y: p.y, t: e.timeStamp, p: e.pressure > 0 ? e.pressure : 0 }],
      offsetX: Number.isFinite(pageEl.offsetLeft) ? pageEl.offsetLeft : DRAW_GAP,
      offsetY: Number.isFinite(pageEl.offsetTop) ? pageEl.offsetTop : DRAW_GAP,
      handle: null
    }
    sessionsRef.current.set(pointerId, session)
    syncDrafts()

    drawTrace(`起笔 pointerId=${pointerId} page=${p.page} 并行=${sessionsRef.current.size}`)
    if (drawDbg()) {
      console.log(
        `[draw] 起笔 pointerId=${pointerId} page=${p.page}` +
          ` 页坐标=(${p.x.toFixed(1)}, ${p.y.toFixed(1)})` +
          ` drawWidth=${session.width} drawColor=${session.color}`
      )
      /*
       * 把关键中间态挂到 window 上，供自动化测试直接读取。
       *
       * 为什么需要这么做：派发合成指针事件后，控制台日志只能证明
       * 「处理函数进来了」，无法证明「点有没有真的进数组」。
       * 而点数组是闭包里的局部状态，外部拿不到。
       * 这里在诊断模式下把它暴露出来，测试就能一步判断
       * 是「点没进数组」还是「进了但结算被跳过」；
       * __sbDraftSessions 还能数出「同时有几笔在画」。
       */
      const w = window as unknown as {
        __sbLivePoints?: StrokePoint[]
        __sbDraftSessions?: Map<number, DraftSession>
      }
      w.__sbLivePoints = session.points
      w.__sbDraftSessions = sessionsRef.current
    }

    const onMove = (ev: PointerEvent): void => {
      /*
       * ★ 只管自己那根指针。
       *   多指同时书写时，其他手指的移动事件同样会流到这里；
       *   少了这一行，两指的坐标就会被混进同一条笔迹 ——
       *   正是用户看到的那条横跨两指的折线。
       */
      if (ev.pointerId !== pointerId) return

      /*
       * 所属页面元素在书写途中被卸载（切视图模式、页面被回收）时，
       * 按页码重新找一次；找不到就收笔 —— 宁可少画几个点，
       * 也不能把点算到别的页面上。
       */
      const el = pageEl.isConnected
        ? pageEl
        : document.querySelector<HTMLElement>(`.pdf-page[data-page="${session.page}"]`)
      if (!el) {
        detach()
        endDrawSession(pointerId)
        return
      }

      /*
       * 与起笔用同一套换算（从 DOM 实测缩放），保证整条笔迹一致。
       * 这里若还用 pageSize.scale，缩放过程中笔画会与手指位置错开。
       */
      const q = toPagePoint(ev.clientX, ev.clientY, el)
      if (!q) return
      const x = q.x
      const y = q.y

      const points = session.points
      /*
       * 采样抽稀：相邻点距离小于 0.8px 不记。
       *
       * 阈值从 1.5 降到 0.8 的原因：
       *   抽稀太狠会让平滑算法缺少控制点，快速划动时曲线变成大弧，
       *   看起来"糊"。0.8 在 125Hz 采样下既省存储又保留足够细节。
       */
      const last = points[points.length - 1]
      if (last && Math.hypot(x - last.x, y - last.y) < 0.8) return

      /*
       * 用 getCoalescedEvents 取出两次事件之间被浏览器合并掉的中间点。
       * 高频书写（尤其是触屏笔）时浏览器会把多个移动事件合并成一个，
       * 只用最后一个点会丢掉细节、笔画发"愣"。
       */
      const events =
        typeof ev.getCoalescedEvents === 'function' ? ev.getCoalescedEvents() : []
      const added: StrokePoint[] = []
      if (events.length > 1) {
        for (const ce of events) {
          // 同样走 toPagePoint，不用已过期的 pageSize.scale
          const cp = toPagePoint(ce.clientX, ce.clientY, el)
          if (!cp) continue
          const prev = added[added.length - 1] ?? last
          if (prev && Math.hypot(cp.x - prev.x, cp.y - prev.y) < 0.5) continue
          added.push({
            x: cp.x,
            y: cp.y,
            t: ce.timeStamp,
            p: ce.pressure > 0 ? ce.pressure : 0
          })
        }
      }
      if (added.length === 0) {
        added.push({ x, y, t: ev.timeStamp, p: ev.pressure > 0 ? ev.pressure : 0 })
      }

      /*
       * ★ 关键：只改这一笔自己的点数组 + 命令式绘制，**不调用 setState**。
       *   这里如果写 setDrafts，就会退回「每点一次全量重渲染」的老问题。
       */
      points.push(...added)
      session.handle?.drawMore(added)
    }

    const detach = (): void => {
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
    }

    const onUp = (ev: PointerEvent): void => {
      // ★ 同样只认自己那根指针：别的指头抬起来不能结算这一笔
      if (ev.pointerId !== pointerId) return
      detach()
      endDrawSession(pointerId)
    }

    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
  }

  /** 收一笔：清预览 → 结算成批注。只结算指定指针，别的笔不受影响 */
  const endDrawSession = (pointerId: number): void => {
    const session = sessionsRef.current.get(pointerId)
    if (!session) return
    sessionsRef.current.delete(pointerId)

    /*
     * 先清预览、再结算，顺序很重要：
     * 预览层要立刻消失，否则成品画上去后会与预览重叠，
     * 看起来像「同一笔被画了两遍、颜色更深」。
     */
    session.handle?.clear()
    syncDrafts()

    drawTrace(`收笔 pointerId=${pointerId} 累计点数=${session.points.length}`)
    if (drawDbg()) {
      console.log(`[draw] 收笔 pointerId=${pointerId} 累计点数=${session.points.length}`)
    }
    commitStroke(session)
  }

  /**
   * 把一条会话结算成一条批注（笔迹点编码后存进 quote）。
   *
   * ★ 点、页码、颜色、粗细**全部从 session 里取**，不读组件状态：
   *   多指几乎同时抬手时会连续调用多次，读全局状态就会串味 ——
   *   第二条笔迹可能用上第一条的点、或被先清空的那次结算清掉。
   */
  const commitStroke = (session: DraftSession): void => {
    const points = session.points
    if (drawDbg()) {
      console.log(`[draw] commitStroke pointerId=${session.pointerId} 点数=${points.length}`)
    }

    if (points.length < 2) {
      if (drawDbg()) {
        console.log(`[draw] 结算放弃：点数 ${points.length} < 2`)
      }
      return
    }

    const xs = points.map((p) => p.x)
    const ys = points.map((p) => p.y)
    const minX = Math.min(...xs)
    const minY = Math.min(...ys)
    const bbox = {
      x: minX,
      y: minY,
      width: Math.max(1, Math.max(...xs) - minX),
      height: Math.max(1, Math.max(...ys) - minY)
    }

    onCreateAnnotation({
      page: session.page,
      type: 'note',
      rects: [bbox],
      color: session.color,
      // 用引擎的编码器：带版本号与四元组压缩，比裸 JSON 小一半左右
      quote: encodeStroke(points, session.width),
      note: ''
    })
  }

  /**
   * 起一次擦除（一个指针一个会话）。
   *
   * 多指同时擦：每个会话有自己的页码、半径与抽稀基准，移动事件按
   * pointerId 过滤；掌心走同一条路径，只是半径按触点尺寸放大。
   *
   * 半径为什么要换算：eraserSize 是**屏幕**像素（用户按手指感受调的），
   * 而笔迹点存的是**页面**坐标，缩放后两者比例不同 ——
   * 不换算的话放大后会「看着擦一个小点，实际删掉一大片」。
   */
  const startEraseSession = (
    e: React.PointerEvent<HTMLDivElement>,
    palm: boolean
  ): void => {
    const pointerId = e.pointerId
    if (eraseSessionsRef.current.has(pointerId)) return

    const pageEl = (e.target as HTMLElement).closest<HTMLElement>('.pdf-page')
    if (!pageEl) return

    /* 与画笔用**同一套坐标换算**（toPagePoint 从 DOM 实测缩放） */
    const p = toPagePoint(e.clientX, e.clientY, pageEl)
    if (!p) return

    e.preventDefault()
    e.stopPropagation()

    /* liveScale 的算法与 toPagePoint 内部完全一致，保证两者同源 */
    const baseWidth = pageSize.scale > 0 ? pageSize.width / pageSize.scale : 0
    const rect = pageEl.getBoundingClientRect()
    const liveScale = baseWidth > 0 && rect.width > 0 ? rect.width / baseWidth : 1

    /*
     * 掌心半径按触点尺寸放大，并夹在 eraserSize（下限）与
     * PALM_MAX_RADIUS（上限）之间：
     *   手掌盖住的面积本来就大，用一个手指粗细的橡皮去擦，
     *   用户要来回抹好几次，体验是「擦不动」；
     *   但也不能无限大，否则一按下去半页笔迹全没了、没法补救。
     */
    const contact = contactSize(e)
    const screenRadius = palm
      ? Math.min(PALM_MAX_RADIUS, Math.max(eraserSize, contact * PALM_RADIUS_RATIO))
      : eraserSize
    const radiusPage = liveScale > 0 ? screenRadius / liveScale : screenRadius

    const session: EraseSession = {
      pointerId,
      palm,
      page: Number(pageEl.dataset.page) || 1,
      radius: radiusPage,
      lastX: p.x,
      lastY: p.y,
      /*
       * 抽稀间距取半径的一半：相邻两个擦除圆必然重叠，
       * 既不会漏擦，也不会因为过密而反复计算同一批笔迹。
       */
      step: Math.max(1, radiusPage * 0.5)
    }
    eraseSessionsRef.current.set(pointerId, session)
    drawTrace(
      `起擦 pointerId=${pointerId} page=${session.page} 掌心=${String(palm)}` +
        ` 屏幕半径=${screenRadius.toFixed(0)}px 并行=${eraseSessionsRef.current.size}`
    )
    void onEraseAt(session.page, p.x, p.y, radiusPage)

    const onEraseMove = (ev: PointerEvent): void => {
      // ★ 只管自己那根指针：多指同时擦时别人的事件会从这里流过
      if (ev.pointerId !== pointerId) return
      // 只在按住左键时擦；松开后即便还有移动事件也不该继续擦
      if (ev.buttons === 0) return

      /*
       * 按**间距抽稀**而不是按时间节流：
       * 手指移动快时相邻事件间隔大，按时间节流会漏掉中间一段，
       * 留下没擦干净的「虚线」。按已擦过的距离判断才能保证连续。
       */
      const q = toPagePoint(ev.clientX, ev.clientY, pageEl)
      if (!q) return
      const d = Math.hypot(q.x - session.lastX, q.y - session.lastY)
      if (d < session.step) return
      session.lastX = q.x
      session.lastY = q.y
      void onEraseAt(session.page, q.x, q.y, session.radius)
    }

    const detach = (): void => {
      eraseSessionsRef.current.delete(pointerId)
      window.removeEventListener('pointermove', onEraseMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
    }

    const onUp = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return
      detach()
    }

    window.addEventListener('pointermove', onEraseMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
  }

  /**
   * 落定尺寸：位图该按多大渲染。
   *
   * 从 pageSize 按 zoom 与 settledZoom 的比值缩放出来，
   * 不重新调 pdf.js —— 两者本来就只差一个倍率。
   *
   * 为什么需要它而不是直接用 pageSize：
   *   panning/缩放过程中 pageSize 每帧都变，而位图重渲染要等手势停下。
   *   两者分开之后，拖动滑块期间渲染 effect 一次都不跑。
   */
  const settledPageSize = (() => {
    const live = typeof zoom === 'number' ? zoom : pageSize.scale
    const settled = typeof settledZoom === 'number' ? settledZoom : pageSize.scale
    /*
     * 用原始尺寸 × 落定倍率现算，不拿 pageSize 乘比值。
     *
     * pageSize 的新旧取决于那次异步 getPage 何时回来，缩放连续变化时会落后一档；
     * 此时 pageSize.width × (settled/live) 会算出一个**既不等于落定尺寸、
     * 也不等于版面尺寸**的中间值（实测 595×(1.1/1.2)=545），
     * 于是手势期间白跑一次整页重渲染，还会把画布换成那个尺寸。
     * 原始尺寸 baseSize 与 zoom 无关，只随文档/旋转变，现算才稳定。
     */
    if (!(baseSize.width > 0) || !(baseSize.height > 0) || !(live > 0) || !(settled > 0)) {
      return { width: pageSize.width, height: pageSize.height }
    }
    return { width: baseSize.width * settled, height: baseSize.height * settled }
  })()

  const pages = singlePage ? [page] : Array.from({ length: pageCount }, (_, i) => i + 1)

  /**
   * 把页码切成「一行」的数组，供版面渲染。
   *
   * 为什么要分行而不是给每个 .pdf-page 加样式：
   *   双页模式下同一行的两页必须**并排且等高**，靠 flex 行容器最省事；
   *   同时 PdfPage 仍是 .viewer-pages 的子孙，它实测的 offsetLeft/offsetTop
   *   依旧相对 viewport-pages，手绘预览与外接偏移的换算逻辑全都不用改。
   *
   * 双栏配对的取舍（用户 2026-10-19 指定）：
   *   一律「1-2、3-4、5-6…」从第一页就并排，不做「封面单排」。
   *   奇数页时最后一页单独占一行（仍然靠左，和正文同一条基线）。
   *   早期版本跟 Adobe / SumatraPDF 学「封面单独一页」，一体机上第一页
   *   永远只有半屏宽，用户反馈「其他页双栏、第一页单栏」看着像坏了，故改掉。
   */
  const pageRows: number[][] = (() => {
    if (viewMode !== 'facing' && viewMode !== 'facing-continuous') {
      return pages.map((n) => [n])
    }
    const rows: number[][] = []
    for (let i = 0; i < pages.length; i += 2) rows.push(pages.slice(i, i + 2))
    return rows
  })()

  /**
   * 真正挂到 DOM 上的行。
   *
   * 「单页」和「双页并排」是**不分页滚动**的：只留当前所在的那一行，
   * 其余行整行不挂载。这样做而不是用 CSS 隐藏的理由是渲染成本 ——
   * 隐藏的行仍然会被 IntersectionObserver 之外的 NEAR_PAGE_RADIUS
   * 规则激活（前后各 2 页永远渲染），单页模式下等于白画 4 页。
   *
   * 「连续」与「双页连续」才把所有行铺开，靠滚动浏览。
   */
  const rowsToRender: number[][] = (() => {
    if (viewMode === 'single') return [[page]]
    if (viewMode !== 'facing') return pageRows
    const rowIndex = pageRows.findIndex((row) => row.includes(page))
    return rowIndex >= 0 ? [pageRows[rowIndex]] : pageRows.slice(0, 1)
  })()
  /*
   * ★ 当前页前后各 2 页永远渲染，不看观察器的结论。
   *
   *   踩坑记录（「快翻黑页」的最后一层）：
   *   哪些页该渲染原本完全由 IntersectionObserver 决定。
   *   但观察器只报告**交集状态的变化**，一旦布局几何在它算出结果之前
   *   变过（页面高度从默认 150px 变成真实高度），它给出的可见集合
   *   就可能永久停在错误答案上：页 4~8 的渲染 effect 从头到尾
   *   一次都没跑过（diag-stages 显示 data-stage 为「未设置」），
   *   画布永远是黑的，而且**不会自愈** —— 因为没有任何东西会再触发它。
   *
   *   用户翻页时真正在意的是「我所在的页和左右邻居得有内容」，
   *   这件事用页码就能判断，不需要测量几何。
   *   观察器继续负责更远的预渲染，但即使它失灵，
   *   核心体验也不再依赖它。
   */
  const NEAR_PAGE_RADIUS = 2
  /*
   * ---------- 触屏手势 ----------
   *
   * 双指捏合缩放 + 双击切换缩放。
   *
   * ★ 绘画模式与橡皮模式都要禁用手势：
   *   绘画模式下手指是用来画线的（多指并写时每根手指各画一笔）；
   *   橡皮模式下手指是用来擦的（用户要求「多指同时擦」）——
   *   两种模式下手指数都应该是「输入工具」，不能被识别成缩放/双击。
   *   代价是这两种模式下不能用双指捏合缩放，退出对应模式即可恢复。
   */
  const setZoom = useViewer((s) => s.setZoom)
  /** 手势或滚轮缩放时记下的锚点，缩放后由 layout effect 消费 */
  const pendingAnchorRef = useRef<{ x: number; y: number; fromScale: number } | null>(null)

  useTouchGestures(scrollRef as React.RefObject<HTMLElement>, {
    getScale: () => pageSize.scale,
    /*
     * ★ 内容编辑工具激活时也要禁用双击/捏合手势：
     *   白板/涂白/矩形都是「点一下再拖」，单指双击会被手势识别器抢走，
     *   用户会看到正在画的框突然把页面缩放到 200%。
     *   选择工具不禁用 —— 那时仍要能捏合缩放、双击切换适应宽度。
     */
    disabled: () => drawMode || eraserMode || contentEdit.suppressGestures,
    /*
     * ★ 「选择」工具下双击交给触摸选字（选中该词，见 startTouchSelect），
     *   这里不再顺带把页面缩放到 200%（以前选字时会突然放大）。
     *   捏合缩放仍然保留 —— 选择工具下也要能放大看细节。
     */
    allowDoubleTap: () => editToolRef.current !== 'select',
    onZoom: (scale, anchorClient) => {
      const container = scrollRef.current
      if (!container) return
      // 把屏幕坐标转成相对滚动容器左上角的坐标
      const rect = container.getBoundingClientRect()
      pendingAnchorRef.current = {
        x: anchorClient.x - rect.left,
        y: anchorClient.y - rect.top,
        fromScale: pageSize.scale
      }
      setZoom(Number(scale.toFixed(4)))
    }
  })

  /**
   * 缩放后修正滚动位置，让锚点内容停在原处。
   *
   * 必须放在 layout effect 里：
   *   缩放会改变页面尺寸，DOM 更新完才能算出正确的偏移，
   *   用普通 effect 会看到一闪而过的跳动。
   */
  useLayoutEffect(() => {
    const pending = pendingAnchorRef.current
    if (!pending) return
    const container = scrollRef.current
    if (!container) return
    // 倍数还没真正变化（尺寸尚未应用）就等下一轮
    if (Math.abs(pageSize.scale - pending.fromScale) < 0.0001) return

    pendingAnchorRef.current = null

    const pageEl = container.querySelector<HTMLElement>(`.pdf-page[data-page="${page}"]`)
    const offset = pageContentOffset(pageEl)
    const next = anchoredScroll({
      scroll: { left: container.scrollLeft, top: container.scrollTop },
      anchor: { x: pending.x, y: pending.y },
      contentOffset: offset,
      fromScale: pending.fromScale,
      toScale: pageSize.scale
    })

    container.scrollLeft = Math.max(0, next.left)
    container.scrollTop = Math.max(0, next.top)
  }, [pageSize.scale, page])

  /**
   * 非手势缩放后的位置修正：按「视口顶部落在本页的比例」把画布放回去。
   *
   * 与上面那条 pendingAnchorRef 分支的分工：
   *   · 那条是手指捏合 / 双击，锚的是屏幕上的**某一点**；
   *   · 这条是工具条档位、适应宽度、标签切回等外部缩放，锚的是**读到哪一行**。
   *
   * 必须放在 useLayoutEffect 里：缩放改了页面尺寸，DOM 更新完才量得到新偏移，
   * 用普通 effect 会先看到一帧错位再跳回来。
   */
  useLayoutEffect(() => {
    const prev = prevScaleRef.current
    prevScaleRef.current = pageSize.scale
    if (!(prev > 0) || !(pageSize.scale > 0)) return
    if (Math.abs(pageSize.scale - prev) < 0.0001) return
    // 手势缩放已经由上面那条 effect 修正过锚点，这里别再抢一次
    if (pendingAnchorRef.current) return

    const container = scrollRef.current
    const el = pageRefs.current.get(page)
    if (!container || !el) return

    const rootRect = container.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    const pageTop = elRect.top - rootRect.top + container.scrollTop

    // 快照不是「同一份文档、同一页、同一档」就不用比例（例如刚切标签/刚打开）
    // 那说明阅读位置本来就换了页，直接对齐页顶更符合预期。
    const snap = scaleAnchorRef.current
    const usable =
      snap !== null &&
      snap.doc === doc &&
      snap.page === page &&
      snap.pageHeight > 0 &&
      Math.abs(snap.scale - prev) < 0.0001

    const nextTop = usable
      ? pageTop + ((snap.scrollTop - snap.pageTop) / snap.pageHeight) * elRect.height
      : pageTop - 16

    syncingRef.current = true
    container.scrollTop = Math.max(0, nextTop)
    // 与「页码变化 → 滚动到该页」保持一致：落位后短暂停掉页码观察，免得来回改
    const timer = window.setTimeout(() => {
      syncingRef.current = false
    }, 160)
    return () => window.clearTimeout(timer)
  }, [doc, page, pageSize.scale])

  /**
   * 橡皮光标元素。
   *
   * 直接改 style.transform 而不走 React state：
   * 指针移动是每帧几十次的高频事件，用 state 会引发大量重渲染，
   * 显著影响擦除的跟手程度。
   */
  const eraserCursorRef = useRef<HTMLDivElement>(null)

  /*
   * 橡皮模式下让圆圈跟随指针。
   *
   * 监听 window 的捕获阶段：指针可以移出页面甚至移出窗口，
   * 挂在滚动容器上会丢事件，圆圈就会卡在边缘不动。
   */
  useEffect(() => {
    if (!eraserMode) return

    const onMove = (e: PointerEvent): void => {
      const el = eraserCursorRef.current
      if (!el) return
      el.style.transform = `translate3d(${e.clientX}px, ${e.clientY}px, 0) translate(-50%, -50%)`
      el.style.opacity = '1'
    }

    window.addEventListener('pointermove', onMove, true)
    return () => window.removeEventListener('pointermove', onMove, true)
  }, [eraserMode])

  /**
   * Ctrl/⌘ + 滚轮缩放。
   *
   * ── 为什么这是桌面端最需要的缩放方式 ────────────────────────
   *   桌面用户没有触摸屏，双指捏合用不了；
   *   而档位按钮一次跳一大格（1 → 1.25 → 1.5），
   *   想停在 1.1 倍这种中间值是做不到的。
   *   Ctrl+滚轮是 Windows 上缩放的通行动作（浏览器、Office 都这样），
   *   用户不用学。
   *
   * ── 与触控板捏合的关系 ──────────────────────────────────────
   *   触控板双指捏合在 Chromium 里就是以 `wheel + ctrlKey=true`
   *   的形式派发的，因此这一个监听同时覆盖了两种输入，
   *   不需要再单独处理 gesture 事件。
   *
   * ── 实现要点 ────────────────────────────────────────────────
   *   · 必须 preventDefault，否则浏览器会对整个页面做视觉缩放
   *   · 监听要 { passive: false }，否则 preventDefault 无效
   *   · 用**乘性**步进而非加性：0.1 的增量在 50% 时太粗、
   *     在 400% 时太细，乘 1.1 在任何比例下手感都一致
   *   · 锚点取指针位置，缩放后指针指着的内容不动（符合直觉）
   *
   * ── 手势窗口（这一版新增，修「缩放不流畅」）─────────────────
   *   原先每个 wheel 事件都独立连乘：factor = exp(-deltaY/1000)。
   *   这有个隐蔽毛病 —— 缩放总量取决于**事件频率**而不是手势幅度。
   *   触控板一次捏合会派发几百个小 delta 的事件，
   *   鼠标一格却只派发一个大 delta 的事件；两者乘积差出好几倍，
   *   用户感觉「有时候轻轻一捏就飞了，有时候滚半天不动」。
   *
   *   SumatraPDF 的做法（src/Canvas.cpp:3310-3363）是：
   *   以 **150ms** 为一个手势窗口（源码注释自承是启发值），
   *   窗口内把 delta 累加起来，用
   *     newZoom = 手势起始zoom × (1 + |累加和| / 100)
   *   一次性算。这样手感只与总行程有关，与事件频率无关。
   *   另外把单个大 delta 压到 ±10，避免高精度滚轮一格跳太远
   *   （`delta ≥ 120` 时归一化，触控板的小 delta 保持原样）。
   */
  useEffect(() => {
    const container = scrollRef.current
    if (!container) return

    /* 手势窗口状态：窗口内的起点缩放值、累加行程、窗口起始时刻 */
    let gestureStartZoom: number | null = null
    let gestureAccum = 0
    let gestureAt = 0

    const onWheel = (e: WheelEvent): void => {
      // 只处理 Ctrl+滚轮；普通滚轮留给页面滚动
      if (!e.ctrlKey && !e.metaKey) return

      /*
       * 手绘/橡皮模式下不缩放：
       * 此时滚轮常被用来微调，且正在落笔时缩放会让笔迹错位。
       */
      if (useViewer.getState().drawMode || useViewer.getState().eraserMode) return

      e.preventDefault()

      const current = useViewer.getState().actualScale
      if (!Number.isFinite(current) || current <= 0) return

      /* 单个事件的 delta 归一化：>=120（鼠标一格）压到 10，触控板小值原样 */
      const raw = e.deltaY
      const norm = Math.abs(raw) >= 120 ? Math.sign(raw) * 10 : raw

      const now = performance.now()
      if (gestureStartZoom === null || now - gestureAt > WHEEL_GESTURE_MS) {
        /* 新的一次手势：以当前缩放为基准重新累加 */
        gestureStartZoom = current
        gestureAccum = 0
      }
      gestureAt = now
      gestureAccum += norm

      /*
       * deltaY < 0 是向上滚 = 放大。
       * 除以 100 的含义：手势总行程 100（= 鼠标滚 10 格）约放大一倍，
       * 与 SumatraPDF 的 1 + |ΣΔ|/100 完全一致。
       */
      const factor = 1 + Math.abs(gestureAccum) / 100
      const target = gestureAccum < 0 ? gestureStartZoom * factor : gestureStartZoom / factor
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, target))
      if (Math.abs(next - current) < 0.0005) return

      /* 记下锚点，缩放后由已有的 layout effect 把该点滚回原处 */
      const rect = container.getBoundingClientRect()
      pendingAnchorRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        fromScale: current
      }

      useViewer.getState().setZoom(Number(next.toFixed(4)))
    }

    container.addEventListener('wheel', onWheel, { passive: false })
    return () => container.removeEventListener('wheel', onWheel)
  }, [])

  /**
   * 右键菜单 / 触摸长按菜单。
   *
   * 触摸长按在 Chromium 里会派发 contextmenu，一体机上会盖住刚选好的词条；
   * 触摸后 2.5 秒内的 contextmenu 一律吞掉，鼠标右键照旧走编辑菜单。
   */
  const handleViewerContextMenu = useCallback(
    (e: React.MouseEvent<HTMLDivElement>): void => {
      if (touchArmedRef.current || Date.now() - lastTouchAtRef.current < 2500) {
        e.preventDefault()
        return
      }
      contentEdit.handleContextMenu(e)
    },
    [contentEdit]
  )

  /**
   * 双击选词：鼠标，以及**把手指报成鼠标**的一体机。
   *
   * 有些触摸面板只发鼠标事件（pointerType 是 mouse），走不到 startTouchSelect；
   * 双击选词这条对它们有效。真正的触摸双击有自己的判定，这里多算一次也无害
   * （同一处落点，选出来的还是同一个词）。
   */
  const handleViewerDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>): void => {
      if (editTool !== 'select') return
      /*
       * 触摸/手写笔的双击由 startTouchSelect 自己判定，这里只在「真鼠标」时生效。
       * 否则 Chrome 触摸仿真或一体机把手指报成鼠标时，一次触摸会既走触摸判定、
       * 又走 dblclick，两条路各选一次词 —— 边界情况（选区刚被轻点清掉）就会重现旧选区。
       */
      if (e.detail === 0) return
      if (Date.now() - lastTouchAtRef.current < 800) return
      if (selectWordAt(e.clientX, e.clientY)) anchorFromSelection()
    },
    [editTool, selectWordAt, anchorFromSelection]
  )

  return (
    /*
     * ★ 用 Fragment 包一层：浮动编辑条 / 隐藏的文件选择器 / 右键菜单
     *   必须挂在 .viewer-scroll **外面**。
     *   它们在 scroll 容器里的话，点一下按钮会先冒泡给容器的 onPointerDown，
     *   被当成「在页面上按了一下」→ 刚选中的物件立刻被取消选中，
     *   甚至顺手在页面上起一个草稿。
     */
    <>
      <div
        className={`viewer-scroll ${drawMode ? 'is-drawing' : ''} ${
          eraserMode ? 'is-erasing' : ''
        } ${!drawMode && !eraserMode ? 'is-roaming' : ''} ${panning ? 'is-panning' : ''} ${editClass}`}
        ref={scrollRef}
        onPointerDown={onPointerDown}
        onDoubleClick={handleViewerDoubleClick}
        /* 右键菜单：编辑态下点物件弹出「删除 / 编辑文字」；触摸长按的 contextmenu 一律吞掉 */
        onContextMenu={handleViewerContextMenu}
      >
      {/*
        橡皮光标：跟随指针的暗色圆圈，直观表示「会擦到多大范围」。
        用 position: fixed 跟随 clientX/clientY —— 与指针零延迟，
        不受滚动容器影响。
        只在橡皮模式显示；绘制模式用十字光标（见 viewer.css）。
      */}
      {eraserMode ? (
        <div
          ref={eraserCursorRef}
          className="eraser-cursor"
          style={{ width: eraserSize * 2, height: eraserSize * 2 }}
          aria-hidden="true"
        />
      ) : null}

      {/* OCR 进度提示：识别一页要几秒，没有反馈用户会以为按钮坏了 */}
      {ocrBusy ? (
        <div className="ocr-busy" role="status">
          正在识别本页文字…（首次约 5 秒）
        </div>
      ) : null}

      <div className="viewer-pages">
        {/*
          ★ 真实页尺寸算出来之前，一页都不挂载。
          
          踩坑记录（「快速翻页卡成黑页」的上游成因）：
          页面尺寸是异步算出来的（要先 doc.getPage(1) 拿基准尺寸）。
          在那之前 width/height 都是 0，PdfPage 只能用内联样式
          的 undefined，于是每个 <canvas> 都保持 pdf.js 的默认属性尺寸
          300×150。10 页加起来内容总高才一千多像素，
          而懒渲染观察器带 rootMargin '150%' ——
          结果**全部 10 页**同时被判定为「接近视口」并一起启动渲染，
          十几个任务互相抢主线程、彼此取消，最终留下几页黑屏。
          
          不挂载就没有尺寸、也就没有观察目标，
          等尺寸就绪后再一次性按正确高度铺开，
          观察器第一次回调就能算出正确的可见集合。
        */}
        {pageSize.width > 0 && pageSize.height > 0
          ? rowsToRender.map((row, rowIndex) => (
              <div
                className={`viewer-row${row.length > 1 ? ' viewer-row--pair' : ''}`}
                key={row[0]}
                data-row={rowIndex}
              >
                {row.map((num) => (
                  <PdfPage
                    key={num}
                    doc={doc}
                    pageNumber={num}
                    width={pageSize.width}
                    height={pageSize.height}
                    renderWidth={settledPageSize.width}
                    renderHeight={settledPageSize.height}
                    rotation={rotation}
                    active={singlePage || visible.has(num) || Math.abs(num - page) <= NEAR_PAGE_RADIUS}
                    annotations={byPage.get(num) ?? EMPTY_ANNOTATIONS}
                    scale={pageSize.scale}
                    erasing={eraserMode}
                    ocrLines={ocr && ocr.page === num ? ocr.lines : undefined}
                    registerRef={registerPageRef}
                    /* 内容编辑层：与批注层同页同尺寸，只画会改内容的那些类型 */
                    editLayer={contentEdit.renderLayer(num, contentByPage.get(num) ?? EMPTY_ANNOTATIONS)}
                  />
                ))}
              </div>
            ))
          : null}

        {/*
          手绘实时预览（**每一笔一张画布**）。
          必须放在 .viewer-pages 里而不是外层滚动容器里：
          笔迹坐标是相对**某一页**算的，而页面在滚动内容中是纵向排列的，
          放进滚动容器会导致第 2 页之后预览整体上移。

          预览与成品走同一个位图光栅化函数（ink-engine 的 paintStroke），
          只是画在一张单独的预览画布上。
          如果预览用折线、成品用带笔锋的曲线，
          松手瞬间笔迹会突然变样，手感很怪。
          ★ 这里按会话列表渲染，而不是「有草稿就渲染一张」：
            多指同时书写时有几笔就有几张画布，各自叠在**自己那一页**上
            （offsetX/offsetY 来自该会话起笔时量到的页面偏移）。
            每张画布只在**起笔（挂载）与收笔（卸载）**时经过 React，
            中途的点通过 ref 命令式追加 —— 这正是消除书写延迟与丢点的关键。
        */}
        {drafts.map((d) => (
          <PreviewInk
            key={d.pointerId}
            /*
             * 句柄直接挂回会话对象：追加点走 session.handle.drawMore()，
             * 不经过 props/state。ref 回调每次渲染都会重挂一次，
             * 但同一笔期间不会重渲染（只有起笔/收笔各一次），
             * 所以不会打断绘制。
             */
            ref={(h) => {
              d.handle = h
            }}
            /* 颜色与粗细取自会话快照：中途改色不该影响正在写的这一笔 */
            color={d.color}
            width={d.width}
            /* 偏移取该会话所属页面元素的实测 offsetLeft/offsetTop */
            offsetX={d.offsetX}
            offsetY={d.offsetY}
            /* 原始尺寸与显示尺寸都给：预览要与成品用同一套分辨率与变换 */
            baseWidth={pageSize.scale > 0 ? pageSize.width / pageSize.scale : pageSize.width}
            baseHeight={pageSize.scale > 0 ? pageSize.height / pageSize.scale : pageSize.height}
            displayWidth={pageSize.width}
            displayHeight={pageSize.height}
            /*
             * 起笔的第一个点。之后追加的点走 drawMore，不再经过 props。
             * 直接传引用即可 —— 不必每点都新建数组（那正是丢点的来源）。
             */
            initialPoints={d.points}
          />
        ))}
      </div>

      {/*
        选中文字的浮动工具条（高亮 / 下划线 / 删除线 / 便签）。
        ★ 选择工具激活时让位给编辑层的选区条（复制 / 高亮 / 下划线 / 取消）：
          两条同时浮在选区上方会互相压住，而且功能重复。
          其余状态（含 editTool === 'none' 的漫游态）行为与改造前完全一致。
      */}
      {anchor && editTool !== 'select' ? (
        <SelectionToolbar
          anchor={anchor}
          color={annoColor}
          onColorChange={setAnnoColor}
          onApply={(type) => {
            applySelection(type, annoColor)
            setAnchor(null)
          }}
          onNote={() => {
            // 便签：先落一条带空备注的批注，再让用户在右侧栏补充文字
            applySelection('note', annoColor)
            setAnchor(null)
          }}
          onDismiss={() => setAnchor(null)}
        />
      ) : null}
      </div>

      {/*
        编辑态的浮动件：顶部编辑条（工具选项 / 未导出提示 / 导出 PDF）、
        隐藏的图片文件选择器、选区工具条、右键菜单。
        由 useContentEdit 统一渲染 —— 它们都要读同一份交互状态。
      */}
      {contentEdit.overlay}
    </>
  )
}

/**
 * 页面之间的间距与容器内边距。
 *
 * 只用于给手绘预览一个「还没量到 DOM」时的初值。
 *
 * 曾经的用法是「按第几页推算纵向偏移」，那个公式已经删掉了 ——
 * 它在双页模式下是错的（同一行的两页 top 相同，公式会算成差一行），
 * 现在纵横向都取页面元素实测的 offsetLeft / offsetTop。
 */
const DRAW_GAP = 16

/* ============================================================
 * 多指绘画 / 掌心擦除：会话类型与触点判定
 * ============================================================ */

/**
 * 正在书写的一条笔迹（一根手指或一支笔一个会话）。
 *
 * 为什么是「会话」而不是一组全局 ref：多指并写时每一笔都要有自己的
 * 点数组、页码、颜色与页面偏移，互相不能串（见组件里 syncDrafts 的注释）。
 * handle 指向这一笔的预览画布，追加点时走它的命令式接口。
 */
interface DraftSession {
  pointerId: number
  page: number
  color: string
  width: number
  points: StrokePoint[]
  offsetX: number
  offsetY: number
  handle: PreviewInkHandle | null
}

/** 正在擦除的一次触摸（橡皮或掌心，一根手指一个会话） */
interface EraseSession {
  pointerId: number
  page: number
  radius: number
  lastX: number
  lastY: number
  /** 抽稀步长（页面坐标）：相邻两次擦除的圆保证重叠 */
  step: number
  palm: boolean
}

/**
 * 触点长边超过这个值（CSS 像素）就当成「掌心」。
 *
 * 阈值是内置的，但**可以在真机上现场标定**，不必改代码重打包：
 *   window.__sbSetPalmThreshold(60)   // 调大一点，避免误判
 *   window.__sbTouchContacts          // 看最近 20 次触点的实测尺寸
 * 记录里带着 palm 判定结果，一眼就能看出真机报的接触面积是多少、
 * 当前阈值卡在哪里。之所以要留这个口子：不同一体机面板上报的
 * width/height 差别很大（有的按毫米、有的直接给 1）。
 */
const PALM_CONTACT_PX = 44

/** 掌心擦除半径的屏幕像素上限：再大就「一按下去半页笔迹没了」，没法补救 */
const PALM_MAX_RADIUS = 80

/** 掌心擦除半径 = 触点长边 × 该系数（手掌盖住的面积本来就大） */
const PALM_RADIUS_RATIO = 0.75

/** 并行笔迹会话上限（用户指定最多 4 指） */
const MAX_DRAW_POINTERS = 4

/**
 * 触点小于这个尺寸就认为「驱动没报接触面积」，按普通手指处理。
 * 宁可漏判掌心（多画一道线，撤销即可），也不能把正常手指
 * 当成掌心去擦掉用户的笔迹 —— 后者是破坏性的。
 */
const CONTACT_MIN_PX = 8

type PalmTestWindow = Window & {
  __sbPalmThreshold?: number
  __sbSetPalmThreshold?: (px: number) => void
  __sbTouchContacts?: Array<{ t: number; type: string; size: number; palm: boolean }>
}

/** 当前生效的掌心阈值（可被真机标定覆盖） */
function palmThreshold(): number {
  const v = (window as PalmTestWindow).__sbPalmThreshold
  return typeof v === 'number' && v > 0 ? v : PALM_CONTACT_PX
}

/**
 * 触点长边（CSS 像素）。
 * PointerEvent 的 width/height 对触摸是接触面的包围盒，
 * 鼠标恒为 1、多数触屏笔是很小的值（几像素）。
 */
function contactSize(e: { width?: number; height?: number }): number {
  return Math.max(Number(e.width) || 0, Number(e.height) || 0)
}

/** 是不是「掌心」：只对 touch 生效，笔永远是细触点 */
function isPalmContact(e: {
  pointerType: string
  width?: number
  height?: number
}): boolean {
  if (e.pointerType !== 'touch') return false
  const size = contactSize(e)
  if (size < CONTACT_MIN_PX) return false
  return size >= palmThreshold()
}

/** 记录最近 20 次触点，供真机标定阈值时查看（生产无副作用） */
function rememberContact(pointerType: string, size: number): void {
  if (pointerType !== 'touch') return
  const w = window as PalmTestWindow
  const list = (w.__sbTouchContacts ??= [])
  list.push({
    t: Date.now(),
    type: pointerType,
    size,
    palm: size >= CONTACT_MIN_PX && size >= palmThreshold()
  })
  while (list.length > 20) list.shift()
}

/* 真机标定入口：装上就能用，不必改代码重打包 */
if (typeof window !== 'undefined' && !(window as PalmTestWindow).__sbSetPalmThreshold) {
  ;(window as PalmTestWindow).__sbSetPalmThreshold = (px: number): void => {
    ;(window as PalmTestWindow).__sbPalmThreshold = px
  }
}

/** 复用的空数组：避免每次渲染都新建，减少子组件无谓的重渲染 */
const EMPTY_ANNOTATIONS: Annotation[] = []

/** 供缩略图使用的页面渲染 hook（把某页画到给定 canvas） */
export function useThumbnail(
  doc: PDFDocumentProxy | null,
  pageNumber: number,
  targetWidth: number
): React.RefObject<HTMLCanvasElement> {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!doc || targetWidth <= 0) return
    let cancelled = false
    let task: { cancel: () => void } | null = null

    void (async () => {
      try {
        const p = await doc.getPage(pageNumber)
        if (cancelled) return
        const base = p.getViewport({ scale: 1 })
        const scale = targetWidth / base.width
        const viewport = p.getViewport({ scale })

        const canvas = ref.current
        if (!canvas) return
        const dpr = window.devicePixelRatio || 1
        canvas.width = Math.floor(viewport.width * dpr)
        canvas.height = Math.floor(viewport.height * dpr)
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`

        const ctx = canvas.getContext('2d', { alpha: false })
        if (!ctx) return
        task = p.render({
          canvasContext: ctx,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined
        })
        await (task as unknown as { promise: Promise<void> }).promise
      } catch (error) {
        const name = (error as { name?: string })?.name
        if (name !== 'RenderingCancelledException' && !cancelled) {
          console.warn(`[pdf] 缩略图 ${pageNumber} 失败：`, error)
        }
      }
    })()

    return () => {
      cancelled = true
      try {
        task?.cancel()
      } catch {
        /* 忽略 */
      }
    }
  }, [doc, pageNumber, targetWidth])

  return ref
}
