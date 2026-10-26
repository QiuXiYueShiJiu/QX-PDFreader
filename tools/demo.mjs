// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 演示脚本：启动可见窗口并自动做一次批注，供用户实际查看。
 *
 * 与测试脚本的区别：**窗口是显示的**（不加 --hidden），
 * 因为用户要亲眼看效果。测试时才用 --hidden 避免打扰。
 *
 * 用法：node tools/demo.mjs [--pdf <路径>] [--port 9223]
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const argv = process.argv.slice(2)
function opt(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const port = Number(opt('port', '9223'))
const pdf =
  opt('pdf', '') ||
  join(process.env.USERPROFILE ?? '', 'Desktop', '生物', '参考答案.pdf')

function runHidden(cmd, args) {
  return spawnSync(cmd, args, { windowsHide: true, encoding: 'utf8', cwd: root })
}

/* ---------- 清场 ---------- */
for (const name of ['秋夕-PDF阅读器.exe', '秋夕月拾旧-PDF阅读器.exe', 'QXPDFReader.exe', '智慧黑板PDF阅读器.exe', 'electron.exe']) {
  const r = runHidden('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH'])
  if ((r.stdout || '').includes(name)) runHidden('taskkill', ['/F', '/IM', name])
}
await new Promise((r) => setTimeout(r, 1500))

/* ---------- 启动（可见窗口） ---------- */
const launchExe = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
if (!existsSync(launchExe)) {
  console.error(`找不到 electron.exe: ${launchExe}`)
  process.exit(1)
}

// 注意：这里**不加 --hidden**，窗口要显示出来给用户看
const args = ['.', `--remote-debugging-port=${port}`]
if (pdf && existsSync(pdf)) args.push(pdf)

console.log('启动可见窗口…')
console.log(`  PDF: ${pdf}`)

const child = spawn(launchExe, args, {
  windowsHide: true,
  detached: true,
  stdio: 'ignore',
  cwd: root
})
child.unref()

// 等窗口与文档加载完成
await new Promise((r) => setTimeout(r, 14000))

/* ---------- 用 CDP 做一次演示批注 ---------- */
const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
const page = list.find((t) => t.type === 'page')
if (!page) {
  console.error('★ 没有页面目标，应用可能未启动')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res)
  ws.addEventListener('error', () => rej(new Error('CDP 连接失败')))
})

let nextId = 0
function send(method, params = {}) {
  const id = ++nextId
  return new Promise((resolve) => {
    const onMsg = (event) => {
      const m = JSON.parse(String(event.data))
      if (m.id !== id) return
      ws.removeEventListener('message', onMsg)
      resolve(m.result)
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return r?.result?.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* 1. 开启手绘并画一个圈 */
console.log('演示：开启手绘…')
await evaluate(`(() => {
  const btns = Array.from(document.querySelectorAll('.tb'));
  const pen = btns.find(b => b.textContent.includes('手绘'));
  if (pen && pen.getAttribute('aria-pressed') !== 'true') pen.click();
})()`)
await sleep(500)

const box = JSON.parse(
  await evaluate(`(() => {
    const p = document.querySelector('.pdf-page');
    const r = p.getBoundingClientRect();
    return JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) });
  })()`)
)

// 画一个椭圆圈（选一处正文区域）
const cx = box.left + box.width * 0.35
const cy = box.top + box.height * 0.45
const rx = box.width * 0.16
const ry = box.height * 0.05

console.log('演示：绘制圈选笔迹…')
await send('Input.dispatchMouseEvent', {
  type: 'mousePressed',
  x: Math.round(cx + rx),
  y: Math.round(cy),
  button: 'left',
  clickCount: 1,
  pointerType: 'mouse'
})
for (let i = 1; i <= 40; i++) {
  const a = (i / 40) * Math.PI * 2
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(cx + Math.cos(a) * rx),
    y: Math.round(cy + Math.sin(a) * ry),
    button: 'left',
    buttons: 1,
    pointerType: 'mouse'
  })
}
await send('Input.dispatchMouseEvent', {
  type: 'mouseReleased',
  x: Math.round(cx + rx),
  y: Math.round(cy),
  button: 'left',
  clickCount: 1,
  pointerType: 'mouse'
})
await sleep(1000)

/* 2. 退出手绘，避免影响用户操作 */
await evaluate(`(() => {
  const btns = Array.from(document.querySelectorAll('.tb'));
  const pen = btns.find(b => b.textContent.includes('手绘'));
  if (pen && pen.getAttribute('aria-pressed') === 'true') pen.click();
})()`)
await sleep(400)

/* 3. v2.1.2.0 起右侧「批注」列表已下线：笔迹直接画在页面上，不再打开侧栏 */
console.log('演示：右侧批注列表已下线（批注直接显示在页面上）…')

/* 4. 把窗口带到前台 */
await evaluate(`window.focus()`)

ws.close()

console.log('\n演示就绪：')
console.log('  · 页面上有一个红色的圈选笔迹（手绘批注）')
console.log('  · 窗口已显示，可以直接操作试用')
console.log('\n提示：窗口保持打开；要我关掉时说一声即可。')
