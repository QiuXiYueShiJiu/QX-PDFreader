/**
 * 临时脚本：从示例文档第 2 页画布导出一张位图，并做成「扫描件」PDF（整页图片，无文字层），
 * 供 OCR 演示截图使用。产物：docs/示例文档-扫描页.pdf
 */
const { writeFileSync, existsSync } = require('node:fs')
const { resolve } = require('node:path')
const { PDFDocument, StandardFonts } = require('pdf-lib')

const PORT = Number(process.argv[2] ?? 9801)

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('找不到页面目标')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })
  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
    }
  })
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })

  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const c = document.querySelector('.pdf-page[data-page="2"] canvas')
      if (!c) return null
      return c.toDataURL('image/jpeg', 0.92)
    })()`,
    returnByValue: true,
    awaitPromise: true
  })
  const dataUrl = r.result && r.result.value
  if (!dataUrl) throw new Error('拿不到画布位图')
  const b64 = dataUrl.split(',')[1]
  const jpg = Buffer.from(b64, 'base64')

  const doc = await PDFDocument.create()
  const img = await doc.embedJpg(jpg)
  const w = 595.28
  const h = (img.height / img.width) * w
  const p = doc.addPage([w, h])
  p.drawImage(img, { x: 0, y: 0, width: w, height: h })
  const bytes = await doc.save()
  const out = resolve('docs/示例文档-扫描页.pdf')
  writeFileSync(out, bytes)
  console.log(`扫描件已生成：${out}  ${bytes.length} 字节  ${Math.round(w)}x${Math.round(h)}`)
  ws.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
