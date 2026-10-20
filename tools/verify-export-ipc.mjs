// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 验证「导出为新的 PDF」的 IPC 链（不弹系统对话框的那一半）。
 *
 * ── 为什么单独测这一半 ─────────────────────────────────────────
 *   导出全链路 = 渲染层把批注画成每页一张透明 PNG
 *              → 主进程用 pdf-lib 把 PNG 烘焙进源 PDF
 *              → 写文件。
 *   用户路径的最后一步会弹「另存为」原生对话框 —— 自动化里一旦弹出来
 *   就是整个套件挂死（没人点确定）。所以这条链上的**落盘/校验逻辑**
 *   必须能用 targetPath 直接驱动，也就是本脚本做的事：
 *   一个对话框都不弹，只考主进程。
 *
 * ── 约定 ──────────────────────────────────────────────────────
 *   · 传 targetPath 时主进程**不得**弹对话框（pdf:export 的自动化入口）；
 *   · 覆盖原文件必须被拒绝（导出是「另存为」语义，src/main/index.ts:932-934）；
 *   · 源文件不存在必须被拒绝（同文件 915-917），而不是抛异常或写出空文件；
 *   · 失败路径**不能**碰源文件（原稿被自动化脚本改掉是不可接受的）。
 *
 * 用法：node tools/verify-export-ipc.mjs [端口]
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument } from 'pdf-lib'

const PORT = Number(process.argv[2] ?? 9280)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'test-results', 'exports')
const outFile = join(outDir, 'ipc-export.pdf')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ============================================================
 * CDP 连接
 * ============================================================ */

async function pageTarget() {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    return list.find((t) => t.type === 'page' && t.url.includes('index.html')) ?? null
  } catch {
    return null
  }
}

const target = await pageTarget()
if (!target) {
  console.error(`✗ 端口 ${PORT} 上找不到页面目标 —— 请用套件起实例：node tools/run-verify-suite.mjs --dev ${PORT}`)
  process.exit(2)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res)
  ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')))
})

let msgId = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(String(ev.data))
  const cb = m.id ? pending.get(m.id) : null
  if (cb) {
    pending.delete(m.id)
    cb(m)
  }
})

function send(method, params = {}, timeout = 60000) {
  const id = (msgId += 1)
  return new Promise((res, rej) => {
    pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)))
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        rej(new Error(`CDP 超时：${method}`))
      }
    }, timeout)
  })
}

async function evaluate(expr, timeout) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, timeout)
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text
    throw new Error(`页面异常：${String(d).split('\n')[0]}`)
  }
  return r.result?.value
}

/* ============================================================
 * 断言收集（编号由 check() 自动给，输出「检查项 → 期望 → 实际」）
 * ============================================================ */

const fails = []
let checks = 0

function check(ok, label, expected, actual) {
  checks += 1
  console.log(`  ${ok ? '✓' : '✗'} ${String(checks).padStart(2, ' ')}. ${label}`)
  console.log(`        期望  ${expected}`)
  console.log(`        实际  ${actual}`)
  if (!ok) fails.push(`${label}｜期望：${expected}｜实际：${actual}`)
}

/** 页面里现画一张 2x2 红色 PNG，然后直接调导出 IPC —— 全程不碰 UI、不弹框 */
function exportCall(sourcePath, targetPath) {
  return `(async () => {
    const c = document.createElement('canvas');
    c.width = 2; c.height = 2;
    const g = c.getContext('2d');
    g.fillStyle = '#ff0000'; g.fillRect(0, 0, 2, 2);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const data = await blob.arrayBuffer();
    const res = await window.pdfApp.doc.exportPdf({
      sourcePath: ${JSON.stringify(sourcePath)},
      targetPath: ${JSON.stringify(targetPath)},
      pages: [{ page: 1, data }]
    });
    return JSON.stringify(res);
  })()`
}

async function pageCountOf(file) {
  const doc = await PDFDocument.load(readFileSync(file), { ignoreEncryption: true })
  return doc.getPageCount()
}

async function firstPageSize(file) {
  const doc = await PDFDocument.load(readFileSync(file), { ignoreEncryption: true })
  const { width, height } = doc.getPage(0).getSize()
  return { width, height }
}

/** 数一数文件里有多少个图片对象（PDF 里就是 /Subtype /Image） */
const countImages = (file) => {
  const buf = readFileSync(file)
  return buf.toString('latin1').split('/Subtype /Image').length - 1
}

/* ============================================================
 * 开跑
 * ============================================================ */

console.log(`=== 导出 IPC（pdf:export，无对话框路径）验证（端口 ${PORT}）===`)
console.log(`  目标    ${target.url}`)
console.log(`  输出目录 ${outDir}\n`)

mkdirSync(outDir, { recursive: true })
rmSync(outFile, { force: true })

/* ── 前置 ───────────────────────────────────────────────────── */

const src = String(await evaluate(`window.__store.getState().filePath || ''`))
const bridge = await evaluate(`typeof window.pdfApp?.doc?.exportPdf`)
const srcPages = existsSync(src) ? await pageCountOf(src) : 0
const srcSize = existsSync(src) ? await firstPageSize(src) : null
const srcImages = existsSync(src) ? countImages(src) : 0
const srcBytes = existsSync(src) ? statSync(src).size : 0

console.log(`  源文件  ${src}`)
console.log(`  源页数  ${srcPages}，第 1 页 ${srcSize ? `${srcSize.width.toFixed(1)}x${srcSize.height.toFixed(1)}` : '?'}，图片对象 ${srcImages}，${srcBytes} 字节\n`)

check(
  bridge === 'function' && existsSync(src),
  '前置：实例里已打开一份文档，且 preload 暴露了 exportPdf（测试挂钩可用）',
  "typeof window.pdfApp.doc.exportPdf === 'function'、store 里的 filePath 在磁盘上存在",
  `exportPdf=${bridge}、filePath 存在=${existsSync(src)}`
)
check(
  srcPages >= 1 && !!srcSize,
  '前置：源文件能被 pdf-lib 解析（后面所有比较都以它为基准）',
  '能加载且页数 ≥ 1',
  `页数 ${srcPages}、第 1 页 ${srcSize ? `${srcSize.width.toFixed(1)}x${srcSize.height.toFixed(1)}` : '读不到'}`
)

/* ── 场景 A：正常导出（传 targetPath → 一个对话框都不弹） ────── */

console.log('\n场景 A：传 targetPath 直接导出（自动化入口，不弹「另存为」）…')
const aRaw = await evaluate(exportCall(src, outFile), 120000)
const a = JSON.parse(aRaw)
console.log(`  返回值  ${aRaw}`)

check(
  a?.ok === true && typeof a.path === 'string' && resolve(a.path) === resolve(outFile),
  '导出返回 ok:true，且 path 就是指定的 targetPath',
  `{ ok: true, path: "${outFile}" }`,
  JSON.stringify(a)
)
check(
  a?.baked === 1,
  '导出报告烘焙了 1 页批注图层（payload 里就给了 1 页）',
  'baked === 1',
  `baked=${JSON.stringify(a?.baked)}`
)
check(
  a?.pages === srcPages,
  '导出报告的 pages 是**源文件总页数**（不是 payload 的页数）',
  `pages === ${srcPages}`,
  `pages=${JSON.stringify(a?.pages)}`
)
check(
  existsSync(outFile) && statSync(outFile).size > 1000,
  '文件真的写到了磁盘上（不是只返回了个 ok）',
  `${outFile} 存在且 > 1000 字节`,
  existsSync(outFile) ? `${statSync(outFile).size} 字节` : '文件不存在'
)

const outPages = existsSync(outFile) ? await pageCountOf(outFile) : 0
const outSize = existsSync(outFile) ? await firstPageSize(outFile) : null
const outImages = existsSync(outFile) ? countImages(outFile) : 0
check(
  outPages === srcPages,
  '导出的 PDF 是合法文件，且页数与源文件一致（没有只导出那一页）',
  `getPageCount() === ${srcPages}`,
  `getPageCount() === ${outPages}`
)
check(
  !!outSize && !!srcSize && Math.abs(outSize.width - srcSize.width) <= 0.5 && Math.abs(outSize.height - srcSize.height) <= 0.5 &&
    Math.abs(outSize.width - 595.3) <= 1 && Math.abs(outSize.height - 841.9) <= 1,
  '导出后第 1 页尺寸不变（A4 595.3x841.9 ±1，批注图层按整页铺满、没把页面改尺寸）',
  `源 ${srcSize?.width.toFixed(1)}x${srcSize?.height.toFixed(1)} → 导出 ${outSize?.width.toFixed(1)}x${outSize?.height.toFixed(1)}（A4 595.3x841.9 ±1）`,
  outSize ? `导出第 1 页 ${outSize.width.toFixed(2)}x${outSize.height.toFixed(2)}` : '读不到导出文件的第 1 页'
)
check(
  outImages > srcImages,
  '批注那张 PNG 真的被嵌进 PDF 了（图片对象数量比源文件多）',
  `输出图片对象数 > 源文件 ${srcImages}`,
  `输出 ${outImages}`
)

/* ── 场景 B：拒绝覆盖原文件，且绝不碰原稿 ───────────────────── */

console.log('\n场景 B：targetPath 指向源文件本身 → 必须拒绝（导出是「另存为」语义）…')
const bRaw = await evaluate(exportCall(src, src), 120000)
const b = JSON.parse(bRaw)
console.log(`  返回值  ${bRaw}`)

check(
  b?.ok === false && typeof b.error === 'string' && b.error.includes('不能覆盖原文件'),
  '覆盖原文件被拒绝，错误信息可读',
  'ok:false 且 error 含「不能覆盖原文件」',
  JSON.stringify(b)
)
const srcPagesAfter = existsSync(src) ? await pageCountOf(src) : 0
const srcBytesAfter = existsSync(src) ? statSync(src).size : 0
check(
  srcPagesAfter === srcPages && srcBytesAfter === srcBytes,
  '被拒绝之后源文件**一个字节都没变**（原稿必须安全）',
  `仍是 ${srcPages} 页、${srcBytes} 字节`,
  `现在是 ${srcPagesAfter} 页、${srcBytesAfter} 字节`
)

/* ── 场景 C：源文件不存在 → 明确报错，不写空文件 ─────────────── */

console.log('\n场景 C：sourcePath 不存在 → 必须明确拒绝…')
const ghost = join(outDir, '根本不存在的源文件.pdf')
rmSync(ghost, { force: true })
const cRaw = await evaluate(exportCall(ghost, join(outDir, 'ipc-export-ghost.pdf')), 60000)
const c = JSON.parse(cRaw)
console.log(`  返回值  ${cRaw}`)

check(
  c?.ok === false && typeof c.error === 'string' && c.error.length > 0,
  '源文件不存在时返回 ok:false + 非空错误信息（不是抛异常、也不是静默成功）',
  'ok:false 且 error 非空',
  JSON.stringify(c)
)
check(
  !existsSync(join(outDir, 'ipc-export-ghost.pdf')),
  '源文件不存在时没有留下半个空文件',
  'ipc-export-ghost.pdf 不存在',
  existsSync(join(outDir, 'ipc-export-ghost.pdf')) ? '居然被创建了' : '不存在'
)

/* ── 收尾：清理本次产物 ─────────────────────────────────────── */

rmSync(outFile, { force: true })
rmSync(join(outDir, 'ipc-export-ghost.pdf'), { force: true })
console.log(`\n  清理    ${outFile} 已删除`)

ws.close()
await sleep(200)

console.log(`\n=== 结果：${checks} 项检查，${fails.length} 项失败 ===`)
if (fails.length) {
  console.log('\n失败原文：')
  for (const f of fails) console.log(`  ✗ ${f}`)
  process.exit(1)
}
process.exit(0)
