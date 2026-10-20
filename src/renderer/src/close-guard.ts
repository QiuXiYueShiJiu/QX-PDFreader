// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 「有编辑还没导出」的统一守卫。
 *
 * 关闭标签、关闭窗口、点「退出应用」三条路都必须先过这里，否则用户
 * 辛苦涂白/打字的编辑会静默消失 —— 这是内容编辑功能里最容易踩的坑。
 *
 * 流程（用户选了「保存为 PDF」时）：
 *   1. 主进程弹原生三选一（保存为 PDF / 不保存 / 取消）；
 *   2. 选「保存」→ 调用注册进来的导出函数（真正的导出在 anno-export.ts，
 *      它需要 pdf.js 文档对象，所以由 App 在拿到 doc 后注册）；
 *   3. 导出成功才放行；导出被取消或失败一律不放行（停在原地，不丢数据）。
 *
 * 导出函数用「注册」而不是直接 import：
 *   · 导出要 pdf.js 的 doc，而 doc 只有 App 里 useDocument 拿得到；
 *   · 首屏不需要导出代码，动态注册也能让这块逻辑保持可替换。
 */
import { useViewer } from './store'

export type ExportOutcome = { ok: boolean; canceled?: boolean; error?: string }

type Exporter = () => Promise<ExportOutcome>

let exporter: Exporter | null = null
/** 注册进来的导出实现属于哪份文档（切标签后要等它重新注册） */
let exporterPath: string | null = null

/** App 拿到 pdf.js 文档后注册导出实现；传 null 表示取消注册 */
export function registerExporter(fn: Exporter | null, path: string | null = null): void {
  exporter = fn
  exporterPath = fn ? path : null
}

/**
 * 等导出实现换成目标文档那一份。
 *
 * 为什么需要：关后台标签时我们会先切过去（见 TabBar），而切标签后
 * App 要等 pdf.js 把新文档加载完才会重新注册导出实现（依赖 [doc]）。
 * 不等待的话，用户点「保存为 PDF」时跑的可能是**上一份文档**的导出，
 * 结果就是「保存了错的文件、真正要保的那份反而丢了」——比不保存更糟。
 */
async function waitForExporter(path: string, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (exporter && exporterPath === path) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/**
 * 守卫：返回 true 表示可以继续（没有脏数据，或用户选择保存成功 / 不保存）。
 *
 * 重入保护：导出过程本身会改动 store，若不拦住，导出触发的一次
 * 关闭请求可能又进来问一遍，用户会看到两个对话框。
 */
let running = false

export async function guardUnsaved(action: string): Promise<boolean> {
  const state = useViewer.getState()
  if (!state.exportDirty) return true
  if (running) return false

  running = true
  try {
    const name = state.fileName || '当前文档'
    const choice = await window.pdfApp?.doc.confirmUnsaved(name)

    // 关掉对话框（Esc）或点取消：什么都不做，文档原样留着
    if (!choice || choice === 'cancel') return false
    if (choice === 'discard') return true

    if (!exporter) {
      // 理论上到不了：有脏数据就说明用了编辑工具，导出实现必然已注册
      window.alert('导出功能还没准备好，暂时不能保存。请用工具条的「导出 PDF」按钮。')
      return false
    }

    // 导出实现必须属于当前这份文档，否则会存错文件
    if (!(await waitForExporter(state.filePath))) {
      window.alert('文档刚切换过来还没加载完，请稍后再试一次。本次操作已取消，编辑内容还在。')
      return false
    }

    const result = await exporter()
    if (result.ok) return true
    if (result.canceled) return false

    window.alert(`保存失败：${result.error ?? '未知错误'}\n${action}已取消，编辑内容还在。`)
    return false
  } finally {
    running = false
  }
}

/**
 * 把 store 的 exportDirty 同步给主进程。
 *
 * 主进程要这个标志来判断「用户点关闭窗口」时该不该拦（见 main/index.ts 的
 * hasUnsavedEdits）：主进程看不到渲染层的 store，只能靠这条通知。
 */
export function installCloseGuard(): () => void {
  const push = (dirty: boolean): void => {
    window.pdfApp?.doc.setDirty(dirty)
  }
  push(useViewer.getState().exportDirty)
  return useViewer.subscribe((state, prev) => {
    if (state.exportDirty !== prev.exportDirty) push(state.exportDirty)
  })
}
