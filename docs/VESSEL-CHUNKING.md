# Putting a work on The Vessel

Referencing a vessel entry from Kiln assumes the work is already stored there.
This is how it gets there: split a file across vault entries, write one
transaction per entry, verify the bytes came back whole.

It happens **before** Kiln. Kiln only reads.

```bash
node script/chunk-for-vessel.mjs <file...> --vessel 9994   # split
node script/write-to-vessel.mjs chunks/<name>              # simulate on a fork
node script/write-to-vessel.mjs chunks/<name> --calldata   # sign in your own wallet
```

## What a vault can hold

A Vessel token of type **Vault** stores a list of byte payloads. Two rules
decide everything else:

- **One entry holds at most `tokenId` bytes.** Vessel #9994 holds 9,994 bytes
  per entry; #500 holds 500. Straight from the contract:
  `if (_bytes.length > _tokenId) revert BytesExceedCapacity`.
- **Entries are append-only.** `setPayloadHolder` pushes a new entry and bumps
  the count. There is no update, no delete, no insert. A mistake is paid for
  once and lives forever.

`craftToEntry(tokenId)` returns the entry *count*, and entries are 0-based, so
the count is also the index of the next free slot.

Capsules are different: they hold one payload and rewriting replaces it.
Chunking only applies to vaults.

## Splitting

```bash
node script/chunk-for-vessel.mjs artwork.html --vessel 9994 --out chunks
```

Reads the vault's live entry count, splits the file at capacity, checks the
pieces rejoin byte-identically, and writes `chunks/artwork/` containing one
`.hex` per chunk plus a manifest recording sizes, hashes and target entries.

**Chunks are raw file bytes.** VesselPortal concatenates the entries you select
in the order you select them, so no loader, index, or assembler entry is
needed. If you have written assembler entries before, they were a workaround
for reassembling in a browser and are no longer required.

**Pass every file you intend to write in one sitting, in write order:**

```bash
node script/chunk-for-vessel.mjs first.html second.html --vessel 9994
```

Chunk two files in separate runs and both will claim the same entries, because
each run only sees the count as it stands. Passing them together stacks them:
`first` takes 45–48, `second` takes 49–52.

Use `--start N` to plan offline or against writes you have not made yet.

## Writing

Simulation is the default, because each write costs real money and cannot be
undone:

```bash
node script/write-to-vessel.mjs chunks/artwork
```

This forks mainnet, impersonates the holder, sends every write, reads the
entries back, and confirms they rebuild the original file. Nothing is sent to
mainnet. It reports the exact gas each write consumed.

To actually write, either sign in your own wallet:

```bash
node script/write-to-vessel.mjs chunks/artwork --calldata
# → vessel-writes.json: one {to, value, data} per chunk, in order
```

Send them to the Vessel contract in order, each confirmed before the next. On
Etherscan use the `setPayloadHolder` write tab: `_tokenId` is the vessel,
`_bytes` is the chunk hex. Or broadcast from the script with a hot key:

```bash
VESSEL_KEY=0x… node script/write-to-vessel.mjs chunks/artwork --broadcast
```

The script refuses if the key does not hold the vessel, if the token is not a
vault, or if it is locked.

### It plans from content, not from slot numbers

Before writing, the script reads every existing entry and hashes it. If a
file's chunks are already stored anywhere in the vault, it skips them and tells
you the entries they actually occupy. This is the guard that matters: a
manifest goes stale the moment anything else is written to the vault, and
trusting its numbers is how a file gets stored twice at full price.

It is also what makes an interrupted run safe to repeat.

## Cost

Vessel payloads are stored as raw contract storage, not SSTORE2, so they are
expensive: **~7.2M gas for a full 9,994-byte entry**, measured on a fork.

| gas price | 4 entries (~38 KB) |
|---|---|
| 0.05 gwei | ~0.003 ETH |
| 0.5 gwei | ~0.03 ETH |
| 2 gwei | ~0.11 ETH |

The price swings by two orders of magnitude across a day. Write when gas is
cheap; nothing about this is urgent.

Storing once on The Vessel and referencing it from every mint afterwards is
what makes it worth the cost. A referenced mint stores a pointer of a few
hundred bytes no matter how large the work is.

## Referencing it in Kiln

Once written: **reference a vessel token → the token id → inspect → pinned
entries → assemble mode**, then select the entries in ascending order. The
write script prints the exact list.

Order is document order. Selecting 47, 45, 46 concatenates them in that order
and produces garbage, which is why the picker records selection order rather
than sorting for you.

## Limits worth knowing before you write

- **64 entries per reference** (`MAX_ENTRIES`). A file needing more chunks than
  that cannot be assembled by the renderer in one reference. On vessel #9994
  that ceiling is ~640 KB, far above the render budget, but on a small vessel
  it binds first. The chunker warns.
- **128 KB of content per token**, shared between the thumbnail and the
  artwork, because `uri()` puts both in one document. Past roughly 140 KB the
  `tokenURI` read exceeds the 50M gas cap wallets and marketplaces use, and the
  token stops rendering anywhere. The chunker reports what fraction you are
  using.
- **SVG padded with NUL bytes past `</svg>`** renders as "extra content at the
  end of the document" rather than as artwork. Vault slots are fixed size and
  XML is strict. Whitespace padding is legal; NUL is not. Kiln checks the
  actual bytes and warns before minting.
- **The mime is pinned at mint.** A rotating vault served in live mode delivers
  every future payload under the type chosen at mint, so keep a rotating vault
  within one medium.
- **Pinned entries cannot change; live payloads can.** A pinned reference is
  immutable because entries are append-only on an immutable contract. A live
  reference follows the vessel *holder's* choices, and the holder need not be
  the collector. Kiln marks the difference, and the metadata carries
  `"mutable":true`.

## A worked example of the trap

Two files, `piece-a.html` and `piece-b.html`, were chunked in separate runs
against vessel #9994 when it held 41 entries. Both manifests claimed entries
45–48, because each run predicted 41–44 for the file it was given and 45–48 for
a file it assumed had gone first.

The files were then written in the other order. `piece-b.html` landed at 41–44
while its manifest said 45–48. Referencing 45–48 would have pointed the token
at the wrong bytes, and re-running a naive writer would have stored the same
file a second time for another ~28M gas.

The content check catches exactly this:

```
reading 45 existing entries to see what is already stored…
  piece-b.html is already on chain at entries 41–44 — skipping
    (the manifest said 45–48; use the real entries above when referencing it in Kiln)
```

Chunk everything in one run, and let the writer confirm against the chain.
