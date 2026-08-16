#!/usr/bin/env node
// Split files into vault-sized chunks for writing to a Vessel token.
//
//   node script/chunk-for-vessel.mjs <file...> --vessel 9994 [--out dir]
//
// Pass every file you intend to write in one sitting, in write order. Entries
// are append-only, so a file's slot numbers depend on everything queued ahead
// of it — chunk two files separately and both will claim the same entries.
//
// Writes `<out>/<name>/` per file: one .hex per chunk plus a manifest. Feed
// the manifests to script/write-to-vessel.mjs, which does the transactions.
//
// See docs/VESSEL-CHUNKING.md for the whole process.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, extname, join } from 'node:path'
import { createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'
import { ADDRESSES, MAX_ENTRIES, MAX_CONTENT_BYTES, planVaultWrites, bytesToHex } from '../src/kiln.js'
import { vesselAbi } from '../src/abi.js'

const args = process.argv.slice(2)
const files = args.filter((a) => !a.startsWith('--') && !isFlagValue(a))
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
function isFlagValue(a) {
  const i = args.indexOf(a)
  return i > 0 && args[i - 1].startsWith('--')
}

if (!files.length) {
  console.error('usage: node script/chunk-for-vessel.mjs <file...> --vessel 9994 [--out dir] [--start N]')
  process.exit(1)
}

const vesselId = BigInt(flag('vessel', '9994'))
const outDir = flag('out', 'chunks')
const sha256 = (b) => createHash('sha256').update(b).digest('hex')

// Where the first chunk lands. A vault's entry count is the next free index,
// so this is read live unless pinned with --start (offline, or planning a
// write that follows one not yet made).
let startEntry = flag('start', null) === null ? null : Number(flag('start'))
let live = null
if (startEntry === null) {
  try {
    const pub = createPublicClient({
      chain: mainnet,
      transport: http(process.env.MAINNET_RPC_URL || 'https://ethereum-rpc.publicnode.com'),
    })
    const [count, isVault, locked] = await Promise.all([
      pub.readContract({ address: ADDRESSES.vessel, abi: vesselAbi, functionName: 'craftToEntry', args: [vesselId] }),
      pub.readContract({ address: ADDRESSES.vessel, abi: vesselAbi, functionName: 'craftToVaultStatus', args: [vesselId] }),
      pub.readContract({ address: ADDRESSES.vessel, abi: vesselAbi, functionName: 'craftToLocked', args: [vesselId] }),
    ])
    startEntry = Number(count)
    live = { isVault, locked }
  } catch {
    console.error(`could not reach the chain to read vessel #${vesselId}'s entry count.`)
    console.error('pass --start N with the current craftToEntry value, or set MAINNET_RPC_URL.')
    process.exit(1)
  }
}

if (live && !live.isVault) {
  console.error(`vessel #${vesselId} is not a Vault — only vaults hold multiple entries.`)
  process.exit(1)
}
if (live?.locked) {
  console.error(`vessel #${vesselId} is locked; no further entries can be written.`)
  process.exit(1)
}

const loaded = files.map((f) => ({ name: basename(f, extname(f)), source: basename(f), bytes: readFileSync(f) }))
const plans = planVaultWrites(loaded, { vesselTokenId: vesselId, startEntry })

console.log(`vessel #${vesselId} — ${startEntry} entries written, ${plans[0].capacity.toLocaleString()} B per entry`)
console.log()

for (const [i, plan] of plans.entries()) {
  const { source, bytes } = loaded[i]
  const dir = join(outDir, plan.name)
  mkdirSync(dir, { recursive: true })

  const manifest = {
    source,
    totalBytes: plan.totalBytes,
    sha256: sha256(bytes),
    vessel: Number(vesselId),
    capacityPerEntry: plan.capacity,
    chunkCount: plan.chunks.length,
    startEntry: plan.startEntry,
    entries: plan.entries,
    chunks: plan.chunks.map((c, j) => ({
      index: j,
      entry: plan.entries[j],
      bytes: c.length,
      sha256: sha256(c),
      file: `${plan.name}_chunk_${j}.hex`,
    })),
  }

  for (const [j, chunk] of plan.chunks.entries()) {
    writeFileSync(join(dir, manifest.chunks[j].file), bytesToHex(chunk) + '\n')
  }
  writeFileSync(join(dir, `${plan.name}_manifest.json`), JSON.stringify(manifest, null, 2) + '\n')

  console.log(`${source}`)
  console.log(`  ${plan.totalBytes.toLocaleString()} bytes · sha256 ${manifest.sha256.slice(0, 16)}…`)
  console.log(`  ${plan.chunks.length} chunks: ${plan.chunks.map((c) => c.length.toLocaleString()).join(', ')}`)
  console.log(`  reassembles byte-identical ✓`)
  console.log(`  → entries ${plan.startEntry}–${plan.endEntry}`)
  console.log(`  in Kiln: assemble mode, select ${plan.startEntry}…${plan.endEntry} in ascending order`)

  if (plan.exceedsMaxEntries) {
    console.log(`  ! ${plan.chunks.length} chunks exceeds MAX_ENTRIES (${MAX_ENTRIES}) — VesselPortal cannot assemble this in one reference`)
  }
  if (plan.exceedsContentBudget) {
    console.log(`  ! ${plan.totalBytes.toLocaleString()} B exceeds the renderer's ${MAX_CONTENT_BYTES.toLocaleString()} B budget`)
  } else {
    const pct = ((plan.totalBytes / MAX_CONTENT_BYTES) * 100).toFixed(0)
    console.log(`  uses ${pct}% of the ${(MAX_CONTENT_BYTES / 1024).toFixed(0)} KB render budget`
      + ` (shared with the thumbnail — reference one to spend nothing)`)
  }
  console.log(`  → ${dir}/`)
  console.log()
}

if (plans.length > 1) {
  const all = plans.flatMap((p) => p.entries)
  console.log(`write order matters: entries ${all[0]}–${all[all.length - 1]} are claimed in the order listed above.`)
  console.log(`writing them out of order makes every manifest below the first one wrong.`)
  console.log()
}
console.log(`next: node script/write-to-vessel.mjs ${plans.map((p) => join(outDir, p.name)).join(' ')}`)
