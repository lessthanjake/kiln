// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Base64 } from "vendor/Base64.sol";
import { LibString } from "vendor/LibString.sol";
import { SSTORE2 } from "vendor/SSTORE2.sol";

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

///           ○
///          ( )
///           ○
///
/// @title  VesselPortal
/// @notice A networked.art renderer that looks into The Vessel's hold.
///
///         A token rendered through VesselPortal stores no artwork of its own.
///         Its artifact is a small reference, decoded as
///         `(string image, string mime, uint256 vesselTokenId, uint256[] entries, uint8 source)`.
///
///         Source 0 — THE VESSEL:
///         - `entries` non-empty: the pinned view. Each index is a 0-based
///           vault entry; their bytes are concatenated in order. Vault entries
///           are append-only on an immutable contract and the type permutation
///           is seed-locked, so a pinned token's content cannot be changed by
///           anyone, including the Vessel's owner.
///         - `entries` empty: the live view — `craftToPayload` right now.
///           WARNING: this follows the vessel HOLDER's chosen entry, machine
///           delegation, and relic overrides. The holder need not be the
///           collector of this token; they can change what it displays.
///
///         Source 1 — RELICS (curated overrides; audio, images, text):
///         - `entries` non-empty: pinned relic entries, **1-based** as the
///           Relics contract counts them, vault-relics only. Relic bytes stay
///           curator-editable: this pins the index, not the content.
///         - `entries` empty: `relicToPayload`.
///
///         DEGRADATION LADDER. `uri()` never reverts. If a reference cannot be
///         resolved — malformed artifact, unknown source, hostile or oversized
///         external data, a curator shrinking a relic — the token renders as
///         its poster image alone, with `"unresolved":true` in the metadata.
///         A minted token can therefore never become unviewable, whatever
///         third parties do afterwards. `imageURI` is likewise total.
///         `animationURI` and `resolve*` stay strict, so tooling still fails
///         loudly at mint time.
///
/// @dev    Immutable, ownerless, stateless. All entry points are `view`.
contract VesselPortal is IRenderer {
    uint8 public constant SOURCE_VESSEL = 0;
    uint8 public constant SOURCE_RELICS = 1;

    /// @notice Most entries one reference may concatenate. Bounds the
    ///         quadratic cost of assembling a render.
    uint256 public constant MAX_ENTRIES = 64;

    /// @notice Most SSTORE2 chunks one artifact may span. A reference is a
    ///         few hundred bytes, so this is generous; without it a hostile
    ///         caller could pass an unbounded pointer array.
    uint256 public constant MAX_CHUNKS = 32;

    /// @notice Ceiling on bytes accepted from one external read. Larger
    ///         responses are refused rather than copied, so a hostile data
    ///         source cannot exhaust an RPC's gas with a returndata bomb.
    uint256 public constant MAX_READ_BYTES = 256 * 1024;

    /// @notice Ceiling on assembled content. Measured: `uri()` costs ~43.8M
    ///         gas at this size, inside geth's default 50M `eth_call` cap,
    ///         which most clients match or undercut. Beyond it a token would
    ///         render nowhere — so oversized references resolve to the poster
    ///         instead, and stay viewable. Kiln warns long before this.
    uint256 public constant MAX_CONTENT_BYTES = 192 * 1024;

    /// @notice Gas forwarded to each external data read. Storage-only reads
    ///         on the Vessel cost well under 1M even for a full 10 KB entry;
    ///         the generous headroom covers legitimate machine computation.
    ///         The looped reads target immutable storage getters, so only the
    ///         single unlooped payload read can reach delegated code — which
    ///         bounds a hostile source's total burn at one READ_GAS.
    uint256 public constant READ_GAS = 3_000_000;

    /// @notice Substituted when a reference's mime is not a valid RFC-2045
    ///         token. Never revert on it: that would brick the token.
    string public constant FALLBACK_MIME = "application/octet-stream";

    IVessel public immutable vessel;
    IRelics public immutable relics;

    /// @notice A required address had no code.
    error NotAContract(address target);
    /// @notice Pinned references require a Vault-type token.
    error NotAVault(uint256 vesselTokenId);
    /// @notice A pinned entry index is outside the source's entry range.
    error EntryOutOfRange(uint256 vesselTokenId, uint256 entry, uint256 count);
    /// @notice The reference names a source this renderer does not know.
    error UnknownSource(uint8 source);
    /// @notice More entries than MAX_ENTRIES were requested.
    error TooManyEntries(uint256 requested, uint256 max);
    /// @notice An external read failed, or returned more than MAX_READ_BYTES.
    error ReadFailed(address target, uint256 returnedBytes);
    /// @notice The artifact bytes are not a valid reference encoding.
    error MalformedReference();
    /// @notice An artifact chunk pointer holds no code.
    error EmptyPointer(address pointer);
    /// @notice More artifact chunks than MAX_CHUNKS.
    error TooManyChunks(uint256 requested, uint256 max);
    /// @notice Assembled content exceeds what clients can render.
    error ContentTooLarge(uint256 size, uint256 max);

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

    // ───────────────────────────── Entry points ───────────────────────────

    /// @inheritdoc IRenderer
    /// @dev Total: never reverts. Falls back to poster-only metadata.
    function uri(uint256, INetworkedArt.TokenData calldata token)
        external
        view
        returns (string memory)
    {
        (bool ok, string memory image, string memory mime, bytes memory content) = _tryResolve(token);

        bytes memory json = abi.encodePacked(
            '{"name":"', LibString.escapeJSON(token.name),
            '","description":"', LibString.escapeJSON(token.description),
            '","image":"', LibString.escapeJSON(image), '"'
        );
        if (ok) {
            // Base64 output needs no JSON escaping, and `mime` is validated,
            // so the animation URI is assembled inline — half the memory of
            // building the string and escaping it separately.
            json = abi.encodePacked(
                json, ',"animation_url":"data:', mime, ';base64,', Base64.encode(content), '"}'
            );
        } else {
            json = abi.encodePacked(json, ',"unresolved":true}');
        }
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(json)));
    }

    /// @inheritdoc IRenderer
    /// @dev Total: never reverts. Returns "" if the reference is malformed.
    function imageURI(uint256, INetworkedArt.TokenData calldata token)
        external
        view
        returns (string memory)
    {
        try this.decodeArtifact(_artifact(token)) returns (
            string memory image, string memory, uint256, uint256[] memory, uint8
        ) {
            return image;
        } catch {
            return "";
        }
    }

    /// @inheritdoc IRenderer
    /// @dev Strict: reverts with a typed error so tooling sees the reason.
    function animationURI(uint256, INetworkedArt.TokenData calldata token)
        external
        view
        returns (string memory)
    {
        (string memory image, string memory mime, uint256 vesselTokenId, uint256[] memory entries, uint8 source)
            = this.decodeArtifact(_artifact(token));
        image; // silence unused
        return _animationDataURI(_validMime(mime), _content(vesselTokenId, entries, source));
    }

    // ───────────────────────────── Preview helpers ────────────────────────

    /// @notice The bytes and animation URI a reference resolves to right now.
    ///         Strict, so a minting interface fails loudly before signing.
    function resolve(string calldata mime, uint256 vesselTokenId, uint256[] calldata entries, uint8 source)
        external
        view
        returns (bytes memory content, string memory animation)
    {
        content = _content(vesselTokenId, entries, source);
        animation = _animationDataURI(_validMime(mime), content);
    }

    /// @notice Resolve straight from candidate artifact bytes — the exact
    ///         path a mint takes, including decoding. Call this with the
    ///         bytes you are about to write to catch encoding mistakes.
    function resolveArtifact(bytes calldata artifact)
        external
        view
        returns (bytes memory content, string memory animation)
    {
        (, string memory mime, uint256 vesselTokenId, uint256[] memory entries, uint8 source)
            = this.decodeArtifact(artifact);
        content = _content(vesselTokenId, entries, source);
        animation = _animationDataURI(_validMime(mime), content);
    }

    /// @notice The full metadata a token would carry, and its gas cost, so a
    ///         minting interface can warn before a piece grows too large for
    ///         wallets and marketplaces to render (many cap eth_call at 50M).
    function previewURI(bytes calldata artifact)
        external
        view
        returns (string memory metadata, uint256 gasUsed)
    {
        INetworkedArt.TokenData memory token;
        token.name = "preview";
        token.description = "";
        uint256 start = gasleft();
        metadata = this.uriFromArtifact(artifact, token);
        gasUsed = start - gasleft();
    }

    /// @notice `uri()` against supplied bytes rather than a minted token.
    function uriFromArtifact(bytes calldata artifact, INetworkedArt.TokenData calldata token)
        external
        view
        returns (string memory)
    {
        INetworkedArt.TokenData memory t = token;
        address[] memory none = new address[](0);
        t.artifact = none;
        return _uriFrom(t, artifact);
    }

    /// @notice Decode a reference. External so callers (and this contract's
    ///         own total entry points) can catch malformed encodings.
    function decodeArtifact(bytes calldata artifact)
        external
        pure
        returns (string memory image, string memory mime, uint256 vesselTokenId, uint256[] memory entries, uint8 source)
    {
        // A valid encoding is at least five head words; decoding shorter
        // bytes panics without a reason.
        if (artifact.length < 160) revert MalformedReference();
        (image, mime, vesselTokenId, entries, source) =
            abi.decode(artifact, (string, string, uint256, uint256[], uint8));
        if (entries.length > MAX_ENTRIES) revert TooManyEntries(entries.length, MAX_ENTRIES);
    }

    /// @notice Renders a known-good reference end to end. A collection owner
    ///         can call this before `registerRenderer` to confirm the
    ///         deployment is wired to live, working data sources.
    function selfTest(uint256 vesselTokenId) external view returns (bool) {
        bytes memory payload = _read(
            address(vessel),
            abi.encodeCall(IVessel.craftToPayload, (vesselTokenId))
        );
        return payload.length > 0;
    }

    // ───────────────────────────── Internals ──────────────────────────────

    function _uriFrom(INetworkedArt.TokenData memory token, bytes memory artifact)
        internal
        view
        returns (string memory)
    {
        INetworkedArt.TokenData memory t = token;
        (bool ok, string memory image, string memory mime, bytes memory content) = _tryResolveBytes(artifact);
        bytes memory json = abi.encodePacked(
            '{"name":"', LibString.escapeJSON(t.name),
            '","description":"', LibString.escapeJSON(t.description),
            '","image":"', LibString.escapeJSON(image), '"'
        );
        json = ok
            ? abi.encodePacked(json, ',"animation_url":"data:', mime, ';base64,', Base64.encode(content), '"}')
            : abi.encodePacked(json, ',"unresolved":true}');
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(json)));
    }

    function _tryResolve(INetworkedArt.TokenData calldata token)
        internal
        view
        returns (bool ok, string memory image, string memory mime, bytes memory content)
    {
        return _tryResolveBytes(_artifact(token));
    }

    /// @dev The whole resolution, made total by routing through an external
    ///      self-call. Any failure — decode, source, external read — leaves
    ///      `ok` false with whatever poster survived decoding.
    function _tryResolveBytes(bytes memory artifact)
        internal
        view
        returns (bool ok, string memory image, string memory mime, bytes memory content)
    {
        try this.resolveForRender(artifact) returns (
            string memory image_, string memory mime_, bytes memory content_
        ) {
            return (true, image_, mime_, content_);
        } catch {
            // Recover the poster alone if it is decodable, so a broken data
            // source still leaves a viewable token.
            try this.decodeArtifact(artifact) returns (
                string memory image_, string memory, uint256, uint256[] memory, uint8
            ) {
                return (false, image_, "", "");
            } catch {
                return (false, "", "", "");
            }
        }
    }

    /// @notice Strict resolution used internally by the total entry points.
    ///         External only so it can be `try`-called; not meant for callers.
    function resolveForRender(bytes calldata artifact)
        external
        view
        returns (string memory image, string memory mime, bytes memory content)
    {
        uint256[] memory entries;
        uint256 vesselTokenId;
        uint8 source;
        (image, mime, vesselTokenId, entries, source) = this.decodeArtifact(artifact);
        mime = _validMime(mime);
        content = _content(vesselTokenId, entries, source);
    }

    function _content(uint256 vesselTokenId, uint256[] memory entries, uint8 source)
        internal
        view
        returns (bytes memory)
    {
        if (entries.length > MAX_ENTRIES) revert TooManyEntries(entries.length, MAX_ENTRIES);
        if (source == SOURCE_VESSEL) return _vesselContent(vesselTokenId, entries);
        if (source == SOURCE_RELICS) return _relicContent(vesselTokenId, entries);
        revert UnknownSource(source);
    }

    function _vesselContent(uint256 vesselTokenId, uint256[] memory entries)
        internal
        view
        returns (bytes memory)
    {
        if (entries.length == 0) {
            return _read(address(vessel), abi.encodeCall(IVessel.craftToPayload, (vesselTokenId)));
        }
        if (!_vaultStatus(vesselTokenId)) revert NotAVault(vesselTokenId);
        uint256 available = abi.decode(
            _read(address(vessel), abi.encodeCall(IVessel.craftToEntry, (vesselTokenId))),
            (uint256)
        );
        bytes[] memory parts = new bytes[](entries.length);
        for (uint256 i; i < entries.length; ++i) {
            if (entries[i] >= available) {
                revert EntryOutOfRange(vesselTokenId, entries[i], available);
            }
            parts[i] = _read(
                address(vessel),
                abi.encodeCall(IVessel.vaultToEntry, (vesselTokenId, entries[i]))
            );
        }
        return _join(parts);
    }

    function _relicContent(uint256 vesselTokenId, uint256[] memory entries)
        internal
        view
        returns (bytes memory)
    {
        // The relics curator can remove a relic, or remove and re-create it
        // with fewer entries. Neither may brick a minted token, so a pinned
        // reference that no longer resolves degrades to the vault's OWN
        // entries at the same indices — keeping a pinned token pinned rather
        // than silently demoting it to holder-controlled live data.
        bool pinned = entries.length != 0;
        bool isRelic = _isRelic(vesselTokenId);

        if (isRelic && pinned) {
            uint256 available = abi.decode(
                _read(address(relics), abi.encodeCall(IRelics.getTokenEntries, (vesselTokenId))),
                (uint256)
            );
            // Relic entries are 1-based; entry 0 underflows inside
            // vaultRelicToEntry, so it can never be valid.
            bool inRange = true;
            for (uint256 i; i < entries.length; ++i) {
                if (entries[i] == 0 || entries[i] > available) { inRange = false; break; }
            }
            if (inRange && _vaultStatus(vesselTokenId)) {
                bytes[] memory parts = new bytes[](entries.length);
                for (uint256 i; i < entries.length; ++i) {
                    parts[i] = _read(
                        address(relics),
                        abi.encodeCall(IRelics.vaultRelicToEntry, (vesselTokenId, entries[i]))
                    );
                }
                return _join(parts);
            }
            // Fall through to the vault-entry fallback below.
        } else if (isRelic) {
            return _read(address(relics), abi.encodeCall(IRelics.relicToPayload, (vesselTokenId)));
        }

        if (pinned && _vaultStatus(vesselTokenId)) {
            return _vesselContent(vesselTokenId, _toZeroBased(entries));
        }
        return _read(address(vessel), abi.encodeCall(IVessel.craftToPayload, (vesselTokenId)));
    }

    /// @dev Relic entries are 1-based; vault entries are 0-based.
    function _toZeroBased(uint256[] memory entries) internal pure returns (uint256[] memory out) {
        out = new uint256[](entries.length);
        for (uint256 i; i < entries.length; ++i) {
            out[i] = entries[i] == 0 ? 0 : entries[i] - 1;
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
    ///      response size is checked BEFORE it is copied into memory. A
    ///      high-level call would `returndatacopy` a multi-megabyte bomb
    ///      before any `try/catch` could intervene.
    function _read(address target, bytes memory callData) internal view returns (bytes memory out) {
        uint256 cap = MAX_READ_BYTES;
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
        // Strip the ABI head so callers receive the bytes/word itself.
        out = _unwrap(out);
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
            let src := add(raw, 0x60)
            let dst := add(out, 0x20)
            mcopy(dst, src, len)
        }
        return out;
    }

    /// @dev Single-pass concatenation: sizes once, copies once. `bytes.concat`
    ///      in a loop reallocates every iteration — quadratic in total bytes.
    function _join(bytes[] memory parts) internal pure returns (bytes memory out) {
        uint256 total;
        for (uint256 i; i < parts.length; ++i) total += parts[i].length;
        if (total > MAX_CONTENT_BYTES) revert ContentTooLarge(total, MAX_CONTENT_BYTES);
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
    function _validMime(string memory mime) internal pure returns (string memory) {
        bytes memory b = bytes(mime);
        if (b.length == 0 || b.length > 64) return FALLBACK_MIME;
        uint256 slashes;
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            if (c == "/") { slashes++; continue; }
            bool alnum = (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9");
            // RFC 2045 token characters, minus those with meaning in a data URI.
            bool punct = c == "!" || c == "#" || c == "$" || c == "&" || c == "^"
                || c == "_" || c == "." || c == "+" || c == "-";
            if (!alnum && !punct) return FALLBACK_MIME;
        }
        if (slashes != 1 || b[0] == "/" || b[b.length - 1] == "/") return FALLBACK_MIME;
        return mime;
    }

    function _animationDataURI(string memory mime, bytes memory content)
        internal
        pure
        returns (string memory)
    {
        return string(abi.encodePacked("data:", mime, ";base64,", Base64.encode(content)));
    }

    /// @dev Reassembles the reference bytes from the token's SSTORE2 chunks.
    ///      Sized in one pass, copied in one pass, straight out of code.
    ///
    ///      The code-length check is load-bearing, not defensive: solady's
    ///      SSTORE2.read underflows `extcodesize - 1` to ~2^40 on a code-less
    ///      address and then extcodecopies ~1.1 TB, consuming the caller's
    ///      entire gas allowance rather than reverting. These entry points
    ///      take TokenData from the caller, so an EOA pointer is reachable by
    ///      anyone — including via an EIP-7702 delegation that appears after
    ///      a mint. This converts that into a 3k-gas typed revert.
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
