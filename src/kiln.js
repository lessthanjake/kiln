// Kiln's pure logic: everything that turns files and references into the
// exact bytes the networked.art contracts store, plus the arithmetic that
// prices them. No DOM, no wallet — importable from tests and the app alike.

import { encodeAbiParameters, decodeAbiParameters } from 'viem'

// SSTORE2 caps stored data at one byte under the EIP-170 code-size limit.
export const CHUNK_SIZE = 24575

// Above this the app refuses a single transaction and stages the artifact
// with prepareArtifact instead. Mainnet blocks fit more, but a mint should
// not need a whole block.
export const SINGLE_TX_GAS_CAP = 25_000_000

export const ADDRESSES = {
  factory: '0x0c2705cF48e49Cc896252dd16Dc8c5d31DF753B2', // factory.networked.eth
  vessel: '0xECb92Cc7112b80A2234936315BbB493fb48d1463', // THE_VESSEL
  relics: '0x48cB121Fa84b7C08692e74872D044B15369977CD', // THE_VESSEL_relics

  // The canonical VesselPortal, once deployed on mainnet. Fill this in and
  // Kiln never deploys another: the renderer is stateless and ownerless, so
  // one deployment serves every collection and every artist. Leave null and
  // Kiln offers a one-time deploy, then remembers it locally.
  //
  // Kiln verifies this address before trusting it (code present, and
  // name() == "VesselPortal"), so a wrong value degrades to "deploy your
  // own" rather than pointing tokens at a stranger's contract.
  vesselPortal: null,
}

export const RENDERER = { default: 0, animation: 1 }

// ── bytes ↔ text ────────────────────────────────────────────────────────────

export function utf8Bytes(text) {
  return new TextEncoder().encode(text)
}

export function base64Encode(bytes) {
  let binary = ''
  const STRIDE = 0x8000
  for (let i = 0; i < bytes.length; i += STRIDE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + STRIDE))
  }
  return btoa(binary)
}

export function base64Decode(text) {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function toDataURI(bytes, mime) {
  return `data:${mime};base64,${base64Encode(bytes)}`
}

export function bytesToHex(bytes) {
  let hex = '0x'
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

export function hexToBytes(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

// ── artifact construction ───────────────────────────────────────────────────

// Upload path. Image alone → Default renderer reads the artifact as a plain
// URI string. Image + HTML → Animation renderer decodes `(string, string)`.
export function buildUploadArtifact({ imageDataURI, animationDataURI }) {
  if (!imageDataURI) throw new Error('an image is required')
  if (!animationDataURI) {
    return { bytes: utf8Bytes(imageDataURI), rendererIndex: RENDERER.default }
  }
  const encoded = encodeAbiParameters(
    [{ type: 'string' }, { type: 'string' }],
    [imageDataURI, animationDataURI],
  )
  return { bytes: hexToBytes(encoded), rendererIndex: RENDERER.animation }
}

// VesselPortal path. A token is two Sources — a poster and an animation —
// each of which resolves from The Vessel (kind 0), the Relics contract
// (kind 1), or bytes carried inline in the artifact (kind 2).
//
// kind 0: `entries` non-empty pins immutable vault entries (0-BASED);
//         empty follows craftToPayload live (holder-controlled).
// kind 1: `entries` non-empty pins relic entries (1-BASED, vault-relics only,
//         bytes stay curator-editable); empty follows relicToPayload.
// kind 2: `data` holds raw bytes. NOT a data URI — the renderer builds the
//         data URI from `data` + `mime`, so pre-wrapping double-encodes.
//         Empty `data` means the source is absent (image-only tokens).
export const KIND = { vessel: 0, relics: 1, inline: 2 }

// Mirrors VesselPortal's on-chain limits.
// MAX_CONTENT_BYTES is a budget shared by BOTH sources, because uri() puts
// them in one document and gas tracks their sum.
export const MAX_CONTENT_BYTES = 128 * 1024
export const WARN_CONTENT_BYTES = 96 * 1024
export const MAX_ENTRIES = 64
export const MAX_TEXT_BYTES = 2048

/// `byteLength` must be the TOTAL resolved content of poster + animation.
export function contentSizeVerdict(byteLength) {
  if (byteLength > MAX_CONTENT_BYTES) {
    return {
      level: 'error',
      message: `${byteLength.toLocaleString()} bytes of content exceeds the renderer's ${MAX_CONTENT_BYTES.toLocaleString()}-byte budget (poster and artwork share it) — this token would show only its poster`,
    }
  }
  if (byteLength > WARN_CONTENT_BYTES) {
    return {
      level: 'warn',
      message: `${byteLength.toLocaleString()} bytes is near the ${MAX_CONTENT_BYTES.toLocaleString()}-byte budget wallets and marketplaces can render`,
    }
  }
  return { level: 'ok', message: '' }
}

const SOURCE_TYPE = {
  type: 'tuple',
  components: [
    { name: 'kind', type: 'uint8' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'entries', type: 'uint256[]' },
    { name: 'mime', type: 'string' },
    { name: 'data', type: 'bytes' },
  ],
}
const ARTIFACT_TYPES = [SOURCE_TYPE, SOURCE_TYPE]

/// A source reading pinned entries or a live payload from the Vessel/Relics.
export function referenceSource({ kind, vesselTokenId, entries = [], mime }) {
  if (kind !== KIND.vessel && kind !== KIND.relics) {
    throw new Error(`referenceSource expects kind vessel or relics, got ${kind}`)
  }
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`at most ${MAX_ENTRIES} entries per source, got ${entries.length}`)
  }
  if (kind === KIND.relics && entries.some((e) => BigInt(e) === 0n)) {
    throw new Error('relic entries are 1-based — entry 0 does not exist')
  }
  return { kind, tokenId: BigInt(vesselTokenId), entries: entries.map(BigInt), mime, data: '0x' }
}

/// A source carrying raw bytes in the artifact. `bytes` is the FILE, not a
/// data URI: the renderer wraps it.
export function inlineSource({ bytes, mime }) {
  return { kind: KIND.inline, tokenId: 0n, entries: [], mime, data: bytesToHex(bytes) }
}

/// The absent source — how a token says "no animation" or "no poster".
export function absentSource() {
  return { kind: KIND.inline, tokenId: 0n, entries: [], mime: '', data: '0x' }
}

export function isAbsent(source) {
  return source.kind === KIND.inline && (source.data === '0x' || source.data.length <= 2)
}

export function buildArtifact({ poster, animation }) {
  // The contract rejects fields that cannot apply to a kind, because dead
  // bytes are carried across frames on every render.
  for (const [label, s] of [['poster', poster], ['animation', animation]]) {
    if (s.kind === KIND.inline && s.entries.length) {
      throw new Error(`${label}: inline sources cannot have entries`)
    }
    if (s.kind !== KIND.inline && s.data !== '0x') {
      throw new Error(`${label}: reference sources cannot carry inline data`)
    }
  }
  return { bytes: hexToBytes(encodeAbiParameters(ARTIFACT_TYPES, [poster, animation])) }
}

export function decodeArtifact(bytes) {
  const [poster, animation] = decodeAbiParameters(ARTIFACT_TYPES, bytesToHex(bytes))
  return { poster, animation }
}

/// True when a source resolves through a path a third party can change after
/// the mint — mirrors the contract's `"mutable":true` marker.
export function isMutableSource(source) {
  if (source.kind === KIND.inline) return false
  if (source.kind === KIND.relics) return true
  return source.entries.length === 0
}

// ── XML validity ────────────────────────────────────────────────────────────
//
// SVG is XML, and XML permits only whitespace, comments, or processing
// instructions after the root element closes. Vault slots are fixed-size, so
// a short SVG in a large slot leaves trailing filler: spaces parse fine, NUL
// bytes produce "Extra content at the end of the document" and the browser
// renders an error page instead of the artwork. Concatenating two SVG roots
// into one document fails the same way. Neither is fixable after minting, so
// Kiln checks before signing.

const XML_MIMES = new Set(['image/svg+xml', 'application/xml', 'text/xml'])

export function isXmlMime(mime) {
  return XML_MIMES.has((mime || '').trim().toLowerCase())
}

/// Bytes after the final `>` that are neither whitespace nor NUL-free filler.
/// Returns null when clean, else a description of the trailing junk.
export function trailingJunk(bytes) {
  let end = -1
  for (let i = bytes.length - 1; i >= 0; i--) {
    if (bytes[i] === 0x3e) { end = i; break } // '>'
  }
  if (end === -1) return null // not markup; nothing to say
  let nul = 0
  let other = 0
  for (let i = end + 1; i < bytes.length; i++) {
    const b = bytes[i]
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) continue
    if (b === 0x00) nul++
    else other++
  }
  if (!nul && !other) return null
  return { nul, other, total: nul + other }
}

export function countRoots(bytes) {
  // Cheap structural count: how many times a document opens a root-level tag
  // that is not a declaration, comment, or closing tag.
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  return (text.match(/<svg[\s>]/gi) || []).length
}

/// Warnings for what the renderer will actually assemble. `parts` is the
/// ordered list of byte arrays that will be concatenated.
export function xmlAssemblyWarnings({ mime, parts }) {
  if (!isXmlMime(mime) || !parts.length) return []
  const warnings = []

  const roots = parts.reduce((n, p) => n + countRoots(p), 0)
  if (roots > 1) {
    warnings.push(
      `this would put ${roots} <svg> roots in one XML document — strict parsers reject everything after the first, so it will render as an error page`,
    )
  }

  // Only the final part's tail matters: junk between concatenated parts is
  // interior content, which is a separate (and worse) problem already covered
  // by the root count.
  const junk = trailingJunk(parts[parts.length - 1])
  if (junk) {
    warnings.push(
      junk.nul
        ? `the last entry has ${junk.total} filler byte${junk.total === 1 ? '' : 's'} after its closing tag (${junk.nul} NUL) — XML allows only whitespace there, so this renders as "extra content at the end of the document"`
        : `the last entry has ${junk.total} non-whitespace byte${junk.total === 1 ? '' : 's'} after its closing tag, which strict XML parsers reject`,
    )
  }
  return warnings
}

// What the entry sniffer's kinds mean as a data-URI mime.
export const KIND_MIME = {
  html: 'text/html',
  svg: 'image/svg+xml',
  png: 'image/png',
  mp3: 'audio/mpeg',
  text: 'text/plain',
  bytes: 'application/octet-stream',
}

export function chunkArtifact(bytes) {
  const chunks = []
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    chunks.push(bytes.subarray(i, i + CHUNK_SIZE))
  }
  return chunks
}

// ── gas & cost model ────────────────────────────────────────────────────────
//
// The estimate the UI shows before a wallet is even connected. The number
// that reaches the wallet always comes from eth_estimateGas; this model is
// for the live meter and the single-vs-staged decision.
//
// Per stored byte: 200 gas code deposit + 16 gas calldata + ~4 memory/copy.
// Per chunk: CREATE + SSTORE2 plumbing. Fixed overheads measured from fork
// runs of the factory paths.

export const GAS = {
  perByte: 220,
  perChunk: 35_000,
  base: 21_000,
  mint: 260_000, // _writeAndMint + ERC721 mint, excluding artifact bytes
  clone: 600_000, // clone + init of collection and patron edition
  lot: 380_000, // createLotFor incl. oracle read and fee ledger
}

export function estimateGas({ byteLength, chunkCount, newCollection, auction }) {
  let gas = GAS.base + GAS.mint + byteLength * GAS.perByte + chunkCount * GAS.perChunk
  if (newCollection) gas += GAS.clone
  if (auction) gas += GAS.lot
  return gas
}

// Mirrors UsdOracle: _usdToWei ceils, _weiToUsd floors. `priceE8` is the
// Chainlink ETH/USD answer (8 decimals). `usd` is whole dollars.
export function usdToWei(usd, priceE8) {
  const p = BigInt(priceE8)
  return (BigInt(usd) * 10n ** 26n + p - 1n) / p
}

export function weiToUsd(wei, priceE8) {
  return (BigInt(wei) * BigInt(priceE8)) / 10n ** 26n
}

export function costFromGas({ gas, gasPriceWei, priceE8 }) {
  const wei = BigInt(gas) * BigInt(gasPriceWei)
  const usdCents = (wei * BigInt(priceE8)) / 10n ** 24n
  return { wei, eth: Number(wei) / 1e18, usd: Number(usdCents) / 100 }
}

// ── flow planning ───────────────────────────────────────────────────────────
//
// Decides which transactions the mint takes, in order. Each step names the
// contract call; app.js turns steps into signatures.

export function planFlow({ byteLength, chunkCount, newCollection, auction }) {
  const singleGas = estimateGas({ byteLength, chunkCount, newCollection, auction })
  if (singleGas <= SINGLE_TX_GAS_CAP) {
    // A new collection with an auction mints in one factory call. A new
    // collection without one has no combined entry point: clone, then mint.
    const steps = newCollection
      ? auction
        ? [{ call: 'cloneCollectionAndMint' }]
        : [{ call: 'cloneCollection' }, { call: 'mint' }]
      : [{ call: auction ? 'mintToLot' : 'mint' }]
    return { staged: false, estimatedGas: singleGas, steps }
  }

  // Staged: batch prepareArtifact calls so each stays under the cap.
  const perChunkGas = CHUNK_SIZE * GAS.perByte + GAS.perChunk
  const chunksPerTx = Math.max(1, Math.floor((SINGLE_TX_GAS_CAP - GAS.base) / perChunkGas))
  const batches = Math.ceil(chunkCount / chunksPerTx)
  const steps = []
  if (newCollection) steps.push({ call: 'cloneCollection' })
  for (let i = 0; i < batches; i++) {
    const from = i * chunksPerTx
    steps.push({ call: 'prepareArtifact', chunkFrom: from, chunkTo: Math.min(from + chunksPerTx, chunkCount) })
  }
  steps.push({ call: auction ? 'mintToLot' : 'mint', emptyArtifact: true })
  return { staged: true, estimatedGas: singleGas, steps, chunksPerTx }
}

// The moment computed, not stored: Luke's "refresh before you mint" trap.
export function auctionExpiry(nowSeconds, durationSeconds) {
  return BigInt(Math.floor(nowSeconds) + durationSeconds)
}
