# Notice

Kiln is [CC0 1.0](LICENSE): public domain, no rights reserved, no attribution
asked. Two carve-outs, both about honesty rather than restriction.

## `contracts/lib/vendor/` is not mine to give away

`Base64.sol`, `LibBytes.sol`, `LibString.sol`, `SafeCast.sol` and `SSTORE2.sol`
are vendored third-party code (MIT) and stay under their original authors'
terms. They are pinned to the exact versions the networked.art protocol itself
was verified with.

## The MIT headers in `contracts/` are frozen on purpose

Solidity hashes every source file into the metadata it appends to compiled
bytecode, so editing a single `SPDX-License-Identifier` line changes what the
contract compiles to. Measured on this repo: that one edit moves the metadata
tail from `6d92f41e2c32…` to `d74fcdf7990c…`.

VesselPortal is deployed and immutable at
[`0x06dDc03Bc74c63650002cBAc386Ed6aaAA355d34`](https://repo.sourcify.dev/1/0x06dDc03Bc74c63650002cBAc386Ed6aaAA355d34),
verified on Sourcify as an **exact match** on both creation and runtime
bytecode. Rewriting those headers would mean this repository no longer compiles
to the contract that is actually on chain — and nothing could restore that,
because the deployed bytecode cannot change. CC0-headered source could only
ever register as a *partial* match.

Reproducibility is worth more than a tidy header. The CC0 dedication covers
that source as authored work; the header is a build input, not the license.
