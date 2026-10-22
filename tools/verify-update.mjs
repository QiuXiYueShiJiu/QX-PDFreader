// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

/**
 * 更新功能回归（离线，不真的连镜像站）。
 *
 * 覆盖的是**界面与状态机**：
 *   · 设置面板里有「检查更新」入口、自动检查开关默认开
 *   · 注入「有新版本」→ 右下角浮层出现、自动发起下载
 *   · 下载失败（这里故意给一个不在镜像站域名下的地址，主进程会拒绝）
 *     → 进入 error 态并给出「手动下载 / 关闭」
 *   · 点 × 或「稍后」能把浮层关掉；再次注入会重新出现
 *   · ready 态出现「立即安装 / 稍后」两个按钮
 *
 * 为什么不连真站：回归用例必须稳定、离线可跑；真站的可用性由用户
 * 点「检查更新」时的实测覆盖（构建验收里也手工跑过一次真实请求）。
 *
 * 用法：node tools/run-verify-suite.mjs --dev <port> verify-update.mjs
 */

import { spawnSync } from 'node:child_process'

const PORT = Number(process.argv[2] ?? 9521)
const CDP = 'pdf-reader/scripts/cdp-eval.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function evl(expression) {
  const run = spawnSync(process.execPath, [CDP, String(PORT), expression], {
    encoding: 'utf8',
    timeout: 60000
  })
  const out = (run.stdout ?? '').trim()
  if (run.status !== 0) throw new Error((run.stderr || out).slice(0, 400))
  try {
    return JSON.parse(out)
  } catch {
    return out
  }
}

let failed = 0
const check = (name, ok, detail) => {
  if (ok) console.log(`  ✓ ${name}${detail ? `：${detail}` : ''}`)
  else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? `：${detail}` : ''}`)
  }
}

const FAKE_URL = 'https://example.invalid/never-download.exe'

const main = async () => {
  // 等渲染层就绪
  for (let i = 0; i < 80; i += 1) {
    const ready = evl('Boolean(window.__store && document.querySelector(".pdf-page"))')
    if (ready) break
    await sleep(250)
  }

  // ① 设置面板入口
  evl('window.__store.getState().setShowSettings(true), true')
  await sleep(350)
  const hasButton = evl('Boolean(document.querySelector("[data-tb-id=\\"settings-check-update\\"]"))')
  check('设置面板里有「检查更新」按钮', hasButton === true, `button=${hasButton}`)

  const autoDefault = evl('window.__store.getState().settings.updateAutoCheck')
  check('自动检查更新默认开启', autoDefault === true, `updateAutoCheck=${autoDefault}`)

  const hasSwitch = evl(
    'Boolean(document.querySelector("input[type=checkbox][id$=\\"update-auto\\"]"))'
  )
  check('自动检查开关渲染出来了', hasSwitch === true, `switch=${hasSwitch}`)

  // ①b 更新来源选择（普通版：自动 / 镜像站 / GitHub）
  const channels = evl(`(() => {
    const root = document.querySelector('[data-update-channel]')
    if (!root) return null
    return {
      options: [...root.querySelectorAll('[data-update-channel-option]')].map((b) => b.getAttribute('data-update-channel-option')),
      pressed: [...root.querySelectorAll('[data-update-channel-option]')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.getAttribute('data-update-channel-option')),
      now: window.__store.getState().settings.updateChannel
    }
  })()`)
  check(
    '设置页提供「自动 / 镜像站 / GitHub」三个更新来源',
    Boolean(channels) && ['auto', 'mirror', 'github'].every((v) => channels.options.includes(v)),
    JSON.stringify(channels)
  )
  check(
    '更新来源默认选「自动」且高亮一致',
    Boolean(channels) && channels.now === 'auto' && channels.pressed.join(',') === 'auto',
    JSON.stringify(channels)
  )
  evl(`(() => {
    const btn = document.querySelector('[data-update-channel-option="github"]')
    if (btn) btn.click()
    return true
  })()`)
  await sleep(250)
  const afterPick = evl('window.__store.getState().settings.updateChannel')
  check('点「GitHub」后设置里真的切到这个通道', afterPick === 'github', `updateChannel=${afterPick}`)
  evl(`(() => {
    const btn = document.querySelector('[data-update-channel-option="auto"]')
    if (btn) btn.click()
    return true
  })()`)
  await sleep(200)

  evl('window.__store.getState().setShowSettings(false), true')
  await sleep(250)

  // ② 注入「有新版本」→ 浮层出现并自动下载
  evl(`(() => {
    window.__store.getState().setUpdateInfo({
      ok: true,
      newer: true,
      current: '1.0.1.0',
      latest: '1.0.2.0',
      page: 'https://example.invalid/release',
      source: 'github',
      asset: { name: 'fake-setup.exe', size: 1024, url: '${FAKE_URL}' }
    })
    return true
  })()`)

  let toast = null
  for (let i = 0; i < 40; i += 1) {
    await sleep(150)
    toast = evl('(() => { const el = document.querySelector("[data-update-toast]"); return el ? el.textContent.replace(/\\s+/g, " ").trim() : null })()')
    if (toast) break
  }
  check('注入新版本后右下角浮层出现', Boolean(toast), String(toast ?? '').slice(0, 60))
  check('浮层里写明了新版本号', String(toast ?? '').includes('v1.0.2.0'), String(toast ?? '').slice(0, 60))
  check('浮层标出了结果来自哪条通道', String(toast ?? '').includes('GitHub'), String(toast ?? '').slice(0, 80))

  // ③ 非镜像站地址会被主进程拒绝 → error 态
  let stage = ''
  for (let i = 0; i < 40; i += 1) {
    await sleep(200)
    stage = evl('window.__store.getState().updateStage')
    if (stage === 'error' || stage === 'ready') break
  }
  check('越权下载地址被拒绝（进入 error 态）', stage === 'error', `stage=${stage}`)

  const errorText = evl(
    '(() => { const el = document.querySelector("[data-update-stage=\\"error\\"]"); return el ? el.textContent.trim() : "" })()'
  )
  check('error 态给出可读的原因', String(errorText ?? '').length > 0, String(errorText ?? '').slice(0, 60))

  const hasManual = evl('Boolean(document.querySelector("[data-tb-id=\\"update-open-page\\"]"))')
  check('error 态提供「手动下载」入口', hasManual === true, `manual=${hasManual}`)

  // ④ 关闭浮层
  evl('document.querySelector("[data-tb-id=\\"update-close\\"]").click(), true')
  await sleep(300)
  const closed = evl('Boolean(document.querySelector("[data-update-toast]"))')
  check('点 × 后浮层消失', closed === false, `stillThere=${closed}`)

  // ⑤ ready 态的两个按钮
  evl(`(() => {
    const s = window.__store.getState()
    s.setUpdateInfo({
      ok: true, newer: true, current: '1.0.1.0', latest: '1.0.2.0',
      asset: { name: 'fake-setup.exe', size: 1024, url: '${FAKE_URL}' }
    })
    s.setUpdateStage('ready', 'C:/Users/public/fake-setup.exe')
    return true
  })()`)
  await sleep(350)
  const hasInstall = evl('Boolean(document.querySelector("[data-tb-id=\\"update-install\\"]"))')
  const hasLater = evl('Boolean(document.querySelector("[data-tb-id=\\"update-later\\"]"))')
  check('ready 态给出「立即安装」', hasInstall === true, `install=${hasInstall}`)
  check('ready 态给出「稍后」', hasLater === true, `later=${hasLater}`)

  // ⑥ 稍后 → 关掉，但状态保留（下次启动还会提示）
  evl('document.querySelector("[data-tb-id=\\"update-later\\"]").click(), true')
  await sleep(300)
  const afterLater = evl('Boolean(document.querySelector("[data-update-toast]"))')
  const keptFile = evl('window.__store.getState().updateFile')
  check('点「稍后」收起浮层但保留已下好的安装包', afterLater === false && keptFile !== '', `hidden=${afterLater} file=${keptFile}`)

  // 收尾：把状态清干净，避免影响后续用例
  evl('window.__store.setState({ updateInfo: null, updateDismissed: false, updateStage: "idle", updateFile: "", updateProgress: { received: 0, total: 0, fraction: 0 } }), true')

  console.log(failed === 0 ? '\n✓ 更新功能 11 项全部通过' : `\n✗ ${failed} 项失败`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('✗ 用例异常：', error)
  process.exit(1)
})
