# Kiln

Mint fully on-chain 1/1s on [networked.art](https://networked.art) — no IPFS.
Your artwork's bytes go into SSTORE2 contract storage, or stay where they
already live on The Vessel and get referenced through **VesselPortal**, a custom
renderer this repo ships.

A local single-page app: connect a wallet, drop files (or point at a Vessel
token), watch the live byte-priced cost meter, preview exactly what will mint,
sign.

## Quick start

```bash
npm install
npm run build       # bundles the app into dist/
npm run serve       # http://localhost:8788 — open in your wallet browser
```

**Running it locally is the recommended way to use it.** The app signs real
transactions, and a hosted frontend is the part of this that an attacker could
plausibly tamper with — the contracts can't take your assets, but a swapped
build can ask you to sign something you didn't mean. Locally you are running
source you can read. See [SECURITY.md](SECURITY.md), which also lists the
exact six transactions Kiln will ever request, so anything else is a red flag.

Hosting notes — deploying to Vercel, and why the contract artifact is
committed — are in [VERCEL.md](VERCEL.md).

After changing the contract, regenerate the bundled bytecode:

```bash
cd contracts && forge build && cd ..
npm run sync-artifact
```

Before any real signature, rehearse everything against a mainnet fork:

```bash
npm test            # pure-logic tests (encoding, chunking, gas math, flow planner)
cd contracts && forge test   # VesselPortal fork tests against real Vessel data
npm run rehearse    # anvil mainnet fork: both mint paths end to end, byte-verified
```

`MAINNET_RPC_URL` overrides the default public RPC for forks.

## How it works

networked.art's factory (`factory.networked.eth`,
`0x0c2705cF48e49Cc896252dd16Dc8c5d31DF753B2`) mints 1/1s whose `artifact`
bytes are stored in SSTORE2 chunks (max 24,575 bytes each) and interpreted by
a per-token renderer:

| renderer | index | artifact bytes |
|---|---|---|
| Default | 0 | a plain image URI string |
| Animation | 1 | `abi.encode(string imageURI, string animationURI)` |
| **VesselPortal** (this repo) | registered per collection | `abi.encode(Source poster, Source animation)` |

Kiln picks the flow automatically:

- **small work, new collection + auction** → one `cloneCollectionAndMint` call
- **small work, no auction** → `cloneCollection` then `mint`
- **big work (over ~110 KB)** → staged: `prepareArtifact` batches across
  transactions, then a final mint with an empty artifact (progress is saved in
  localStorage and resumable)
- **vessel reference** → one-time `VesselPortal` deploy + `registerRenderer`,
  then each mint stores only a reference — under 1 KB however large the work

Auction params are computed at click time (`expiresAt = now + duration`) and
`expectedAuctions` is read live, so nothing goes stale between form-fill and
signature. The $10 lot-creation fee is quoted from the protocol's own
Chainlink feed with a small buffer; the contract refunds the excess.

## VesselPortal

`contracts/src/VesselPortal.sol` — a networked.art `IRenderer` that reads
The Vessel (`0xECb92Cc7112b80A2234936315BbB493fb48d1463`) and its Relics
contract (`0x48cB121Fa84b7C08692e74872D044B15369977CD`) at view time.

A token is two `Source`s — a poster and an animation — resolved the same way:

```solidity
struct Source {
    uint8      kind;     // 0 = vessel, 1 = relics, 2 = inline
    uint256    tokenId;  // vessel/relic id; ignored when inline
    uint256[]  entries;  // pinned entries; empty = that source's live payload
    string     mime;     // content type for the assembled data URI
    bytes      data;     // only when kind == 2; empty = source absent
}
```

- **kind 0, pinned** (`entries` non-empty, 0-based): concatenates immutable
  vault entries in the order given. Entries are append-only on an immutable
  contract whose type permutation is seed-locked, so a pinned source cannot be
  changed by anyone, ever. **Entry order is document order**, so a work sharded
  across slots reassembles exactly as you pick it — Kiln's "assemble mode".
- **kind 0, live** (`entries` empty): whatever `craftToPayload` returns now —
  the vessel *holder's* chosen entry, machine delegation, relic overrides. The
  holder need not be the collector.
- **kind 1, relics**: pinned relic entries are **1-based**, vault-relics only,
  and the bytes stay curator-editable — this pins the index, not the content. A
  removed or shrunk relic degrades to the vault's own entries, then to the live
  payload, never to a dead token.
- **kind 2, inline**: raw bytes carried in the artifact. Not a data URI — the
  renderer builds that from `data` + `mime`. Empty `data` means absent, which is
  how an image-only token omits its animation.

Because either half can be a reference, **a poster already on-chain costs ~100
bytes instead of its full size**. A fully referenced mint measured **896 bytes
of artifact serving 75,099 bytes of art**.

Metadata carries `"mutable":true` when any source resolves through a path a
third party can change, so front-ends can badge or sandbox rather than trusting
a docstring. Poster and animation **share** a 128 KB content budget, because
`uri()` puts both in one document and gas tracks their sum.

Because SVG is XML and vault slots are fixed-size, an SVG padded with NUL bytes
past its closing tag renders as *"extra content at the end of the document"*
rather than as artwork; whitespace padding is legal. Kiln checks the actual
bytes and warns before minting, and warns again if an assembly would put two
`<svg>` roots in one document. It also suggests the mime from the referenced
bytes (html, svg, png, mp3, text).

**`uri()` can never revert.** Registration is append-only and a token's
renderer index is fixed at mint, so a renderer that can fail is a renderer that
can brick a collector's token forever. Poster and animation degrade
independently, marked `"unresolved":true`. `animationURI`/`resolve*` stay strict
so minting tools fail loudly first.

The contract is immutable, ownerless and stateless. Two independent adversarial
reviews before deployment found 13 issues, two measured in the billions of gas;
see [contracts/AUDIT.md](contracts/AUDIT.md) for findings, fixes, measured gas,
and the limits that remain.

**Ownership courtesy.** The contract would let anyone reference anyone's
vessel; Kiln deliberately won't. Once a wallet is connected the app sweeps
`ownerOf(1..10000)` through Multicall3 — a dozen batched calls against the
wallet's own RPC (public endpoints only as fallback), no archive access
needed — and offers only the wallet's vessels in a picker. If every RPC
refuses, a free token-id field remains, but inspect still rejects any vessel
the wallet doesn't hold. Not everyone is CC0.

Deploy once, register per collection (Kiln adds both transactions when needed):

```bash
cd contracts
forge script script/Deploy.s.sol --rpc-url $MAINNET_RPC_URL --interactive --broadcast
```

**After the first mainnet deployment, record it** in `src/kiln.js`:

```js
export const ADDRESSES = {
  …
  vesselPortal: '0xYourDeployedAddress',
}
```

Kiln then never deploys another. The renderer is stateless and ownerless, so
one deployment serves every collection and every artist — anyone in the Vessel
community can register that same address on their own collection. Kiln
verifies the constant at connect time (code present, `name() == "VesselPortal"`),
so a wrong value falls back to deploying your own rather than pointing tokens
at a stranger's contract.

Registration is still one ~85k-gas transaction per collection; that part is
unavoidable, since each collection keeps its own renderer registry.

## Costs (mainnet, measured on fork)

- storing bytes: ~216 gas/byte + ~32k per 24.6 KB chunk. Base64 in a data URI
  inflates source files by 4/3.
- a minimal upload mint with new collection + auction: ~1.27M gas
- a VesselPortal mint: ~380k gas with an uploaded poster, ~406k with both
  poster and artwork referenced — flat, regardless of how large the work is
- one-time VesselPortal deploy ~1.4M gas, register ~85k gas per collection

## Layout

```
index.html, src/app.js      the page and its wiring
src/kiln.js                 pure logic — encoding, chunking, gas model, flow planner
src/abi.js                  hand-pruned ABIs, verified against on-chain sources
test/kiln.test.js           node:test suite for the pure logic
script/fork-mint.mjs        the rehearsal (anvil mainnet fork, both paths)
contracts/                  foundry project: VesselPortal.sol, fork tests, deploy script
contracts/lib/vendor/       solady SSTORE2/LibString + OZ Base64, pinned to the
                            exact versions the protocol itself was verified with
```

## Hard-won notes

- **Never use anvil's stock keys against a mainnet fork.** Those keys are
  public, and their real mainnet accounts carry EIP-7702 sweeper delegations —
  `onERC721Received` fires mid-mint and the delegated code tries to steal the
  token. The rehearsal derives its own throwaway key and funds it with
  `anvil_setBalance`.
- `vaultToEntry` is 0-based and unbounded (reverts `WrongType` on non-vaults,
  panics past the end); `craftToEntry` returns the entry *count*. VesselPortal
  guards both.
- The first vessel inspection after starting a fork is slow — the fork is
  faulting in remote storage slots. Retry; they cache.
