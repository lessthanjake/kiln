// Kiln — UI wiring, wallet, and transaction orchestration.
// All byte-exact logic lives in kiln.js; this file moves state between the
// form, the chain, and the wallet.

import {
  createPublicClient, createWalletClient, custom, http, formatEther,
} from 'viem'
import { mainnet } from 'viem/chains'

import {
  ADDRESSES, CHUNK_SIZE, KIND_MIME, MAX_ENTRIES, contentSizeVerdict, mimeForFile,
  estimateRenderGas, RENDER_GAS_CAP, maxRenderableBytes,
  xmlAssemblyWarnings, buildUploadArtifact,
  KIND, referenceSource, inlineSource, absentSource, buildArtifact, isMutableSource,
  chunkArtifact, toDataURI, bytesToHex, base64Decode, estimateGas,
  usdToWei, costFromGas, planFlow, auctionExpiry,
} from './kiln.js'
import { factoryAbi, collectionAbi, auctionsAbi, chainlinkAbi, vesselAbi, relicsAbi } from './abi.js'
import vesselPortalArtifact from './vesselPortalArtifact.js'

const $ = (id) => document.getElementById(id)
const VESSELPORTAL_KEY = 'kiln.vesselPortal'
const stagedKey = (col, id) => `kiln.staged.${col?.toLowerCase()}.${id}`

const GAS_EXTRA = { registerRenderer: 95_000, deployVesselPortal: 1_200_000 }
// No display cap: every entry a vault holds is listed. The limits that matter
// are the renderer's and they are enforced on-chain — at most MAX_ENTRIES
// selected, at most MAX_CONTENT_BYTES assembled. Hiding entries only hid data.
const ENTRY_BATCH = 8
const MAX_OWNED_CHECK = 400

const state = {
  providers: [],
  provider: null,
  account: null,
  pub: null,
  wallet: null,
  chainId: null,
  dest: 'new',
  collections: [],
  collection: null, // selected existing collection address
  source: 'upload',
  image: null, // { dataURI }
  html: null, // { dataURI, text }
  poster: null, // { dataURI } (vessel path)
  vessel: null, // { id, type, isVault, entryCount, entries: [{index,size,kind,bytes}], vesselSelection: [index…], mode }
  vesselPortalAddr: localStorage.getItem(VESSELPORTAL_KEY),
  ethUsdE8: null,
  gasPriceWei: null,
}

// ── wallet ──────────────────────────────────────────────────────────────────

window.addEventListener('eip6963:announceProvider', (e) => {
  state.providers.push(e.detail)
})
window.dispatchEvent(new Event('eip6963:requestProvider'))

$('connect').addEventListener('click', async () => {
  try {
    const detail = state.providers[0]
    const provider = detail?.provider ?? window.ethereum
    if (!provider) {
      showError('no wallet found — install Rabby or MetaMask, or open this page in a wallet-enabled browser')
      return
    }
    const [account] = await provider.request({ method: 'eth_requestAccounts' })
    state.provider = provider
    state.account = account
    state.chainId = Number(await provider.request({ method: 'eth_chainId' }))
    state.pub = createPublicClient({ chain: mainnet, transport: custom(provider) })
    state.wallet = createWalletClient({ chain: mainnet, transport: custom(provider), account })

    $('connect').classList.add('hidden')
    $('account').textContent = `${account.slice(0, 6)}…${account.slice(-4)}${detail ? ` · ${detail.info.name}` : ''}`
    $('account').classList.remove('hidden')
    const badge = $('chain-badge')
    if (state.chainId === 1) { badge.textContent = 'mainnet' }
    else { badge.textContent = `wrong network (chain ${state.chainId}) — switch to mainnet`; badge.classList.add('wrong') }

    // Prefer the canonical deployment; fall back to whatever this browser
    // remembers. Either way it must prove itself before we point tokens at it.
    const canonical = ADDRESSES.vesselPortal
    if (canonical && await isVesselPortal(canonical)) {
      state.vesselPortalAddr = canonical
      state.vesselPortalIsCanonical = true
    } else if (state.vesselPortalAddr && !(await isVesselPortal(state.vesselPortalAddr))) {
      state.vesselPortalAddr = null
      localStorage.removeItem(VESSELPORTAL_KEY)
    }

    await refreshPrices()
    await loadCollections()
    recompute()
    loadOwnedVessels() // background — populates the vessel picker when done
  } catch (err) { showError(err) }
})

// ── owned-vessel discovery ──────────────────────────────────────────────────
//
// The contract would let anyone reference anyone's vessel; Kiln deliberately
// scopes the picker — and the inspect guard below — to vessels the connected
// wallet actually holds. Not everyone publishes CC0.
//
// The Vessel is a fixed 10,000-token space, so ownership is discovered by
// sweeping ownerOf(1..10000) through Multicall3 — a dozen batched eth_calls
// against *latest* state. The wallet's own RPC is tried first; the public
// endpoints below are a fallback and need no archive access.

const MAX_VESSEL_ID = 10_000
const SWEEP_BATCH = 800
const FALLBACK_RPCS = [
  'https://eth.drpc.org',
  'https://ethereum-rpc.publicnode.com',
]

async function sweepOwnedIds(client) {
  const vessel = { address: ADDRESSES.vessel, abi: vesselAbi }
  const balance = Number(await client.readContract({ ...vessel, functionName: 'balanceOf', args: [state.account] }))
  if (balance === 0) return []

  const me = state.account.toLowerCase()
  const owned = []
  for (let start = 1; start <= MAX_VESSEL_ID && owned.length < balance; start += SWEEP_BATCH) {
    const ids = []
    for (let id = start; id < start + SWEEP_BATCH && id <= MAX_VESSEL_ID; id++) ids.push(BigInt(id))
    const results = await client.multicall({
      contracts: ids.map((id) => ({ ...vessel, functionName: 'ownerOf', args: [id] })),
      allowFailure: true, // unclaimed ids revert; that just means "not yours"
      // One real aggregate3 per batch. viem's default batchSize (1,024 BYTES)
      // would shred this into ~100 rate-limitable requests whose failures
      // read as "not yours" — silently dropping owned vessels.
      batchSize: 250_000,
    })
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'success' && results[i].result.toLowerCase() === me) owned.push(ids[i])
    }
  }
  return owned
}

async function loadOwnedVessels() {
  const note = $('vessel-owned-note')
  try {
    note.textContent = 'scanning this wallet for vessels…'
    let ids
    try {
      ids = await sweepOwnedIds(state.pub)
    } catch (err) {
      console.warn('wallet RPC refused the ownership sweep, trying public fallbacks', err)
      let lastErr = err
      for (const url of FALLBACK_RPCS) {
        try {
          ids = await sweepOwnedIds(createPublicClient({ chain: mainnet, transport: http(url) }))
          break
        } catch (fallbackErr) { lastErr = fallbackErr }
      }
      if (!ids) throw lastErr
    }

    const vessel = { address: ADDRESSES.vessel, abi: vesselAbi }
    const owned = []
    for (const id of ids.slice(0, MAX_OWNED_CHECK)) {
      const type = await state.pub.readContract({ ...vessel, functionName: 'craftToType', args: [id] }).catch(() => '?')
      owned.push({ id, type })
    }
    state.ownedVessels = owned

    const picker = $('vessel-picker')
    const input = $('vessel-id')
    if (owned.length) {
      picker.innerHTML = '<option value="">pick one of your vessels…</option>'
        + owned.map((v) => `<option value="${v.id}">#${v.id} — ${v.type}</option>`).join('')
      picker.classList.remove('hidden')
      input.classList.add('hidden')
      note.textContent = `${owned.length} vessel${owned.length === 1 ? '' : 's'} in this wallet`
    } else {
      picker.classList.add('hidden')
      input.classList.add('hidden')
      note.textContent = 'no vessels in this wallet — kiln only references vessels you hold'
    }
  } catch (err) {
    // Scan failed (RPC limits) — keep the free input; the inspect-time
    // ownership check below still enforces the rule.
    console.warn('owned-vessel scan failed', err)
    state.ownedVessels = null
    note.textContent = 'could not scan holdings — enter a token id you own; ownership is checked on inspect'
  }
}

$('vessel-picker').addEventListener('change', (e) => {
  if (!e.target.value) return
  $('vessel-id').value = e.target.value
  $('vessel-inspect').click()
})

async function refreshPrices() {
  try {
    const auctions = await state.pub.readContract({ address: ADDRESSES.factory, abi: factoryAbi, functionName: 'auctions' })
    state.auctions = auctions
    const feed = await state.pub.readContract({ address: auctions, abi: auctionsAbi, functionName: 'ETH_USD' })
    const [, answer] = await state.pub.readContract({ address: feed, abi: chainlinkAbi, functionName: 'latestRoundData' })
    state.ethUsdE8 = answer
    state.gasPriceWei = await state.pub.getGasPrice()
  } catch (err) { console.warn('price refresh failed', err) }
}

async function loadCollections() {
  const count = await state.pub.readContract({
    address: ADDRESSES.factory, abi: factoryAbi, functionName: 'collectionCount', args: [state.account],
  })
  state.collections = []
  for (let i = 0n; i < count; i++) {
    const addr = await state.pub.readContract({
      address: ADDRESSES.factory, abi: factoryAbi, functionName: 'collectionsOf', args: [state.account, i],
    })
    const name = await state.pub.readContract({ address: addr, abi: collectionAbi, functionName: 'name' })
    state.collections.push({ addr, name })
  }
  const sel = $('col-select')
  sel.innerHTML = state.collections.length
    ? state.collections.map((c, i) => `<option value="${i}">${c.name} — ${c.addr.slice(0, 10)}…</option>`).join('')
    : '<option value="">no collections yet — create one</option>'
  if (state.collections.length) await selectCollection(0)
}

async function selectCollection(i) {
  const col = state.collections[i]
  if (!col) { state.collection = null; return }
  state.collection = col.addr
  const latest = await state.pub.readContract({ address: col.addr, abi: collectionAbi, functionName: 'latestTokenId' })
  $('tok-id').value = String(latest + 1n)
  $('col-info').textContent = `latest token id ${latest} — next suggested ${latest + 1n}`
  await detectVesselPortal()
  recompute()
}

// Finds an already-registered VesselPortal on the chosen collection, so the
// register step is skipped when it is not needed.
async function detectVesselPortal() {
  state.registeredVesselPortalIndex = null
  if (!state.collection || !state.pub) return
  try {
    const count = await state.pub.readContract({ address: state.collection, abi: collectionAbi, functionName: 'rendererCount' })
    for (let i = 2; i < Number(count); i++) {
      const addr = await state.pub.readContract({ address: state.collection, abi: collectionAbi, functionName: 'rendererAt', args: [i] })
      const name = await state.pub.readContract({ address: addr, abi: vesselPortalAbi_name, functionName: 'name' }).catch(() => '')
      if (name === 'VesselPortal') {
        state.registeredVesselPortalIndex = i
        state.vesselPortalAddr = addr
        localStorage.setItem(VESSELPORTAL_KEY, addr)
        break
      }
    }
  } catch { /* clean slate is fine */ }
  updateVesselPortalStatus()
}
const vesselPortalAbi_name = [{ type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }]

/// Proves an address really is a VesselPortal before Kiln registers it or
/// mints against it. A wrong constant, a stale localStorage entry, or a
/// different chain all fail this and fall back to deploying a fresh one.
async function isVesselPortal(address) {
  try {
    const code = await state.pub.getCode({ address })
    if (!code || code === '0x') return false
    const name = await state.pub.readContract({ address, abi: vesselPortalAbi_name, functionName: 'name' })
    return name === 'VesselPortal'
  } catch {
    return false
  }
}

function updateVesselPortalStatus() {
  const el = $('vesselPortal-status')
  if (state.registeredVesselPortalIndex != null) {
    el.textContent = `VesselPortal registered on this collection at renderer index ${state.registeredVesselPortalIndex} — nothing extra to sign`
  } else if (state.vesselPortalAddr) {
    const which = state.vesselPortalIsCanonical ? 'canonical' : 'your'
    el.textContent = `using the ${which} VesselPortal at ${state.vesselPortalAddr} — kiln adds one register transaction for this collection (~85k gas)`
  } else {
    el.textContent = 'no VesselPortal deployment known — kiln will deploy one (~1.1M gas, once ever) and register it'
  }
}

// ── form wiring ─────────────────────────────────────────────────────────────

for (const btn of $('dest-choice').querySelectorAll('button')) {
  btn.addEventListener('click', () => {
    state.dest = btn.dataset.dest
    setActive($('dest-choice'), btn)
    $('dest-new').classList.toggle('hidden', state.dest !== 'new')
    $('dest-existing').classList.toggle('hidden', state.dest !== 'existing')
    recompute()
  })
}
for (const btn of $('source-choice').querySelectorAll('button')) {
  btn.addEventListener('click', () => {
    state.source = btn.dataset.source
    setActive($('source-choice'), btn)
    $('source-upload').classList.toggle('hidden', state.source !== 'upload')
    $('source-vessel').classList.toggle('hidden', state.source !== 'vessel')
    if (state.source === 'vessel') updateVesselPortalStatus()
    recompute()
  })
}
function setActive(group, active) {
  for (const b of group.querySelectorAll('button')) b.classList.toggle('active', b === active)
}

$('col-select').addEventListener('change', (e) => selectCollection(Number(e.target.value)))
$('ack-oversize').addEventListener('change', recompute)
$('auction-toggle').addEventListener('change', () => {
  $('auction-fields').classList.toggle('hidden', !$('auction-toggle').checked)
  recompute()
})
for (const id of ['col-name', 'col-symbol', 'tok-name', 'tok-desc', 'tok-id', 'auction-reserve', 'vessel-mime']) {
  $(id).addEventListener('input', recompute)
}

/// A drop zone that validates what it is given, shows what it holds, and can
/// be emptied again. `accept` only filters the file-picker dialog — a drag and
/// drop bypasses it entirely — so the kind check has to live here, or an image
/// dropped on the artwork slot would be minted labelled `text/html`.
function wireDrop(dropId, inputId, { kind, onFile, onClear }) {
  const drop = $(dropId)
  const input = $(inputId)
  const prompt = drop.firstChild.textContent

  const looksRight = (file) => {
    if (kind === 'image') return /^image\//.test(file.type) || /\.(png|jpe?g|gif|svg|webp|avif)$/i.test(file.name)
    // The artwork slot is `animation_url`, which carries HTML, video, audio and
    // 3D models — not HTML alone. Refuse only what we cannot name a type for,
    // since minting under the wrong mime is permanent.
    return mimeForFile(file) !== null
  }

  const clear = () => {
    drop.classList.remove('filled')
    drop.innerHTML = ''
    drop.append(document.createTextNode(prompt), promptSmall.cloneNode(true))
    input.value = ''
    onClear()
    recompute()
  }

  // Keep the original hint so clearing can restore it verbatim.
  const promptSmall = drop.querySelector('small').cloneNode(true)

  const accept = async (file) => {
    if (!looksRight(file)) {
      showError(kind === 'image'
        ? `${file.name} is not an image — the ${dropId === 'drop-poster' ? 'thumbnail' : 'still'} must be png / jpg / gif / svg`
        : `cannot determine a media type for ${file.name} — rename it with a known extension (html, mp4, webm, mov, mp3, wav, glb, gif…) so it is not minted mislabelled`)
      input.value = ''
      return
    }
    await onFile(file)
    drop.classList.add('filled')
    drop.innerHTML = ''
    drop.append(
      document.createTextNode(`${file.name} · ${(file.size / 1024).toFixed(1)} KB`),
      el('button', { class: 'clear', type: 'button', title: 'remove', text: '✕' }),
    )
    drop.querySelector('.clear').addEventListener('click', (e) => { e.stopPropagation(); clear() })
    recompute()
  }

  drop.addEventListener('click', () => input.click())
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over') })
  drop.addEventListener('dragleave', () => drop.classList.remove('over'))
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('over')
    if (e.dataTransfer.files[0]) accept(e.dataTransfer.files[0])
  })
  input.addEventListener('change', () => { if (input.files[0]) accept(input.files[0]) })
}

/// Minimal element helper for the bits built in JS.
function el(tag, attrs = {}) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v
    else if (k === 'text') node.textContent = v
    else node.setAttribute(k, v)
  }
  return node
}

async function fileBytes(file) { return new Uint8Array(await file.arrayBuffer()) }

wireDrop('drop-image', 'file-image', {
  kind: 'image',
  onFile: async (file) => {
    state.image = { dataURI: toDataURI(await fileBytes(file), file.type || 'image/png') }
  },
  onClear: () => { state.image = null },
})
wireDrop('drop-html', 'file-html', {
  kind: 'html',
  onFile: async (file) => {
    const bytes = await fileBytes(file)
    const mime = mimeForFile(file)
    state.html = {
      mime,
      dataURI: toDataURI(bytes, mime),
      // Only markup gets the XML/padding checks; decoding an mp4 as text is
      // meaningless and would only produce noise.
      text: /html|xml|svg/.test(mime) ? new TextDecoder().decode(bytes) : '',
    }
  },
  onClear: () => { state.html = null },
})
wireDrop('drop-poster', 'file-poster', {
  kind: 'image',
  onFile: async (file) => {
    const raw = await fileBytes(file)
    state.poster = { bytes: raw, mime: file.type || 'image/png', dataURI: toDataURI(raw, file.type || 'image/png') }
  },
  onClear: () => { state.poster = null },
})

// ── vessel inspection ───────────────────────────────────────────────────────

$('vessel-inspect').addEventListener('click', async () => {
  try {
    if (!state.pub) { showError('connect a wallet first — vessel reads go through it'); return }
    const id = BigInt($('vessel-id').value || 0)
    if (id <= 0n) return
    const vessel = { address: ADDRESSES.vessel, abi: vesselAbi }
    setInspectStatus(`reading vessel #${id}…`)

    // Hard rule regardless of how the id got here: only vessels this wallet
    // holds. The contract wouldn't stop you; courtesy does.
    const holder = await state.pub.readContract({ ...vessel, functionName: 'ownerOf', args: [id] }).catch(() => null)
    if (holder?.toLowerCase() !== state.account.toLowerCase()) {
      $('vessel-detail').classList.add('hidden')
      state.vessel = null
      setInspectStatus('')
      showError(`this wallet doesn't hold vessel #${id} — kiln only references vessels you own`)
      recompute()
      return
    }
    const [type, isVault, isRelic] = await Promise.all([
      state.pub.readContract({ ...vessel, functionName: 'craftToType', args: [id] }),
      state.pub.readContract({ ...vessel, functionName: 'craftToVaultStatus', args: [id] }),
      state.pub.readContract({ address: ADDRESSES.relics, abi: relicsAbi, functionName: 'isRelic', args: [id] }).catch(() => false),
    ])
    const entryCount = isVault
      ? Number(await state.pub.readContract({ ...vessel, functionName: 'craftToEntry', args: [id] }))
      : 0
    // The holder's display slot: 0 = follow latest entry, N = entry N-1 pinned.
    const chosenRaw = isVault
      ? Number(await state.pub.readContract({ ...vessel, functionName: 'craftToChosenEntry', args: [id] }))
      : 0
    const chosenEntry = isVault ? (chosenRaw === 0 ? entryCount - 1 : chosenRaw - 1) : null
    state.vessel = {
      id, type, isVault, isRelic, entryCount, chosenEntry,
      entries: [], relicEntries: [], sourceContract: isRelic ? 'relics' : 'vessel',
      mode: isVault ? 'pinned' : 'live',
    }
    $('vessel-detail').classList.remove('hidden')
    const entries = await readEntries({
      contract: vessel,
      functionName: 'vaultToEntry',
      tokenId: id,
      from: 0,
      count: entryCount,
      label: 'entries',
      onBatch: (partial) => {
        // Render as batches land so early entries are pickable while the rest
        // are still arriving.
        if (!state.vessel) return
        state.vessel.entries = partial
        renderEntries()
      },
    })
    state.vessel.entries = entries
    // What live mode serves right now — relic override, machine output, or the
    // holder's slot — so the preview is honest for every token type.
    state.vessel.payload = hexBytes(await state.pub.readContract({ ...vessel, functionName: 'craftToPayload', args: [id] }))

    // Relic data lives on its own contract, with its own 1-based entry space.
    if (isRelic) {
      const relics = { address: ADDRESSES.relics, abi: relicsAbi }
      state.vessel.relicPayload = hexBytes(await state.pub.readContract({ ...relics, functionName: 'relicToPayload', args: [id] }))
      state.vessel.relicEntryCount = Number(await state.pub.readContract({ ...relics, functionName: 'getTokenEntries', args: [id] }))
      if (isVault) {
        // Relic entries are 1-based.
        state.vessel.relicEntries = await readEntries({
          contract: relics,
          functionName: 'vaultRelicToEntry',
          tokenId: id,
          from: 1,
          count: state.vessel.relicEntryCount,
          label: 'relic entries',
          onBatch: (partial) => {
            if (!state.vessel) return
            state.vessel.relicEntries = partial
            renderEntries()
          },
        })
      } else {
        state.vessel.mode = 'live'
      }
    }

    const vaultLine = entryCount === 0
      ? 'no vault entries of its own'
      : `${entryCount} immutable entr${entryCount === 1 ? 'y' : 'ies'} — pin entries, or live mode follows the holder's slot (now: entry ${chosenEntry}${chosenRaw === 0 ? ', latest' : ''})`
    const typeLine = {
      Vault: vaultLine,
      Capsule: 'always live — the holder can overwrite its payload at any time',
      Machine: 'always live — payload is computed by the attached machine contract',
    }[type] ?? 'live payload only'
    $('vessel-summary').textContent = `#${id} — ${type}${isRelic ? ' · RELIC' : ''}: ${typeLine}`
    const relicNote = $('vessel-relic-note')
    relicNote.classList.toggle('hidden', !isRelic)
    if (isRelic) {
      relicNote.textContent = isVault
        ? 'relic override active — live mode serves the relic’s curated data; pinned entries read the vault’s own entries underneath it'
        : 'relic override active — live mode serves the relic’s curated data, not the holder’s payload'
    }
    const srcChoice = $('vessel-source-choice')
    srcChoice.classList.toggle('hidden', !isRelic)
    if (isRelic) setActive(srcChoice, srcChoice.querySelector(`[data-vsource=${state.vessel.sourceContract}]`))

    setInspectStatus('')
    if (state.ownedVessels) {
      const n = state.ownedVessels.length
      $('vessel-owned-note').textContent = `${n} vessel${n === 1 ? '' : 's'} in this wallet`
    }
    suggestMime()
    renderEntries()
    // A newly inspected vessel invalidates a poster pick from the old one.
    if (state.posterPick && state.posterPick.vesselId !== id) state.posterPick = null
    renderPosterChoices()
    $('vessel-detail').classList.remove('hidden')
    setActive($('vessel-mode'), $('vessel-mode').querySelector(`[data-mode=${state.vessel.mode}]`))
    recompute()
  } catch (err) { showError(err) }
})

// The list and payload the current source contract provides.
function activeEntries() {
  if (!state.vessel) return []
  return state.vessel.sourceContract === 'relics' ? state.vessel.relicEntries : state.vessel.entries
}

// Selection is an ORDERED list of entry indices, not a set of booleans:
// VesselPortal concatenates `entries[]` in array order, so click order is
// document order for a sharded work. `selection` lives per source contract.
function selectionList() {
  if (!state.vessel) return []
  const key = state.vessel.sourceContract === 'relics' ? 'relicSelection' : 'vesselSelection'
  if (!state.vessel[key]) state.vessel[key] = []
  return state.vessel[key]
}

function setSelection(list) {
  if (!state.vessel) return
  const key = state.vessel.sourceContract === 'relics' ? 'relicSelection' : 'vesselSelection'
  state.vessel[key] = list
}

/// Entries in the order they will be concatenated.
function selectedEntries() {
  const byIndex = new Map(activeEntries().map((e) => [e.index, e]))
  return selectionList().map((i) => byIndex.get(i)).filter(Boolean)
}

function toggleEntry(index) {
  const current = selectionList()
  if (!state.assembleMode) {
    // Single-select: one entry is one document.
    setSelection(current.length === 1 && current[0] === index ? [] : [index])
  } else {
    const at = current.indexOf(index)
    setSelection(at === -1 ? [...current, index] : current.filter((i) => i !== index))
  }
  suggestMime()
  renderEntries()
  recompute()
}

function moveSelected(index, delta) {
  const current = [...selectionList()]
  const at = current.indexOf(index)
  const to = at + delta
  if (at === -1 || to < 0 || to >= current.length) return
  ;[current[at], current[to]] = [current[to], current[at]]
  setSelection(current)
  renderEntries()
  recompute()
}
function activePayload() {
  if (!state.vessel) return new Uint8Array(0)
  return state.vessel.sourceContract === 'relics'
    ? (state.vessel.relicPayload ?? new Uint8Array(0))
    : (state.vessel.payload ?? new Uint8Array(0))
}

// Suggest a mime from the sniffed content unless the artist typed one.
let mimeTouched = false
$('vessel-mime').addEventListener('input', () => { mimeTouched = true })
function suggestMime() {
  if (mimeTouched || !state.vessel) return
  const selected = selectedEntries()
  const sample = state.vessel.mode === 'pinned'
    ? (selected[0] ?? activeEntries()[0])?.bytes
    : activePayload()
  if (!sample || !sample.length) return
  $('vessel-mime').value = KIND_MIME[sniff(sample)] ?? 'application/octet-stream'
}

/// Reads a run of vault entries through Multicall3. One batched request per
/// ENTRY_BATCH instead of one round-trip per entry: a 41-entry vault went from
/// dozens of sequential eth_calls to three. Entries can be ~10 KB each, so the
/// batch stays small enough that a response never trips an RPC size limit.
function setInspectStatus(text) {
  const el = $('vessel-owned-note')
  if (text) el.dataset.busy = '1'
  else delete el.dataset.busy
  if (text) el.textContent = text
}

async function readEntries({ contract, functionName, tokenId, from, count, label = 'entries', onBatch }) {
  const out = []
  for (let start = 0; start < count; start += ENTRY_BATCH) {
    // Entries can be ~10 KB each, so a big vault on a slow RPC takes real
    // time. Say so, with progress, rather than showing a blank panel.
    setInspectStatus(`reading ${label} ${Math.min(start + ENTRY_BATCH, count)} / ${count}…`)
    const indices = []
    for (let i = start; i < Math.min(start + ENTRY_BATCH, count); i++) indices.push(from + i)
    const results = await state.pub.multicall({
      contracts: indices.map((i) => ({ ...contract, functionName, args: [tokenId, BigInt(i)] })),
      allowFailure: true,
      batchSize: 250_000, // one real aggregate3; viem's 1,024-BYTE default would shred it
    })
    for (let i = 0; i < results.length; i++) {
      let hex = results[i].status === 'success' ? results[i].result : null
      if (hex === null) {
        // A batched call can fail for reasons that have nothing to do with the
        // entry — response-size limits, rate limiting, a cold fork. Retrying
        // singly costs one round-trip and keeps a slow RPC from silently
        // shortening the list, which would look identical to "the vault has
        // fewer entries".
        hex = await state.pub
          .readContract({ ...contract, functionName, args: [tokenId, BigInt(indices[i])] })
          .catch(() => null)
      }
      if (hex === null) {
        out.push({ index: indices[i], bytes: new Uint8Array(0), size: null, kind: 'unreadable' })
        continue
      }
      const bytes = hexBytes(hex)
      out.push({ index: indices[i], bytes, size: bytes.length, kind: sniff(bytes) })
    }
    onBatch?.([...out])
  }
  return out
}

function hexBytes(hex) {
  const clean = hex.slice(2)
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

function sniff(bytes) {
  const head = new TextDecoder().decode(bytes.subarray(0, 64)).trimStart().toLowerCase()
  if (head.startsWith('<svg')) return 'svg'
  if (head.startsWith('<!') || head.startsWith('<')) return 'html'
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'png'
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'mp3'
  return 'bytes'
}

for (const btn of $('vessel-mode').querySelectorAll('button')) {
  btn.addEventListener('click', () => {
    if (!state.vessel) return
    if (btn.dataset.mode === 'pinned' && !state.vessel.isVault) return
    state.vessel.mode = btn.dataset.mode
    setActive($('vessel-mode'), btn)
    suggestMime()
    renderEntries()
    recompute()
  })
}

for (const btn of $('vessel-source-choice').querySelectorAll('button')) {
  btn.addEventListener('click', () => {
    if (!state.vessel?.isRelic) return
    state.vessel.sourceContract = btn.dataset.vsource
    setActive($('vessel-source-choice'), btn)
    suggestMime()
    renderEntries()
    recompute()
  })
}

function renderEntries() {
  const list = $('entries-list')
  list.innerHTML = ''
  if (!state.vessel || state.vessel.mode !== 'pinned') return
  const relicSource = state.vessel.sourceContract === 'relics'
  const selection = selectionList()
  for (const e of activeEntries()) {
    const row = document.createElement('label')
    row.className = 'entry-row'
    const isSlot = !relicSource && e.index === state.vessel.chosenEntry
    const pos = selection.indexOf(e.index)
    const picked = pos !== -1
    const badge = state.assembleMode && picked
      ? `<span class="order-badge">${pos + 1}</span>`
      : ''
    const arrows = state.assembleMode && picked
      ? `<button type="button" class="reorder" data-dir="-1" title="earlier">↑</button>
         <button type="button" class="reorder" data-dir="1" title="later">↓</button>`
      : ''
    row.innerHTML = `<input type="${state.assembleMode ? 'checkbox' : 'radio'}" name="entry-pick" ${picked ? 'checked' : ''}>
      ${badge}<span>${relicSource ? 'relic entry' : 'entry'} ${e.index}</span><span class="kind">${e.kind}${isSlot ? ' · holder’s slot' : ''}</span>${arrows}<span class="size">${e.size} bytes</span>`
    if (e.size === null) row.querySelector('input').disabled = true
    row.querySelector('input').addEventListener('click', (ev) => {
      ev.preventDefault()
      if (e.size !== null) toggleEntry(e.index)
    })
    for (const btn of row.querySelectorAll('.reorder')) {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault(); ev.stopPropagation()
        moveSelected(e.index, Number(btn.dataset.dir))
      })
    }
    list.appendChild(row)
  }
  const total = relicSource ? state.vessel.relicEntryCount : state.vessel.entryCount
  const shown = activeEntries().length
  if (total > shown) {
    const note = document.createElement('p')
    note.className = 'note'
    note.textContent = `showing first ${shown} of ${total} entries`
    list.appendChild(note)
  }
  if (relicSource && shown) {
    const note = document.createElement('p')
    note.className = 'note'
    note.textContent = 'relic entries pin the index, not the bytes — the relics curator can edit or remove them'
    list.appendChild(note)
  }
}

// ── recompute: artifact, meter, preview, button ─────────────────────────────

function currentArtifact() {
  if (state.source === 'upload') {
    if (!state.image) return null
    return buildUploadArtifact({ imageDataURI: state.image.dataURI, animationDataURI: state.html?.dataURI })
  }
  // vessel
  if (!state.vessel) return null
  const poster = currentPosterSource()
  if (!poster) return null

  const pinned = state.vessel.mode === 'pinned'
  // Selection order — not index order — is the order VesselPortal concatenates.
  const entries = pinned ? [...selectionList()] : []
  if (pinned && entries.length === 0) return null

  const animation = referenceSource({
    kind: state.vessel.sourceContract === 'relics' ? KIND.relics : KIND.vessel,
    vesselTokenId: state.vessel.id,
    entries,
    mime: $('vessel-mime').value || 'text/html',
  })
  const { bytes } = buildArtifact({ poster, animation })
  return { bytes, rendererIndex: null } // resolved at mint (registered index)
}

/// The poster as a Source: an uploaded file rides inline, a chosen vault entry
/// is referenced — which is the whole point of this renderer, since a
/// referenced poster costs ~100 bytes instead of its full size in storage.
function currentPosterSource() {
  if (state.posterMode === 'vessel') {
    const pick = state.posterPick
    if (!pick) return null
    return referenceSource({
      kind: KIND.vessel,
      vesselTokenId: pick.vesselId,
      entries: [pick.index],
      mime: pick.mime,
    })
  }
  if (!state.poster) return null
  return inlineSource({ bytes: state.poster.bytes, mime: state.poster.mime })
}

function currentSteps(chunkCount, byteLength) {
  const auction = $('auction-toggle').checked
  const newCollection = state.dest === 'new'
  if (state.source === 'upload') return planFlow({ byteLength, chunkCount, newCollection, auction }).steps
  const steps = []
  if (newCollection) steps.push({ call: 'cloneCollection' })
  if (state.registeredVesselPortalIndex == null || newCollection) {
    if (!state.vesselPortalAddr) steps.push({ call: 'deployVesselPortal' })
    steps.push({ call: 'registerRenderer' })
  }
  steps.push({ call: auction ? 'mintToLot' : 'mint' })
  return steps
}

function recompute() {
  const artifact = currentArtifact()
  const auction = $('auction-toggle').checked
  const newCollection = state.dest === 'new'

  if (!artifact) {
    for (const id of ['m-bytes', 'm-chunks', 'm-txs', 'm-gas', 'm-eth', 'm-usd']) $(id).textContent = '—'
    updateMintButton(null)
    updatePreview()
    // Warnings must show while you are still choosing entries, not only once
    // a poster completes the form.
    updateSizeVerdict()
    updateXmlWarning()
    return
  }

  const chunks = chunkArtifact(artifact.bytes)
  const steps = currentSteps(chunks.length, artifact.bytes.length)
  let gas = estimateGas({ byteLength: artifact.bytes.length, chunkCount: chunks.length, newCollection, auction })
  for (const s of steps) gas += GAS_EXTRA[s.call] ?? 0

  $('m-bytes').textContent = artifact.bytes.length.toLocaleString()
  $('m-chunks').textContent = String(chunks.length)
  $('m-txs').textContent = String(steps.length)
  showCost(gas, auction, false)
  showRenderCost(resolvedContentSize())
  updateOversizeAck()
  // The model above is a heuristic — measured against real estimates it runs
  // up to ~20% high on small mints, converging within a percent on large
  // ones. Once a wallet is connected the chain can be asked directly, so ask.
  scheduleRealEstimate(steps, artifact, auction)

  updatePreview()
  updateSizeVerdict()
  updateXmlWarning()
  updateMintButton(steps)
}

// The bytes the renderer will actually assemble — what determines whether
// wallets and marketplaces can render the token at all.
/// Total content the renderer will assemble. Poster and animation SHARE the
/// on-chain budget, so the meter has to add them: two individually-legal
/// sources can still exceed what any RPC will render.
function resolvedContentSize() {
  if (state.source === 'upload') {
    return state.html ? state.html.dataURI.length : (state.image?.dataURI.length ?? 0)
  }
  if (!state.vessel) return 0
  const animation = state.vessel.mode !== 'pinned'
    ? activePayload().length
    : selectedEntries().reduce((n, e) => n + e.bytes.length, 0)
  const poster = state.posterMode === 'vessel'
    ? (state.posterPick?.size ?? 0)
    : (state.poster?.bytes.length ?? 0)
  return animation + poster
}

/// Minting is only half the price of a token. Reading it is the half nothing
/// on-chain enforces, so put it on screen next to the mint cost.
function showRenderCost(contentBytes) {
  const el = $('m-render')
  if (!contentBytes) { el.textContent = '—'; el.parentElement.classList.remove('warn'); return }
  const gas = estimateRenderGas(contentBytes)
  el.textContent = `${(gas / 1e6).toFixed(1)}M`
  el.title = `${gas.toLocaleString()} gas to read tokenURI; wallets and marketplaces typically cap at `
    + `${(RENDER_GAS_CAP / 1e6).toFixed(0)}M`
  el.parentElement.classList.toggle('warn', gas > RENDER_GAS_CAP * 0.6)
}

function updateXmlWarning() {
  const el = $('xml-warning')
  if (state.source !== 'vessel' || !state.vessel) { el.classList.add('hidden'); return }
  const parts = state.vessel.mode === 'pinned'
    ? selectedEntries().map((e) => e.bytes)
    : [activePayload()]
  const warnings = xmlAssemblyWarnings({ mime: $('vessel-mime').value, parts })
  if (!warnings.length) { el.classList.add('hidden'); return }
  el.textContent = warnings.join(' · ')
  el.classList.remove('hidden')
}

function updateSizeVerdict() {
  const el = $('size-verdict')
  const size = resolvedContentSize()
  if (!size) { el.classList.add('hidden'); return }
  const { level, message } = contentSizeVerdict(size, state.source)
  if (level === 'ok') { el.classList.add('hidden'); return }
  el.textContent = message
  el.style.color = level === 'error' ? 'var(--err)' : 'var(--warn)'
  el.classList.remove('hidden')
}

function updatePreview() {
  const poster = state.source === 'upload' ? state.image : state.poster
  $('preview-poster').classList.toggle('hidden', !poster)
  if (poster) $('preview-poster').src = poster.dataURI

  const frame = $('preview-frame')
  if (state.source === 'upload') {
    frame.src = state.html?.dataURI ?? poster?.dataURI ?? 'about:blank'
    return
  }
  if (!state.vessel) { frame.src = 'about:blank'; return }
  // Assemble exactly what VesselPortal._content will return, from whichever
  // source contract is active.
  let bytes
  if (state.vessel.mode === 'pinned') {
    const chosen = selectedEntries()
    if (!chosen.length) { frame.src = 'about:blank'; return }
    const total = chosen.reduce((n, e) => n + e.bytes.length, 0)
    bytes = new Uint8Array(total)
    let off = 0
    for (const e of chosen) { bytes.set(e.bytes, off); off += e.bytes.length }
  } else {
    bytes = activePayload()
  }
  frame.src = toDataURI(bytes, $('vessel-mime').value || 'text/html')
}

function validInputs() {
  if (state.dest === 'new' && (!$('col-name').value.trim() || !$('col-symbol').value.trim())) return false
  if (state.dest === 'existing' && !state.collection) return false
  if (!$('tok-name').value.trim()) return false
  if (!(Number($('tok-id').value) > 0)) return false
  if ($('auction-toggle').checked && Number($('auction-reserve').value) < 10) return false
  return true
}

/// Paints the gas/eth/usd row. `measured` distinguishes a number the chain
/// gave us from the model's guess, because the difference matters to anyone
/// deciding whether to mint.
function showCost(gas, auction, measured) {
  $('m-gas').textContent = gas.toLocaleString()
  $('m-gas').nextElementSibling.textContent = measured ? 'gas (measured)' : 'est. gas'
  if (state.gasPriceWei && state.ethUsdE8) {
    const { eth, usd } = costFromGas({ gas, gasPriceWei: state.gasPriceWei, priceE8: state.ethUsdE8 })
    const usdTotal = auction ? usd + 10 : usd
    $('m-eth').textContent = eth.toFixed(5)
    $('m-usd').textContent = `$${usdTotal.toFixed(2)}${auction ? ' (incl. $10 fee)' : ''}`
  } else {
    $('m-eth').textContent = 'connect'
    $('m-usd').textContent = 'connect'
  }
}

/// Ask the chain what the mint really costs, debounced, and only when the
/// whole thing is one transaction we can simulate. A staged mint, or a new
/// collection that must exist before its token can be estimated, stays on the
/// model — the collection address does not exist yet to simulate against.
let estimateToken = 0
function scheduleRealEstimate(steps, artifact, auction) {
  const mine = ++estimateToken
  if (!state.pub || !state.account || state.chainId !== 1) return
  if (steps.length !== 1 && !(steps.length === 1)) return
  if (steps.length !== 1) return
  if (!validInputs()) return

  setTimeout(async () => {
    if (mine !== estimateToken) return // superseded by newer input
    try {
      const gas = await realEstimate(steps[0], artifact, auction)
      if (mine !== estimateToken || !gas) return
      showCost(Number(gas), auction, true)
    } catch {
      // A revert here is usually an incomplete form, not a problem worth
      // shouting about — the model's number stays on screen.
    }
  }, 400)
}

async function realEstimate(step, artifact, auction) {
  const chunks = chunkArtifact(artifact.bytes)
  const tokenId = BigInt($('tok-id').value || 1)
  const reserveUsd = BigInt($('auction-reserve').value || 10)
  const expiresAt = auctionExpiry(Date.now() / 1000, Number($('auction-duration').value))
  const feeWei = auction && state.ethUsdE8 ? (usdToWei(10n, state.ethUsdE8) * 105n) / 100n : 0n
  const params = {
    tokenId,
    artifact: chunks.map(bytesToHex),
    name: $('tok-name').value.trim(),
    description: $('tok-desc').value,
    rendererIndex: state.source === 'upload'
      ? buildUploadArtifact({
          imageDataURI: (state.image ?? state.poster).dataURI,
          animationDataURI: state.html?.dataURI,
        }).rendererIndex
      : state.registeredVesselPortalIndex,
    rendererData: 0n,
  }
  if (step.call === 'cloneCollectionAndMint') {
    return state.pub.estimateContractGas({
      account: state.account, address: ADDRESSES.factory, abi: factoryAbi,
      functionName: 'cloneCollectionAndMint',
      args: [$('col-name').value.trim(), $('col-symbol').value.trim(), state.auctions, params, reserveUsd, expiresAt],
      value: feeWei,
    })
  }
  if (!state.collection) return null
  if (step.call === 'mint') {
    return state.pub.estimateContractGas({
      account: state.account, address: state.collection, abi: collectionAbi,
      functionName: 'mint', args: [params],
    })
  }
  if (step.call === 'mintToLot') {
    return state.pub.estimateContractGas({
      account: state.account, address: state.collection, abi: collectionAbi,
      functionName: 'mintToLot', args: [params, reserveUsd, expiresAt], value: feeWei,
    })
  }
  return null
}

/// An oversized upload mints without complaint and then cannot be read by
/// anything, forever — the chain will not stop it, so Kiln does. Deliberate is
/// fine; accidental is not, hence an explicit acknowledgement rather than a
/// silent warning.
function updateOversizeAck() {
  const over = resolvedContentSize() > maxRenderableBytes()
  $('oversize-ack').classList.toggle('hidden', !over)
  if (!over) $('ack-oversize').checked = false
  return over
}

function oversizeBlocked() {
  return updateOversizeAck() && !$('ack-oversize').checked
}

function updateMintButton(steps) {
  const btn = $('mint')
  if (!state.account) { btn.disabled = true; btn.textContent = 'connect wallet to mint'; return }
  if (state.chainId !== 1) { btn.disabled = true; btn.textContent = 'switch to mainnet'; return }
  if (!steps || !validInputs()) { btn.disabled = true; btn.textContent = 'complete the form to mint'; return }
  if (oversizeBlocked()) {
    btn.disabled = true
    btn.textContent = 'too large to render — acknowledge to continue'
    return
  }
  btn.disabled = false
  btn.textContent = steps.length === 1 ? 'mint' : `mint (${steps.length} transactions)`
}

// ── mint orchestration ──────────────────────────────────────────────────────

$('mint').addEventListener('click', async () => {
  $('mint').disabled = true
  $('mint-error').classList.add('hidden')
  $('result').classList.add('hidden')
  try {
    await refreshPrices() // live values at the moment of signing — never stale
    const artifact = currentArtifact()
    const chunks = chunkArtifact(artifact.bytes)
    const steps = currentSteps(chunks.length, artifact.bytes.length)
    renderSteps(steps)

    const auction = $('auction-toggle').checked
    const tokenId = BigInt($('tok-id').value)
    const reserveUsd = BigInt($('auction-reserve').value || 10)
    const duration = Number($('auction-duration').value)
    const feeWei = auction ? (usdToWei(10n, state.ethUsdE8) * 105n) / 100n : 0n
    let collection = state.dest === 'existing' ? state.collection : null
    let rendererIndex = state.source === 'upload' ? null : state.registeredVesselPortalIndex

    const mintParams = () => ({
      tokenId,
      artifact: chunks.map(bytesToHex),
      name: $('tok-name').value.trim(),
      description: $('tok-desc').value,
      rendererIndex: state.source === 'upload'
        ? buildUploadArtifact({ imageDataURI: (state.image ?? state.poster).dataURI, animationDataURI: state.html?.dataURI }).rendererIndex
        : rendererIndex,
      rendererData: 0n,
    })

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]
      stepState(i, 'active')
      const expiresAt = auctionExpiry(Date.now() / 1000, duration)

      if (step.call === 'cloneCollectionAndMint') {
        await tx({
          address: ADDRESSES.factory, abi: factoryAbi, functionName: 'cloneCollectionAndMint',
          args: [$('col-name').value.trim(), $('col-symbol').value.trim(), state.auctions, mintParams(), reserveUsd, expiresAt],
          value: feeWei,
        })
        const count = await state.pub.readContract({ address: ADDRESSES.factory, abi: factoryAbi, functionName: 'collectionCount', args: [state.account] })
        collection = await state.pub.readContract({ address: ADDRESSES.factory, abi: factoryAbi, functionName: 'collectionsOf', args: [state.account, count - 1n] })
      } else if (step.call === 'cloneCollection') {
        await tx({
          address: ADDRESSES.factory, abi: factoryAbi, functionName: 'cloneCollection',
          args: [$('col-name').value.trim(), $('col-symbol').value.trim(), state.auctions],
        })
        const count = await state.pub.readContract({ address: ADDRESSES.factory, abi: factoryAbi, functionName: 'collectionCount', args: [state.account] })
        collection = await state.pub.readContract({ address: ADDRESSES.factory, abi: factoryAbi, functionName: 'collectionsOf', args: [state.account, count - 1n] })
      } else if (step.call === 'deployVesselPortal') {
        const hash = await state.wallet.deployContract({
          abi: vesselPortalArtifact.abi, bytecode: vesselPortalArtifact.bytecode.object, args: [ADDRESSES.vessel, ADDRESSES.relics],
        })
        const receipt = await state.pub.waitForTransactionReceipt({ hash })
        state.vesselPortalAddr = receipt.contractAddress
        localStorage.setItem(VESSELPORTAL_KEY, state.vesselPortalAddr)
      } else if (step.call === 'registerRenderer') {
        const { result } = await state.pub.simulateContract({
          account: state.account, address: collection, abi: collectionAbi,
          functionName: 'registerRenderer', args: [state.vesselPortalAddr],
        })
        await tx({ address: collection, abi: collectionAbi, functionName: 'registerRenderer', args: [state.vesselPortalAddr] })
        rendererIndex = Number(result)
      } else if (step.call === 'prepareArtifact') {
        const key = stagedKey(collection, tokenId)
        const done = Number(localStorage.getItem(key) ?? 0)
        if (step.chunkTo <= done) { stepState(i, 'done', 'already staged'); continue }
        const batch = chunks.slice(Math.max(step.chunkFrom, done), step.chunkTo).map(bytesToHex)
        await tx({
          address: collection, abi: collectionAbi, functionName: 'prepareArtifact',
          args: [tokenId, batch, step.chunkFrom === 0 && done === 0],
        })
        localStorage.setItem(key, String(step.chunkTo))
      } else if (step.call === 'mint' || step.call === 'mintToLot') {
        const params = step.emptyArtifact ? { ...mintParams(), artifact: [] } : mintParams()
        if (step.call === 'mint') {
          await tx({ address: collection, abi: collectionAbi, functionName: 'mint', args: [params] })
        } else {
          await tx({
            address: collection, abi: collectionAbi, functionName: 'mintToLot',
            args: [params, reserveUsd, expiresAt], value: feeWei,
          })
        }
        localStorage.removeItem(stagedKey(collection, tokenId))
      }
      stepState(i, 'done')
    }

    await showResult(collection, tokenId)
    await loadCollections()
  } catch (err) {
    showError(err)
    const active = document.querySelector('#steps li.active')
    if (active) active.classList.replace('active', 'failed')
  } finally {
    recompute()
  }
})

async function tx(args) {
  const gas = await state.pub.estimateContractGas({ account: state.account, ...args })
  const hash = await state.wallet.writeContract({ ...args, gas: (gas * 12n) / 10n })
  const receipt = await state.pub.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`${args.functionName} reverted (${hash})`)
  return receipt
}

function renderSteps(steps) {
  $('steps').innerHTML = steps
    .map((s) => `<li>${s.call}${s.call === 'prepareArtifact' ? ` chunks ${s.chunkFrom}–${s.chunkTo - 1}` : ''}</li>`)
    .join('')
}
function stepState(i, cls, note) {
  const li = $('steps').children[i]
  li.className = cls
  if (note) li.textContent += ` — ${note}`
}

async function showResult(collection, tokenId) {
  const uri = await state.pub.readContract({ address: collection, abi: collectionAbi, functionName: 'tokenURI', args: [tokenId] })
  const json = JSON.parse(new TextDecoder().decode(base64Decode(uri.split(',')[1])))
  $('r-scan').href = `https://etherscan.io/token/${collection}?a=${tokenId}`
  $('r-net').href = 'https://networked.art/'
  $('r-frame').src = json.animation_url || json.image
  $('r-uri').textContent = `${collection} · token ${tokenId} · tokenURI ${uri.length.toLocaleString()} chars, fully on-chain`
  $('result').classList.remove('hidden')
}

// ── poster source ───────────────────────────────────────────────────────────

state.posterMode = 'upload'

for (const btn of $('poster-mode').querySelectorAll('button')) {
  btn.addEventListener('click', () => {
    state.posterMode = btn.dataset.pmode
    setActive($('poster-mode'), btn)
    $('poster-upload').classList.toggle('hidden', state.posterMode !== 'upload')
    $('poster-vessel').classList.toggle('hidden', state.posterMode !== 'vessel')
    renderPosterChoices()
    recompute()
  })
}

/// Offers the inspected vessel's entries as poster candidates. Only image-ish
/// entries: an HTML entry would render as a broken thumbnail everywhere.
function renderPosterChoices() {
  const sel = $('poster-entry')
  const candidates = (state.vessel?.entries ?? []).filter(
    (e) => e.size !== null && (e.kind === 'svg' || e.kind === 'png'),
  )
  if (!state.vessel) {
    sel.innerHTML = '<option value="">inspect a vessel, then pick an entry…</option>'
    return
  }
  if (!candidates.length) {
    sel.innerHTML = `<option value="">#${state.vessel.id} has no image entries — upload one instead</option>`
    state.posterPick = null
    return
  }
  sel.innerHTML = '<option value="">pick an entry…</option>'
    + candidates.map((e) => `<option value="${e.index}">entry ${e.index} — ${e.kind}, ${e.size.toLocaleString()} bytes</option>`).join('')
  if (state.posterPick) sel.value = String(state.posterPick.index)
}

$('poster-entry').addEventListener('change', (e) => {
  const index = Number(e.target.value)
  const entry = (state.vessel?.entries ?? []).find((x) => x.index === index)
  state.posterPick = entry
    ? { vesselId: state.vessel.id, index: entry.index, mime: KIND_MIME[entry.kind], size: entry.size }
    : null
  recompute()
})

// ── assemble mode ───────────────────────────────────────────────────────────

$('assemble-mode').addEventListener('change', (e) => {
  state.assembleMode = e.target.checked
  // Leaving assemble mode collapses to the first pick: one document again.
  if (!state.assembleMode) {
    const current = selectionList()
    if (current.length > 1) setSelection([current[0]])
  }
  renderEntries()
  recompute()
})

// ── preview modal ───────────────────────────────────────────────────────────

function currentPreviewSrc() {
  return $('preview-frame').getAttribute('src') || ''
}

function openModal() {
  const src = currentPreviewSrc()
  if (!src || src === 'about:blank') return
  $('modal-frame').src = src
  $('modal-label').textContent = state.source === 'vessel' && state.vessel
    ? `vessel #${state.vessel.id} — ${state.vessel.mode === 'pinned' ? `entries ${selectionList().join(', ')}` : 'live payload'}`
    : 'uploaded artwork'
  $('modal').classList.remove('hidden')
}

function closeModal() {
  $('modal').classList.add('hidden')
  $('modal-frame').src = 'about:blank'
}

// A data: URI navigated to directly is blocked by browsers; a blob URL of the
// same bytes opens fine and keeps zooming/inspecting available.
function openInNewTab() {
  const src = currentPreviewSrc()
  if (!src.startsWith('data:')) return
  const [head, b64] = src.split(',', 2)
  const mime = head.slice(5).replace(';base64', '') || 'text/html'
  const blob = new Blob([base64Decode(b64)], { type: mime })
  const url = URL.createObjectURL(blob)
  window.open(url, '_blank', 'noopener')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

$('preview-enlarge').addEventListener('click', openModal)
$('preview-frame').addEventListener('click', openModal)
$('preview-newtab').addEventListener('click', openInNewTab)
$('modal-newtab').addEventListener('click', openInNewTab)
$('modal-close').addEventListener('click', closeModal)
$('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal() })
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal() })

function showError(err) {
  const el = $('mint-error')
  el.textContent = String(err?.shortMessage ?? err?.message ?? err)
  el.classList.remove('hidden')
  console.error(err)
}

recompute()

// ── what this page talks to ─────────────────────────────────────────────────
//
// Rendered from ADDRESSES rather than written out, so the links can never
// drift from the contracts the app actually calls.
{
  const el = $('contract-links')
  const entries = [
    ['networked.art factory', ADDRESSES.factory],
    ['The Vessel', ADDRESSES.vessel],
    ['Relics', ADDRESSES.relics],
    ['VesselPortal', ADDRESSES.vesselPortal],
  ]
  el.innerHTML = entries
    .map(([label, addr]) => addr
      ? `<a href="https://etherscan.io/address/${addr}#code" target="_blank" rel="noopener" title="${addr}">${label}</a>`
      : `<span title="deployed on your first vessel mint">${label} (not yet deployed)</span>`)
    .join(' · ')
}

// ── build identity ──────────────────────────────────────────────────────────
//
// Injected at bundle time (script/build.mjs). With push-to-deploy, this is the
// only way to tell from the page which commit you are actually running.
const BUILD = typeof __KILN_BUILD__ !== 'undefined'
  ? __KILN_BUILD__
  : { commit: 'dev', ref: '—', env: 'local', builtAt: '', repo: '' }

{
  const el = $('build-stamp')
  const link = BUILD.repo && BUILD.commit !== 'dev' && !BUILD.commit.endsWith('+')
    ? `<a href="${BUILD.repo}/commit/${BUILD.commit}" target="_blank" rel="noopener">${BUILD.commit}</a>`
    : BUILD.commit
  const portal = ADDRESSES.vesselPortal
    ? `renderer ${ADDRESSES.vesselPortal.slice(0, 8)}…`
    : 'renderer not yet deployed'
  el.innerHTML = `<span class="dot">●</span> build ${link} · ${BUILD.ref} · ${BUILD.env}`
    + `${BUILD.builtAt ? ` · ${BUILD.builtAt}` : ''} · ${portal}`
  el.title = `Kiln build ${BUILD.commit} from ${BUILD.ref} (${BUILD.env})`
    + `${BUILD.builtAt ? `, built ${BUILD.builtAt}` : ''}`
}
