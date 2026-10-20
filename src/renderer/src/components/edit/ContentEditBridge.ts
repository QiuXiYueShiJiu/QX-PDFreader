// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 内容编辑 → 底部工具条的桥。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要它（用户 2026-10-16 要求）
 * ══════════════════════════════════════════════════════════════════
 *   原先「选择 / 文字 / 图片 / 涂白 / 矩形 / 椭圆」的**选项条**
 *   （字号、线宽、颜色、选图、删除、导出、完成）是浮动在阅读区**顶部**的
 *   `.edit-bar`。用户要求把它**合并到全局唯一的底部工具条**里去，
 *   让「工具选择」和「该工具的选项」出现在同一处，一体机上不用来回找。
 *
 * ── 为什么用注册表而不是 props ────────────────────────────────
 *   编辑态的真实状态（选中物件、导出进度、待放置图片、隐藏的 file input…）
 *   全部活在 `components/edit/useContentEdit.tsx` 这个 hook 里，
 *   而底部工具条 `DrawToolbar` 是 App 直接渲染的**无 props 组件**。
 *   两条可选路径：
 *     · 把 EditBar 的十几个 prop 一层层透传给 DrawToolbar
 *       —— 要穿过 DocumentView / App，改动面大且容易漏；
 *     · 让 hook 把「渲染入口」注册进来，DrawToolbar 只管调用。
 *   选了后者：**一个函数注册、一个函数读取**，边界清楚，也没有 DOM 依赖
 *   （比 portal 稳，且不受容器重挂载影响）。
 *
 * 生命周期：hook 每次渲染都会用最新的闭包重新注册（刻意不用 useMemo，
 * 否则闭包会捕获旧的 state，点导出按钮会读到过期的进度）。
 * hook 卸载时传 null 注销，避免工具条调用到已卸载组件的 setState。
 */

/** 渲染入口：由 DrawToolbar 调用，返回一条 React 节点 */
export type EditBarRenderer = () => JSX.Element | null

let renderer: EditBarRenderer | null = null
/** 通知订阅者「注册内容变了」——只传一个自增版本号，避免把 React 节点塞进 state */
const listeners = new Set<(version: number) => void>()
let version = 0

/**
 * 注册/注销编辑条渲染入口。传 null 表示注销。
 * @param fn 返回 React 节点的函数（用当前闭包捕获最新的编辑态）
 */
export function setEditBarRenderer(fn: EditBarRenderer | null): void {
  if (renderer === fn) return
  renderer = fn
  version += 1
  for (const l of listeners) l(version)
}

/** 订阅注册变化，返回取消订阅函数 */
export function subscribeEditBar(listener: (version: number) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * 取出当前渲染入口。
 *
 * 注意调用时机：必须在**订阅回调触发之后**的渲染里调用，
 * 这样拿到的才是最新注册的那个闭包。
 */
export function getEditBarRenderer(): EditBarRenderer | null {
  return renderer
}

/** 当前是否处于编辑态（有注册 = 有编辑条要显示） */
export function hasEditBar(): boolean {
  return renderer !== null
}
