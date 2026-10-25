// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 渲染层入口。
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as pdfjsLib from 'pdfjs-dist'
import App from './App'
import { useViewer } from './store'
import { decodeStroke, encodeStroke } from './ink-engine'
import {
  extractEmbeddedImages,
  extractTablePages,
  extractTextPages,
  openPdfForTools,
  readMetadata,
  readOutline,
  renderLongImages,
  renderPdfPages,
  renderRedactedPage,
  renderWatermarkImage
} from './pdf-tools'
import {
  buildCompareHtmlReport,
  buildCompareTextReport,
  comparePageTexts,
  composeSideBySidePage,
  diffLines
} from './pdf-compare'
import { batchPdfToImages } from './batch-images'
import './styles/base.css'
import './styles/viewer.css'
import './styles/viewer-compat.css'
import './styles/rails.css'
import './styles/drawbar.css'
import './styles/tabs.css'
import './styles/slideclear.css'
import './styles/mask.css'
import './styles/strokes.css'
import './styles/ink.css'
import './styles/components.css'
import './styles/edit.css'
import './styles/disclaimer.css'
/*
 * Metro 主题的形态覆盖放最后：它只改「外观形态」，颜色校验值在 base.css 里，
 * 放最后能确保它对前面文件的圆角/阴影规则有最终决定权。
 */
import './styles/metro.css'
import './styles/glass.css'
/* PDF 工具箱面板（合并/拆分/水印/压缩/加解密/图片互转/Office 转换） */
import './styles/tools.css'
import './styles/update-toast.css'
import './styles/market.css'
/* 布局包放最后：它只写结构，需要能覆盖前面各主题对圆角/高度的设定 */
import './styles/layout-office.css'

/*
 * ---------- 自动化测试挂钩 ----------
 *
 * 把 store 与笔迹编解码挂到 window，供 tools/ 下的验证脚本
 * 直接读写数据层。为什么需要它：
 *   橡皮切段是纯几何算法，用像素比对验证不可靠
 *   （抗锯齿、超采样都会干扰边缘判定），直接查数据最准；
 *   而且能定位到具体哪一段算错，而不是只知道「看起来不对」。
 *
 * ★ 只在 URL 带 ?test-hooks=1 时挂载。
 *   用查询参数而不是 process.argv：渲染层（带 contextIsolation）
 *   拿不到 process，而 location.search 始终可用。
 *   生产包正常打开时不会带这个参数，因此等于没有后门。
 */
const exposeTestHooks = new URLSearchParams(window.location.search).get('test-hooks') === '1'

if (exposeTestHooks) {
  const w = window as unknown as Record<string, unknown>
  w.__store = useViewer
  w.__inkTest = { encodeStroke, decodeStroke }
  /*
   * PDF 工具箱的渲染侧函数也开放给测试脚本。
   * 「压缩」「PDF→图片」「水印」这几条链的真正难点在主进程与 pdf.js 之间：
   * 参数是否传对、页面尺寸是否保持、ArrayBuffer 过 IPC 有没有被截断。
   * 只验主进程拿不到这些函数，只验界面又看不出数据，故统一挂在这里，
   * 与 __store 同一开关，生产包不带 ?test-hooks=1 时完全不存在。
   */
  w.__pdfTools = {
    openPdfForTools,
    renderPdfPages,
    renderLongImages,
    renderWatermarkImage,
    extractTextPages,
    extractTablePages,
    readMetadata,
    readOutline,
    renderRedactedPage,
    extractEmbeddedImages
  }
  /*
   * pdf.js 的 OPS 常量也挂出来：图片提取用例需要核对
   * 「哪些算子代表图片」的确切数值（不同 pdf.js 版本增删过成员），
   * 让脚本读真实常量而不是猜数字。同样受 --test-hooks 门控。
   */
  w.__pdfOps = pdfjsLib.OPS
  /* 比较功能的纯函数（逐页差异/报告生成/并排对照页）也开放给验证脚本 */
  w.__pdfCompare = {
    comparePageTexts,
    diffLines,
    buildCompareTextReport,
    buildCompareHtmlReport,
    composeSideBySidePage
  }
  /* 批量导图（多份 PDF → 图片）开放给验证脚本 */
  w.__pdfBatch = { batchPdfToImages }
  /*
   * ★ 这个标记给组件读：只有它是 true 时，组件才会把自己的内部对象
   *   （目前是 pdf.js 的 PDFDocumentProxy）挂到 window 上。
   *   之所以要一个显式标记而不是让组件各自读 location.search：
   *     ① 组件树里读 URL 会散落一堆重复判断，容易漏掉某个分支；
   *     ② 挂钩开关集中在这一个地方，审「生产包有没有后门」时只看这里。
   *   生产包正常启动不会带 ?test-hooks=1，因此等于不存在。
   */
  w.__testHooks = true
  console.log('[test] 已挂载测试挂钩')
}

const container = document.getElementById('root')
if (!container) throw new Error('找不到 #root 容器')
/* 收窄后另存一份非空引用：bootstrap 是异步函数，TS 不会把外面的收窄带进闭包 */
const rootEl: HTMLElement = container

/*
 * ---------- 资源管理器缩略图客户端 ----------
 *
 * 两个入口共用一份渲染代码（`./thumb.ts`）：
 *   ① `--render-thumb` 启动（shell 提供器唤起）：只渲染首页 → 交回 dataURL → 主进程写盘退出。
 *      ★ 这种模式**不挂 React**（见文件末尾的 bootstrap）：挂载整套界面只会拖慢启动，
 *      而且 App 挂载后会 `app:renderer-ready`，主进程会把待打开文件推过来 ——
 *      等于为了渲一张缩略图顺手把整个文档加载一遍。
 *   ② 正常启动：文档打开后顺手把首页缩略图写进缓存，用户在资源管理器里马上就能看到。
 *      用 store 订阅而不是改组件，避免把「顺带做的事」散进渲染路径。
 */
async function bootstrap(): Promise<void> {
  const api = window.pdfApp
  let thumbMode = false
  if (api?.thumb) {
    let pdfPath = ''
    let width = 512
    try {
      const task = await api.thumb.task()
      thumbMode = task.mode
      pdfPath = task.pdfPath
      width = task.width || 512
    } catch (err) {
      console.warn('[thumb] 取任务失败', err)
    }

    if (thumbMode) {
      try {
        const { renderThumbDataUrl } = await import('./thumb')
        const dataUrl = await renderThumbDataUrl(pdfPath, width)
        await api.thumb.done(dataUrl)
      } catch (err) {
        console.warn('[thumb] 渲染失败', err)
        await api.thumb.done('')
      }
      /* 交完就停：不挂 React、不报到 renderer-ready */
      return
    }

    /* 正常模式：每个路径只暖一次；失败静默（缩略图不能让阅读主流程变慢或报错） */
    const warmed = new Set<string>()
    let busy = false
    useViewer.subscribe((state) => {
      if (busy) return
      const tab = state.tabs.find((t) => t.id === state.activeTabId)
      const path = tab?.path
      if (!path || state.pageCount < 1 || warmed.has(path)) return
      warmed.add(path)
      busy = true
      void (async () => {
        try {
          if (await api.thumb.fresh(path)) return
          const { renderThumbDataUrl } = await import('./thumb')
          const dataUrl = await renderThumbDataUrl(path, 512)
          await api.thumb.save(path, dataUrl)
        } catch (err) {
          console.warn('[thumb] 缓存失败', err)
        } finally {
          busy = false
        }
      })()
    })
  }

  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}

void bootstrap()
