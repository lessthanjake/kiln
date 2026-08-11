# VesselPortal — pre-deployment audit

VesselPortal is meant to be registered by people other than its author, on
collections its author does not control, holding art its author did not make.
That makes it infrastructure, and infrastructure earns trust by being specific
about what it guarantees and what it cannot.

This document records what was reviewed, what was found, what changed, and
what remains true but unfixable. Reviewed 2026-08-11 against commit-time
source; two independent adversarial reviews (interactor harm; Solidity/EVM
footguns) plus line-by-line review and measured proofs-of-concept.

## The guarantee

**A token rendered by VesselPortal can never become unviewable.** `uri()` and
`imageURI()` are total: they cannot revert, whatever the artifact bytes say and
whatever the Vessel, the Relics curator, or a delegated machine contract does
afterwards. When a reference cannot be resolved, the token renders its poster
with `"unresolved":true` rather than failing.

This matters because the protocol makes rendering permanent: renderer
registration is append-only, and a token's renderer index is fixed at mint.
A renderer that can revert is a renderer that can brick a collector's token
forever, with no recourse for the artist, the collection owner, or the
collector.

`animationURI()`, `resolve()`, `resolveArtifact()` and `previewURI()` stay
strict, so minting tools still fail loudly *before* a signature.

## Findings fixed

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | Critical | A vessel holder (who need not be the collector) could point a machine contract at code that reverts, permanently bricking `tokenURI`. Same power held by the relics curator. | All external reads go through a gas-capped raw `staticcall`; failures degrade instead of propagating. |
| 2 | Critical | No failure isolation: every revert path was permanent for that token. | `uri()`/`imageURI()` made total via an external self-call boundary. |
| 3 | Critical | `SSTORE2.read` on a code-less pointer underflows `extcodesize - 1` to ~2^40 and `extcodecopy`s ~1.1 TB, **consuming the caller's entire gas allowance** (measured: 100M). Reachable by anyone, since entry points take `TokenData` from the caller — and reachable post-mint via an EIP-7702 delegation. | Explicit `code.length` check per pointer; a 3k-gas typed `EmptyPointer` revert instead. |
| 4 | High | Return-data bombs: a hostile source returning megabytes is `returndatacopy`'d in full before `try/catch` can intervene (measured: 6 MB → 295M gas). | Raw `staticcall` checks `returndatasize()` **before** copying; `MAX_READ_BYTES` = 256 KB. |
| 5 | High | `mime` was interpolated raw into the data URI. Per RFC 2397 the first `,` ends the media type, so `text/html,<script>…<!--` yields attacker HTML in a wallet iframe with the real content commented out — a drainer surface under a legitimate collection's name. | `mime` validated as an RFC-2045 token; invalid values substitute `application/octet-stream` rather than reverting. |
| 6 | High | `uri()` cost ~4.2× `animationURI()` because the content was copied four extra times, notably an `escapeJSON` pass over a base64 string that provably cannot need escaping. Ordinary artwork exceeded RPC gas caps and rendered nowhere. | JSON assembled inline. Measured: 128 KB content 52.6M → 26.3M gas. |
| 7 | High | Unbounded `entries`/chunk loops with `bytes.concat` are super-quadratic; duplicates allowed. 100 entries measured at 379M gas. | Single-pass sizing + `mcopy`; `MAX_ENTRIES` = 64, `MAX_CHUNKS` = 32, and `MAX_CONTENT_BYTES` = 192 KB (the measured point where `uri()` still fits a 50M cap). |
| 8 | High | The relics curator could `removeRelic` then `addRelic` with fewer entries, pushing a pinned index out of range and bricking the token. | Out-of-range pinned relic entries degrade to the vault's own entries at the same indices. |
| 9 | Medium | A removed relic silently converted a *pinned* token into a *live*, holder-controlled one — the mode with the most third-party exposure. | Pinned references now degrade to pinned vault entries first, live payload only as a last resort. |
| 10 | Medium | Malformed artifact bytes reverted with no reason and no recovery. | Length precheck + typed `MalformedReference`; `uri()` degrades; `resolveArtifact()` added so tools can validate the exact bytes before minting. |
| 11 | Medium | Constructor accepted any address, uncorrectably, forever. | Both addresses must have code; `selfTest()` added so a collection owner can verify a deployment before registering it. |
| 12 | Low | `resolve()` understated real render cost by >4× and never exercised decoding — a token could preview fine and be unreadable everywhere. | `previewURI()` runs the true `uri()` assembly and reports its gas; Kiln warns above 128 KB and refuses above 192 KB. |
| 13 | Low | A one-byte `source` typo bricked the token permanently. | Unknown sources degrade to poster-only. |

## Verified sound (unchanged)

- **`abi.decode` cannot be turned into a memory bomb.** Every adversarial
  encoding tested — claimed array lengths of 2^64/2^40/1e6, wild head offsets,
  truncation, garbage — reverts in 6–7k gas with no allocation. Bounds are
  validated before memory is touched.
- **Vendored libraries are byte-identical to upstream**: OpenZeppelin
  `Base64`/`SafeCast` v5.6.0, solady `SSTORE2`/`LibString` v0.1.26. `Base64.encode`
  and `LibString.escapeJSON` were separately verified memory-safe on
  attacker-shaped input across all 256 byte values.
- **No known Solidity 0.8.36 compiler bug applies** (no via-IR, no storage, no
  transient storage, no inheritance beyond one interface, no mutual recursion).
  Compiles clean under both legacy and via-IR codegen.
- **Stateless**: `forge inspect storageLayout` is empty. No storage, no owner,
  no pause, no upgrade, no `delegatecall`, no `selfdestruct`, no payable
  function. No view-reentrancy surface of its own.
- **Pinned source-0 immutability holds, for a non-obvious reason.** It depends
  on vault status never flipping, which derives from `_permute()` and thus from
  `blockEvents[0]` — owner-settable via `setBlockEvent`, *except* mainnet has
  `blockEventLock(0) == true`, freezing the seed at block 24524524. Combined
  with `craftToEntry` only incrementing and `payloadList` only pushing, and with
  post-Dencun `SELFDESTRUCT` no longer removing code, pinned vault entries are
  genuinely permanent.
- **`try/catch` gotchas avoided.** `catch` does *not* fire for a no-code target
  or an undecodable return; both self-calls target `this` with a known ABI, and
  bare `catch {}` is used so a revert bomb is never copied.

## Limits that remain, honestly

- **Live mode is third-party-controlled by design.** With empty `entries`, the
  vessel holder (via chosen entry or machine delegation) and the relics curator
  decide what the token displays. That is the feature; it is not a defect. If
  you want permanence, pin entries. The renderer cannot make a mutable source
  immutable — it can only guarantee the token stays viewable.
- **Relic pinning pins the index, not the bytes.** The curator can `editRelic`
  in place with no on-chain signal.
- **Content above 192 KB renders as poster only.** Chosen because `uri()` costs
  ~43.8M gas there, against geth's default 50M `eth_call` cap.
- **Invalid UTF-8** in `name`/`description`/`image` passes through `escapeJSON`
  (which is byte-level) and can make strict JSON parsers reject the document.
  Validate in the minting tool; Kiln does.
- **`image` is an arbitrary artist-supplied string.** It could be an off-chain
  URL, undercutting the on-chain permanence framing. Kiln builds `data:` URIs.
- **No ERC-165.** The registry does not need it; some tooling likes it.
- **This is not a paid professional audit.** It is a careful adversarial review
  with measured proofs. Read the contract yourself before registering it.

## Test coverage

38 tests across three suites, all passing:

- `VesselPortal.t.sol` (16) — mainnet fork against real Vessel and Relics data,
  including the degradation ladder and a test that pranks the relics owner into
  removing a relic to prove a minted token survives it.
- `VesselPortalHardening.t.sol` (19) — mock-based adversarial suite: reverting
  and gas-burning machines, a 6 MB return bomb, malformed artifacts, mime
  injection and its variants, the entry cap, and relic shrink/remove.
- `VesselPortalGas.t.sol` (3) — measured cost profile, the worst legal case,
  and a regression guard that content at the cap resolves inside an RPC budget.

Pin the fork for determinism when an archive RPC is available:
`FORK_BLOCK=25733153 MAINNET_RPC_URL=<archive> forge test`

## Measured cost profile

| content bytes | `uri()` gas |
|---|---|
| 8 KB | 1.4M |
| 16 KB | 2.8M |
| 32 KB | 5.7M |
| 64 KB | 11.9M |
| 128 KB | 26.3M |
| 192 KB | 43.8M |

Deployed bytecode: 11,074 bytes.
