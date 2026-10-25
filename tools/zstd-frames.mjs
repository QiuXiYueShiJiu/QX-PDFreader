// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright 2026 秋夕月拾旧

// DSH stores session transcripts as CONCATENATED independent zstd frames.
// Node's createZstdDecompress errors at a second frame boundary, so decode frame by frame.
// Usage: node tools/zstd-frames.mjs <in.jsonl.zstd> <out.jsonl>
import { createReadStream, createWriteStream, statSync } from 'node:fs'
import { zstdDecompressSync, constants } from 'node:zlib'

const ZSTD_MAGIC = 4247762216
const src = process.argv[2]
const dst = process.argv[3]
const buf = await new Promise((res, rej) => {
  const chunks = []
  createReadStream(src)
    .on('data', (c) => chunks.push(c))
    .on('end', () => res(Buffer.concat(chunks)))
    .on('error', rej)
})

function scanFrames(b) {
  const frames = []
  let offset = 0
  while (offset < b.length) {
    const start = offset
    if (b.length - offset < 4) return { frames, tornStart: start }
    if (b.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === b.length) return { frames, tornStart: start }
    const descriptor = b.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (b.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (b.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = b.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (b.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (b.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

const { frames, tornStart } = scanFrames(buf)
const out = createWriteStream(dst)
let total = 0
let failed = 0
for (const [i, f] of frames.entries()) {
  let plain
  try {
    plain = zstdDecompressSync(buf.subarray(f.start, f.end))
  } catch (e) {
    failed++
    if (failed < 5) console.error(`frame ${i} @${f.start}: ${e.message}`)
    continue
  }
  total += plain.length
  if (!out.write(plain)) await new Promise((r) => out.once('drain', r))
}
if (tornStart !== undefined) {
  try {
    const plain = zstdDecompressSync(buf.subarray(tornStart), { finishFlush: constants.ZSTD_e_flush })
    total += plain.length
    out.write(plain)
    console.error(`recovered torn final frame @${tornStart}: ${plain.length} bytes`)
  } catch (e) {
    console.error(`torn frame @${tornStart} unrecoverable: ${e.message}`)
  }
}
await new Promise((r) => out.end(r))
console.error(`frames=${frames.length} failed=${failed} bytes=${total} src=${statSync(src).size}`)
