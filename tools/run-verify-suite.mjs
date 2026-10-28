// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 一次性跑完整套「已构建产物」验证 —— 交付前的最后一道关。
 *
 * ── 为什么需要它 ────────────────────────────────────────────
 *   此前每个 verify-*.mjs 都自己 spawn 一个 **dev 版 electron** 并占一个端口，
 *   跑九个脚本就要开关九次窗口，还会互相抢端口、把 CDP 视口覆盖带过去。
 *   更重要的是：那样验证的是 `out/` 这份构建产物，
 *   而**用户装的是安装包里的那份** —— 两者不一致时（打包漏文件、
 *   资源版本没写对、asar 里少了个 worker）验证全绿也说明不了问题。
 *
 *   所以这里只做两件事：
 *     ① 起**一个**实例（默认就是已安装的 exe），加 --hidden 不占前台；
 *     ② 把纯「连端口」的验证脚本依次跑一遍，收集退出码。
 *
 * ── 为什么 --hidden 是硬要求 ────────────────────────────────
 *   用户的硬约束：全程不能更改前台、任务跑后台不影响正常使用。
 *   `--hidden` 让窗口从创建到销毁都不 show()（src/main/index.ts:212,239-245），
 *   而 CDP 对隐藏窗口完全有效，所以验证全程前台不动。
 *
 * ── 不放进套件的脚本，以及为什么 ────────────────────────────
 *   verify-flip-real.mjs / verify-scroll-pressure.mjs **自己会 spawn 实例**，
 *   而且起手就 `Get-Process electron | Stop-Process` —— 会把本脚本起的实例一起杀掉，
 *   套件后面几个脚本就全废了。这两个的渲染层判据已由 verify-zoom-stability.mjs
 *   （同样是逐页/加压取样，但连端口）覆盖，需要单独跑时手动来。
 *
 * 用法：
 *   node tools/run-verify-suite.mjs                          # 验证已安装的 安装目录
 *   node tools/run-verify-suite.mjs <exe路径> [端口] [脚本...]
 *   node tools/run-verify-suite.mjs --dev [端口] [脚本...]    # 跑 out/ + dev 版 electron
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, openSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installedExe, fixturePath } from '../scripts/packaging-paths.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const argv = process.argv.slice(2)
const devMode = argv.includes('--dev')
const rest = argv.filter((a) => a !== '--dev')

const DEFAULT_INSTALLED = installedExe()
const PDF = fixturePath()
const EXE = devMode
  ? join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  : (rest[0] ?? DEFAULT_INSTALLED)
const PORT = (devMode ? rest[0] : rest[1]) ?? '9290'

/** 默认套件：全部是「连端口」型，自己不起进程 */
const DEFAULT_SUITE = [
  'verify-bundle-markers.mjs', // 静态自检：产物里 v2.0 的标记齐不齐（源码改了没 build 时先红在这，不用等端到端）
  'verify-fixture.mjs', // ★ 夹具自检：金标准测试 PDF 真的覆盖所有需求（页数/尺寸/旋转/书签/位图/文字层）
  /* —— 缩放 / 视图手感 —— */
  'verify-zoom-stability.mjs', // 冷启动 + 逐页加压 + 缩放档位，全程采「不透光暗点」
  'verify-zoom-debounce.mjs', // 手势期间不动位图、停手后追上版面
  'verify-view-modes.mjs', // 四种视图模式真的改版面、且当前页有内容
  'verify-toolbar-adaptive.mjs', // 窄窗收文字 / 很窄出溢出菜单 / 不溢出
  'verify-wheel-gesture.mjs', // 150ms 手势窗口 + 逐手势累加 + 大 delta 归一化
  'verify-textlayer-scale.mjs', // 文字层选字质量（--scale-factor 必须定义）+ 漫游不按文本选字
  'verify-touch-zoom-guard.mjs', // 触摸屏快速滑动不再被误判成双击/捏合（用户报的「滑动后页面宽度变化」）
  /* —— 用户报过的重点 bug —— */
  'verify-jump-navigation.mjs', // 左侧导航点缩略图真的滚到那一页
  'verify-pen-e2e.mjs', // 起笔 / 大量 pointermove 不丢点 / 收笔落成批注
  'verify-drawbar.mjs', // 颜色盘唯一、粗细连续滑块、改色改粗真的影响笔迹、退出绘画后置灰不隐藏
  'verify-roam.mjs', // 漫游工具：手形图标 / 三工具恒有一个激活 / 点两次不退出 / 拖动平移 / 文字层让位 / Esc 回漫游
  'verify-eraser-e2e.mjs', // 橡皮端到端（含「按钮不被工具条遮挡」）
  'verify-multitouch-ink.mjs', // 多指并写不串点 / 中途抬指不丢点 / 上限 4 指 / 笔指共存 / 掌心擦除 / 多指擦除
  'verify-text-edit.mjs', // 选择工具下改文字内容 + 改字号/颜色（涂白盖原文 + 新文字落原位）
  'verify-touch-select.mjs', // ★ 选择工具的**触摸**交互：长按选词 / 拖动扩选 / 轻点取消 / 双击选词 / 拖动平移 / 跨页选区不丢工具条
  'verify-touch-real.mjs', // ★ 真触摸管线（Input.dispatchTouchEvent）：长按 360ms 选词 / 双击选词不缩放 / 一按就拖平移 + 惯性
  'verify-select.mjs', // ★ 选择工具的**鼠标**交互：跨行拖选 / 反向拖选 / 点灰底清选区 / 双击选词 / 高亮矩形落在页内（含「拖两行只选 1 个字」回归）
  'verify-ocr.mjs', // 扫描页 OCR：识别当前页画布 / 文字层可选中 / 选中后可进改文字（tesseract 资源与 CSP 的回归）
  'verify-teaching.mjs',
  'verify-update.mjs',
  'verify-theme.mjs', // 主题 9 档凭据与对比度、Metro 直角、自定义背景图的 CSS 变量与解码
  'verify-theme-pack.mjs', // 主题包：3 个包 / 每包设置 / 分段控件不溢出（用户报的横向溢出）
  'verify-tools.mjs', // PDF 工具箱：面板入口 + 水印/元数据两条真链路 + 高级 API 齐全（离线）
  'verify-newpdf.mjs',
    'verify-impose.mjs', // 新建空白 PDF：工具栏入口 / 对话框默认值 / 页数方向底色 / 创建后多标签且不顶掉旧文档
  'verify-content-edit.mjs', // 内容编辑入口冒烟：工具接线 / 画-选-删链路 / 文字层让位 / 漫游态不误建物件
  'verify-edit-shapes.mjs', // 直线 / 箭头：方向不丢、零厚度撑热区、箭头三笔画、可拉伸
  'verify-page-edit.mjs',
  'verify-rail-height.mjs', // 右栏随高度降档、永不滚动（B4）
  'verify-image-float.mjs', // 图片工具入口在上栏、面板可拖动（B5）
  'verify-theme-store.mjs', // 主题商店：入口在设置里 + 清单新字段（B9）
  'verify-store-detail.mjs', // 插件商店：分类/详情/一键更新（B10）
  'verify-plugin-store.mjs', // 插件商店：安装 / 权限闸门 / 命令 / 启停 / 卸载
  'verify-compare.mjs', // 分屏对比：右侧参考窗 / 独立滚动 / 关闭还原
  'verify-rollback.mjs', // 紧急回滚：列表 / 同版本防呆 / 启动计数 / 设置页区块
  'verify-export-ipc.mjs', // 导出为新 PDF 的 IPC（带 targetPath 不弹框）：落盘、可解析、拒绝覆盖源文件
  'verify-no-foreground.mjs', // 前台不被改动：第二实例转交文件时不许把隐藏窗口拽到前台
  /* —— 退出相关的三支已从默认套件移除（用户 2026-10-19 要求：测试不需要测退出）——
   *   verify-quit-flow / verify-quit-dialog / verify-native-dialogs 仍然保留脚本本身，
   *   需要时单独跑：node tools\\run-verify-suite.mjs --dev <端口> verify-quit-flow.mjs
   */
  'verify-tabs.mjs'
] // DEFAULT_SUITE 末尾（verify-tabs 会真的退出一次应用，必须最后）

const positionalCount = devMode ? 1 : 2
const suite = rest.length > positionalCount ? rest.slice(positionalCount) : DEFAULT_SUITE

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function pageTarget() {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    return list.find((t) => t.type === 'page' && t.url.includes('index.html')) ?? null
  } catch {
    return null
  }
}

async function waitReady(seconds) {
  const t0 = Date.now()
  while ((Date.now() - t0) / 1000 < seconds) {
    await sleep(700)
    if (!(await pageTarget())) continue
    const r = spawnSync(
      'node',
      [
        join(root, 'scripts', 'cdp-eval.mjs'),
        PORT,
        `(() => { try { const s = window.__store.getState(); return s.pageCount ? 'ready:' + s.pageCount : 'no' } catch (e) { return 'no' } })()`
      ],
      { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 15000 }
    )
    const out = `${r.stdout ?? ''}`.trim()
    if (out.startsWith('ready:')) {
      return { pages: out.slice(6), seconds: ((Date.now() - t0) / 1000).toFixed(1) }
    }
  }
  return null
}

/*
 * 只杀「本套件起的那个实例」——按调试端口认，绝不误伤用户自己开着的阅读器。
 *
 * ★ 这里踩过一次坑（2026-10-15 晚）：老实现是 `Get-Process QXPDFReader | Stop-Process`，
 *   ① dev 模式起的实例叫 electron.exe，**根本杀不掉** → 实例常驻，
 *   ② 下一次跑套件时端口还占着，waitReady 连的是**上一轮那个残留实例**，
 *      新起的实例撞 requestSingleInstanceLock 直接退出 —— 于是「验证的是谁」都是错的，
 *      主进程日志还会因为文件被重新截断而丢失行。
 *   现在：按端口找出监听进程，taskkill /T 连子进程一起收，并在启动前确认端口已空。
 */
function killByPort() {
  spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--remote-debugging-port=${PORT}*' -and $_.CommandLine -notlike '*--type=*' } | ForEach-Object { & taskkill.exe /PID $_.ProcessId /T /F 2>&1 | Out-Null }`
    ],
    { windowsHide: true, stdio: 'ignore' }
  )
}

/** 端口的监听进程 pid（拿它跟「我们 spawn 的那个」对账，防止验证到残留实例） */
function portOwnerPid() {
  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`
    ],
    { windowsHide: true, encoding: 'utf8' }
  )
  const v = Number.parseInt(`${r.stdout ?? ''}`.trim(), 10)
  return Number.isFinite(v) ? v : null
}

async function portFree(seconds) {
  const t0 = Date.now()
  while ((Date.now() - t0) / 1000 < seconds) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/json/list`)
    } catch {
      return true
    }
    killByPort()
    await sleep(500)
  }
  return false
}

if (!existsSync(EXE)) {
  console.error(`✗ 找不到可执行文件：${EXE}`)
  process.exit(2)
}

console.log(`=== 验证套件 ===`)
console.log(`  目标    ${EXE}${devMode ? '  (dev 版 electron，验证 out/)' : '  (已安装版)'}`)
console.log(`  端口    ${PORT}`)
console.log(`  脚本    ${suite.join(', ')}\n`)

/* 先把可能占着端口的旧实例清掉，并确认端口真的空了 */
killByPort()
if (!(await portFree(15))) {
  console.error(`✗ 端口 ${PORT} 被别的进程占着，清不掉 —— 先查 Get-NetTCPConnection -LocalPort ${PORT}`)
  process.exit(2)
}
await sleep(600)

/*
 * ★ 必须把 PDF 路径当命令行参数传进去：
 *   主进程用 extractFileArg(process.argv) 取它（src/main/index.ts:89），
 *   `--hidden` 只是不 show() 窗口（src/main/index.ts:212,239-245），读取照常。
 *   不带这个参数的话 store 里 pageCount 永远是 0，后面每个脚本都无页可测。
 *
 * ★ `--allow-native-dialogs` 是 2026-10-16 新增的**测试专用探针**
 *   （src/main/index.ts 的 DIALOG_PROBE）：
 *   隐藏模式下 app:quit 本来会跳过原生确认框直接退出，于是
 *   「退出确认框到底弹不弹得出来」这条路从来没被验证过 ——
 *   而用户报的「退出窗口不能正常弹出」正是这条路上的缺陷
 *   （注入清单里的 <dpiAwareness> 会让所有原生框把进程打崩，
 *     见 scripts/inject-dpi-manifest.mjs）。
 *
 * ★ 但**套件这一份实例不能带这个参数**（2026-10-18 修正）：
 *   带了之后「点退出应用」会真的弹出一个模态框，进程停在框上不退，
 *   verify-quit-dialog 的「隐藏模式下跳过确认框、处理完就退出」两条就假红
 *   （实测：日志收到请求、10 秒后实例还在）。
 *   verify-quit-flow 在**运行期**用 `setDialogProbe(true)` 打开探针
 *   （src/main/index.ts:1182，DIALOG_PROBE 是 let），足够让框弹出来；
 *   verify-native-dialogs 自己 spawn 一个实例并显式带这个参数。
 *   正式的启动与交付 exe 都不会带，线上行为不变。
 */
const args = devMode
  ? [
      '.',
      '--hidden',
      '--test-hooks',
      `--remote-debugging-port=${PORT}`,
      PDF
    ]
  : [
      '--hidden',
      '--test-hooks',
      `--remote-debugging-port=${PORT}`,
      PDF
    ]

/*
 * ★ 实例的 stdout 要留档（写到 test-results\instance-<端口>.log）。
 *   有的脚本得拿**主进程日志**当证据 —— 最典型的是 verify-quit-dialog.mjs：
 *   它要确认「点了退出按钮 → 主进程确实收到了一次 app:quit 请求」，
 *   而渲染层那侧挂不了探针（contextBridge 暴露的对象是深冻结的，
 *   赋值静默失败，见该脚本头部的说明）。日志是唯一可信证据。
 */
const INSTANCE_LOG = join(root, 'test-results', `instance-${PORT}.log`)
console.log(`启动：${EXE} ${args.join(' ')}`)
console.log(`主进程日志：${INSTANCE_LOG}`)
const instance = spawn(EXE, args, {
  cwd: devMode ? root : dirname(EXE),
  detached: true,
  stdio: ['ignore', openSync(INSTANCE_LOG, 'w'), openSync(INSTANCE_LOG, 'a')],
  windowsHide: true
})
instance.unref()

const ready = await waitReady(40)
if (!ready) {
  console.error('✗ 40 秒内没等到渲染层就绪（store 里没有 pageCount）')
  killByPort()
  process.exit(2)
}

/*
 * ★ 对账：端口上的监听者必须就是刚 spawn 的那个进程。
 *   不对账的话，一旦有残留实例占着端口，waitReady 会连上残留实例并「就绪」，
 *   而新实例早被 requestSingleInstanceLock 挡掉退出了 —— 整轮验证测的是谁都不知道。
 */
const owner = portOwnerPid()
if (owner !== null && instance.pid && owner !== instance.pid) {
  console.error(`✗ 端口 ${PORT} 的监听进程 pid=${owner}，不是本套件刚起的 pid=${instance.pid}（有残留实例）`)
  killByPort()
  process.exit(2)
}
console.log(`✓ 渲染层就绪（${ready.seconds}s，${ready.pages} 页，pid=${instance.pid}）\n`)
await sleep(1500)

/*
 * ★ 把帧节奏顶起来（隐藏窗口专治）。
 *
 *   从未 show() 过的窗口，Chromium 的合成器基本不产帧：
 *   实测隐藏实例 600ms 只有 1 帧 rAF（可见窗口是 36 帧上下）。
 *   而 pdf.js 的渲染任务是靠 rAF 排帧的，于是「停手后重渲染」
 *   会被拖到 1 秒开外 —— verify-zoom-debounce.mjs 因此时通时不通。
 *   这是**测量环境失真**，不是用户会遇到的 bug。
 *   起一个 keep-frames.mjs 开 Page.startScreencast，让隐藏实例也有帧，
 *   各脚本的时序才和用户的可见窗口一致。
 */
const framePump = spawn('node', [join(root, 'tools', 'keep-frames.mjs'), PORT], {
  cwd: root,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe']
})
framePump.stdout.on('data', (b) => process.stdout.write('[帧] ' + b))
framePump.stderr.on('data', (b) => process.stderr.write('[帧] ' + b))

const results = []
for (const script of suite) {
  console.log(`\n${'─'.repeat(64)}\n▶ ${script}\n${'─'.repeat(64)}`)
  const t0 = Date.now()
  const r = spawnSync('node', [join(root, 'tools', script), PORT], {
    cwd: root,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 300000,
    env: {
      ...process.env,
      PDF_READER_LOG: INSTANCE_LOG,
      PDF_READER_PORT: PORT,
      // 脚本要自己起「第二个实例」时得知道测的是哪一个 exe（verify-no-foreground.mjs）
      PDF_READER_EXE: EXE,
      ...(devMode ? { PDF_READER_DEV: '1' } : {})
    }
  })
  const out = `${r.stdout ?? ''}${r.stderr ? '\n[stderr] ' + r.stderr : ''}`
  process.stdout.write(out.endsWith('\n') ? out : out + '\n')
  const code = r.status ?? -1
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  results.push({ script, code, secs })
  console.log(`\n◀ ${script} 退出码 ${code}（${secs}s）`)
}

/* 收尾：先停帧泵，再关掉验证用的隐藏实例，前台干净退场 */
try {
  framePump.kill()
} catch {
  /* 已经退了就算了 */
}
killByPort()

console.log(`\n${'═'.repeat(64)}\n=== 汇总 ===`)
for (const r of results) {
  const mark = r.code === 0 ? '✓' : '✗'
  console.log(`  ${mark} ${r.script.padEnd(30)} 退出码 ${String(r.code).padStart(3)}  ${r.secs}s`)
}
const failed = results.filter((r) => r.code !== 0)
console.log(failed.length ? `\n✗ ${failed.length} 个脚本未通过` : '\n✓ 整套通过')
process.exit(failed.length ? 1 : 0)
