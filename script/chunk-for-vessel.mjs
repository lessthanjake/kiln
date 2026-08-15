#!/usr/bin/env node
// Split a file into vault-sized hex chunks for writing to a Vessel token, and
// check the result against what VesselPortal can actually render.
//
//   node script/chunk-for-vessel.mjs <file> [--vessel 9994] [--out dir]
//
// The chunks are RAW FILE BYTES. VesselPortal concatenates the entries you
// select, in the order you select them, so no loader or assembler entry is
// needed — that was only ever a workaround for reassembling in the browser.
// Write these, then in Kiln: reference the vessel, turn on assemble mode, and
// pick the entries in ascending order.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, extname, join } from 'node:path'
import { createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'
import { ADDRESSES, MAX_ENTRIES, MAX_CONTENT_BYTES } from '../src/kiln.js'
import { vesselAbi } from '../src/abi.js'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
if (!file) {
  console.error('usage: node script/chunk-for-vessel.mjs <file> [--vessel 9994] [--out dir]')
  process.exit(1)
}

const vesselId = BigInt(flag('vessel', '9994'))
const outDir = flag('out', 'chunks')
// When writing several files to the same vault, later ones land after the
// earlier ones — pass --after N to account for writes you have not made yet.
const after = Number(flag('after', '0'))
// A vault token holds at most `tokenId` bytes per entry — the contract's own
// capacity rule (`if (_bytes.length > _tokenId) revert BytesExceedCapacity`).
const capacity = Number(vesselId)

const raw = readFileSync(file)
const name = basename(file, extname(file))
const sha = createHash('sha256').update(raw).digest('hex')

const chunks = []
for (let i = 0; i < raw.length; i += capacity) chunks.push(raw.subarray(i, i + capacity))

// Reassembly must be byte-identical — this is exactly what the renderer does.
const rejoined = Buffer.concat(chunks)
if (!rejoined.equals(raw) || createHash('sha256').update(rejoined).digest('hex') !== sha) {
  console.error('reassembly mismatch — refusing to write')
  process.exit(1)
}

// Where will these land? The vault's current entry count is the next index.
let startEntry = null
try {
  const pub = createPublicClient({
    chain: mainnet,
    transport: http(process.env.MAINNET_RPC_URL || 'https://ethereum-rpc.publicnode.com'),
  })
  startEntry = Number(await pub.readContract({
    address: ADDRESSES.vessel, abi: vesselAbi, functionName: 'craftToEntry', args: [vesselId],
  })) + after
} catch {
  // offline is fine; just cannot suggest indices
}

mkdirSync(outDir, { recursive: true })
const manifest = {
  source: basename(file),
  totalBytes: raw.length,
  sha256: sha,
  vessel: Number(vesselId),
  capacityPerEntry: capacity,
  chunkCount: chunks.length,
  startEntry,
  entries: startEntry === null ? null : chunks.map((_, i) => startEntry + i),
  chunks: [],
}

for (const [i, chunk] of chunks.entries()) {
  const f = join(outDir, `${name}_chunk_${i}.hex`)
  writeFileSync(f, '0x' + chunk.toString('hex') + '\n')
  manifest.chunks.push({
    index: i,
    bytes: chunk.length,
    sha256: createHash('sha256').update(chunk).digest('hex'),
    file: basename(f),
  })
}
writeFileSync(join(outDir, `${name}_manifest.json`), JSON.stringify(manifest, null, 2) + '\n')

// ── report ──
const pct = (n) => `${((n / MAX_CONTENT_BYTES) * 100).toFixed(0)}%`
console.log(`${basename(file)}`)
console.log(`  ${raw.length.toLocaleString()} bytes · sha256 ${sha.slice(0, 16)}…`)
console.log(`  ${chunks.length} chunks of ≤${capacity.toLocaleString()} B (vessel #${vesselId} per-entry capacity)`)
console.log(`  sizes: ${chunks.map((c) => c.length.toLocaleString()).join(', ')}`)
console.log(`  reassembles byte-identical ✓`)
if (startEntry !== null) {
  const last = startEntry + chunks.length - 1
  console.log(`  vessel #${vesselId} currently holds ${startEntry} entries, so these become entries ${startEntry}–${last}`)
  console.log(`  in Kiln: assemble mode, select ${startEntry}…${last} in ascending order`)
}

const warn = []
if (chunks.length > MAX_ENTRIES) warn.push(`${chunks.length} chunks exceeds MAX_ENTRIES (${MAX_ENTRIES})`)
if (raw.length > MAX_CONTENT_BYTES) {
  warn.push(`${raw.length.toLocaleString()} B exceeds the renderer's ${MAX_CONTENT_BYTES.toLocaleString()} B budget`)
} else {
  console.log(`  uses ${pct(raw.length)} of the ${(MAX_CONTENT_BYTES / 1024).toFixed(0)} KB render budget`
    + ` (shared with the thumbnail — reference one to spend nothing)`)
}
for (const w of warn) console.log(`  ! ${w}`)
console.log(`  → ${outDir}/`)
