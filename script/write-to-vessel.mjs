#!/usr/bin/env node
// Write chunked files to a Vessel vault: one `setPayloadHolder` per chunk.
//
//   node script/write-to-vessel.mjs <chunkdir...>              # simulate (default)
//   node script/write-to-vessel.mjs <chunkdir...> --calldata    # emit tx data to sign elsewhere
//   node script/write-to-vessel.mjs <chunkdir...> --broadcast   # send, using VESSEL_KEY
//
// Simulation is the default because these writes are append-only and cost real
// money at ~7.2M gas each. It forks mainnet in-process, sends every write, and
// reads the entries back to prove they rebuild the source file byte for byte.
//
// Resumable: it reads the vault's live entry count first and skips chunks
// already on chain, so an interrupted run continues where it stopped rather
// than appending a second copy.
//
// See docs/VESSEL-CHUNKING.md.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { createPublicClient, createWalletClient, http, encodeFunctionData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'
import { ADDRESSES, hexToBytes } from '../src/kiln.js'
import { vesselAbi } from '../src/abi.js'

const args = process.argv.slice(2)
const dirs = args.filter((a) => !a.startsWith('--'))
const has = (f) => args.includes(`--${f}`)
const RPC = process.env.MAINNET_RPC_URL || 'https://ethereum-rpc.publicnode.com'

if (!dirs.length) {
  console.error('usage: node script/write-to-vessel.mjs <chunkdir...> [--calldata | --broadcast]')
  console.error('       chunkdir is a directory produced by script/chunk-for-vessel.mjs')
  process.exit(1)
}

// `setPayloadHolder` is the holder-or-delegate entry point; on a vault it
// appends one entry. There is no update and no delete.
const writeAbi = [{
  type: 'function', name: 'setPayloadHolder', stateMutability: 'nonpayable',
  inputs: [{ name: '_tokenId', type: 'uint256' }, { name: '_bytes', type: 'bytes' }], outputs: [],
}]

const sha256 = (b) => createHash('sha256').update(b).digest('hex')

// ── load and re-verify the manifests ────────────────────────────────────────

const jobs = dirs.map((dir) => {
  const name = basename(dir)
  const path = join(dir, `${name}_manifest.json`)
  if (!existsSync(path)) throw new Error(`no manifest at ${path} — is ${dir} a chunk directory?`)
  const manifest = JSON.parse(readFileSync(path, 'utf8'))

  const chunks = manifest.chunks.map((c) => {
    const hex = readFileSync(join(dir, c.file), 'utf8').trim()
    const data = hexToBytes(hex)
    // A manifest that no longer matches its .hex files is the one silent way
    // to write the wrong bytes permanently.
    if (data.length !== c.bytes) throw new Error(`${c.file}: ${data.length} bytes, manifest says ${c.bytes}`)
    if (sha256(data) !== c.sha256) throw new Error(`${c.file}: sha256 does not match the manifest`)
    return { ...c, hex, data }
  })

  const rejoined = Buffer.concat(chunks.map((c) => Buffer.from(c.data)))
  if (sha256(rejoined) !== manifest.sha256) throw new Error(`${name}: chunks do not rebuild ${manifest.source}`)

  return { dir, name, manifest, chunks, rejoined }
})

const vesselId = BigInt(jobs[0].manifest.vessel)
if (jobs.some((j) => BigInt(j.manifest.vessel) !== vesselId)) {
  throw new Error('all chunk directories must target the same vessel')
}

const pub = createPublicClient({ chain: mainnet, transport: http(RPC) })
const read = (fn, a = [vesselId]) =>
  pub.readContract({ address: ADDRESSES.vessel, abi: vesselAbi, functionName: fn, args: a })

const [liveEntry, isVault, locked, owner] = await Promise.all([
  read('craftToEntry'), read('craftToVaultStatus'), read('craftToLocked'), read('ownerOf'),
])

if (!isVault) throw new Error(`vessel #${vesselId} is not a Vault`)
if (locked) throw new Error(`vessel #${vesselId} is locked — no further entries can be written`)

console.log(`vessel #${vesselId} — vault, unlocked, held by ${owner}`)
console.log(`live entry count: ${liveEntry}`)
console.log()

// ── plan against what is already on chain ───────────────────────────────────
//
// Entries are assigned by arrival, not by the manifest, and a manifest goes
// stale the moment anything else is written to the vault. Trusting its slot
// numbers is how a file gets stored twice: the second copy is as permanent as
// the first and costs the same.
//
// So the plan is built from content, not from numbers. Every existing entry is
// read and hashed once, and a file already present anywhere in the vault is
// skipped — whatever the manifest claims its entries were.

console.log(`reading ${liveEntry} existing entr${liveEntry === 1n ? 'y' : 'ies'} to see what is already stored…`)
const existing = []
for (let e = 0n; e < liveEntry; e++) {
  const hex = await pub.readContract({
    address: ADDRESSES.vessel, abi: vesselAbi, functionName: 'vaultToEntry', args: [vesselId, e],
  })
  existing.push(sha256(Buffer.from(hexToBytes(hex))))
}

/// Where this file's chunks already sit, if they do — a contiguous run of
/// entries whose hashes match the manifest's, in order.
function findExisting(job) {
  const want = job.chunks.map((c) => c.sha256)
  for (let start = 0; start + want.length <= existing.length; start++) {
    if (want.every((h, i) => existing[start + i] === h)) {
      return Array.from({ length: want.length }, (_, i) => start + i)
    }
  }
  return null
}

let cursor = Number(liveEntry)
const pending = []

for (const job of jobs) {
  const found = findExisting(job)
  if (found) {
    job.actualEntries = found
    console.log(`  ${job.manifest.source} is already on chain at entries ${found[0]}–${found.at(-1)} — skipping`)
    if (String(found) !== String(job.manifest.entries)) {
      console.log(`    (the manifest said ${job.manifest.entries[0]}–${job.manifest.entries.at(-1)};`
        + ` use the real entries above when referencing it in Kiln)`)
    }
    continue
  }
  // Not present: it appends at the current end, whatever the manifest guessed.
  job.actualEntries = job.chunks.map((_, i) => cursor + i)
  if (String(job.actualEntries) !== String(job.manifest.entries)) {
    console.log(`  ${job.manifest.source}: manifest said entries ${job.manifest.entries[0]}–${job.manifest.entries.at(-1)},`
      + ` the vault has moved on — it will land at ${job.actualEntries[0]}–${job.actualEntries.at(-1)}`)
  }
  for (const [i, chunk] of job.chunks.entries()) {
    pending.push({ job, chunk, entry: job.actualEntries[i] })
    cursor++
  }
}
console.log()

if (!pending.length) {
  console.log('nothing to write — everything is already stored.')
} else {
  console.log(`${pending.length} write(s) to make, entries ${pending[0].entry}–${pending.at(-1).entry}:`)
  for (const p of pending) {
    console.log(`  entry ${p.entry}  ${p.job.name} chunk ${p.chunk.index}  ${p.chunk.bytes.toLocaleString()} B`)
  }
}
console.log()

const calldataFor = (chunk) =>
  encodeFunctionData({ abi: writeAbi, functionName: 'setPayloadHolder', args: [vesselId, chunk.hex] })

// ── calldata: for a hardware wallet, Rabby, a Safe, or Etherscan ────────────

if (has('calldata')) {
  const out = pending.map((p) => ({
    to: ADDRESSES.vessel,
    value: '0',
    data: calldataFor(p.chunk),
    note: `${p.job.name} chunk ${p.chunk.index} → entry ${p.entry} (${p.chunk.bytes} bytes)`,
  }))
  const path = 'vessel-writes.json'
  writeFileSync(path, JSON.stringify(out, null, 2) + '\n')
  console.log(`wrote ${out.length} transaction(s) to ${path}`)
  console.log(`send them to ${ADDRESSES.vessel} IN ORDER, each confirmed before the next.`)
  console.log(`on Etherscan use the setPayloadHolder write tab: _tokenId ${vesselId}, _bytes the chunk hex.`)
  process.exit(0)
}

// ── broadcast ───────────────────────────────────────────────────────────────

if (has('broadcast')) {
  const key = process.env.VESSEL_KEY
  if (!key) {
    console.error('set VESSEL_KEY to the holder key, or use --calldata to sign elsewhere.')
    process.exit(1)
  }
  const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`)
  if (account.address.toLowerCase() !== owner.toLowerCase()) {
    console.error(`VESSEL_KEY is ${account.address}, which does not hold vessel #${vesselId} (${owner}).`)
    process.exit(1)
  }
  const wallet = createWalletClient({ account, chain: mainnet, transport: http(RPC) })
  await runWrites(wallet, account, pub)
  await verifyOnChain(pub)
  process.exit(0)
}

// ── simulate (default) ──────────────────────────────────────────────────────

console.log('simulating on a mainnet fork — nothing is sent.')
if (!pending.length) process.exit(0)

const FORK_PORT = 8549
const forkRpc = `http://127.0.0.1:${FORK_PORT}`
const anvil = spawn('anvil', ['--fork-url', RPC, '--port', String(FORK_PORT), '--silent'], { stdio: 'ignore' })
process.on('exit', () => anvil.kill())

// Impersonation lets the simulation run as the real holder without a key,
// which is the point: the rehearsal must not need the thing it is protecting.
const forkChain = { ...mainnet, id: 1, rpcUrls: { default: { http: [forkRpc] } } }
const forkPub = createPublicClient({ chain: forkChain, transport: http(forkRpc) })
for (let i = 0; ; i++) {
  try { await forkPub.getBlockNumber(); break }
  catch { if (i > 60) throw new Error('anvil did not come up'); await new Promise((r) => setTimeout(r, 500)) }
}
try {
  await forkPub.request({ method: 'anvil_impersonateAccount', params: [owner] })
  await forkPub.request({ method: 'anvil_setBalance', params: [owner, '0x21e19e0c9bab2400000'] })
  const wallet = createWalletClient({ account: owner, chain: forkChain, transport: http(forkRpc) })
  await runWrites(wallet, { address: owner }, forkPub)
  await verifyOnChain(forkPub)
  console.log()
  console.log('simulation only — nothing was sent. --calldata to sign elsewhere, --broadcast to send.')
} finally {
  anvil.kill()
}

// ── the two halves used by both paths ───────────────────────────────────────

async function runWrites(wallet, account, client) {
  let totalGas = 0n
  for (const p of pending) {
    const gas = await client.estimateContractGas({
      account: account.address, address: ADDRESSES.vessel, abi: writeAbi,
      functionName: 'setPayloadHolder', args: [vesselId, p.chunk.hex],
    })
    const hash = await wallet.writeContract({
      address: ADDRESSES.vessel, abi: writeAbi, functionName: 'setPayloadHolder',
      args: [vesselId, p.chunk.hex], gas: (gas * 12n) / 10n,
    })
    const receipt = await client.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`entry ${p.entry} reverted (${hash})`)
    totalGas += receipt.gasUsed
    console.log(`  entry ${p.entry} ✓  ${receipt.gasUsed.toLocaleString()} gas  ${hash}`)
  }
  const price = await client.getGasPrice()
  console.log()
  console.log(`total ${totalGas.toLocaleString()} gas`
    + ` — ${(Number(totalGas * price) / 1e18).toFixed(5)} ETH at ${(Number(price) / 1e9).toFixed(2)} gwei`)
}

/// The only check that matters: read the entries back through the same call
/// VesselPortal will make, and confirm they rebuild the original file.
async function verifyOnChain(client) {
  console.log()
  for (const job of jobs) {
    const parts = []
    for (const entry of job.actualEntries ?? job.manifest.entries) {
      const hex = await client.readContract({
        address: ADDRESSES.vessel, abi: vesselAbi, functionName: 'vaultToEntry', args: [vesselId, BigInt(entry)],
      })
      parts.push(Buffer.from(hexToBytes(hex)))
    }
    const rebuilt = Buffer.concat(parts)
    const ok = sha256(rebuilt) === job.manifest.sha256
    const at = job.actualEntries ?? job.manifest.entries
    console.log(`${job.manifest.source}: entries ${at[0]}–${at.at(-1)}`
      + ` → ${rebuilt.length.toLocaleString()} B  ${ok ? 'IDENTICAL ✓' : 'MISMATCH ✗'}`)
    if (!ok) process.exitCode = 1
  }
  console.log()
  console.log(`in Kiln: reference a vessel token → ${vesselId} → inspect → pinned entries → assemble mode,`)
  for (const job of jobs) {
    console.log(`  ${job.manifest.source}: select ${(job.actualEntries ?? job.manifest.entries).join(', ')} in that order`)
  }
}
