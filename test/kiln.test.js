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
  referenceSource,
  inlineSource,
  absentSource,
  isAbsent,
  isMutableSource,
  buildArtifact,
  decodeArtifact,
  KIND,
  KIND_MIME,
  MAX_CONTENT_BYTES,
  WARN_CONTENT_BYTES,
  MAX_ENTRIES,
  contentSizeVerdict,
  mimeForFile,
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

test('a fully referenced artifact round-trips and stays tiny', () => {
  const poster = referenceSource({ kind: KIND.vessel, vesselTokenId: 9994, entries: [40], mime: 'image/svg+xml' })
  const animation = referenceSource({
    kind: KIND.vessel, vesselTokenId: 9994, entries: [32, 33, 34, 35, 36, 37, 38], mime: 'text/html',
  })
  const { bytes } = buildArtifact({ poster, animation })
  // ~75 KB of artwork + ~10 KB of poster, referenced in under 1 KB.
  assert.ok(bytes.length < 1024, `expected < 1KB, got ${bytes.length}`)

  const decoded = decodeArtifact(bytes)
  assert.equal(decoded.poster.kind, KIND.vessel)
  assert.equal(decoded.poster.tokenId, 9994n)
  assert.deepEqual([...decoded.animation.entries], [32n, 33n, 34n, 35n, 36n, 37n, 38n])
  assert.equal(decoded.animation.mime, 'text/html')
})

test('inline sources carry raw bytes, not a pre-formed data URI', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  const { bytes } = buildArtifact({
    poster: inlineSource({ bytes: png, mime: 'image/png' }),
    animation: absentSource(),
  })
  const { poster, animation } = decodeArtifact(bytes)
  assert.equal(poster.data, '0x89504e47')
  assert.equal(poster.mime, 'image/png')
  assert.ok(isAbsent(animation), 'empty inline data means absent')
  assert.ok(!isAbsent(poster))
})

test('relic entry 0 is rejected at build time', () => {
  assert.throws(
    () => referenceSource({ kind: KIND.relics, vesselTokenId: 9778, entries: [0], mime: 'text/html' }),
    /1-based/,
  )
})

test('entries beyond MAX_ENTRIES are rejected at build time', () => {
  assert.throws(
    () => referenceSource({
      kind: KIND.vessel, vesselTokenId: 1, entries: Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => i), mime: 'text/html',
    }),
    /at most/,
  )
})

test('cross-field violations are rejected before they reach the chain', () => {
  const bad = { ...referenceSource({ kind: KIND.vessel, vesselTokenId: 1, entries: [], mime: 'x/y' }), data: '0xdead' }
  assert.throws(() => buildArtifact({ poster: absentSource(), animation: bad }), /cannot carry inline data/)

  const bad2 = { ...inlineSource({ bytes: new Uint8Array([1]), mime: 'x/y' }), entries: [1n] }
  assert.throws(() => buildArtifact({ poster: bad2, animation: absentSource() }), /cannot have entries/)
})

test('mutability mirrors the contract marker', () => {
  const pinned = referenceSource({ kind: KIND.vessel, vesselTokenId: 1, entries: [1], mime: 'x/y' })
  const live = referenceSource({ kind: KIND.vessel, vesselTokenId: 1, entries: [], mime: 'x/y' })
  const relicPinned = referenceSource({ kind: KIND.relics, vesselTokenId: 1, entries: [1], mime: 'x/y' })
  assert.equal(isMutableSource(pinned), false, 'pinned vault entries are permanent')
  assert.equal(isMutableSource(live), true, 'live payload follows the holder')
  assert.equal(isMutableSource(relicPinned), true, 'relic bytes stay curator-editable')
  assert.equal(isMutableSource(inlineSource({ bytes: new Uint8Array([1]), mime: 'x/y' })), false)
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

test('an oversized upload is warned about differently than a vessel reference', () => {
  const over = MAX_CONTENT_BYTES + 1
  // VesselPortal refuses and degrades — the token still shows something.
  assert.match(contentSizeVerdict(over, 'vessel').message, /only its thumbnail/)
  // The stock renderers do not refuse; the token mints and cannot be read.
  const up = contentSizeVerdict(over, 'upload').message
  assert.match(up, /will mint but will not render/)
  assert.match(up, /permanently/)
})

test('content size verdict tracks the shared renderer budget', () => {
  assert.equal(contentSizeVerdict(50_000).level, 'ok')
  assert.equal(contentSizeVerdict(WARN_CONTENT_BYTES + 1).level, 'warn')
  assert.equal(contentSizeVerdict(MAX_CONTENT_BYTES + 1).level, 'error')
  // The JS mirror must match the constants the contract enforces.
  assert.equal(MAX_CONTENT_BYTES, 128 * 1024)
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

test('mimeForFile names what animation_url actually carries', () => {
  const cases = [
    ['piece.html', '', 'text/html'],
    ['loop.mp4', 'video/mp4', 'video/mp4'],
    ['clip.mov', '', 'video/quicktime'],
    ['scene.glb', '', 'model/gltf-binary'],
    ['track.mp3', '', 'audio/mpeg'],
    ['anim.gif', '', 'image/gif'],
    // Browsers often hand over an empty or generic type; the extension wins.
    ['piece.html', 'application/octet-stream', 'text/html'],
  ]
  for (const [name, type, expected] of cases) {
    assert.equal(mimeForFile({ name, type }), expected, `${name} (${type || 'no type'})`)
  }
  // Unknown and unnameable: refuse rather than mint something mislabelled.
  assert.equal(mimeForFile({ name: 'mystery.qqq', type: '' }), null)
  assert.equal(mimeForFile({ name: 'blob', type: 'application/octet-stream' }), null)
})
