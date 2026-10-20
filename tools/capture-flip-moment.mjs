// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 用「截图」而不是「读画布像素」来验证加载瞬间的画面。
 *
 * ★ 为什么要换判据
 *   `getImageData` 读的是画布自己的像素缓冲。新建的 <canvas> 是全零，
 *   而「全零」既可能是「透明」（用户看到的是底下的白纸），
 *   也可能是「不透明黑」（用户看到黑板）—— 光看像素数组分不出来。
 *   之前据此把冷启动第一页判成「★全黑」，修了半天 CSS，症状不变，
 *   就是因为量错了对象。
 *
 *   截图走的是合成器的输出，透明与否、底下垫了什么颜色，
 *   全都在里面了。这才是用户眼睛看到的东西。
 *
 * 用法：node tools/capture-flip-moment.mjs [端口]
 */

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const port = Number(process.argv[2] ?? 9280)

/*
 * ★★ 默认禁止运行（2026-10-15 起）★★
 *   本脚本是**唯一**会主动把 --hidden 的阅读器窗口显示出来的工具（见下面 show(true)），
 *   而它正是用户 seq21024「现在前台有一个空白无标题栏窗口弹出」最可能的来源：
 *   show-window.ps1 做的是 ShowWindow + SetForegroundWindow，窗口若还没画过内容，
 *   而阅读器又是 frame:false 的自绘标题栏窗口，屏幕上就是一个空白无标题栏的矩形。
 *   用户的硬约束是「你全程不能更改前台」「保证一切任务跑后台不影响正常使用」，
 *   所以这里在连 CDP 之前就拒绝启动；确需人工看截图时显式开口子：
 *       $env:PDF_READER_ALLOW_FOREGROUND = '1'
 *
 *   要「不显示窗口也能拿到画面」，用 tools/keep-frames.mjs 那套：
 *   隐藏窗口真正缺的是帧（合成器不产帧），开 Page.startScreencast 喂帧即可，
 *   verify-zoom-debounce / verify-flip-real 都靠它拿到隐藏窗口的真实画面。
 */
if (process.env.PDF_READER_ALLOW_FOREGROUND !== '1') {
  console.error('【已阻止】capture-flip-moment.mjs 需要把窗口显示出来才截得到图，这会改动前台。')
  console.error('  硬约束：全程不能更改前台、一切任务跑后台。')
  console.error('  替代方案：node tools/keep-frames.mjs <端口>（隐藏窗口也能出帧），')
  console.error('           或直接用 verify-flip-real.mjs 的判据（它就是为隐藏窗口写的）。')
  console.error('  确需人工截图时：$env:PDF_READER_ALLOW_FOREGROUND = \'1\' 后再运行。')
  process.exit(3)
}

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'))
  if (!page) throw new Error('找不到页面目标')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  let id = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    const p = pending.get(msg.id)
    if (p) {
      pending.delete(msg.id)
      p(msg.result)
    }
  }
  const send = (method, params = {}) =>
    new Promise((res) => {
      const myId = ++id
      pending.set(myId, res)
      ws.send(JSON.stringify({ id: myId, method, params }))
    })
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (r.exceptionDetails) {
      throw new Error('表达式异常: ' + JSON.stringify(r.exceptionDetails.exception?.description))
    }
    return r.result.value
  }
  return { ws, send, evalJs }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const { ws, send, evalJs } = await connect()

/*
 * 页面必须可见才截得到图 —— 隐藏窗口下 captureScreenshot 会挂起。
 * 这里直接用 Win32 把窗口显示出来，测完再藏回去。
 * （能走到这里说明 PDF_READER_ALLOW_FOREGROUND=1，否则脚本开头就退了。）
 */
const show = (visible) =>
  spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-File',
      join(root, 'tools', visible ? 'show-window.ps1' : 'hide-window.ps1')
    ],
    { windowsHide: true, encoding: 'utf8' }
  )

console.log('=== 截图验证「加载瞬间用户看到什么」 ===\n')

show(true)
await sleep(2500)

/* 让第 1 页回到「从未渲染」的状态：重新加载整页最干净 */
await send('Page.enable', {})
await send('Page.reload', { ignoreCache: false })
await sleep(2600)

/* 冷启动后立刻连拍：这正是以前抓到全黑的那个时刻 */
const shots = []
for (let i = 0; i < 5; i++) {
  const t = Date.now()
  const r = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false
  })
  const name = `flip-moment-${i + 1}.png`
  if (r?.data) {
    writeFileSync(join(root, 'test-results', name), Buffer.from(r.data, 'base64'))
    shots.push(name)
    console.log(`  ${name}  用时 ${Date.now() - t}ms`)
  } else {
    console.log(`  第 ${i + 1} 张截图失败`)
  }
  await sleep(220)
}

/* 顺带把每一刻的画布状态记下来，和图片对得上 */
const states = await evalJs(`(function(){
  var el = document.querySelector('.pdf-page[data-page="1"]');
  if (!el) return '第一页节点不存在';
  var cv = el.querySelector('canvas.pdf-page__canvas');
  var wrap = el.querySelector('.pdf-page__cwrap');
  return JSON.stringify({
    画布: cv ? cv.width + 'x' + cv.height : '无',
    自带类: cv ? cv.className : '无',
    行内透明度: cv ? (cv.style.opacity || '(空)') : '无',
    计算透明度: cv ? getComputedStyle(cv).opacity : '无',
    阶段: wrap ? wrap.dataset.stage : null,
    容器背景色: wrap ? getComputedStyle(wrap).backgroundColor : null,
    容器有快照: wrap ? (wrap.style.backgroundImage ? '有' : '无') : null
  });
})()`)
console.log('\n当前状态: ' + states)

console.log(`\n截图已存到 test-results/：${shots.join(', ')}`)

show(false)
ws.close()
