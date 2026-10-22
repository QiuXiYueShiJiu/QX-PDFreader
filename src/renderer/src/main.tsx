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
 * Metro 主题的形态覆盖放最后：它只改「外观形态」，颜色令牌在 base.css 里，
 * 放最后能确保它对前面文件的圆角/阴影规则有最终决定权。
 */
import './styles/metro.css'
/* PDF 工具箱面板（合并/拆分/水印/压缩/加解密/图片互转/Office 转换） */
import './styles/tools.css'
import './styles/update-toast.css'

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

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
