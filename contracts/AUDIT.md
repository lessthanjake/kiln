# VesselPortal — pre-deployment audit

VesselPortal is meant to be registered by people other than its author, on
collections its author does not control, holding art its author did not make.
That makes it infrastructure, and infrastructure earns trust by being specific
about what it guarantees and what it cannot.

Reviewed 2026-08-14 against the Source-based design, before any deployment.
Two independent adversarial reviews — one on harm to interactors, one on
Solidity/EVM correctness — each given the contract, interfaces, tests, and
protocol facts but not the author's reasoning. Both wrote and ran measured
proof-of-concept Foundry tests. Every number below was measured, not estimated.

## The guarantee

**A token rendered by VesselPortal can never become unviewable.** `uri()` and
`imageURI()` are total: they cannot revert, whatever the artifact says and
whatever the Vessel, the Relics curator, or a delegated machine contract does
afterwards. Poster and animation degrade independently — a failed poster
renders as an empty image, a failed animation is omitted, and `"unresolved":true`
marks the metadata.

This matters because the protocol makes rendering permanent: renderer
registration is append-only, and a token's renderer index is fixed at mint. A
renderer that can revert is a renderer that can brick a collector's token
forever, with no recourse for anyone.

`animationURI()`, `resolveSource()` and `resolveArtifact()` stay strict, so
minting tools fail loudly *before* a signature.

## Findings fixed

| # | Severity | Finding | Resolution | Measured |
|---|---|---|---|---|
| 1 | Critical | The content budget was enforced *after* every read completed, so an over-budget source was paid for in full — up to 64 reads × 256 KB materialised to enforce a 128 KB cap — and only then refused. A relics curator could `editRelic` a pinned document larger and push a working token past every RPC's gas cap. | Budget enforced as reads arrive: each `staticcall` accepts at most the remaining budget, checked before `returndatacopy`. | rejection **2,198,380,752 → 653,338 gas** (3,364×) |
| 2 | Critical | `renderForTotal` was public and took the content budget as a caller argument — the amplification limiter for the whole contract, settable by anyone. | Gated to self-calls (`NotSelf`). Same for `decodeArtifactFromToken`. | attack **28,472,157,209 gas / 22 MB return → 17,028 gas, nothing returned** |
| 3 | High | `MAX_CONTENT_BYTES` = 192 KB left ~5% headroom against geth's 50M `eth_call` cap — before the collection's own `tokenURI` wrapper (~4% measured) and before providers that budget lower. | Lowered to 128 KB. | 192 KB ≈ 47.5M → 128 KB ≈ 28.8M |
| 4 | High | Poster and animation each got the *full* budget in the strict preview paths, while `uri()` shares one. An artifact could validate cleanly at mint and render permanently `unresolved`. | `resolveArtifact` walks the shared budget, poster first, exactly as `uri()` does. | — |
| 5 | High | `READ_GAS` bounded one read, not one token. A source burning just under it and *returning* keeps the loop going for up to 128 reads. | Added `SOURCE_READ_GAS`, an aggregate budget per source, enforced statelessly via a gas delta across each read loop. | worst case **371,745,567 → bounded at 12M** |
| 6 | Medium | `name` and `description` were the only uncapped inputs, and `escapeJSON` expands them 6×. 128 KB of control bytes measured at 180,934,978 gas on a token with no artwork at all. | `MAX_TEXT_BYTES` = 2048, truncated (never refused — `uri()` degrades, never fails). | — |
| 7 | Medium | `previewURI` reported a number that depended on the gas the *preview caller* supplied, undercounted by ~10%, and could not distinguish "broken" from "cheap". | Returns `unresolved`, takes the real `TokenData`, and documents that `gasUsed` is a lower bound. | — |
| 8 | Medium | `selfTest` only exercised the Vessel, so a deployment wired to a wrong Relics address self-tested green. | Exercises both. Tooling must still verify `vessel()`/`relics()` — `name()`/`version()` are not identity. | — |
| 9 | Low | `_validMime` accepted `#`, which opens a URI fragment and silently truncates the payload: a valid-looking mime producing a permanently blank token. | Charset narrowed to `alnum . + - _`. | — |
| 10 | Low | A source resolving to zero bytes rendered `data:image/png;base64,` with no marker — a token that reads as healthy and displays nothing. | Zero-length content is a failure; sets `unresolved`. | — |
| 11 | Low | Relic entry 0 (never valid, 1-based) fell back to *vault entry 0* — real content the artist never referenced. | Excluded from the fallback. | — |
| 12 | Low | No cross-field validation: dead `data` on a reference source was decoded, passed across frames and re-encoded on every render. | Rejected at decode (`MalformedReference`). | up to **31.23M → 0.22M gas** |
| 13 | Low | Nothing in the metadata distinguished a fixed source from one a third party can change. | `"mutable":true` when any source is a live payload or a relic (curator-editable even when pinned). | — |

Findings 1 and 5, and 1 and 4, were reported independently by both reviewers —
the strongest signal in the set.

## Verified sound (unchanged)

- **`_unwrap` bounds arithmetic.** The `raw.length < 64` guard precedes
  `raw.length - 64`, so the underflow is unreachable; sizes 1–63 revert cleanly;
  `len == raw.length - 64` is the maximum accepted and the `mcopy` stays inside
  its allocation, verified byte-for-byte against sentinel tails. No adjacent
  memory can reach the render.
- **`abi.decode((Source, Source))` is not a memory bomb.** Claimed lengths are
  validated against the input before allocation; a full truncation sweep, a
  per-word corruption sweep, and `entries.length = 2^64` all revert in ~7k gas.
  256-run fuzzes of `uri()`/`imageURI()` over arbitrary artifacts, names,
  descriptions and pointer arrays never reverted.
- **`_artifact`.** The `code.length` check removes the `extcodesize - 1`
  underflow that would otherwise consume the caller's entire gas allowance. An
  **EIP-7702 delegated EOA reports 23 bytes and degrades cleanly** — the
  post-mint-delegation case is covered.
- **Dropping `escapeJSON` from the data-URI path is correct.** An exhaustive
  256-value sweep confirms `_validMime` admits no `,`, `;`, `"`, `\`, control
  byte, or high byte; base64's alphabet contains none either. Key injection via
  `name`/`description` was attempted and correctly escaped.
- **Vendored libraries** are byte-identical to upstream (OZ 5.6.0, solady
  0.1.26). `Base64.encode`'s free-memory-pointer trick and `escapeJSON`'s
  scratch-space use were both hand-verified memory-safe with allocator canaries.
- **try/catch semantics.** Bare `catch {}` catches revert, panic, empty revert,
  OOG and the no-code case; never copies a revert bomb. The
  "return-decode-fails-in-the-caller's-frame" hazard does not apply because both
  callees are `this` with a fixed ABI. Stack depth is unreachable as an attack.
- **Compiler.** solc 0.8.36's known-bug list is empty and none of the entries
  carried by 0.8.30–0.8.35 applied. Every suite passes identically under
  `--via-ir`. No stack-too-deep.
- **Stateless.** `forge inspect storageLayout` is empty. An opcode walk of the
  deployed runtime finds no SSTORE, TSTORE, DELEGATECALL, CREATE, SELFDESTRUCT,
  LOG or CALL. All entry points `view`/`pure`, nothing payable, no owner, no
  upgrade path.
- **Pinned vault immutability holds** — and for a non-obvious reason. Vault
  status derives from `_permute()`, which reads `blockEvents[0]`, owner-settable
  via `setBlockEvent` *unless locked*. Mainnet has `blockEventLock(0) == true`,
  freezing the seed. With `craftToEntry` only incrementing, `payloadList` only
  pushing, and post-Dencun `SELFDESTRUCT` no longer removing code, a pinned
  vault source is genuinely permanent.

## Limits that remain, honestly

- **Live mode is third-party-controlled by design.** A vessel holder (via their
  chosen entry or a delegated machine) and the relics curator decide what a live
  source displays. With `mime = "text/html"` that is a full attacker-authored
  document inside the collection's frame. The renderer cannot fix this — it is
  the feature — so it now *declares* it with `"mutable":true`. Front-ends should
  badge or sandbox accordingly. **If you want permanence, pin vault entries.**
- **Relic pinning pins the index, not the bytes.** `editRelic` rewrites in place
  with no on-chain signal. Relic sources are always marked mutable.
- **Metadata is a function of the gas the caller supplied.** A starved `eth_call`
  yields `"unresolved":true` and indexers cache it. Callers should budget ≥ 40M;
  there is no way for the contract to distinguish "broken" from "stingy".
- **Content above 128 KB per token degrades to poster-only.** Poster and
  animation share that budget, poster first — deliberately, so the thumbnail
  every marketplace grid uses is the half that survives.
- **Invalid UTF-8** in `name`/`description` passes through byte-for-byte; strict
  JSON parsers reject the whole document. Validate in the minting tool.
- **`name()`/`version()` are not identity.** A lookalike can return the same
  ones with hostile `vessel`/`relics` wired in. Verify the addresses;
  `script/publish-renderer.sh` does.
- **A well-formed but enormous artifact** (up to `MAX_CHUNKS` × 24,575 B) is
  expensive to reject. Bounded, but not free.
- **This is not a paid professional audit.** It is two careful adversarial
  reviews with measured proofs. Read the contract yourself before registering it.

## Test coverage

58 tests, all passing:

- `VesselPortal.t.sol` (20) — mainnet fork against real Vessel and Relics data,
  including a vault-hosted poster (#9994 entry 40), the sharded 65,105-byte
  document (#9994 entries 32–38), relic sources, independent degradation, and a
  test that pranks the relics owner into removing a relic to prove a minted
  token survives it.
- `VesselPortalHardening.t.sol` (31) — mock-based adversarial suite: hostile
  reverting/burning/bombing sources, mime injection on both slots, cross-field
  validation, the shared budget, empty content, the mutable marker, gated
  self-calls, and truncated titles.
- `VesselPortalAttacks.t.sol` (3) — permanent regression guards reproducing the
  two billion-gas findings; they fail if either becomes cheap again.
- `VesselPortalGas.t.sol` (4) — measured cost profile, the shared-budget
  interaction, and a guard that content at the cap resolves inside an RPC budget.

Pin the fork for determinism when an archive RPC is available:
`FORK_BLOCK=25733153 MAINNET_RPC_URL=<archive> forge test`

## Measured cost profile

`uri()` against an absent poster, isolating the animation curve:

| content | gas |
|---|---|
| 8 KB | 1.41M |
| 16 KB | 2.83M |
| 32 KB | 5.85M |
| 64 KB | 12.58M |
| 128 KB (cap) | 28.77M |

Real mainnet reads cost ~70 gas/byte (the Vessel reads storage, not SSTORE2),
so vessel-sourced content runs above these mock figures; the showcase token
(vault SVG poster + the 7-entry document) measured ~14.5M through the portal and
~15.1M through the collection's `tokenURI`. Budget ≥ 40M for comfort.
