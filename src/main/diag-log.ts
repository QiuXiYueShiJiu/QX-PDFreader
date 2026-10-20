// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 渲染诊断日志（主进程侧）。
 *
 * 用途：把「页面宽度到底什么时候变、被谁改的」写进一个文本文件，
 *   让用户在真机上复现一次（他们的窗口是最大化 + 150% 缩放 + 触摸屏惯性滑动，
 *   这些条件在自动化用的隐藏窗口里复现不出来）后，直接把日志读出来定位。
 *
 * 为什么放在主进程写盘：
 *   · 渲染层是 contextIsolation + 无 Node API，写不了文件；
 *   · 而且崩溃/关闭时渲染层的异步写可能丢，主进程同步追加最稳。
 *
 * ★ 默认关闭。只有下面两个条件之一成立才写盘：
 *   ① 命令行带 `--diag-render`；
 *   ② userData 目录下存在标记文件 `render-diag.on`。
 *   生产用户机器上两者都不会有，因此这段代码等于不存在（不影响正常包）。
 *
 * 日志路径：%APPDATA%\秋夕月拾旧-PDF阅读器\render-diag.log
 *   每次启动会把上一轮的日志挪到 render-diag.log.prev，
 *   所以「用户复现完直接关掉」这一轮的内容永远在 render-diag.log 里。
 */

import { app } from 'electron'
import { appendFileSync, existsSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 单个日志文件的字节上限；超了就不再写，避免异常循环把磁盘写满 */
const MAX_BYTES = 8 * 1024 * 1024

let enabled = false
let logPath = ''
let written = 0

/** 标记文件的完整路径（同时也是「怎么打开诊断」的答案） */
export function diagMarkerPath(): string {
  try {
    return join(app.getPath('userData'), 'render-diag.on')
  } catch {
    return ''
  }
}

/** 诊断日志文件路径（未启用时也返回，方便提示用户） */
export function diagLogPath(): string {
  if (logPath) return logPath
  try {
    return join(app.getPath('userData'), 'render-diag.log')
  } catch {
    return ''
  }
}

export function initDiagLog(): boolean {
  try {
    logPath = join(app.getPath('userData'), 'render-diag.log')
    enabled = process.argv.includes('--diag-render') || existsSync(diagMarkerPath())
    if (!enabled) return false

    // 上一轮的日志挪走：保证 render-diag.log 永远是「最近一次运行」
    if (existsSync(logPath)) {
      try {
        renameSync(logPath, `${logPath}.prev`)
      } catch {
        /* 挪不动就直接覆盖 */
      }
    }
    writeFileSync(logPath, '', 'utf8')
    written = 0
    diagLine('=== 诊断启动 ===')
    diagLine(`日志文件 ${logPath}`)
    diagLine(`命令行 ${process.argv.slice(1).join(' ')}`)
    diagLine(`Electron ${process.versions.electron}  Chromium ${process.versions.chrome}`)
    return true
  } catch {
    enabled = false
    return false
  }
}

/**
 * 追加一行诊断日志。
 *
 * 贴的是渲染层的时间戳（调用方自带），主进程不再补时间，避免两套时钟对不上。
 */
export function diagLine(text: string): void {
  if (!enabled) return
  try {
    if (written > MAX_BYTES) return
    const line = `${text}\n`
    appendFileSync(logPath, line, 'utf8')
    written += Buffer.byteLength(line)
  } catch {
    /* 诊断日志失败绝不影响阅读器本身 */
  }
}

export function diagBytes(): number {
  try {
    return existsSync(logPath) ? statSync(logPath).size : 0
  } catch {
    return -1
  }
}

/** 本次运行是否真的在写诊断日志 */
export function diagEnabled(): boolean {
  return enabled
}
