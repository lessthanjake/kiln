# v2 renderers — spec

Two contracts, not yet built. Both are new deployments registered at fresh
renderer indices; nothing about them touches tokens already minted, because a
token's renderer index is fixed at mint and registration is append-only. That
freedom is the reason v2 can change the artifact encoding outright rather than
carrying v1's shape forward.

Everything in `AUDIT.md` still binds: `uri()` must never revert, external reads
go through the gas- and returndata-capped `_read`, SSTORE2 pointers get a
`code.length` check, `mime` is validated, and content is capped. Assume those
are copied verbatim.

---

## 1. VesselPortal v2 — the poster stops being special

### Problem

In v1 the poster is the only component stored inline, so it is the only thing
an artist pays real storage for. Measured at 0.060 gwei:

| poster | artifact | mint gas | cost |
|---|---|---|---|
| 70 B | 640 B | 457k | $0.05 |
| 25 KB | 34 KB | 7.8M | $0.88 |
| 150 KB | 200 KB | 44.7M | $5.05 |

Meanwhile seven vessel entry indices pointing at a 65 KB artwork cost ~224
bytes. The artwork is free and the thumbnail is what you buy — backwards, and
worse when a perfectly good poster already exists on-chain (vessel #9994 entry
40 is a 9,994-byte SVG that v1 forces you to re-upload and re-pay for).

### Design

Make poster and animation the *same* resolvable thing, and let either be a
reference or inline bytes:

```solidity
struct Source {
    uint8      kind;      // 0 = vessel, 1 = relics, 2 = inline
    uint256    tokenId;   // vessel/relic id; ignored when inline
    uint256[]  entries;   // pinned entries; empty = that source's live payload
    string     mime;      // content type for the assembled data URI
    bytes      data;      // used only when kind == 2
}

// artifact
abi.encode(Source poster, Source animation)
```

- Both resolve through one code path, so the pinned/live/relic/degradation
  ladder applies identically to each — no second implementation to keep honest.
- A vessel-referenced poster and animation together is a **flat ~460-byte
  artifact**, whatever they point at.
- `kind = 2` (inline) subsumes v1's behaviour, so an artist with no on-chain
  poster is no worse off.
- An empty `animation.mime` means image-only, which also covers what the stock
  Default renderer does — one renderer for every case Kiln offers.

### Consequences

- `imageURI()` becomes a resolving call rather than a field read, so it needs
  the same totality treatment as `uri()` (return `""` on failure, never revert).
- The content cap applies per-source, not per-token: poster and animation each
  bounded, since both now land in one JSON document.
- Kiln change: the poster drop-zone gains a "use a vessel entry" mode, mirroring
  the artwork picker. Mint cost display becomes near-constant for reference
  mints, which is the visible payoff.

### Open question

Whether to also let `rendererData` (the unused `uint128` on every token) carry
the poster's entry index, saving ~60 bytes. Probably not worth the encoding
special-case, but it is free storage already paid for.

---

## 2. ETHFS renderer — not this roadmap's to build

**Decided (2026-08-14): left to the EthFS community.** A portal should be
built by someone who lives in the world it opens onto — the natural author is
an artist who already stores work on EthFS. This section stays as an
invitation and a head start: the pattern, the measured constraints (the
framework-inlining ceiling below was expensive to learn), and a verified
reference implementation in VesselPortal, whose registration mechanics,
totality discipline, and `_read` hardening translate directly. registerRenderer
is permissionless per collection; nobody needs permission from anyone here to
ship it.

The Frameworks pattern: store a JS program on EthFS
(`0xFe1411d6864592549AdE050215482e4385dFa0FB`), have the renderer read it at
view time, splice in per-token parameters, and return one self-contained
`data:text/html` document. No runtime RPC, so it avoids the failure class that
broke Sequence #6 and that vessel-explorer patches at serve time.

### The hard constraint, established before building

`uri()` assembles content in memory and base64s it. Measured ceiling is
~192 KB of content ≈ 43.8M gas, against a 50M `eth_call` cap:

| library | raw | base64 | verdict |
|---|---|---|---|
| p5.min.js | 1,030 KB | 1,373 KB | **exceeds** |
| three.min.js | 620 KB | 827 KB | **exceeds** |
| compact custom JS | 40 KB | 53 KB | fits |

**So a renderer cannot inline p5 or three.** Any spec that assumed "store p5 on
EthFS and splice it in" is dead on arrival — the token would render nowhere.
This is why Luke's WebGPU Frameworks renderer works: the program is compact.

### Viable shapes

1. **Compact program, fully inlined** (preferred). A hand-written canvas/WebGL
   program under ~150 KB, stored on EthFS, spliced with a seed. Fully
   self-contained, no runtime dependency, renders forever.
2. **Hybrid**: inline the sketch, fetch only the heavy library at runtime.
   Restores the dependency for the library but keeps the artwork on-chain.
   Honest middle ground; should be labelled as such in the UI.
   **Note: this shape needs no new contract.** The runtime fetch lives in the
   artwork HTML itself — an eth_call to the EthFS FileStore, then eval — so a
   VesselPortal v1 token or a stock Animation-renderer token can do it today.
   p5 on EthFS is immutable, so the fetch is deterministic: same bytes forever,
   from any RPC. Only the library rides the runtime dependency; the sketch
   stays pinned. (Confirm the FileStore read ABI when writing the bootstrap.)
3. **Reject**: inlining a full framework. Document why so nobody retries it.

Consequence of §2's note: this renderer exists solely for shape 1 — compact
seeded programs. Library loading is the artwork's job, not the renderer's.

### Design

```solidity
// artifact
abi.encode(Source poster, string[] files, bytes params)
```

- `files` are EthFS filenames concatenated in order into one `<script>`.
- `params` is spliced into a template as a JSON literal; per-token variation
  (seed, palette) rides in `rendererData` (uint128, already paid for, unused).
- One EthFS-stored program serves a whole generative series: each mint is a
  poster reference plus a seed, so a series costs the same per token as a
  vessel reference does.
- Template lives as a contract constant, not on EthFS, so the renderer has no
  bootstrapping dependency of its own.

### Composition with §1

**Decided (2026-08-14): two contracts, split by domain.** VesselPortal is a
portal into the Vessel and stays that way — its `Source` kinds are vessel,
relics, and inline, for both poster and animation. No EthFS kind, ever; the
name is the scope. The EthFS renderer is its own contract with its own name,
and *its* poster-by-reference reads EthFS files, so an EthFS-stored thumbnail
is served by the renderer whose world it lives in. The `Source` struct shape
is shared between the two codebases; the registries of readable contracts are
not. Cost of the split: a piece cannot mix a vessel-sourced animation with an
EthFS-sourced poster in one token. Accepted — each renderer stays small,
legible, and auditable as one idea.

---

## Build order

1. §1 first — it is small, entirely additive, and pays for itself immediately
   on the next vessel mint.
2. §2 after a compact program exists to test against. Writing the renderer
   before the artwork risks specifying for a library that cannot fit.
3. Re-run the full adversarial audit on whichever contract ships; the v1
   findings are a checklist, not a guarantee, for a new encoding.
