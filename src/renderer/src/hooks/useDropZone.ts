// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 拖放打开 PDF。
 *
 * 为什么单独抽一个 hook：
 *   dragover 必须持续 preventDefault，否则浏览器不会触发 drop；
 *   而计数器要处理「在子元素之间移动时会连续触发 dragleave」的问题 ——
 *   用 enter/leave 计数比用布尔量可靠，否则鼠标划过子元素时提示会闪。
 */

import { useEffect, useRef, useState } from 'react'

/** 从 DataTransfer 里取出第一个 PDF 路径 */
function extractPdfPath(dt: DataTransfer | null): string | null {
  if (!dt) return null
  for (const file of Array.from(dt.files)) {
    // Electron 里 File 对象带有 path 属性（标准浏览器没有）
    const path = (file as File & { path?: string }).path
    if (path && path.toLowerCase().endsWith('.pdf')) return path
  }
  return null
}

export function useDropZone(onFile: (path: string) => void): { dragging: boolean } {
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  const callback = useRef(onFile)
  callback.current = onFile

  useEffect(() => {
    const onDragEnter = (e: DragEvent): void => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      depth.current += 1
      setDragging(true)
    }

    const onDragOver = (e: DragEvent): void => {
      if (!e.dataTransfer?.types.includes('Files')) return
      // 必须阻止默认行为，否则 drop 不会触发
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }

    const onDragLeave = (): void => {
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setDragging(false)
    }

    const onDrop = (e: DragEvent): void => {
      e.preventDefault()
      depth.current = 0
      setDragging(false)
      const path = extractPdfPath(e.dataTransfer)
      if (path) callback.current(path)
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)

    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  return { dragging }
}
