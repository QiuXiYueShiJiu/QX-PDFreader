// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 渲染层入口。
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { useViewer } from './store'
import { decodeStroke, encodeStroke } from './ink-engine'
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
