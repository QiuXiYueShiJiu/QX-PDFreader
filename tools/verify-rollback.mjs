/*
 * verify-rollback.mjs —— 紧急回滚（2.0.0 B13）
 *
 * 用户第 9 条：允许紧急回滚更新。设计要点（见 src/main/rollback.ts）：
 *   · 只保留最近 3 个安装包；
 *   · 设置 / 最近文件 / 批注不受影响（安装器本身是原地覆盖安装）；
 *   · 「同一个版本」不允许回滚（防呆）；
 *   · 连续两次启动失败会弹框问要不要回滚。
 *
 * 这条用例**不会真的启动安装器**（那会装第二遍、还可能弹窗），
 * 只验：IPC 通、列表形状、同版本防呆、启动计数在渲染完成后归零。
 */
import { spawnSync } from 'node:child_process'

const PORT = process.argv[2] ?? '9520'
const ROOT = process.cwd()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function cdp(expr) {
  const r = spawnSync(process.execPath, ['scripts/cdp-eval.mjs', PORT, expr], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  })
  const out = (r.stdout ?? '').trim()
  if (!out) throw new Error(`CDP 无输出：${(r.stderr ?? '').trim()}`)
  return out
}

function parseCdp(out) {
  try {
    return JSON.parse(out)
  } catch {
    const lines = out.split(/\r?\n/).filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i])
      } catch {
        /* 往前找 */
      }
    }
    throw new Error(`CDP 输出无法解析：${out.slice(0, 200)}`)
  }
}

const ev = (body) => {
  const out = cdp(`(async () => { ${body} })()`)
  /* cdp-eval 对字符串是原样打印（不带引号），所以解析失败时按字符串返回 */
  if (out === 'undefined') return undefined
  try {
    return JSON.parse(out)
  } catch {
    return out
  }
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : `  —— ${detail}`}`)
}

async function main() {
  console.log('紧急回滚（隐藏窗口）')
  console.log(`  端口 ${PORT}\n`)

  /* ① IPC 通道在 */
  const hasApi = await ev(`return Boolean(window.pdfApp?.rollback)`)
  check('① 渲染层能拿到 rollback 通道', hasApi)

  /* ② 列表是数组，元素形状对 */
  const list = await ev(`return await window.pdfApp.rollback.list()`)
  const isList = Array.isArray(list)
  const shapeOk =
    isList &&
    list.every(
      (e) =>
        typeof e?.version === 'string' &&
        typeof e?.path === 'string' &&
        typeof e?.size === 'number' &&
        typeof e?.savedAt === 'string'
    )
  check('② 回滚列表是数组且字段齐全', isList && shapeOk, JSON.stringify(list).slice(0, 160))
  check('② 最多留 3 个安装包', isList && list.length <= 3, `实际 ${isList ? list.length : 'N/A'}`)

  /* ③ 同版本不许回滚（防呆） */
  const info = await ev(`return await window.pdfApp.app.info()`)
  const candidates = [info?.buildVersion, info?.version].filter((v) => typeof v === 'string' && v)
  let guard = null
  for (const v of candidates) {
    guard = await ev(`return await window.pdfApp.rollback.apply(${JSON.stringify(v)})`)
    if (guard?.ok === false && /当前就是/.test(guard?.error ?? '')) break
  }
  check(
    '③ 回滚到「当前版本」被拒绝并说明原因',
    guard?.ok === false && /当前就是/.test(guard?.error ?? ''),
    `${candidates.join('/')} → ${JSON.stringify(guard)}`
  )

  /* ④ 回滚到不存在的版本 → 明确报错 */
  const missing = await ev(`return await window.pdfApp.rollback.apply('0.0.0.1')`)
  check(
    '④ 回滚到没有安装包的版本时给出提示',
    missing?.ok === false && /没有找到/.test(missing?.error ?? ''),
    JSON.stringify(missing)
  )

  /* ⑤ 启动计数：进到界面后应当已归零 */
  const failures = await ev(`return await window.pdfApp.rollback.failures()`)
  check('⑤ 正常启动后失败计数归零', failures === 0, `计数 ${failures}`)

  /* ⑥ 设置页有回滚区块（有安装包时才渲染） */
  const panel = await ev(`
    const s = window.__store.getState();
    s.setShowSettings(true);
    await new Promise((r) => setTimeout(r, 700));
    const has = document.querySelector('[data-rollback]') !== null;
    const btns = document.querySelectorAll('[data-tb-id^="rollback-"]').length;
    s.setShowSettings(false);
    await new Promise((r) => setTimeout(r, 300));
    return { has, btns }
  `)
  if (isList && list.length > 0) {
    check('⑥ 有安装包时设置页渲染回滚区块', panel.has, JSON.stringify(panel))
  } else {
    /* 没有安装包时不该渲染空区块（用户不需要看到「没有可回滚版本」的噪音） */
    check('⑥ 没有安装包时不渲染回滚区块', panel.has === false, JSON.stringify(panel))
  }

  const failed = results.filter((r) => !r.ok).length
  console.log(`\n=== 结果：${results.length} 项检查，${failed} 项失败 ===`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('✗', e.message)
  process.exit(1)
})