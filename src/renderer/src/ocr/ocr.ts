// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 扫描件文字识别（OCR）—— v2.1.3
 *
 * 为什么需要它：
 *   扫描件（图片型 PDF）没有文字层，`caretRangeFromPoint` 拿不到任何字符，
 *   于是「选中文字 → 改文字」这条主路径在扫描件上完全不可用。
 *   用户看到的只是「点上去没反应」。
 *
 * 方案：用 tesseract.js 在**渲染层**离线识别，把识别出的每一行/每个词
 *   做成一层透明的可选文字（`.ocr-text-layer`），叠在页面图片上方。
 *   之后的选中、复制、改文字、高亮全都复用现有逻辑 ——
 *   对上层来说，它和真正的文字层没有区别。
 *
 * 为什么放渲染层而不是主进程：
 *   tesseract.js 的 worker 脚本与 wasm 核心都要按 URL 加载；
 *   渲染层有稳定的 document.baseURI（dev 是 http://localhost，
 *   打包后是 file://…/out/renderer/index.html），相对路径两边一致。
 *   放主进程反而要额外处理 asar 内的 worker 路径。
 *
 * 资源（由 scripts/copy-ocr-assets.mjs 复制到 public/ocr）：
 *   worker.min.js、tesseract-core-simd-lstm.wasm.js、lang/{chi_sim,eng}.traineddata
 *
 * 许可：tesseract.js（Apache-2.0）、tesseract.js-core（Apache-2.0）、
 *   tessdata_fast 语言包（Apache-2.0），详见 THIRD-PARTY-NOTICES.md。
 */

/** 识别出的一行文字（坐标是**页面坐标系**，即 scale = 1 的像素） */
export interface OcrLine {
  text: string
  x: number
  y: number
  width: number
  height: number
  /** tesseract 给的置信度 0~100，低置信度的行可以标灰（暂未使用） */
  confidence: number
}

export interface OcrProgress {
  /** 0~1；未知阶段时为 -1 */
  fraction: number
  stage: string
}

const ASSET_BASE = 'ocr/'

/** 把相对资源路径解析成绝对 URL（dev / 打包后都成立） */
function assetUrl(path: string): string {
  return new URL(ASSET_BASE + path, document.baseURI).href
}

let workerPromise: Promise<import('tesseract.js').Worker> | null = null
let progressSink: ((p: OcrProgress) => void) | null = null

/**
 * 取（并缓存）OCR worker。
 *
 * 语言固定 `chi_sim+eng`：教学场景里中文为主、英文/公式符号混排很常见；
 * 两份语言包合起来约 6 MB，首次识别要加载 3~6 秒，第二次起是热启动。
 */
async function getWorker(): Promise<import('tesseract.js').Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const mod = await import('tesseract.js')
      return mod.createWorker('chi_sim+eng', 1, {
        workerPath: assetUrl('worker.min.js'),
        /*
         * 显式指定 SIMD 版 LSTM 核心：
         * 目录形式会让 tesseract.js 自己探测 simd/lstm，探测失败时的报错
         * 很难懂（"Error loading core"）。直接给文件，失败信息更明确。
         */
        corePath: assetUrl('tesseract-core-simd-lstm.wasm.js'),
        langPath: assetUrl('lang'),
        /*
         * 不写 IndexedDB 缓存：打包后页面是 file:// 源，IndexedDB 在部分
         * Electron 版本上会抛 SecurityError；语言包本来就在本地磁盘上，
         * 走 HTTP/file 读取已经够快，不需要再缓存一份。
         */
        cacheMethod: 'none',
        /*
         * ★ 关掉 gzip：默认会去拉 `<lang>.traineddata.gz`，但我们复制的
         *   是原始 `.traineddata`（CI/离线环境不重新压缩）。实测不关会
         *   在 worker 里报 ERR_FILE_NOT_FOUND，表现是识别永远不返回。
         */
        gzip: false,
        logger: (m: { status?: string; progress?: number }) => {
          progressSink?.({
            fraction: typeof m.progress === 'number' ? m.progress : -1,
            stage: m.status ?? ''
          })
        }
      })
    })().catch((err) => {
      /* 失败要清掉缓存，否则后续每次调用都拿到同一个 rejected promise */
      workerPromise = null
      throw err
    })
  }
  return workerPromise
}

interface RawWord {
  text?: string
  confidence?: number
  bbox?: { x0: number; y0: number; x1: number; y1: number }
}
interface RawLine {
  text?: string
  confidence?: number
  bbox?: { x0: number; y0: number; x1: number; y1: number }
  words?: RawWord[]
}

/** 把 tesseract 的结果树拍成「行」数组（v5 的 blocks→paragraphs→lines） */
function flattenLines(data: unknown): RawLine[] {
  const lines: RawLine[] = []
  const blocks = (data as { blocks?: { paragraphs?: { lines?: RawLine[] }[] }[] }).blocks
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      for (const para of block.paragraphs ?? []) {
        for (const line of para.lines ?? []) lines.push(line)
      }
    }
  }
  return lines
}

/**
 * 识别一张图片（dataURL），返回按行切好的文字 + 页面坐标。
 *
 * @param imageDataUrl 页面渲染结果的 dataURL（PNG/JPEG）
 * @param pixelRatio   图片像素 / 页面坐标像素（用于把 bbox 换算回页面坐标）
 */
export async function recognizePage(
  imageDataUrl: string,
  pixelRatio: number,
  onProgress?: (p: OcrProgress) => void
): Promise<OcrLine[]> {
  progressSink = onProgress ?? null
  try {
    const worker = await getWorker()
    const { data } = await worker.recognize(imageDataUrl, {}, { text: true, blocks: true })
    const ratio = pixelRatio > 0 ? pixelRatio : 1
    const out: OcrLine[] = []
    for (const line of flattenLines(data)) {
      const text = (line.text ?? '').replace(/\s+$/g, '')
      const box = line.bbox
      if (!text.trim() || !box) continue
      out.push({
        text,
        x: box.x0 / ratio,
        y: box.y0 / ratio,
        width: Math.max(1, (box.x1 - box.x0) / ratio),
        height: Math.max(1, (box.y1 - box.y0) / ratio),
        confidence: line.confidence ?? 0
      })
    }
    return out
  } finally {
    progressSink = null
  }
}

/** 预热：打开文档后空闲时先把 worker 拉起来，首次点识别就不用等加载 */
export function warmUpOcr(): void {
  void getWorker().catch(() => {
    /* 预热失败不打扰用户：真点识别时还会再试一次，并给出明确错误 */
  })
}

/** 释放 worker（切换文档/退出时调用，避免残留 4~6 个 worker 线程） */
export async function disposeOcr(): Promise<void> {
  const pending = workerPromise
  workerPromise = null
  if (!pending) return
  try {
    const worker = await pending
    await worker.terminate()
  } catch {
    /* 已经挂了就没什么可释放的 */
  }
}
