import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeAbiParameters } from 'viem'

import {
  CHUNK_SIZE,
  SINGLE_TX_GAS_CAP,
  base64Encode,
  base64Decode,
  toDataURI,
  utf8Bytes,
  bytesToHex,
  hexToBytes,
  buildUploadArtifact,
  buildVesselPortalReference,
  decodeVesselPortalReference,
  SOURCE,
  KIND_MIME,
  MAX_CONTENT_BYTES,
  WARN_CONTENT_BYTES,
  MAX_ENTRIES,
  contentSizeVerdict,
  xmlAssemblyWarnings,
  trailingJunk,
  isXmlMime,
  chunkArtifact,
  estimateGas,
  usdToWei,
  weiToUsd,
  costFromGas,
  planFlow,
  auctionExpiry,
  RENDERER,
} from '../src/kiln.js'

function randomBytes(n) {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = (i * 7 + 13) % 256
  return b
}

test('base64Encode matches Buffer for small and large payloads', () => {
  for (const n of [0, 1, 2, 3, 100, 0x8000 - 1, 0x8000, 0x8000 + 1, 200_000]) {
    const bytes = randomBytes(n)
    assert.equal(base64Encode(bytes), Buffer.from(bytes).toString('base64'))
  }
})

test('base64Decode inverts base64Encode', () => {
  const bytes = randomBytes(70_001)
  assert.deepEqual(base64Decode(base64Encode(bytes)), bytes)
})

test('hex round-trip', () => {
  const bytes = randomBytes(1000)
  assert.deepEqual(hexToBytes(bytesToHex(bytes)), bytes)
})

test('toDataURI shape', () => {
  assert.equal(toDataURI(utf8Bytes('hi'), 'text/html'), 'data:text/html;base64,aGk=')
})

test('image-only artifact is the raw URI bytes with the default renderer', () => {
  const uri = 'data:image/png;base64,QUJD'
  const { bytes, rendererIndex } = buildUploadArtifact({ imageDataURI: uri })
  assert.equal(rendererIndex, RENDERER.default)
  assert.equal(new TextDecoder().decode(bytes), uri)
})

test('image+animation artifact abi-decodes as (string,string)', () => {
  const image = 'data:image/png;base64,QUJD'
  const animation = 'data:text/html;base64,PGh0bWw+'
  const { bytes, rendererIndex } = buildUploadArtifact({ imageDataURI: image, animationDataURI: animation })
  assert.equal(rendererIndex, RENDERER.animation)
  const [img, anim] = decodeAbiParameters(
    [{ type: 'string' }, { type: 'string' }],
    bytesToHex(bytes),
  )
  assert.equal(img, image)
  assert.equal(anim, animation)
})

test('vesselPortal reference round-trips through abi encoding', () => {
  const input = {
    imageDataURI: 'data:image/png;base64,cG9zdGVy',
    mime: 'text/html',
    vesselTokenId: 3348,
    entries: [1, 2, 5],
  }
  const { bytes } = buildVesselPortalReference(input)
  const decoded = decodeVesselPortalReference(bytes)
  assert.equal(decoded.imageDataURI, input.imageDataURI)
  assert.equal(decoded.mime, input.mime)
  assert.equal(decoded.vesselTokenId, 3348n)
  assert.deepEqual([...decoded.entries], [1n, 2n, 5n])
  assert.equal(decoded.source, SOURCE.vessel)
})

test('live-mode vesselPortal reference has empty entries', () => {
  const { bytes } = buildVesselPortalReference({
    imageDataURI: 'data:image/png;base64,cA==',
    vesselTokenId: 9994,
    entries: [],
  })
  const decoded = decodeVesselPortalReference(bytes)
  assert.equal(decoded.entries.length, 0)
  assert.equal(decoded.mime, 'text/html')
  assert.equal(decoded.source, SOURCE.vessel)
})

test('relic reference carries source 1 and 1-based entries', () => {
  const { bytes } = buildVesselPortalReference({
    imageDataURI: 'data:image/png;base64,cA==',
    mime: 'audio/mpeg',
    vesselTokenId: 9778,
    entries: [1],
    source: SOURCE.relics,
  })
  const decoded = decodeVesselPortalReference(bytes)
  assert.equal(decoded.source, SOURCE.relics)
  assert.deepEqual([...decoded.entries], [1n])
  assert.equal(decoded.mime, 'audio/mpeg')
})

test('relic entry 0 is rejected at build time', () => {
  assert.throws(
    () => buildVesselPortalReference({
      imageDataURI: 'data:image/png;base64,cA==',
      vesselTokenId: 9778,
      entries: [0],
      source: SOURCE.relics,
    }),
    /1-based/,
  )
})

test('KIND_MIME maps every sniffer kind', () => {
  for (const kind of ['html', 'svg', 'png', 'mp3', 'text', 'bytes']) {
    assert.ok(KIND_MIME[kind], `missing mime for kind ${kind}`)
  }
})

test('chunking respects the SSTORE2 limit exactly', () => {
  assert.equal(chunkArtifact(randomBytes(CHUNK_SIZE)).length, 1)
  assert.equal(chunkArtifact(randomBytes(CHUNK_SIZE + 1)).length, 2)
  assert.equal(chunkArtifact(new Uint8Array(0)).length, 0)

  const bytes = randomBytes(CHUNK_SIZE * 2 + 100)
  const chunks = chunkArtifact(bytes)
  assert.equal(chunks.length, 3)
  assert.deepEqual(chunks.map((c) => c.length), [CHUNK_SIZE, CHUNK_SIZE, 100])
  const rejoined = new Uint8Array(bytes.length)
  let off = 0
  for (const c of chunks) { rejoined.set(c, off); off += c.length }
  assert.deepEqual(rejoined, bytes)
})

test('usdToWei ceils exactly like UsdOracle', () => {
  // $10 at $4,000.00000000/ETH → 0.0025 ETH.
  assert.equal(usdToWei(10, 4000_00000000n), 2_500_000_000_000_000n)
  // A price that does not divide cleanly must round up, never down.
  const price = 3333_33333333n
  const wei = usdToWei(10, price)
  assert.ok(weiToUsd(wei, price) >= 10n)
  assert.ok(weiToUsd(wei - 1n, price) < 10n)
})

test('costFromGas converts through gas price and oracle price', () => {
  const { eth, usd } = costFromGas({ gas: 1_000_000, gasPriceWei: 1_000_000_000n, priceE8: 4000_00000000n })
  assert.equal(eth, 0.001)
  assert.equal(usd, 4)
})

test('small mint into a new collection with auction is one factory call', () => {
  const plan = planFlow({ byteLength: 30_000, chunkCount: 2, newCollection: true, auction: true })
  assert.equal(plan.staged, false)
  assert.deepEqual(plan.steps.map((s) => s.call), ['cloneCollectionAndMint'])
})

test('new collection without auction needs clone then mint', () => {
  const plan = planFlow({ byteLength: 10_000, chunkCount: 1, newCollection: true, auction: false })
  assert.deepEqual(plan.steps.map((s) => s.call), ['cloneCollection', 'mint'])
})

test('existing collection small mint is a single call', () => {
  const plan = planFlow({ byteLength: 10_000, chunkCount: 1, newCollection: false, auction: false })
  assert.deepEqual(plan.steps.map((s) => s.call), ['mint'])
})

test('oversized artifact stages prepareArtifact batches under the gas cap', () => {
  const byteLength = 400_000 // ~88M gas if done in one tx
  const chunkCount = Math.ceil(byteLength / CHUNK_SIZE)
  const plan = planFlow({ byteLength, chunkCount, newCollection: true, auction: true })
  assert.equal(plan.staged, true)

  const calls = plan.steps.map((s) => s.call)
  assert.equal(calls[0], 'cloneCollection')
  assert.equal(calls.at(-1), 'mintToLot')
  assert.ok(plan.steps.at(-1).emptyArtifact)

  const batches = plan.steps.filter((s) => s.call === 'prepareArtifact')
  assert.ok(batches.length >= 2)
  // Every chunk is covered exactly once, in order.
  let next = 0
  for (const b of batches) {
    assert.equal(b.chunkFrom, next)
    assert.ok(b.chunkTo > b.chunkFrom)
    next = b.chunkTo
  }
  assert.equal(next, chunkCount)
  // Each batch respects the cap.
  const perChunkGas = CHUNK_SIZE * 220 + 35_000
  for (const b of batches) {
    assert.ok((b.chunkTo - b.chunkFrom) * perChunkGas <= SINGLE_TX_GAS_CAP)
  }
})

test('estimateGas grows with every dimension', () => {
  const base = estimateGas({ byteLength: 1000, chunkCount: 1, newCollection: false, auction: false })
  assert.ok(estimateGas({ byteLength: 2000, chunkCount: 1, newCollection: false, auction: false }) > base)
  assert.ok(estimateGas({ byteLength: 1000, chunkCount: 2, newCollection: false, auction: false }) > base)
  assert.ok(estimateGas({ byteLength: 1000, chunkCount: 1, newCollection: true, auction: false }) > base)
  assert.ok(estimateGas({ byteLength: 1000, chunkCount: 1, newCollection: false, auction: true }) > base)
})

test('auctionExpiry is computed from now, not stored', () => {
  assert.equal(auctionExpiry(1_000_000, 86_400), 1_086_400n)
})

test('content size verdict tracks the renderer ceiling', () => {
  assert.equal(contentSizeVerdict(50_000).level, 'ok')
  assert.equal(contentSizeVerdict(WARN_CONTENT_BYTES + 1).level, 'warn')
  assert.equal(contentSizeVerdict(MAX_CONTENT_BYTES + 1).level, 'error')
  // The JS mirror must match the constants the contract enforces.
  assert.equal(MAX_CONTENT_BYTES, 192 * 1024)
  assert.equal(MAX_ENTRIES, 64)
})

// ── XML assembly warnings ────────────────────────────────────────────────────

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="9" height="9"/></svg>'

function padded(text, pad, n) {
  const body = utf8Bytes(text)
  const out = new Uint8Array(body.length + n)
  out.set(body, 0)
  out.fill(pad, body.length)
  return out
}

test('clean svg produces no warnings', () => {
  assert.deepEqual(xmlAssemblyWarnings({ mime: 'image/svg+xml', parts: [utf8Bytes(SVG)] }), [])
})

test('whitespace padding after the root is legal XML', () => {
  const bytes = padded(SVG, 0x20, 249)
  assert.equal(trailingJunk(bytes), null)
  assert.deepEqual(xmlAssemblyWarnings({ mime: 'image/svg+xml', parts: [bytes] }), [])
})

test('NUL padding after the root is flagged — this is the "extra content" error', () => {
  const bytes = padded(SVG, 0x00, 249)
  const junk = trailingJunk(bytes)
  assert.equal(junk.nul, 249)
  const warnings = xmlAssemblyWarnings({ mime: 'image/svg+xml', parts: [bytes] })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /extra content at the end of the document/)
})

test('two svg roots in one document are flagged', () => {
  const warnings = xmlAssemblyWarnings({
    mime: 'image/svg+xml',
    parts: [utf8Bytes(SVG), utf8Bytes(SVG)],
  })
  assert.ok(warnings.some((w) => /2 <svg> roots/.test(w)))
})

test('sharded html across many entries is never flagged — that is the valid case', () => {
  const parts = ['<!DOCTYPE html><html><body>', '<script>const a=1</script>', '</body></html>']
    .map(utf8Bytes)
  assert.deepEqual(xmlAssemblyWarnings({ mime: 'text/html', parts }), [])
})

test('non-xml mimes are never warned about', () => {
  const bytes = padded(SVG, 0x00, 100)
  assert.deepEqual(xmlAssemblyWarnings({ mime: 'text/html', parts: [bytes] }), [])
  assert.deepEqual(xmlAssemblyWarnings({ mime: 'audio/mpeg', parts: [bytes] }), [])
})

test('isXmlMime is case and whitespace tolerant', () => {
  assert.ok(isXmlMime(' Image/SVG+XML '))
  assert.ok(!isXmlMime('text/html'))
})
