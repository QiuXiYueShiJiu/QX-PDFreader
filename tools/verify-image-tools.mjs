// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 图片工具自检（不启动 GUI、不弹窗、不写用户目录）。
 *
 *   node tools/verify-image-tools.mjs
 *
 * 两类检查：
 *
 *   A. 静态契约检查 —— 直接读源码文本，确认
 *      · 格式表里有 ico / tif / tiff，且 tif/ico 被标成 native: false；
 *      · 临时 PDF 名是「原文件名-8位hash.pdf」；
 *      · 打开链路、文件对话框、面板 data-tb-id、preload 桥都对得上；
 *      · 没有引入 sharp / jimp / canvas 这类新依赖。
 *
 *   B. 真跑一遍主进程的纯函数 —— 用 esbuild 把 src/main/image-tools.ts
 *      打成一个临时 CJS（electron 与 ./pdf-tools 换成桩），然后真的：
 *      · 编码一张 2×2 BMP，逐字节核对文件头、行序（自下而上）、行对齐、alpha 白底合成；
 *      · 真写临时目录，验证「目录不可写」「覆盖先备份 .bak」「批量重名加 -2」
 *        「拒绝网络路径」「空数据报错」这些安全约束。
 *
 * 为什么用 esbuild 打桩而不是直接 import：源文件是 TS + Electron 运行时，
 * 而本任务不允许启动 GUI，所以只能把纯函数部分单独取出来测。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const results = []
let failed = 0

function pass(name, detail = '') {
  results.push({ ok: true, name, detail })
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
}

function fail(name, detail) {
  failed += 1
  results.push({ ok: false, name, detail })
  console.log(`  ✗ ${name} — ${detail}`)
}

function check(name, fn) {
  try {
    const detail = fn()
    pass(name, typeof detail === 'string' ? detail : '')
  } catch (error) {
    fail(name, error instanceof Error ? error.message : String(error))
  }
}

/** 需要 await 的检查（真的写盘，saveImage 是 async） */
async function checkAsync(name, fn) {
  try {
    const detail = await fn()
    pass(name, typeof detail === 'string' ? detail : '')
  } catch (error) {
    fail(name, error instanceof Error ? error.message : String(error))
  }
}

function read(relativePath) {
  const full = join(ROOT, relativePath)
  if (!existsSync(full)) throw new Error(`文件不存在：${relativePath}`)
  return readFileSync(full, 'utf8')
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/* 中文被写成乱码（GBK/UTF-8 混用）时，源码里会出现 U+FFFD */
function assertNoReplacementChars(text, label) {
  if (text.includes('\uFFFD')) throw new Error(`${label} 里有 U+FFFD，说明写入时编码被破坏了`)
}

/* ============================================================
 * A. 静态检查
 * ============================================================ */

console.log('\n[1/5] 静态检查：文件与格式表')

const decodeSource = read('src/main/image-decode.ts')
const toolsSource = read('src/main/image-tools.ts')
const mainSource = read('src/main/index.ts')
const preloadSource = read('src/preload/index.ts')
const panelSource = read('src/renderer/src/components/ImageToolsPanel.tsx')
const cssSource = read('src/renderer/src/styles/image-tools.css')
const appSource = read('src/renderer/src/App.tsx')

const REQUIRED_DATA_TB_IDS = [
  'image-tools-toggle',
  'image-crop',
  'image-rotate-90',
  'image-flip-h',
  'image-filter-gray',
  'image-adj-brightness',
  'image-convert-png',
  'image-export'
]

check('新增/修改的 7 个文件都在（含本脚本）', () => {
  const files = [
    'src/main/image-decode.ts',
    'src/main/image-tools.ts',
    'src/preload/index.ts',
    'src/renderer/src/components/ImageToolsPanel.tsx',
    'src/renderer/src/styles/image-tools.css',
    'src/renderer/src/App.tsx',
    'tools/verify-image-tools.mjs'
  ]
  for (const file of files) assert(statSync(join(ROOT, file)).size > 0, `${file} 是空文件`)
  return `${files.length} 个文件`
})

check('源码没有 U+FFFD（编码没坏）', () => {
  for (const [label, text] of [
    ['image-decode.ts', decodeSource],
    ['image-tools.ts', toolsSource],
    ['ImageToolsPanel.tsx', panelSource],
    ['image-tools.css', cssSource],
    ['index.ts', mainSource],
    ['preload/index.ts', preloadSource]
  ]) {
    assertNoReplacementChars(text, label)
  }
})

check('格式表包含 png/jpg/jpeg/webp/bmp/gif/ico/tif/tiff', () => {
  const exts = [...decodeSource.matchAll(/ext:\s*'(\.[a-z]+)'/g)].map((m) => m[1])
  const aliases = [...decodeSource.matchAll(/aliases:\s*\[([^\]]*)\]/g)]
    .flatMap((m) => m[1].split(',').map((s) => s.trim().replace(/'/g, '')))
    .filter(Boolean)
  const all = new Set([...exts, ...aliases])
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.ico', '.tif', '.tiff']) {
    assert(all.has(ext), `格式表缺 ${ext}`)
  }
  return [...all].join(' ')
})

check('ico / tif 被标记成 native:false 且有「暂不支持」话术', () => {
  const icoBlock = decodeSource.slice(decodeSource.indexOf("ext: '.ico'"), decodeSource.indexOf("ext: '.tif'"))
  const tifBlock = decodeSource.slice(decodeSource.indexOf("ext: '.tif'"))
  assert(/native:\s*false/.test(icoBlock), 'ico 没标 native:false')
  assert(/native:\s*false/.test(tifBlock), 'tif 没标 native:false')
  assert(decodeSource.includes('此格式暂不支持'), '缺少「此格式暂不支持」文案')
  assert(/ICO/.test(decodeSource) && /TIFF/.test(decodeSource), 'ICO / TIFF 的专门提示缺失')
})

check('IMAGE_OPEN_EXTS / IMAGE_DIALOG_EXTS / IMAGE_FORMATS 都导出了', () => {
  for (const name of ['IMAGE_FORMATS', 'IMAGE_OPEN_EXTS', 'IMAGE_DIALOG_EXTS', 'isImageFile', 'decodeImage', 'tempPdfName', 'imageHash8', 'rememberImageMeta', 'getImageMeta']) {
    assert(new RegExp(`export (const|function) ${name}\\b`).test(decodeSource), `image-decode.ts 没有导出 ${name}`)
  }
})

console.log('\n[2/5] 静态检查：打开链路与命名')

check('临时 PDF 命名是「原文件名-8位hash.pdf」', () => {
  assert(/\$\{safeBaseName\(source\)\}-\$\{hash8\}\.pdf/.test(decodeSource), 'tempPdfName 不是 原名-hash8.pdf')
  assert(/slice\(0,\s*8\)/.test(decodeSource), 'imageHash8 没有截 8 位')
  assert(/sha1/.test(decodeSource), 'hash 没用 sha1')
})

check('index.ts 用统一格式表 + 带原文件名的临时 PDF', () => {
  assert(/const IMAGE_EXTS = IMAGE_OPEN_EXTS/.test(mainSource), 'IMAGE_EXTS 没接 IMAGE_OPEN_EXTS')
  assert(/imageHash8\(source\)/.test(mainSource), 'imageToPdfFile 没用 imageHash8')
  assert(/tempPdfName\(source, hash8\)/.test(mainSource), 'imageToPdfFile 没用 tempPdfName')
  assert(/rememberImageMeta\(/.test(mainSource), '打开后没记原图元数据')
  assert(/registerImageToolsIpc\(\(\) => mainWindow\)/.test(mainSource), '没注册图片工具 IPC')
  assert(/该图片打不开|这张图片打不开/.test(mainSource), '图片打不开时没有明确报错')
})

check('打开/选择/标题都用原文件名', () => {
  assert(/title = basename\(abs\)/.test(mainSource), 'openFileInWindow 没把原文件名当 title')
  assert(/name: title \?\? basename\(abs\)/.test(mainSource), 'pdf:open 载荷没用原文件名')
  assert(/setTitle\(`\$\{title \?\? basename\(abs\)\} - /.test(mainSource), '窗口标题没用原文件名')
  assert(/filters: \[/.test(mainSource) && /\.\.\.IMAGE_DIALOG_EXTS/.test(mainSource), '文件对话框 filters 没接格式表')
})

console.log('\n[3/5] 静态检查：面板 / preload / 依赖')

check(`面板包含契约要求的 ${REQUIRED_DATA_TB_IDS.length} 个 data-tb-id`, () => {
  const missing = REQUIRED_DATA_TB_IDS.filter((id) => !panelSource.includes(`data-tb-id="${id}"`))
  assert(missing.length === 0, `缺：${missing.join(', ')}`)
  const total = (panelSource.match(/data-tb-id="/g) ?? []).length
  return `共 ${total} 个`
})

check('面板在渲染层做像素运算并回传 Buffer', () => {
  for (const api of ['document.createElement(\'canvas\')', 'getImageData', 'toDataURL', 'putImageData']) {
    assert(panelSource.includes(api), `面板没用 ${api}`)
  }
  assert(/image\/webp/.test(panelSource), '没有 WebP 编码路径')
  assert(/rgba:/.test(panelSource) && /encodeCanvas/.test(panelSource), 'BMP 的 RGBA 回传路径缺失')
  assert(!/from 'node:fs'|require\('node:fs'\)/.test(panelSource), '面板不该直接碰 fs')
})

check('面板把 originalName / isImage / imageMetaById 写进 store', () => {
  for (const key of ['originalName', 'isImage', 'imageMetaById']) {
    assert(panelSource.includes(key), `面板没写 ${key}`)
  }
  assert(/useViewer\.setState/.test(panelSource), '没有写 store 的入口')
})

check('preload 暴露 image 桥且通道与主进程一致', () => {
  const methods = ['read', 'meta', 'pick', 'pickFolder', 'save']
  for (const method of methods) {
    assert(new RegExp(`${method}:\\s*\\(`).test(preloadSource), `preload 缺 image.${method}`)
  }
  const preloadChannels = [...preloadSource.matchAll(/invoke<[^>]*>\('(img:[a-z-]+)'/g)].map((m) => m[1])
  const mainChannels = [...toolsSource.matchAll(/ipcMain\.handle\('(img:[a-z-]+)'/g)].map((m) => m[1])
  const missing = preloadChannels.filter((channel) => !mainChannels.includes(channel))
  const unused = mainChannels.filter((channel) => !preloadChannels.includes(channel))
  assert(missing.length === 0, `preload 调了主进程没注册的通道：${missing.join(', ')}`)
  assert(unused.length === 0, `主进程注册了 preload 没暴露的通道：${unused.join(', ')}`)
  return `${mainChannels.length} 个通道`
})

check('安全函数都在（写盘前校验 / 备份 / 原子写）', () => {
  for (const name of ['assertWritableDir', 'backupFile', 'writeFileAtomic', 'encodeBmp', 'saveImage', 'readImageFile']) {
    assert(new RegExp(`export (async )?function ${name}\\b`).test(toolsSource), `image-tools.ts 没有导出 ${name}`)
  }
  assert(/dsh-write-probe/.test(toolsSource), '没有写探针文件的真实可写检测')
  assert(/只支持本地文件/.test(toolsSource), '没有拒绝网络路径')
  assert(/\.bak/.test(toolsSource), '没有覆盖前备份')
})

check('App.tsx 只多挂了 ImageToolsPanel', () => {
  assert(/import \{ ImageToolsPanel \} from '\.\/components\/ImageToolsPanel'/.test(appSource), '没 import 面板')
  const mounts = (appSource.match(/<ImageToolsPanel \/>/g) ?? []).length
  assert(mounts === 1, `<ImageToolsPanel /> 出现 ${mounts} 次`)
})

check('没有引入新的图片处理依赖', () => {
  const pkg = JSON.parse(read('package.json'))
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  for (const banned of ['sharp', 'jimp', 'canvas', 'gm', 'image-js', 'imagemagick']) {
    assert(!deps[banned], `package.json 里出现了新依赖 ${banned}`)
  }
  const imports = [...`${decodeSource}\n${toolsSource}`.matchAll(/from '([^']+)'/g)].map((m) => m[1])
  const allowed = /^(node:|electron$|\.\/|@shared\/)/
  const weird = [...new Set(imports)].filter((spec) => !allowed.test(spec))
  assert(weird.length === 0, `image-decode/image-tools 引了额外模块：${weird.join(', ')}`)
})

/* ============================================================
 * B. 真跑主进程纯函数
 * ============================================================ */

console.log('\n[4/5] 运行测试：主进程纯函数（真写临时目录）')

const workRoot = mkdtempSync(join(tmpdir(), 'dsh-image-verify-'))
const bundlePath = join(workRoot, 'image-tools.cjs')

async function buildBundle() {
  let esbuild
  try {
    esbuild = require('esbuild')
  } catch {
    throw new Error('找不到 esbuild（vite 自带），跳过运行测试')
  }

  /* ./pdf-tools 只为 friendly()：用桩替掉，避免把 pdf-lib 整包拖进来 */
  const stubPdfTools = {
    name: 'stub-pdf-tools',
    setup(build) {
      build.onResolve({ filter: /^\.\/pdf-tools$/ }, () => ({ path: 'pdf-tools', namespace: 'stub' }))
      build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: 'exports.friendly = (error) => (error instanceof Error ? error.message : String(error))\n',
        loader: 'js'
      }))
    }
  }

  await esbuild.build({
    entryPoints: [join(ROOT, 'src/main/image-tools.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
    plugins: [stubPdfTools],
    logLevel: 'silent'
  })
}

/* electron 桩：只提供被引用到的成员 */
const electronStub = {
  app: { getPath: () => workRoot, isPackaged: false },
  BrowserWindow: class {},
  dialog: {
    async showOpenDialog() {
      return { canceled: true, filePaths: [] }
    },
    async showSaveDialog() {
      return { canceled: true, filePath: undefined }
    }
  },
  ipcMain: { handle() {} },
  nativeImage: {
    createFromPath() {
      return { isEmpty: () => true }
    }
  }
}

const Module = require('node:module')
const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return electronStub
  return originalLoad.call(this, request, parent, isMain)
}

let tools = null
try {
  await buildBundle()
  tools = require(bundlePath)
  pass('esbuild 打包 + require 成功', bundlePath.endsWith('image-tools.cjs') ? '未加载真实 electron' : '')
} catch (error) {
  fail('esbuild 打包 + require', error instanceof Error ? error.message : String(error))
}

if (tools) {
  check('encodeBmp：文件头 / 行序 / 行对齐 / alpha 白底', () => {
    /* 2×2：左上红、右上绿、左下蓝、右下全透明（应合成为白） */
    const rgba = new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 255,
      0, 0, 255, 255, 0, 0, 0, 0
    ])
    const bmp = Buffer.from(tools.encodeBmp(rgba, 2, 2))
    const rowSize = 8 /* 2*3=6 → 对齐到 8 */
    assert(bmp.length === 54 + rowSize * 2, `文件长度应为 ${54 + rowSize * 2}，实际 ${bmp.length}`)
    assert(bmp.subarray(0, 2).toString('ascii') === 'BM', '缺 BM 魔数')
    assert(bmp.readUInt32LE(2) === bmp.length, 'bfSize 不等于文件长度')
    assert(bmp.readUInt32LE(10) === 54, 'bfOffBits 应为 54')
    assert(bmp.readUInt32LE(14) === 40, 'biSize 应为 40')
    assert(bmp.readInt32LE(18) === 2, 'biWidth 应为 2')
    assert(bmp.readInt32LE(22) === 2, 'biHeight 应为 2（正数=自下而上）')
    assert(bmp.readUInt16LE(26) === 1, 'biPlanes 应为 1')
    assert(bmp.readUInt16LE(28) === 24, 'biBitCount 应为 24')
    assert(bmp.readUInt32LE(34) === rowSize * 2, 'biSizeImage 不对')

    /* 第一行像素 = 原图**最下面**一行：蓝 (BGR 255,0,0) + 透明→白 (255,255,255) */
    const firstRow = 54
    assert(bmp[firstRow] === 255 && bmp[firstRow + 1] === 0 && bmp[firstRow + 2] === 0, '左下角不是蓝色（行序不是自下而上）')
    assert(bmp[firstRow + 3] === 255 && bmp[firstRow + 4] === 255 && bmp[firstRow + 5] === 255, '透明像素没合成到白底')
    /* 第二行 = 原图最上面一行：红 (0,0,255) + 绿 (0,255,0) */
    const secondRow = 54 + rowSize
    assert(bmp[secondRow] === 0 && bmp[secondRow + 1] === 0 && bmp[secondRow + 2] === 255, '左上角不是红色')
    assert(bmp[secondRow + 3] === 0 && bmp[secondRow + 4] === 255 && bmp[secondRow + 5] === 0, '右上角不是绿色')
  })

  check('assertWritableDir：目录可写 / 不存在 / 不是目录', () => {
    const dir = join(workRoot, 'writable')
    mkdirSync(dir, { recursive: true })
    tools.assertWritableDir(dir)
    let threw = false
    try {
      tools.assertWritableDir(join(workRoot, 'no-such-dir'))
    } catch (error) {
      threw = /不存在/.test(String(error))
    }
    assert(threw, '对不存在的目录没有报「不存在」')

    const filePath = join(workRoot, 'plain.txt')
    writeFileSync(filePath, 'x')
    threw = false
    try {
      tools.assertWritableDir(filePath)
    } catch (error) {
      threw = /不是文件夹/.test(String(error))
    }
    assert(threw, '把文件当目录时没有报错')
  })

  check('writeFileAtomic：内容正确且不留临时文件', () => {
    const target = join(workRoot, 'atomic.bin')
    tools.writeFileAtomic(target, Buffer.from([1, 2, 3, 4]))
    assert(readFileSync(target).toString('hex') === '01020304', '写入内容不对')
    const leftovers = readdirSafe(workRoot).filter((name) => name.includes('.tmp'))
    assert(leftovers.length === 0, `留下了临时文件：${leftovers.join(', ')}`)
  })

  check('backupFile：备份一次且不覆盖旧备份', () => {
    const target = join(workRoot, 'backup.txt')
    writeFileSync(target, 'v1')
    const bak = tools.backupFile(target)
    assert(bak === `${target}.bak`, '.bak 路径不对')
    assert(readFileSync(bak, 'utf8') === 'v1', '备份内容不对')
    writeFileSync(target, 'v2')
    tools.backupFile(target)
    assert(readFileSync(bak, 'utf8') === 'v1', '第二次备份把最初的原件覆盖掉了')
  })

  await checkAsync('saveImage overwrite：真的覆盖原图并留下 .bak', async () => {
    const source = join(workRoot, 'shot.png')
    writeFileSync(source, Buffer.from([1, 1, 1]))
    const result = await tools.saveImage(null, {
      sourcePath: source,
      bytes: new Uint8Array([9, 9, 9, 9]),
      format: 'png',
      mode: 'overwrite'
    })
    assert(result.ok === true, `保存失败：${result.error ?? ''}`)
    assert(result.path === source, '返回路径不是原图')
    assert(readFileSync(source).toString('hex') === '09090909', '原图没被新内容覆盖')
    assert(result.backup === `${source}.bak`, '没返回备份路径')
    assert(readFileSync(`${source}.bak`).toString('hex') === '010101', '.bak 里不是原内容')
  })

  await checkAsync('saveImage directory：同名不覆盖，自动加 -2', async () => {
    const dir = join(workRoot, 'out')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.png'), Buffer.from('keep'))
    const request = {
      sourcePath: join(workRoot, 'shot.png'),
      bytes: new Uint8Array([7, 7]),
      format: 'png',
      mode: 'directory',
      directory: dir,
      fileName: 'a.png'
    }
    const first = await tools.saveImage(null, request)
    const second = await tools.saveImage(null, request)
    assert(first.ok === true && second.ok === true, '目录模式保存失败')
    assert(readFileSync(join(dir, 'a.png'), 'utf8') === 'keep', '目录模式覆盖了已有文件')
    assert(first.path.endsWith('a-2.png'), `第一份应叫 a-2.png，实际 ${first.path}`)
    assert(second.path.endsWith('a-3.png'), `第二份应叫 a-3.png，实际 ${second.path}`)
  })

  await checkAsync('saveImage bmp：直接吃 RGBA，落盘是真 BMP', async () => {
    const source = join(workRoot, 'shot.png')
    const result = await tools.saveImage(null, {
      sourcePath: source,
      rgba: { bytes: new Uint8Array([0, 0, 255, 255, 255, 255, 255, 255]), width: 1, height: 2 },
      format: 'bmp',
      mode: 'dialog',
      targetPath: join(workRoot, 'from-rgba.bmp')
    })
    assert(result.ok === true, `BMP 保存失败：${result.error ?? ''}`)
    const bytes = readFileSync(result.path)
    assert(bytes.subarray(0, 2).toString('ascii') === 'BM', '不是 BMP')
    assert(bytes.readInt32LE(18) === 1 && bytes.readInt32LE(22) === 2, 'BMP 尺寸不对')
  })

  await checkAsync('安全：拒绝 URL / 空数据 / 非法格式', async () => {
    const base = { sourcePath: join(workRoot, 'shot.png'), format: 'png', mode: 'overwrite' }

    let threw = false
    try {
      await tools.saveImage(null, { ...base, sourcePath: 'https://example.com/a.png', bytes: new Uint8Array([1]) })
    } catch (error) {
      threw = /只支持本地文件/.test(String(error))
    }
    assert(threw, 'http(s) 路径没被拒绝')

    threw = false
    try {
      await tools.saveImage(null, { ...base, bytes: new Uint8Array(0) })
    } catch (error) {
      threw = /没有可写入的图片数据/.test(String(error))
    }
    assert(threw, '空数据没有报错')

    threw = false
    try {
      await tools.saveImage(null, { ...base, format: 'gif', bytes: new Uint8Array([1]) })
    } catch (error) {
      threw = /不支持的导出格式/.test(String(error))
    }
    assert(threw, '非法格式没有报错')
  })
}

/* ============================================================
 * C. image-decode：命名 / 元数据旁车 / 不支持格式的提示
 * ============================================================ */

console.log('\n[5/5] 运行测试：命名 / 元数据旁车 / 不支持格式')

const decodeBundlePath = join(workRoot, 'image-decode.cjs')

let decode = null
try {
  const esbuild = require('esbuild')
  await esbuild.build({
    entryPoints: [join(ROOT, 'src/main/image-decode.ts')],
    outfile: decodeBundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
    logLevel: 'silent'
  })
  decode = require(decodeBundlePath)
  pass('image-decode 打包 + require 成功')
} catch (error) {
  fail('image-decode 打包 + require', error instanceof Error ? error.message : String(error))
}

if (decode) {
  check('tempPdfName：原文件名做前缀 + 8 位 hash', () => {
    const source = join(workRoot, 'IMG_2026.JPG')
    writeFileSync(source, Buffer.from([1, 2, 3]))
    const hash = decode.imageHash8(source)
    assert(/^[0-9a-f]{8}$/.test(hash), `hash 不是 8 位小写 hex：${hash}`)
    /* 契约示例就是 IMG_2026-<hash8>.pdf：原名去掉扩展名，再加短 hash */
    assert(decode.tempPdfName(source, hash) === `IMG_2026-${hash}.pdf`, '临时 PDF 名不是「原名-hash8.pdf」')

    /* 文件名里的非法字符必须清掉，否则写盘会失败 */
    assert(decode.tempPdfName(join(workRoot, 'a:b?c.jpg'), 'deadbeef') === 'a_b_c-deadbeef.pdf', '非法字符没被替换')

    /* 内容一变 hash 就得变，旧缓存才不会冒充新图 */
    const before = decode.imageHash8(source)
    writeFileSync(source, Buffer.from([1, 2, 3, 4]))
    assert(decode.imageHash8(source) !== before, '图片改了 hash 却没变')
  })

  check('imageHash8 对同一文件稳定', () => {
    const source = join(workRoot, 'IMG_2026.JPG')
    assert(decode.imageHash8(source) === decode.imageHash8(source), '同一文件两次 hash 不一致')
  })

  check('元数据旁车：重启后仍能读回原文件名', () => {
    const tempPath = join(workRoot, 'IMG_2026-ab12cd34.pdf')
    writeFileSync(tempPath, 'pdf')
    const meta = {
      sourcePath: join(workRoot, 'IMG_2026.JPG'),
      originalName: 'IMG_2026.JPG',
      tempPath,
      isImage: true,
      format: '.jpg',
      formatLabel: 'JPEG',
      width: 800,
      height: 600,
      bytes: 12345,
      openedAt: Date.now()
    }
    decode.writeImageMetaSidecar(meta)
    const fromDisk = decode.readImageMetaSidecar(tempPath)
    assert(fromDisk && fromDisk.originalName === 'IMG_2026.JPG', '旁车读不回原文件名')

    /* 内存表是空的（模拟重启）：getImageMeta 必须回落到旁车 */
    assert(decode.getImageMeta(tempPath)?.originalName === 'IMG_2026.JPG', 'getImageMeta 没回落旁车')

    writeFileSync(decode.metaSidecarPath(tempPath), '{ 这不是 json')
    assert(decode.readImageMetaSidecar(tempPath) === null, '损坏的旁车没被当成「没有」')
  })

  check('ico / tif 报「暂不支持」，坏图报「无法解码」', () => {
    const probe = (name, bytes) => {
      const filePath = join(workRoot, name)
      writeFileSync(filePath, bytes)
      try {
        decode.decodeImage(filePath)
      } catch (error) {
        return String(error)
      }
      return ''
    }

    const tif = probe('scan.tif', 'not really a tif')
    assert(/此格式暂不支持/.test(tif) && /TIFF/.test(tif), `TIFF 提示不对：${tif}`)

    const ico = probe('favicon.ico', 'nope')
    assert(/此格式暂不支持/.test(ico) && /ICO/.test(ico), `ICO 提示不对：${ico}`)

    const jpg = probe('broken.jpg', 'not a jpg')
    assert(/无法解码/.test(jpg), `坏 JPG 提示不对：${jpg}`)
  })

  check('IMAGE_OPEN_EXTS / IMAGE_DIALOG_EXTS 与格式表一致', () => {
    for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.ico', '.tif', '.tiff']) {
      assert(decode.IMAGE_OPEN_EXTS.includes(ext), `IMAGE_OPEN_EXTS 缺 ${ext}`)
    }
    assert(!decode.IMAGE_DIALOG_EXTS.some((ext) => ext.startsWith('.')), 'IMAGE_DIALOG_EXTS 不该带点')
    for (const ext of ['ico', 'tif', 'tiff']) {
      assert(decode.IMAGE_DIALOG_EXTS.includes(ext), `IMAGE_DIALOG_EXTS 缺 ${ext}`)
    }
  })
}

/* 清场：测试目录整个删掉（只删自己 mkdtemp 出来的） */
Module._load = originalLoad
try {
  rmSync(workRoot, { recursive: true, force: true })
} catch {
  /* 删不掉不影响结论 */
}

function readdirSafe(dir) {
  try {
    return require('node:fs').readdirSync(dir)
  } catch {
    return []
  }
}

/* ============================================================
 * 收尾
 * ============================================================ */

const total = results.length
console.log('')
if (failed === 0) {
  console.log(`全部通过：${total} 项检查（0 项失败）`)
  process.exit(0)
}
console.log(`失败 ${failed} 项 / 共 ${total} 项`)
process.exit(1)
