import { readFileSync, writeFileSync, existsSync } from 'node:fs'
const idx = JSON.parse(readFileSync('plugin-store/index.json', 'utf8'))
const errs = []
const ids = new Set()
const kinds = new Set(['theme', 'plugin'])
const themes = new Set(['light','sepia','dark','night','forest','warm','contrast','paper','midnight','plum','glow','metro','glass'])
for (const [i, it] of idx.items.entries()) {
  const at = `items[${i}]`
  for (const k of ['id','kind','name','version','summary','download','sha256','size']) if (!(k in it)) errs.push(`${at} 缺 ${k}`)
  if (ids.has(it.id)) errs.push(`${at} id 重复: ${it.id}`)
  ids.add(it.id)
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(it.id)) errs.push(`${at} id 格式不对`)
  if (!kinds.has(it.kind)) errs.push(`${at} kind 只能是 theme/plugin`)
  if (!/^\d+\.\d+\.\d+$/.test(it.version)) errs.push(`${at} version 不是 x.y.z`)
  if (!/^https:\/\//.test(it.download)) errs.push(`${at} download 必须 https://`)
  if (!/^[a-f0-9]{64}$/.test(it.sha256)) errs.push(`${at} sha256 必须是 64 位小写十六进制`)
  if (!(it.summary.length <= 80)) errs.push(`${at} summary 超过 80 字`)
  if (it.kind === 'theme') {
    if (!it.theme || !themes.has(it.theme.theme)) errs.push(`${at} 主题包缺合法 theme.theme`)
    if (!it.theme || !['normal','office'].includes(it.theme.themeLayout)) errs.push(`${at} themeLayout 只能是 normal/office`)
  }
}
const placeholders = idx.items.filter((it) => /^0{64}$/.test(it.sha256)).length
console.log(errs.length ? '✗ ' + errs.join('\n  ') : `✓ 清单结构通过：${idx.items.length} 条（${placeholders} 条仍是占位 sha256，上架前必须替换）`)
if (!existsSync('plugin-store/docs/API.md')) console.log('✗ 缺 docs/API.md')
process.exit(errs.length ? 1 : 0)
