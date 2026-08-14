#!/usr/bin/env node
// The rehearsal: everything Kiln will ask a wallet to sign, executed against
// an anvil fork of mainnet with a throwaway key. Run this before any real
// signature. It exercises both paths end to end:
//
//   1. Upload path — cloneCollectionAndMint with a small HTML artwork,
//      auction included; asserts tokenURI decodes back to the exact inputs.
//   2-4. VesselPortal paths — deploy, register, then mint with an inline
//      poster, with BOTH poster and artwork referenced (the point of the
//      design), and against a relic. Every rendered byte is asserted against
//      a direct read of the source contract.
//
// Usage: npm run rehearse   (MAINNET_RPC_URL overrides the fork source)

import { spawn, execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  createPublicClient, createWalletClient, http, defineChain, parseEther, decodeAbiParameters,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import {
  ADDRESSES, buildUploadArtifact, chunkArtifact, KIND, referenceSource,
  inlineSource, absentSource, buildArtifact,
  toDataURI, utf8Bytes, bytesToHex, base64Decode, estimateGas, usdToWei, auctionExpiry,
} from '../src/kiln.js'
import { factoryAbi, collectionAbi, auctionsAbi, chainlinkAbi, vesselAbi, relicsAbi } from '../src/abi.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FORK_URL = process.env.MAINNET_RPC_URL ?? 'https://ethereum-rpc.publicnode.com'
const ANVIL_PORT = 8547
// keccak256("kiln fork rehearsal key — worthless, never fund on a real network").
// NOT an anvil stock key: those are public, and on a mainnet fork their real
// mainnet accounts carry EIP-7702 sweeper delegations that steal any token
// minted to them mid-transaction. Learned the hard way; see README.
const KEY = '0x4eb5dcd33bf040f5861ac088bbe428e4b601a3ef185a27d2d48c122c6a3b4190'

const ok = (label) => console.log(`  ✓ ${label}`)
function assert(cond, label) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${label}`)
  ok(label)
}

// ── anvil ───────────────────────────────────────────────────────────────────

console.log(`Forking mainnet from ${FORK_URL} …`)
const anvil = spawn('anvil', ['--fork-url', FORK_URL, '--port', String(ANVIL_PORT), '--silent'], {
  stdio: ['ignore', 'ignore', 'inherit'],
})
process.on('exit', () => anvil.kill())

const chain = defineChain({
  id: 1, name: 'anvil-fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [`http://127.0.0.1:${ANVIL_PORT}`] } },
})
const account = privateKeyToAccount(KEY)
// A cold fork faults every storage slot in from upstream, and a fully
// referenced token reads ~75 KB across eight entries — well past viem's 10s
// default. This is fork latency, not chain cost.
const transport = http(undefined, { timeout: 180_000 })
const pub = createPublicClient({ chain, transport })
const wallet = createWalletClient({ chain, transport, account })

for (let i = 0; ; i++) {
  try { await pub.getBlockNumber(); break }
  catch { if (i > 60) throw new Error('anvil did not come up'); await new Promise((r) => setTimeout(r, 500)) }
}
await pub.request({ method: 'anvil_setBalance', params: [account.address, '0x21e19e0c9bab2400000'] })
console.log(`Fork ready. Rehearsal account ${account.address} funded.\n`)

async function send(label, args) {
  const gas = await pub.estimateContractGas({ account, ...args })
  const hash = await wallet.writeContract({ ...args, gas: (gas * 12n) / 10n })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`${label} reverted`)
  console.log(`  ${label}: ${receipt.gasUsed} gas`)
  return receipt
}

const factory = { address: ADDRESSES.factory, abi: factoryAbi }
const expectedAuctions = await pub.readContract({ ...factory, functionName: 'auctions' })
const feed = await pub.readContract({ address: expectedAuctions, abi: auctionsAbi, functionName: 'ETH_USD' })
const [, answer] = await pub.readContract({ address: feed, abi: chainlinkAbi, functionName: 'latestRoundData' })
console.log(`ETH/USD feed: $${Number(answer) / 1e8}`)

// ── path 1: upload, new collection, auction ─────────────────────────────────

console.log('\n[1/2] Upload path — cloneCollectionAndMint')

const artworkHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000}</style></head><body><canvas id="c"></canvas><script>const c=document.getElementById('c'),x=c.getContext('2d');c.width=innerWidth;c.height=innerHeight;let t=0;(function d(){t++;x.fillStyle='rgba(0,0,0,.05)';x.fillRect(0,0,c.width,c.height);x.fillStyle='hsl('+t%360+',80%,60%)';x.fillRect((Math.sin(t/40)+1)/2*c.width,(Math.cos(t/31)+1)/2*c.height,8,8);requestAnimationFrame(d)})()</script></body></html>`
const posterPng = base64Decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==')

const imageDataURI = toDataURI(posterPng, 'image/png')
const animationDataURI = toDataURI(utf8Bytes(artworkHtml), 'text/html')
const { bytes: artifactBytes, rendererIndex } = buildUploadArtifact({ imageDataURI, animationDataURI })
const chunks = chunkArtifact(artifactBytes)

const modelGas = estimateGas({ byteLength: artifactBytes.length, chunkCount: chunks.length, newCollection: true, auction: true })
const reserveUsd = 10n
const feeWei = usdToWei(10n, answer) // $10 lot-creation fee, refunded above actual
const now = (await pub.getBlock()).timestamp
const params1 = {
  tokenId: 1n,
  artifact: chunks.map(bytesToHex),
  name: 'Rehearsal',
  description: 'Kiln fork rehearsal — upload path',
  rendererIndex,
  rendererData: 0n,
}

const receipt1 = await send('cloneCollectionAndMint', {
  ...factory,
  functionName: 'cloneCollectionAndMint',
  args: ['Kiln Rehearsal', 'KILN', expectedAuctions, params1, reserveUsd, auctionExpiry(Number(now), 86_400)],
  value: (feeWei * 105n) / 100n,
})
console.log(`  model estimate was ${modelGas} gas (${((Number(receipt1.gasUsed) / modelGas - 1) * 100).toFixed(1)}% off actual)`)

const collectionAddr = await pub.readContract({ ...factory, functionName: 'collectionsOf', args: [account.address, 0n] })
const collection = { address: collectionAddr, abi: collectionAbi }
console.log(`  collection: ${collectionAddr}`)

const uri1 = await pub.readContract({ ...collection, functionName: 'tokenURI', args: [1n] })
const json1 = JSON.parse(new TextDecoder().decode(base64Decode(uri1.split(',')[1])))
assert(json1.image === imageDataURI, 'tokenURI image is byte-identical to the uploaded poster')
assert(json1.animation_url === animationDataURI, 'tokenURI animation_url is byte-identical to the uploaded HTML')
const decodedHtml = new TextDecoder().decode(base64Decode(json1.animation_url.split(',')[1]))
assert(decodedHtml === artworkHtml, 'animation decodes back to the exact source HTML')

// ── path 2: vessel animation + inline poster ────────────────────────────────

console.log('\n[2/4] VesselPortal — vessel animation, uploaded poster')

const artifactJson = JSON.parse(readFileSync(join(ROOT, 'contracts/out/VesselPortal.sol/VesselPortal.json'), 'utf8'))
const deployHash = await wallet.deployContract({
  abi: artifactJson.abi, bytecode: artifactJson.bytecode.object, args: [ADDRESSES.vessel, ADDRESSES.relics],
})
const { contractAddress: portalAddr } = await pub.waitForTransactionReceipt({ hash: deployHash })
console.log(`  VesselPortal deployed: ${portalAddr}`)

await send('registerRenderer', { ...collection, functionName: 'registerRenderer', args: [portalAddr] })
const portalIndex = (await pub.readContract({ ...collection, functionName: 'rendererCount' })) - 1n
const registered = await pub.readContract({ ...collection, functionName: 'rendererAt', args: [Number(portalIndex)] })
assert(registered.toLowerCase() === portalAddr.toLowerCase(), `registered at renderer index ${portalIndex}`)

const vessel = { address: ADDRESSES.vessel, abi: vesselAbi }
const entry5 = await pub.readContract({ ...vessel, functionName: 'vaultToEntry', args: [2623n, 5n] })

const mintReference = async (tokenId, name, artifactBytes) => {
  const params = {
    tokenId,
    artifact: chunkArtifact(artifactBytes).map(bytesToHex),
    name,
    description: 'Kiln fork rehearsal',
    rendererIndex: Number(portalIndex),
    rendererData: 0n,
  }
  return send(`mint (${name})`, { ...collection, functionName: 'mint', args: [params] })
}

const readMeta = async (tokenId) => {
  const uri = await pub.readContract({ ...collection, functionName: 'tokenURI', args: [tokenId] })
  return JSON.parse(new TextDecoder().decode(base64Decode(uri.split(',')[1])))
}

const { bytes: ref2 } = buildArtifact({
  poster: inlineSource({ bytes: posterPng, mime: 'image/png' }),
  animation: referenceSource({ kind: KIND.vessel, vesselTokenId: 2623n, entries: [5n], mime: 'text/html' }),
})
const receipt2 = await mintReference(2n, 'inline poster', ref2)
const meta2 = await readMeta(2n)
assert(
  bytesToHex(base64Decode(meta2.animation_url.split(',')[1])) === entry5,
  'animation equals vaultToEntry(2623, 5) byte for byte',
)
assert(meta2.image === toDataURI(posterPng, 'image/png'), 'inline poster round-trips')
assert(!meta2.mutable, 'pinned sources are not marked mutable')

// ── path 3: BOTH sources referenced — the point of this design ──────────────

console.log('\n[3/4] VesselPortal — vault poster + vault animation, nothing stored')

const posterEntry = await pub.readContract({ ...vessel, functionName: 'vaultToEntry', args: [9994n, 40n] })
const { bytes: ref3 } = buildArtifact({
  poster: referenceSource({ kind: KIND.vessel, vesselTokenId: 9994n, entries: [40n], mime: 'image/svg+xml' }),
  animation: referenceSource({
    kind: KIND.vessel, vesselTokenId: 9994n, entries: [32n, 33n, 34n, 35n, 36n, 37n, 38n], mime: 'text/html',
  }),
})
const posterBytes = (posterEntry.length - 2) / 2
console.log(`  ${posterBytes.toLocaleString()}-byte poster + 65,105-byte artwork referenced in ${ref3.length} bytes`)
assert(ref3.length < 1024, 'a fully referenced artifact stays under 1 KB')

const receipt3 = await mintReference(3n, 'both referenced', ref3)
const meta3 = await readMeta(3n)
assert(
  bytesToHex(base64Decode(meta3.image.split(',')[1])) === posterEntry,
  'poster equals vaultToEntry(9994, 40) byte for byte — never stored in the token',
)
const assembled = base64Decode(meta3.animation_url.split(',')[1])
assert(assembled.length === 65_105, `sharded document reassembles to 65,105 bytes (got ${assembled.length})`)
assert(new TextDecoder().decode(assembled.subarray(0, 15)) === '<!DOCTYPE html>', 'and starts as one HTML document')

// ── path 4: relic reference ─────────────────────────────────────────────────

console.log('\n[4/4] VesselPortal — relic source')

const relics = { address: ADDRESSES.relics, abi: relicsAbi }
const relicBytes = await pub.readContract({ ...relics, functionName: 'vaultRelicToEntry', args: [9778n, 1n] })
const { bytes: ref4 } = buildArtifact({
  poster: inlineSource({ bytes: posterPng, mime: 'image/png' }),
  animation: referenceSource({
    kind: KIND.relics, vesselTokenId: 9778n, entries: [1n], mime: 'application/octet-stream',
  }),
})
const receipt4 = await mintReference(4n, 'relic reference', ref4)
const meta4 = await readMeta(4n)
assert(
  bytesToHex(base64Decode(meta4.animation_url.split(',')[1])) === relicBytes,
  'animation equals vaultRelicToEntry(9778, 1) byte for byte',
)
assert(meta4.mutable === true, 'relic sources are marked mutable — curators can edit them')

console.log(`\nRehearsal passed.
  upload (stock renderers)      ${receipt1.gasUsed} gas
  inline poster + vault artwork ${receipt2.gasUsed} gas
  BOTH referenced               ${receipt3.gasUsed} gas
  relic reference               ${receipt4.gasUsed} gas`)
anvil.kill()
process.exit(0)
