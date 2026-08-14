// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Base64 } from "vendor/Base64.sol";
import { LibString } from "vendor/LibString.sol";

import { IRenderer } from "./interfaces/IRenderer.sol";
import { INetworkedArt } from "./interfaces/INetworkedArt.sol";

/// @notice The read surface VesselPortal needs on The Vessel.
interface IVessel {
    function vaultToEntry(uint256 tokenId, uint256 entry) external view returns (bytes memory);
    function craftToPayload(uint256 tokenId) external view returns (bytes memory);
    function craftToVaultStatus(uint256 tokenId) external view returns (bool);
    function craftToEntry(uint256 tokenId) external view returns (uint256);
}

/// @notice The read surface VesselPortal needs on the Relics contract.
interface IRelics {
    function isRelic(uint256 tokenId) external view returns (bool);
    function relicToPayload(uint256 tokenId) external view returns (bytes memory);
    function vaultRelicToEntry(uint256 tokenId, uint256 entry) external view returns (bytes memory);
    function getTokenEntries(uint256 tokenId) external view returns (uint256);
}

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

///           ○
///          ( )
///           ○
///
/// @title  VesselPortal
/// @notice A networked.art renderer that looks into The Vessel's hold.
///
///         A token rendered through VesselPortal is two `Source`s — a poster
///         and an animation — abi-encoded into its artifact. Each source is
///         resolved the same way:
///
///         kind 0 — THE VESSEL:
///           `entries` non-empty pins immutable, 0-based vault entries,
///           concatenated in order. Vault entries are append-only on an
///           immutable contract whose type permutation is seed-locked, so a
///           pinned source cannot be changed by anyone, ever.
///           `entries` empty follows `craftToPayload` live: the vessel
///           HOLDER's chosen entry, machine delegation, relic overrides. The
///           holder need not be this token's collector.
///
///         kind 1 — RELICS (curated overrides):
///           `entries` non-empty pins relic entries, **1-based** as the Relics
///           contract counts them, vault-relics only; relic bytes stay
///           curator-editable, so this pins the index, not the content.
///           `entries` empty follows `relicToPayload`. A removed or shrunk
///           relic degrades to the vault's own entries, then to the live
///           payload — never to a dead token.
///
///         kind 2 — INLINE: `data` holds raw bytes stored in the artifact
///           itself. Empty `data` means the source is absent (an image-only
///           token omits its animation this way).
///
///         `mime` types each source's data URI. Content is served verbatim —
///         this renderer never rewrites, parameterizes, or injects into the
///         bytes it resolves. That byte-fidelity is the contract's core
///         auditable property.
///
///         DEGRADATION. `uri()` and `imageURI()` never revert. A source that
///         cannot resolve — malformed artifact, hostile or oversized external
///         data, curator surprises — degrades independently: a failed poster
///         renders as an empty image, a failed animation is omitted, and
///         `"unresolved":true` marks the metadata. A minted token can never
///         become unviewable through anything a third party does.
///         `animationURI()` and the `resolve*` helpers stay strict so minting
///         tools fail loudly before a signature.
///
/// @dev    Immutable, ownerless, stateless. All entry points are `view`.
///
///         `TokenData.data` (the per-token `uint128 rendererData`) is
///         RESERVED and deliberately ignored, forever. Every additional
///         channel of meaning is decode surface, and decode surface is where
///         renderer bugs live. Mint it as 0.
contract VesselPortal is IRenderer, IERC165 {
    /// @notice One resolvable half of a token: its poster or its animation.
    struct Source {
        uint8      kind;     // 0 = vessel, 1 = relics, 2 = inline
        uint256    tokenId;  // vessel/relic id; ignored when inline
        uint256[]  entries;  // pinned entries; empty = that source's live payload
        string     mime;     // content type for the assembled data URI
        bytes      data;     // only when kind == 2; empty = source absent
    }

    uint8 public constant KIND_VESSEL = 0;
    uint8 public constant KIND_RELICS = 1;
    uint8 public constant KIND_INLINE = 2;

    /// @notice Most entries one source may concatenate.
    uint256 public constant MAX_ENTRIES = 64;

    /// @notice Most SSTORE2 chunks one artifact may span.
    uint256 public constant MAX_CHUNKS = 32;

    /// @notice Ceiling on bytes accepted from one external read, checked
    ///         before the response is copied — a hostile data source cannot
    ///         exhaust an RPC's gas with a returndata bomb.
    uint256 public constant MAX_READ_BYTES = 256 * 1024;

    /// @notice Ceiling on the content one TOKEN assembles — poster and
    ///         animation share it, because `uri()` puts both in one document
    ///         and gas tracks their sum. A per-source cap would let two
    ///         individually-legal sources add up to a token that renders
    ///         nowhere. Sized for real headroom, not the theoretical maximum:
    ///         192 KB measured at ~47.5M against geth's 50M default, which
    ///         leaves nothing for the collection's own tokenURI wrapper (~4%
    ///         measured) or for providers that budget below 50M. 128 KB
    ///         measures ~30M and clears both. Over-budget sources degrade to
    ///         absent instead of rendering nowhere.
    uint256 public constant MAX_CONTENT_BYTES = 128 * 1024;

    /// @notice Gas forwarded to each external data read.
    uint256 public constant READ_GAS = 3_000_000;

    /// @notice Aggregate gas one source's reads may consume. READ_GAS alone
    ///         bounds a single read, but a source that burns just under it and
    ///         RETURNS keeps the loop going: 128 such reads measured at 371M
    ///         gas. This bounds the token, not merely the call.
    uint256 public constant SOURCE_READ_GAS = 12_000_000;

    /// @dev Offset word + length word + worst-case padding.
    uint256 internal constant ABI_ENVELOPE = 96;

    /// @notice Substituted when a source's mime is not a valid RFC-2045 token.
    string public constant FALLBACK_MIME = "application/octet-stream";

    /// @notice Ceiling on the token name and description this renderer will
    ///         emit. `escapeJSON` can double their length, so an unbounded
    ///         title is its own denial-of-render: 128 KB of name measured at
    ///         46.6M gas on a token with no artwork at all. Longer strings are
    ///         truncated rather than refused — `uri()` may degrade, never fail.
    uint256 public constant MAX_TEXT_BYTES = 2048;

    IVessel public immutable vessel;
    IRelics public immutable relics;

    /// @notice A required address had no code.
    error NotAContract(address target);
    /// @notice Pinned references require a Vault-type token.
    error NotAVault(uint256 vesselTokenId);
    /// @notice A pinned entry index is outside the source's entry range.
    error EntryOutOfRange(uint256 vesselTokenId, uint256 entry, uint256 count);
    /// @notice The source names a kind this renderer does not know.
    error UnknownKind(uint8 kind);
    /// @notice More entries than MAX_ENTRIES were requested.
    error TooManyEntries(uint256 requested, uint256 max);
    /// @notice An external read failed, or returned more than MAX_READ_BYTES.
    error ReadFailed(address target, uint256 returnedBytes);
    /// @notice The artifact bytes are not a valid (Source, Source) encoding.
    error MalformedReference();
    /// @notice An artifact chunk pointer holds no code.
    error EmptyPointer(address pointer);
    /// @notice More artifact chunks than MAX_CHUNKS.
    error TooManyChunks(uint256 requested, uint256 max);
    /// @notice Assembled content exceeds what clients can render.
    error ContentTooLarge(uint256 size, uint256 max);
    /// @notice A source resolved to zero bytes.
    error EmptyContent();
    /// @notice An internal-only entry point was called from outside.
    error NotSelf();
    /// @notice One source's reads consumed more than SOURCE_READ_GAS.
    error ReadBudgetExhausted(uint256 spent, uint256 max);

    constructor(address vessel_, address relics_) {
        // An immutable contract wired to the wrong address could never be
        // corrected, and never removed from a collection's registry.
        if (vessel_.code.length == 0) revert NotAContract(vessel_);
        if (relics_.code.length == 0) revert NotAContract(relics_);
        vessel = IVessel(vessel_);
        relics = IRelics(relics_);
    }

    /// @inheritdoc IRenderer
    function name() external pure returns (string memory) { return "VesselPortal"; }
    /// @inheritdoc IRenderer
    function version() external pure returns (uint256) { return 1; }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IRenderer).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    // ───────────────────────────── Entry points ───────────────────────────

    /// @inheritdoc IRenderer
    /// @dev Total: never reverts. Sources degrade independently.
    function uri(uint256, INetworkedArt.TokenData calldata token)
        external
        view
        returns (string memory)
    {
        (bool decoded, Source memory poster, Source memory animation) = _tryDecode(token);

        bool broken = !decoded;
        string memory image = "";
        uint256 budget = MAX_CONTENT_BYTES;
        if (decoded && !_absent(poster)) {
            (bool ok, string memory dataURI, uint256 used) = _tryRender(poster, budget);
            if (ok) { image = dataURI; budget -= used; }
            else broken = true;
        }

        bytes memory json = abi.encodePacked(
            '{"name":"', _text(token.name),
            '","description":"', _text(token.description),
            '","image":"', image, '"'
        );
        if (decoded && !_absent(animation)) {
            (bool ok, string memory dataURI, ) = _tryRender(animation, budget);
            if (ok) json = abi.encodePacked(json, ',"animation_url":"', dataURI, '"');
            else broken = true;
        }
        if (broken) json = abi.encodePacked(json, ',"unresolved":true');
        if (decoded && (_mutable(poster) || _mutable(animation))) {
            json = abi.encodePacked(json, ',"mutable":true');
        }
        json = abi.encodePacked(json, "}");
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(json)));
    }

    /// @dev True when a source resolves through a path a third party can
    ///      change after the mint: a live payload (vessel holder's slot or
    ///      machine delegation) or any relic source (curator-editable, even
    ///      when pinned — pinning fixes the index, not the bytes). Front-ends
    ///      should badge or sandbox these rather than trusting a docstring.
    function _mutable(Source memory s) internal pure returns (bool) {
        if (s.kind == KIND_INLINE) return false;
        if (s.kind == KIND_RELICS) return true;
        return s.entries.length == 0; // vessel live payload
    }

    /// @inheritdoc IRenderer
    /// @dev Total: never reverts. Returns "" when the poster cannot resolve.
    function imageURI(uint256, INetworkedArt.TokenData calldata token)
        external
        view
        returns (string memory)
    {
        (bool decoded, Source memory poster, ) = _tryDecode(token);
        if (!decoded || _absent(poster)) return "";
        (bool ok, string memory dataURI, ) = _tryRender(poster, MAX_CONTENT_BYTES);
        return ok ? dataURI : "";
    }

    /// @inheritdoc IRenderer
    /// @dev Strict: reverts with a typed error so tooling sees the reason.
    function animationURI(uint256, INetworkedArt.TokenData calldata token)
        external
        view
        returns (string memory)
    {
        (, Source memory animation) = this.decodeArtifact(_artifact(token));
        if (_absent(animation)) return "";
        return _dataURI(animation.mime, _content(animation));
    }

    // ───────────────────────────── Preview helpers ────────────────────────

    /// @notice Resolve one source, strictly. A minting interface calls this
    ///         to fail loudly before a signature.
    function resolveSource(Source calldata source)
        external
        view
        returns (bytes memory content, string memory dataURI)
    {
        content = _content(source);
        dataURI = _dataURI(source.mime, content);
    }

    /// @notice Resolve straight from candidate artifact bytes — the exact
    ///         path a mint takes, including decoding.
    function resolveArtifact(bytes calldata artifact)
        external
        view
        returns (string memory image, string memory animation)
    {
        (Source memory poster, Source memory anim) = this.decodeArtifact(artifact);
        // Resolve against ONE shared budget, poster first, exactly as `uri()`
        // will. Resolving each against the full budget would let a pair that
        // cannot possibly render together preview as healthy.
        uint256 budget = MAX_CONTENT_BYTES;
        if (!_absent(poster)) {
            bytes memory content = _content(poster, budget);
            if (content.length == 0) revert EmptyContent();
            image = _dataURI(poster.mime, content);
            budget -= content.length;
        }
        if (!_absent(anim)) {
            bytes memory content = _content(anim, budget);
            if (content.length == 0) revert EmptyContent();
            animation = _dataURI(anim.mime, content);
        }
    }

    /// @notice The full metadata a token would carry, and its gas cost, so a
    ///         minting interface can warn before a piece grows too large for
    ///         wallets and marketplaces to render (many cap eth_call at 50M).
    /// @notice The metadata a token would carry, whether any source failed,
    ///         and what it cost to assemble.
    /// @dev    `gasUsed` is a LOWER BOUND on what a client needs: it excludes
    ///         the collection's own `tokenURI` wrapper (~4% measured) and is
    ///         only meaningful if this call was given several times the target
    ///         cap, since a starved call degrades and reports a small number.
    ///         Pass the real name/description — their length is not free.
    function previewURI(bytes calldata artifact, INetworkedArt.TokenData calldata token)
        external
        view
        returns (string memory metadata, uint256 gasUsed, bool unresolved)
    {
        uint256 start = gasleft();
        metadata = this.uriFromArtifact(artifact, token);
        gasUsed = start - gasleft();
        // The marker lives inside base64, so recompute it rather than
        // searching the encoded document.
        unresolved = _wouldBeUnresolved(artifact);
    }

    function _wouldBeUnresolved(bytes calldata artifact) internal view returns (bool) {
        Source memory poster;
        Source memory anim;
        try this.decodeArtifact(artifact) returns (Source memory p, Source memory a) {
            poster = p;
            anim = a;
        } catch {
            return true;
        }
        uint256 budget = MAX_CONTENT_BYTES;
        if (!_absent(poster)) {
            (bool ok, , uint256 used) = _tryRender(poster, budget);
            if (!ok) return true;
            budget -= used;
        }
        if (!_absent(anim)) {
            (bool ok, , ) = _tryRender(anim, budget);
            if (!ok) return true;
        }
        return false;
    }

    /// @notice `uri()` against supplied bytes rather than a minted token.
    function uriFromArtifact(bytes calldata artifact, INetworkedArt.TokenData calldata token)
        external
        view
        returns (string memory)
    {
        INetworkedArt.TokenData memory t;
        t.name = token.name;
        t.description = token.description;
        return _uriFromBytes(t, artifact);
    }

    /// @notice Decode an artifact. External so callers (and this contract's
    ///         own total entry points) can catch malformed encodings.
    function decodeArtifact(bytes calldata artifact)
        external
        pure
        returns (Source memory poster, Source memory animation)
    {
        // Two heads (64) plus, per source, five head words and three dynamic
        // lengths: anything shorter cannot be a valid encoding and decoding
        // it panics without a reason.
        if (artifact.length < 0x240) revert MalformedReference();
        (poster, animation) = abi.decode(artifact, (Source, Source));
        if (poster.entries.length > MAX_ENTRIES) revert TooManyEntries(poster.entries.length, MAX_ENTRIES);
        if (animation.entries.length > MAX_ENTRIES) revert TooManyEntries(animation.entries.length, MAX_ENTRIES);
        if (poster.kind > KIND_INLINE) revert UnknownKind(poster.kind);
        if (animation.kind > KIND_INLINE) revert UnknownKind(animation.kind);
        _requireWellFormed(poster);
        _requireWellFormed(animation);
    }

    /// @dev Fields that cannot apply to a kind must be empty. Dead bytes are
    ///      not merely untidy: they are decoded, returned across frames and
    ///      re-encoded as calldata on every single render.
    function _requireWellFormed(Source memory s) internal pure {
        if (s.kind == KIND_INLINE) {
            if (s.entries.length != 0) revert MalformedReference();
        } else if (s.data.length != 0) {
            revert MalformedReference();
        }
    }

    /// @notice Renders a known-good read end to end. A collection owner can
    ///         call this before `registerRenderer` to confirm the deployment
    ///         is wired to live, working data sources.
    ///         Exercises BOTH wired contracts: a deployment pointed at the
    ///         right Vessel and the wrong Relics would otherwise self-test
    ///         green. Tooling must still verify `vessel()` and `relics()`
    ///         against known addresses — `name()` and `version()` are not
    ///         identity, and a lookalike can return the same ones.
    function selfTest(uint256 vesselTokenId) external view returns (bool) {
        bytes memory payload = _read(
            address(vessel),
            abi.encodeCall(IVessel.craftToPayload, (vesselTokenId))
        );
        // Reverts if the relics address is not a Relics contract.
        abi.decode(_read(address(relics), abi.encodeCall(IRelics.isRelic, (vesselTokenId))), (bool));
        abi.decode(_read(address(relics), abi.encodeCall(IRelics.getTokenEntries, (vesselTokenId))), (uint256));
        return payload.length > 0;
    }

    // ───────────────────────────── Internals ──────────────────────────────

    /// @dev An inline source with no bytes is "absent" — how an image-only
    ///      token omits its animation, or an animation-only token its poster.
    /// @dev Escaped, bounded text for the JSON document.
    function _text(string memory value) internal pure returns (string memory) {
        bytes memory b = bytes(value);
        if (b.length <= MAX_TEXT_BYTES) return LibString.escapeJSON(value);
        bytes memory cut = new bytes(MAX_TEXT_BYTES);
        for (uint256 i; i < MAX_TEXT_BYTES; ++i) cut[i] = b[i];
        return LibString.escapeJSON(string(cut));
    }

    function _absent(Source memory s) internal pure returns (bool) {
        return s.kind == KIND_INLINE && s.data.length == 0;
    }

    function _tryDecode(INetworkedArt.TokenData calldata token)
        internal
        view
        returns (bool ok, Source memory poster, Source memory animation)
    {
        try this.decodeArtifactFromToken(token) returns (Source memory p, Source memory a) {
            return (true, p, a);
        } catch {
            return (false, poster, animation);
        }
    }

    /// @notice Chunk reassembly + decode behind one external self-call so the
    ///         total entry points can catch bad pointers and bad encodings
    ///         alike. Not meant for callers.
    function decodeArtifactFromToken(INetworkedArt.TokenData calldata token)
        external
        view
        returns (Source memory poster, Source memory animation)
    {
        if (msg.sender != address(this)) revert NotSelf();
        return this.decodeArtifact(_artifact(token));
    }

    function _tryRender(Source memory source, uint256 budget)
        internal
        view
        returns (bool ok, string memory dataURI, uint256 used)
    {
        try this.renderForTotal(source, budget) returns (string memory u, uint256 n) {
            return (true, u, n);
        } catch {
            return (false, "", 0);
        }
    }

    /// @notice Strict resolution used internally by the total entry points.
    /// @dev    External only because `try` requires an external call. Gated:
    ///         `budget` is the amplification limiter for the entire contract,
    ///         and an open endpoint taking it as an argument would let anyone
    ///         request unbounded concatenation — measured at 28.5 BILLION gas
    ///         and a 22 MB return before this check existed.
    function renderForTotal(Source calldata source, uint256 budget)
        external
        view
        returns (string memory, uint256)
    {
        if (msg.sender != address(this)) revert NotSelf();
        bytes memory content = _content(source, budget);
        // A source that resolves to nothing is broken, not healthy: emitting
        // `data:image/png;base64,` would read as a working token that happens
        // to display nothing. Fail so the caller marks it unresolved.
        if (content.length == 0) revert EmptyContent();
        return (_dataURI(source.mime, content), content.length);
    }

    function _content(Source memory s) internal view returns (bytes memory) {
        return _content(s, MAX_CONTENT_BYTES);
    }

    /// @dev `budget` is what remains of the token's content allowance.
    function _content(Source memory s, uint256 budget) internal view returns (bytes memory out) {
        if (s.entries.length > MAX_ENTRIES) revert TooManyEntries(s.entries.length, MAX_ENTRIES);
        if (s.kind == KIND_VESSEL) out = _vesselContent(s.tokenId, s.entries, budget);
        else if (s.kind == KIND_RELICS) out = _relicContent(s.tokenId, s.entries, budget);
        else if (s.kind == KIND_INLINE) out = s.data;
        else revert UnknownKind(s.kind);
        if (out.length > budget) revert ContentTooLarge(out.length, budget);
    }

    function _vesselContent(uint256 vesselTokenId, uint256[] memory entries, uint256 budget)
        internal
        view
        returns (bytes memory)
    {
        if (entries.length == 0) {
            return _read(address(vessel), abi.encodeCall(IVessel.craftToPayload, (vesselTokenId)), budget);
        }
        if (!_vaultStatus(vesselTokenId)) revert NotAVault(vesselTokenId);
        uint256 available = abi.decode(
            _read(address(vessel), abi.encodeCall(IVessel.craftToEntry, (vesselTokenId))),
            (uint256)
        );
        bytes[] memory parts = new bytes[](entries.length);
        uint256 consumed;
        uint256 startGas = gasleft();
        for (uint256 i; i < entries.length; ++i) {
            if (entries[i] >= available) {
                revert EntryOutOfRange(vesselTokenId, entries[i], available);
            }
            parts[i] = _read(
                address(vessel),
                abi.encodeCall(IVessel.vaultToEntry, (vesselTokenId, entries[i])),
                budget - consumed
            );
            consumed += parts[i].length;
            // READ_GAS bounds one read; a source that burns just under it and
            // returns would otherwise keep the loop going for 128 reads.
            if (startGas - gasleft() > SOURCE_READ_GAS) {
                revert ReadBudgetExhausted(startGas - gasleft(), SOURCE_READ_GAS);
            }
        }
        return _join(parts, budget);
    }

    function _relicContent(uint256 vesselTokenId, uint256[] memory entries, uint256 budget)
        internal
        view
        returns (bytes memory)
    {
        // The relics curator can remove a relic, or remove and re-create it
        // with fewer entries. Neither may brick a minted token: a pinned
        // reference that no longer resolves degrades to the vault's OWN
        // entries at the same indices — pinned stays pinned — and only then
        // to holder-controlled live data.
        bool pinned = entries.length != 0;
        bool isRelic = _isRelic(vesselTokenId);

        if (isRelic && pinned) {
            uint256 available = abi.decode(
                _read(address(relics), abi.encodeCall(IRelics.getTokenEntries, (vesselTokenId))),
                (uint256)
            );
            // Relic entries are 1-based; entry 0 underflows inside
            // vaultRelicToEntry and can never be valid.
            bool inRange = true;
            for (uint256 i; i < entries.length; ++i) {
                if (entries[i] == 0 || entries[i] > available) { inRange = false; break; }
            }
            if (inRange && _vaultStatus(vesselTokenId)) {
                bytes[] memory parts = new bytes[](entries.length);
                uint256 consumed;
                uint256 startGas = gasleft();
                for (uint256 i; i < entries.length; ++i) {
                    parts[i] = _read(
                        address(relics),
                        abi.encodeCall(IRelics.vaultRelicToEntry, (vesselTokenId, entries[i])),
                        budget - consumed
                    );
                    consumed += parts[i].length;
                    if (startGas - gasleft() > SOURCE_READ_GAS) {
                        revert ReadBudgetExhausted(startGas - gasleft(), SOURCE_READ_GAS);
                    }
                }
                return _join(parts, budget);
            }
            // Fall through to the vault-entry fallback below.
        } else if (isRelic) {
            return _read(address(relics), abi.encodeCall(IRelics.relicToPayload, (vesselTokenId)), budget);
        }

        if (pinned && _vaultStatus(vesselTokenId)) {
            return _vesselContent(vesselTokenId, _toZeroBased(entries), budget);
        }
        return _read(address(vessel), abi.encodeCall(IVessel.craftToPayload, (vesselTokenId)), budget);
    }

    /// @dev Relic entries are 1-based; vault entries are 0-based. Entry 0 is
    ///      never a valid relic index, so it must not silently become vault
    ///      entry 0 — that would serve real content the artist never named.
    function _toZeroBased(uint256[] memory entries) internal pure returns (uint256[] memory out) {
        out = new uint256[](entries.length);
        for (uint256 i; i < entries.length; ++i) {
            if (entries[i] == 0) revert EntryOutOfRange(0, 0, 0);
            out[i] = entries[i] - 1;
        }
    }

    function _vaultStatus(uint256 vesselTokenId) internal view returns (bool) {
        return abi.decode(
            _read(address(vessel), abi.encodeCall(IVessel.craftToVaultStatus, (vesselTokenId))),
            (bool)
        );
    }

    function _isRelic(uint256 vesselTokenId) internal view returns (bool) {
        return abi.decode(
            _read(address(relics), abi.encodeCall(IRelics.isRelic, (vesselTokenId))),
            (bool)
        );
    }

    /// @dev Every external read goes through here: gas-capped, and the
    ///      response size checked BEFORE it is copied into memory. A
    ///      high-level call would `returndatacopy` a multi-megabyte bomb
    ///      before any `try/catch` could intervene.
    function _read(address target, bytes memory callData) internal view returns (bytes memory) {
        return _read(target, callData, MAX_READ_BYTES);
    }

    /// @dev `maxBytes` is the most this particular read may return. Passing the
    ///      remaining content budget makes an over-budget source fail for the
    ///      price of a rejected staticcall instead of the price of copying and
    ///      concatenating megabytes and only then refusing them — the
    ///      difference between a token that degrades and a token that exceeds
    ///      every RPC's gas cap.
    function _read(address target, bytes memory callData, uint256 maxBytes)
        internal
        view
        returns (bytes memory out)
    {
        // `maxBytes` bounds CONTENT; returndatasize() measures the ABI
        // envelope around it (offset word + length word + padding to 32).
        // Comparing the two directly would refuse legitimately at-budget
        // content, so allow the envelope here and check the unwrapped length
        // afterwards.
        uint256 cap = maxBytes < MAX_READ_BYTES ? maxBytes : MAX_READ_BYTES;
        unchecked { cap += ABI_ENVELOPE; }
        uint256 gasCap = READ_GAS;
        bool ok;
        uint256 size;
        assembly ("memory-safe") {
            ok := staticcall(gasCap, target, add(callData, 0x20), mload(callData), 0, 0)
            size := returndatasize()
        }
        if (!ok || size > cap) revert ReadFailed(target, size);
        out = new bytes(size);
        assembly ("memory-safe") {
            returndatacopy(add(out, 0x20), 0, size)
        }
        out = _unwrap(out);
        if (out.length > maxBytes) revert ContentTooLarge(out.length, maxBytes);
    }

    /// @dev Decodes a single dynamic `bytes`/static word return blob.
    function _unwrap(bytes memory raw) internal pure returns (bytes memory) {
        if (raw.length == 32) return raw; // static return: caller abi.decodes
        if (raw.length < 64) revert MalformedReference();
        uint256 offset;
        uint256 len;
        assembly ("memory-safe") {
            offset := mload(add(raw, 0x20))
            len := mload(add(raw, 0x40))
        }
        // A well-formed dynamic return is head(32) + length(32) + padded data,
        // so 64 + len can never exceed what was actually returned. Reading
        // past it would copy adjacent memory into the render.
        if (offset != 32 || len > raw.length - 64) revert MalformedReference();
        bytes memory out = new bytes(len);
        assembly ("memory-safe") {
            mcopy(add(out, 0x20), add(raw, 0x60), len)
        }
        return out;
    }

    /// @dev Single-pass concatenation: sizes once, copies once, cap enforced.
    function _join(bytes[] memory parts, uint256 budget) internal pure returns (bytes memory out) {
        uint256 total;
        for (uint256 i; i < parts.length; ++i) total += parts[i].length;
        if (total > budget) revert ContentTooLarge(total, budget);
        out = new bytes(total);
        uint256 offset;
        for (uint256 i; i < parts.length; ++i) {
            bytes memory part = parts[i];
            uint256 len = part.length;
            assembly ("memory-safe") {
                mcopy(add(add(out, 0x20), offset), add(part, 0x20), len)
            }
            offset += len;
        }
    }

    /// @dev RFC-2045 `type/subtype`. An unvalidated mime would let the string
    ///      before the base64 payload carry its own `,` and hijack the whole
    ///      data URI with attacker-chosen HTML. Substitute, never revert.
    ///      Base64 output needs no JSON escaping and the mime is validated,
    ///      so `uri()` embeds these strings without an escape pass.
    function _validMime(string memory mime) internal pure returns (string memory) {
        bytes memory b = bytes(mime);
        if (b.length == 0 || b.length > 64) return FALLBACK_MIME;
        uint256 slashes;
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            if (c == "/") { slashes++; continue; }
            bool alnum = (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9");
            // RFC 2045 permits more, but a data URI is still a URI: '#'
            // opens a fragment and silently truncates the payload, and the
            // rest buy nothing worth the risk.
            bool punct = c == "_" || c == "." || c == "+" || c == "-";
            if (!alnum && !punct) return FALLBACK_MIME;
        }
        if (slashes != 1 || b[0] == "/" || b[b.length - 1] == "/") return FALLBACK_MIME;
        return mime;
    }

    function _dataURI(string memory mime, bytes memory content)
        internal
        pure
        returns (string memory)
    {
        return string(abi.encodePacked("data:", _validMime(mime), ";base64,", Base64.encode(content)));
    }

    function _uriFromBytes(INetworkedArt.TokenData memory token, bytes calldata artifact)
        internal
        view
        returns (string memory)
    {
        bool decoded = true;
        Source memory poster;
        Source memory animation;
        try this.decodeArtifact(artifact) returns (Source memory p, Source memory a) {
            poster = p;
            animation = a;
        } catch {
            decoded = false;
        }

        bool broken = !decoded;
        string memory image = "";
        uint256 budget = MAX_CONTENT_BYTES;
        if (decoded && !_absent(poster)) {
            (bool ok, string memory dataURI, uint256 used) = _tryRender(poster, budget);
            if (ok) { image = dataURI; budget -= used; }
            else broken = true;
        }
        bytes memory json = abi.encodePacked(
            '{"name":"', _text(token.name),
            '","description":"', _text(token.description),
            '","image":"', image, '"'
        );
        if (decoded && !_absent(animation)) {
            (bool ok, string memory dataURI, ) = _tryRender(animation, budget);
            if (ok) json = abi.encodePacked(json, ',"animation_url":"', dataURI, '"');
            else broken = true;
        }
        if (broken) json = abi.encodePacked(json, ',"unresolved":true');
        if (decoded && (_mutable(poster) || _mutable(animation))) {
            json = abi.encodePacked(json, ',"mutable":true');
        }
        json = abi.encodePacked(json, "}");
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(json)));
    }

    /// @dev Reassembles the reference bytes from the token's SSTORE2 chunks.
    ///      Sized in one pass, copied in one pass, straight out of code.
    ///
    ///      The code-length check is load-bearing: solady-style SSTORE2 reads
    ///      underflow `extcodesize - 1` on a code-less address and then copy
    ///      ~1.1 TB, consuming the caller's entire gas allowance. These entry
    ///      points take TokenData from the caller, so an EOA pointer is
    ///      reachable by anyone — including via an EIP-7702 delegation that
    ///      appears after a mint.
    function _artifact(INetworkedArt.TokenData memory token)
        internal
        view
        returns (bytes memory out)
    {
        address[] memory pointers = token.artifact;
        uint256 len = pointers.length;
        if (len == 0) return "";
        if (len > MAX_CHUNKS) revert TooManyChunks(len, MAX_CHUNKS);

        uint256 total;
        for (uint256 i; i < len; ++i) {
            uint256 size = pointers[i].code.length;
            if (size == 0) revert EmptyPointer(pointers[i]);
            total += size - 1; // skip the STOP byte SSTORE2 prefixes
        }

        out = new bytes(total);
        uint256 offset;
        for (uint256 i; i < len; ++i) {
            address pointer = pointers[i];
            uint256 size = pointer.code.length - 1;
            assembly ("memory-safe") {
                extcodecopy(pointer, add(add(out, 0x20), offset), 1, size)
            }
            offset += size;
        }
    }
}
