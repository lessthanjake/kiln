#!/usr/bin/env node
// The rehearsal: everything Kiln will ask a wallet to sign, executed against
// an anvil fork of mainnet with a throwaway key. Run this before any real
// signature. It exercises both paths end to end:
//
//   1. Upload path — cloneCollectionAndMint with a small HTML artwork,
//      auction included; asserts tokenURI decodes back to the exact inputs.
//   2. VesselPortal path — deploy VesselPortal, register it, mint a token that
//      references vessel #3348 entry 5 (RGB Carrier); asserts the rendered
//      animation equals the bytes read straight off The Vessel.
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
  ADDRESSES, buildUploadArtifact, buildVesselPortalReference, chunkArtifact,
  toDataURI, utf8Bytes, bytesToHex, base64Decode, estimateGas, usdToWei, auctionExpiry,
} from '../src/kiln.js'
import { factoryAbi, collectionAbi, auctionsAbi, chainlinkAbi, vesselAbi, relicsAbi } from '../src/abi.js'
import { SOURCE } from '../src/kiln.js'

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
const pub = createPublicClient({ chain, transport: http() })
const wallet = createWalletClient({ chain, transport: http(), account })

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

// ── path 2: vesselPortal, vessel reference ──────────────────────────────────────

console.log('\n[2/2] VesselPortal path — reference vessel #3348 entry 5 (RGB Carrier)')

const artifact = JSON.parse(readFileSync(join(ROOT, 'contracts/out/VesselPortal.sol/VesselPortal.json'), 'utf8'))
const deployHash = await wallet.deployContract({
  abi: artifact.abi, bytecode: artifact.bytecode.object, args: [ADDRESSES.vessel, ADDRESSES.relics],
})
const { contractAddress: vesselPortalAddr } = await pub.waitForTransactionReceipt({ hash: deployHash })
console.log(`  VesselPortal deployed: ${vesselPortalAddr}`)

await send('registerRenderer', { ...collection, functionName: 'registerRenderer', args: [vesselPortalAddr] })
const vesselPortalIndex = (await pub.readContract({ ...collection, functionName: 'rendererCount' })) - 1n
const registered = await pub.readContract({ ...collection, functionName: 'rendererAt', args: [Number(vesselPortalIndex)] })
assert(registered.toLowerCase() === vesselPortalAddr.toLowerCase(), `VesselPortal registered at renderer index ${vesselPortalIndex}`)

const vessel = { address: ADDRESSES.vessel, abi: vesselAbi }
const entryBytesHex = await pub.readContract({ ...vessel, functionName: 'vaultToEntry', args: [3348n, 5n] })

const { bytes: refBytes } = buildVesselPortalReference({
  imageDataURI, mime: 'text/html', vesselTokenId: 3348n, entries: [5n],
})
const params2 = {
  tokenId: 2n,
  artifact: chunkArtifact(refBytes).map(bytesToHex),
  name: 'Through the VesselPortal',
  description: 'Kiln fork rehearsal — vessel reference',
  rendererIndex: Number(vesselPortalIndex),
  rendererData: 0n,
}
const receipt2 = await send('mint (vesselPortal reference)', { ...collection, functionName: 'mint', args: [params2] })

const uri2 = await pub.readContract({ ...collection, functionName: 'tokenURI', args: [2n] })
const json2 = JSON.parse(new TextDecoder().decode(base64Decode(uri2.split(',')[1])))
const renderedBytes = base64Decode(json2.animation_url.split(',')[1])
assert(json2.animation_url.startsWith('data:text/html;base64,'), 'vesselPortal animation_url is typed text/html')
assert(bytesToHex(renderedBytes) === entryBytesHex, 'rendered animation equals vaultToEntry(3348, 5) byte for byte')
assert(json2.image === imageDataURI, 'vesselPortal poster survives the reference round-trip')
console.log(`  reference artifact was ${refBytes.length} bytes for a ${renderedBytes.length}-byte artwork`)

// ── path 3: relic reference ─────────────────────────────────────────────────

console.log('\n[3/3] Relic path — pin vault-relic #9778 entry 1 (Manhattan Blocks)')

const relics = { address: ADDRESSES.relics, abi: relicsAbi }
const relicBytesHex = await pub.readContract({ ...relics, functionName: 'vaultRelicToEntry', args: [9778n, 1n] })

const { bytes: relicRef } = buildVesselPortalReference({
  imageDataURI, mime: 'application/octet-stream', vesselTokenId: 9778n, entries: [1n], source: SOURCE.relics,
})
const params3 = {
  tokenId: 3n,
  artifact: chunkArtifact(relicRef).map(bytesToHex),
  name: 'Relic Through the VesselPortal',
  description: 'Kiln fork rehearsal — relic reference',
  rendererIndex: Number(vesselPortalIndex),
  rendererData: 0n,
}
const receipt3 = await send('mint (relic reference)', { ...collection, functionName: 'mint', args: [params3] })

const uri3 = await pub.readContract({ ...collection, functionName: 'tokenURI', args: [3n] })
const json3 = JSON.parse(new TextDecoder().decode(base64Decode(uri3.split(',')[1])))
const relicRendered = base64Decode(json3.animation_url.split(',')[1])
assert(bytesToHex(relicRendered) === relicBytesHex, 'rendered animation equals vaultRelicToEntry(9778, 1) byte for byte')

console.log(`\nRehearsal passed. Upload mint: ${receipt1.gasUsed} gas. VesselPortal mint: ${receipt2.gasUsed} gas. Relic mint: ${receipt3.gasUsed} gas.`)
anvil.kill()
process.exit(0)
