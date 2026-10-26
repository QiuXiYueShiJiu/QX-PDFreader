import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const p = fileURLToPath(new URL('QXThumbNative.cpp', import.meta.url))
let s = readFileSync(p, 'utf8')
s = s.replace(/static const IID IID_IInitializeWithStream =[\s\S]*?\};\s*\r?\n\r?\n/, '')
writeFileSync(p, s)
console.log('has-def', s.includes('IID_IInitializeWithStream ='))
