// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 在隐藏实例里求值一段 JS，并把结果打印到 stdout。
 *
 * ── 为什么这个文件必须存在 ──────────────────────────────────
 *   四十多支 `tools/verify-*.mjs` 都靠这一条命令和实例对话：
 *
 *     spawnSync('node', [join(root, 'scripts', 'cdp-eval.mjs'), PORT, expr])
 *
 *   仓库里**唯独漏了这个脚本**（.gitignore 也没排除它，是漏提交），
 *   于是套件里绝大多数用例一跑就报
 *   `Cannot find module ... scripts/cdp-eval.mjs` ——
 *   看起来像「用例坏了」，实际只是缺一个共用工具。
 *
 * ── 用法 ────────────────────────────────────────────────────
 *   node scripts/cdp-eval.mjs <端口> "<JS 表达式>"
 *
 *   约定：
 *     · 表达式可以返回 Promise（awaitPromise: true）；
 *     · 结果是字符串就原样打印（用例普遍 `return JSON.stringify(...)`）；
 *     · 其他类型 JSON 化后打印；
 *     · 求值抛异常时把错误打进 stderr 并以退出码 1 结束，
 *       这样调用方的断言才会红，而不是静默拿到空串。
 *
 * 端口也可用环境变量 PDF_READER_PORT 给（部分脚本这样传）。
 */

import { argv, env, exit } from 'node:process'

const PORT = String(argv[2] ?? env.PDF_READER_PORT ?? '9229')
const EXPR = argv[3]

if (!EXPR) {
  console.error('用法：node scripts/cdp-eval.mjs <端口> "<JS 表达式>"')
  exit(2)
}

/** 等 CDP 端点可用（启动瞬间可能还没监听） */
async function listTargets(timeoutMs = 8000) {
  const started = Date.now()
  let lastError = null
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, {
        signal: AbortSignal.timeout(2000)
      })
      if (res.ok) return await res.json()
      lastError = new Error(`HTTP ${res.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw lastError ?? new Error('CDP 端点不可用')
}

/**
 * 挑页面目标。
 *
 * 优先 index.html 那个页面：实例里还可能有 print.html、
 * devtools 自身的页面，选错就求值到空白页上，读到的全是 undefined。
 */
function pickPage(targets) {
  const pages = targets.filter((t) => t.type === 'page')
  return pages.find((t) => String(t.url).includes('index.html')) ?? pages[0] ?? null
}

const targets = await listTargets()
const page = pickPage(targets)
if (!page?.webSocketDebuggerUrl) {
  console.error('✗ 找不到可求值的页面目标')
  exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
const opened = await new Promise((resolve) => {
  ws.onopen = () => resolve(true)
  ws.onerror = () => resolve(false)
})
if (!opened) {
  console.error('✗ 连不上 WebSocket 调试端点')
  exit(1)
}

let seq = 0
const pending = new Map()

ws.onmessage = (ev) => {
  let msg
  try {
    msg = JSON.parse(ev.data)
  } catch {
    return
  }
  if (!msg.id || !pending.has(msg.id)) return
  const entry = pending.get(msg.id)
  pending.delete(msg.id)
  if (msg.error) entry.reject(new Error(msg.error.message))
  else entry.resolve(msg.result)
}

function send(method, params, timeout = 60000) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP 超时：${method}`))
    }, timeout)
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      reject: (e) => {
        clearTimeout(timer)
        reject(e)
      }
    })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

try {
  const result = await send('Runtime.evaluate', {
    expression: EXPR,
    awaitPromise: true,
    returnByValue: true,
    /* 让用例里 `return` 的写法也能用：包一层函数比拼接字符串稳 */
    userGesture: true
  })

  if (result.exceptionDetails) {
    const detail =
      result.exceptionDetails.exception?.description ??
      result.exceptionDetails.text ??
      '求值异常'
    console.error(detail)
    exit(1)
  }

  const value = result.result?.value
  if (value === undefined) {
    /* undefined 也要打印点东西，否则调用方分不清「没输出」和「失败」 */
    console.log('undefined')
  } else if (typeof value === 'string') {
    console.log(value)
  } else {
    console.log(JSON.stringify(value))
  }
} catch (error) {
  console.error(String(error?.message ?? error))
  exit(1)
} finally {
  try {
    ws.close()
  } catch {
    /* 忽略 */
  }
}
