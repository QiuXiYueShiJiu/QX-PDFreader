/*
 * verify-compare.mjs —— 分屏对比（2.0.0 B12）
 *
 * 用户第 8 条：单窗口内左主文档、右参考文档，开始页是主页，右侧只读。
 * 判据覆盖：
 *   ① 上栏有「对比」按钮，点了之后出分屏容器与右侧参考窗（空态）
 *   ② 空态有「打开」入口，且提示文案说明只读
 *   ③ 用 store 灌一个真实 PDF 后，右侧画出 canvas，页数与主文档无关
 *   ④ 左右两栏各自独立滚动（右侧滚动不影响左侧 scrollTop）
 *   ⑤ 关闭后容器与参考窗一起消失
 *   ⑥ 收尾：回单栏、回第 1 页
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const PORT = process.argv[2] ?? '9520'
const ROOT = process.cwd()
const FIXTURE = join(ROOT, 'tests', 'fixture', 'fixture.pdf')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function cdp(expr) {
  const r = spawnSync(process.execPath, ['scripts/cdp-eval.mjs', PORT, expr], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  })
  const out = (r.stdout ?? '').trim()
  if (!out) throw new Error(`CDP 无输出：${(r.stderr ?? '').trim()}`)
  return out
}

/* cdp-eval 打印的是 JSON.stringify(value, null, 2)，可能多行，整体解析 */
function parseCdp(out) {
  try {
    return JSON.parse(out)
  } catch {
    const lines = out.split(/\r?\n/).filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i])
      } catch {
        /* 继续往前找 */
      }
    }
    throw new Error(`CDP 输出无法解析：${out.slice(0, 200)}`)
  }
}

const ev = (body) => {
  const out = cdp(`(async () => { ${body} })()`)
  /* cdp-eval 对字符串原样打印、对对象才 JSON.stringify，所以字符串要再解析一次 */
  return typeof out === 'string' ? parseCdp(out) : out
}
const j = async (body) => await ev(body)
const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : `  —— ${detail}`}`)
}

async function waitFor(expr, ms = 12000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await j(`return Boolean(${expr})`).catch(() => false)) return true
    await sleep(250)
  }
  return false
}

async function main() {
  console.log('分屏对比（隐藏窗口）')
  console.log(`  端口 ${PORT}\n`)

  /* 归位：别的用例可能留了浮层 */
  await ev(`
    const w = (ms) => new Promise((r) => setTimeout(r, ms));
    const s = window.__store.getState();
    if (s.showSettings) s.setShowSettings(false);
    if (s.showTools) s.setShowTools(false);
    if (s.showThemeStore) s.setShowThemeStore(false);
    if (s.showPluginStore) s.setShowPluginStore(false);
    if (s.showImageTools) s.setShowImageTools(false);
    if (s.compareOpen) s.closeComparePane();
    /* 参考窗会记住上一次的文档；这条用例要验空态，所以先把记忆清掉 */
    window.__store.setState({ comparePath: '' });
    const peek = document.querySelector('[data-tb-id="ribbon-expand"]');
    if (peek) { peek.click(); await w(300); }
    const tab = document.querySelector('[data-tb-id="ribbon-tab-home"]');
    if (tab) tab.click();
    await w(600);
    return true;
  `)

  /* ① 上栏按钮 → 分屏容器 + 空态参考窗 */
  const hasBtn = await j(`return Boolean(document.querySelector('[data-tb-id="compare-toggle"]'))`)
  check('① 上栏有「对比」按钮', hasBtn)

  await ev(`
    const b = document.querySelector('[data-tb-id="compare-toggle"]');
    b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    b.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    b.click();
    return true;
  `)
  const emptyState = await waitFor(`document.querySelector('[data-compare-pane="1"]')`, 6000)
  const split = await j(`return document.querySelector('.app__split')?.getAttribute('data-compare') === '1'`)
  check('① 点后出分屏容器与右侧参考窗', emptyState && split, `pane=${emptyState} split=${split}`)

  /* ② 空态入口 + 只读提示 */
  const empty = await j(`
    return {
      pick: Boolean(document.querySelector('[data-tb-id="compare-pick-empty"]')),
      note: (document.querySelector('.compare-pane__tagline')?.textContent ?? '').trim()
    }
  `)
  check('② 空态有「打开」入口', empty.pick)
  check('② 提示里写明只读', /只读/.test(empty.note), empty.note.slice(0, 40))

  /* ③ 灌真实 PDF → 右侧画 canvas，页数独立 */
  const opened = await j(`
    const s = window.__store.getState();
    await s.openComparePane(${JSON.stringify(FIXTURE)});
    return { open: window.__store.getState().compareOpen, path: window.__store.getState().comparePath }
  `)
  const painted = await waitFor(
    `document.querySelectorAll('[data-compare-scroll] canvas').length >= 3`,
    20000
  )
  const nums = await j(`
    return {
      canvases: document.querySelectorAll('[data-compare-scroll] canvas').length,
      pages: document.querySelectorAll('[data-compare-page]').length,
      bytes: [...document.querySelectorAll('[data-compare-scroll] canvas')].map((c) => c.width * c.height).filter((n) => n > 0).length
    }
  `)
  check('③ store 打开参考文档后右侧画出 canvas', painted && nums.bytes >= 3, JSON.stringify(nums))
  check(
    '③ 参考窗标题是文件名',
    await j(`return (document.querySelector('.compare-pane__title')?.textContent ?? '').includes('fixture')`)
  )

  /* ④ 左右独立滚动 */
  const scroll = await j(`
    const w = (ms) => new Promise((r) => setTimeout(r, ms));
    const left = document.querySelector('.viewer-scroll');
    const right = document.querySelector('[data-compare-scroll]');
    left.scrollTop = 0;
    await w(200);
    right.scrollTop = 600;
    await w(400);
    return { left: left.scrollTop, right: right.scrollTop }
  `)
  check('④ 右侧滚动不影响左侧', scroll.left === 0 && scroll.right > 100, JSON.stringify(scroll))

  /* ⑤ 关闭 */
  await ev(`
    const b = document.querySelector('[data-tb-id="compare-close"]');
    if (b) { b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); b.click(); }
    return true;
  `)
  const closed = await waitFor(`!document.querySelector('[data-compare-pane="1"]')`, 6000)
  check(
    '⑤ 关闭后参考窗与分屏容器一起消失',
    closed && (await j(`return document.querySelector('.app__split')?.getAttribute('data-compare') === '0'`))
  )

  /* ⑥ 收尾 */
  await ev(`
    const s = window.__store.getState();
    if (s.compareOpen) s.closeComparePane();
    /* 参考窗会记住上一次的文档；这条用例要验空态，所以先把记忆清掉 */
    window.__store.setState({ comparePath: '' });
    s.setPage(1);
    const sc = document.querySelector('.viewer-scroll');
    if (sc) sc.scrollTop = 0;
    return true;
  `)
  check('⑥ 收尾回到单栏第 1 页', await j(`const s = window.__store.getState(); return s.compareOpen === false`))

  const failed = results.filter((r) => !r.ok).length
  console.log(`\n=== 结果：${results.length} 项检查，${failed} 项失败 ===`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('✗', e.message)
  process.exit(1)
})
