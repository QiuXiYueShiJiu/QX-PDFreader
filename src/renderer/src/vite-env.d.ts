// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 资源导入的类型声明。
 */

/** Vite 的 ?url 后缀：导入资源并返回其最终 URL 字符串 */
declare module '*?url' {
  const url: string
  export default url
}
