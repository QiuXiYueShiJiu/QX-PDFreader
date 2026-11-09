// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 崩溃/异常日志（主进程侧，默认常开）。
 *
 * 为什么单独一个文件而不是复用 diag-log：
 *   diag-log 是给「页面宽度抖动」那种可复现问题用的，默认关闭、要放标记文件才写。
 *   而「软件偶尔闪退」这类问题是事后追溯：等用户报告时现场已经没了，
 *   必须有一个**不需要用户提前准备**、只记录异常、体积很小、会轮转的日志。
 *
 * 记录什么：
 *   · 主进程未捕获异常 / 未处理的 Promise 拒绝
 *   · 渲染进程崩溃、GPU/工具进程退出、preload 出错、窗口无响应
 *   · 窗口 close / closed（区分「用户关的」和「自己关的」）
 *   · 渲染层 window.onerror / unhandledrejection（经 IPC 转发）
 *   · 每次启动一行头（版本、argv、启动序号），用来对齐「哪次启动出的问题」
 *
 * 不记录什么：正常操作的流水。只有异常才写，所以平时这个文件几乎不增长。
 *
 * 路径：%APPDATA%\秋夕月拾旧-PDF阅读器\crash.log
 *   · 超过 512 KB 滚到 crash.log.prev（只留一轮）
 *   · 写失败绝不影响阅读器本身（全部 try/catch 吞掉）
 */

import { app } from 'electron'
import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_BYTES = 512 * 1024

let logPath = ''
let written = 0
let bootSeq = 0
let ready = false

/** 读取/写入用的绝对路径；未初始化时返回空串 */
export function crashLogPath(): string {
  if (logPath) return logPath
  try {
    return join(app.getPath('userData'), 'crash.log')
  } catch {
    return ''
  }
}

function rotateIfNeeded(): void {
  try {
    if (!existsSync(logPath)) return
    if (statSync(logPath).size < MAX_BYTES) return
    renameSync(logPath, `${logPath}.prev`)
  } catch {
    /* 轮转失败就继续追加，宁可大一点也不要丢信息 */
  }
}

/** 启动时调用一次。返回日志路径（便于界面上展示「日志在哪」）。 */
export function initCrashLog(): string {
  try {
    logPath = join(app.getPath('userData'), 'crash.log')
    rotateIfNeeded()
    bootSeq = Date.now()
    written = existsSync(logPath) ? statSync(logPath).size : 0
    ready = true

    const header = [
      '',
      '==================== 启动 ====================',
      `时间     ${new Date().toISOString()}`,
      `启动号   ${bootSeq}`,
      `版本     ${app.getVersion()}  (build ${process.env['QX_BUILD_VERSION'] ?? '?'})`,
      `Electron ${process.versions.electron}  Chromium ${process.versions.chrome}  Node ${process.versions.node}`,
      `命令行   ${stripAbsolutePaths(process.argv.slice(1).join(' '))}`,
      `数据目录 ${stripAbsolutePaths(app.getPath('userData'))}`,
    ].join('\n')
    append(logPath, header + '\n')
    return logPath
  } catch {
    ready = false
    return ''
  }
}

/**
 * 去掉绝对路径，只留文件名。
 *
 * ★ 隐私要求（A 与用户都提过）：日志里不能出现 `D:\班级资料\张三\试卷.pdf`
 *   这种路径 —— 里面有学生姓名和班级。凡是 `盘符:\…\name.ext` 一律压成 `name.ext`。
 *   堆栈里的 node_modules 路径同样处理，反正定位问题靠文件名 + 行号就够了。
 */
function stripAbsolutePaths(text: string): string {
  return text
    .replace(/[A-Za-z]:\\[^\s'"()<>]*\\([^\s\\'"()<>]+)/g, '$1')
    .replace(/\/[^\s'"()<>]*\/([^\s/'"()<>]+)/g, '$1')
}

function append(file: string, text: string): void {
  try {
    appendFileSync(file, text, 'utf8')
    written += Buffer.byteLength(text)
  } catch {
    /* 日志失败不能影响功能 */
  }
}

/**
 * 写一条异常记录。
 *
 * @param kind  短标签，如 `uncaughtException` / `render-process-gone`
 * @param detail 任意可序列化内容；字符串原样写，其余尽量 JSON 化
 */
export function crashLog(kind: string, detail?: unknown): void {
  if (!ready) return
  try {
    const time = new Date().toISOString()
    let body: string
    if (detail === undefined) {
      body = ''
    } else if (typeof detail === 'string') {
      body = detail
    } else if (detail instanceof Error) {
      body = `${detail.name}: ${detail.message}\n${detail.stack ?? ''}`
    } else {
      try {
        body = JSON.stringify(detail)
      } catch {
        body = String(detail)
      }
    }
    append(logPath, `[${time}] ${kind}  ${body}\n`)
    // 控制台也留一份，开发时能直接看到（打包后没有控制台，只写文件）
    if (process.env['NODE_ENV'] !== 'production') console.error(`[crash] ${kind}`, detail)
  } catch {
    /* 同上 */
  }
}

/** 本次运行实际写入的字节数（用于界面上显示「日志有多大」） */
export function crashLogBytes(): number {
  try {
    return existsSync(logPath) ? statSync(logPath).size : written
  } catch {
    return written
  }
}
