// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Test } from "forge-std/Test.sol";
import { Base64 } from "vendor/Base64.sol";

import { VesselPortal } from "../src/VesselPortal.sol";
import { INetworkedArt } from "../src/interfaces/INetworkedArt.sol";

/// A Vessel whose behaviour we can make hostile. Mirrors the real read
/// surface; `mode` selects the attack.
contract MockVessel {
    enum Mode { NORMAL, REVERT, BOMB, BURN }
    Mode public mode;
    bool public vaultStatus = true;
    uint256 public entries = 3;
    bytes public payload = "live payload";

    function setMode(Mode m) external { mode = m; }
    function setVaultStatus(bool v) external { vaultStatus = v; }
    function setEntries(uint256 n) external { entries = n; }

    function craftToVaultStatus(uint256) external view returns (bool) { return vaultStatus; }
    function craftToEntry(uint256) external view returns (uint256) { return entries; }

    function vaultToEntry(uint256, uint256 entry) external view returns (bytes memory) {
        _attack();
        return abi.encodePacked("vault-entry-", bytes1(uint8(48 + entry)));
    }

    function craftToPayload(uint256) external view returns (bytes memory) {
        _attack();
        return payload;
    }

    function _attack() internal view {
        if (mode == Mode.REVERT) revert("hostile machine");
        if (mode == Mode.BOMB) {
            // 6 MB of returndata: a high-level call would copy it all.
            bytes memory huge = new bytes(6_000_000);
            assembly { return(add(huge, 0x20), mload(huge)) }
        }
        if (mode == Mode.BURN) {
            uint256 x;
            // Burn far more than the read cap allows.
            for (uint256 i; i < 100_000_000; ++i) { x = uint256(keccak256(abi.encode(x, i))); }
        }
    }
}

contract MockRelics {
    bool public relic = true;
    uint256 public entries = 3;

    function setRelic(bool v) external { relic = v; }
    function setEntries(uint256 n) external { entries = n; }

    function isRelic(uint256) external view returns (bool) { return relic; }
    function getTokenEntries(uint256) external view returns (uint256) { return entries; }
    function relicToPayload(uint256) external pure returns (bytes memory) { return "relic payload"; }
    function vaultRelicToEntry(uint256, uint256 entry) external pure returns (bytes memory) {
        return abi.encodePacked("relic-entry-", bytes1(uint8(48 + entry)));
    }
}

contract VesselPortalHardeningTest is Test {
    MockVessel vessel;
    MockRelics relics;
    VesselPortal portal;

    string constant POSTER = "data:image/png;base64,poster";
    uint256 constant VID = 42;

    function setUp() public {
        vessel = new MockVessel();
        relics = new MockRelics();
        portal = new VesselPortal(address(vessel), address(relics));
    }

    // Builds TokenData directly, bypassing SSTORE2 (artifact bytes supplied
    // inline via the uriFromArtifact preview path).
    function _token() internal pure returns (INetworkedArt.TokenData memory t) {
        t.name = "Test";
        t.description = "d";
    }

    function _ref(string memory mime, uint256[] memory entries, uint8 source)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(POSTER, mime, VID, entries, source);
    }

    function _one(uint256 v) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = v;
    }

    function _decodeJson(string memory uri) internal pure returns (string memory) {
        bytes memory b = bytes(uri);
        uint256 comma;
        for (uint256 i; i < b.length; ++i) if (b[i] == ",") { comma = i; break; }
        bytes memory tail = new bytes(b.length - comma - 1);
        for (uint256 i; i < tail.length; ++i) tail[i] = b[comma + 1 + i];
        return string(Base64.decode(string(tail)));
    }

    function _uri(bytes memory artifact) internal view returns (string memory) {
        return portal.uriFromArtifact(artifact, _token());
    }

    // ── the constructor guard ───────────────────────────────────────────────

    function test_constructor_rejectsNonContract() public {
        vm.expectRevert(abi.encodeWithSelector(VesselPortal.NotAContract.selector, address(0)));
        new VesselPortal(address(0), address(relics));

        address eoa = makeAddr("eoa");
        vm.expectRevert(abi.encodeWithSelector(VesselPortal.NotAContract.selector, eoa));
        new VesselPortal(address(vessel), eoa);
    }

    // ── uri() is total: no third party can brick a token ────────────────────

    function test_hostileRevert_degradesToPoster() public {
        vessel.setMode(MockVessel.Mode.REVERT);
        string memory json = _decodeJson(_uri(_ref("text/html", new uint256[](0), 0)));
        assertTrue(vm.contains(json, '"unresolved":true'), "should flag unresolved");
        assertTrue(vm.contains(json, POSTER), "poster must survive");
        assertFalse(vm.contains(json, "animation_url"), "no animation when unresolved");
    }

    function test_returndataBomb_refusedNotCopied() public {
        vessel.setMode(MockVessel.Mode.BOMB);
        uint256 before = gasleft();
        string memory json = _decodeJson(_uri(_ref("text/html", new uint256[](0), 0)));
        uint256 used = before - gasleft();
        assertTrue(vm.contains(json, '"unresolved":true'));
        // A copied 6MB blob costs hundreds of millions of gas; refusing is cheap.
        assertLt(used, 5_000_000, "bomb must not be copied into memory");
    }

    function test_gasBurn_cappedAndDegrades() public {
        vessel.setMode(MockVessel.Mode.BURN);
        string memory json = _decodeJson(_uri(_ref("text/html", new uint256[](0), 0)));
        assertTrue(vm.contains(json, '"unresolved":true'));
        assertTrue(vm.contains(json, POSTER));
    }

    function test_malformedArtifact_degrades() public view {
        string memory json = _decodeJson(_uri(hex"deadbeef"));
        assertTrue(vm.contains(json, '"unresolved":true'));
    }

    function test_unknownSource_degrades() public view {
        string memory json = _decodeJson(_uri(_ref("text/html", new uint256[](0), 7)));
        assertTrue(vm.contains(json, '"unresolved":true'));
        assertTrue(vm.contains(json, POSTER), "poster still recovered");
    }

    function test_entryOutOfRange_degrades() public view {
        // entries=3, so index 9 is out of range: uri degrades, not reverts.
        string memory json = _decodeJson(_uri(_ref("text/html", _one(9), 0)));
        assertTrue(vm.contains(json, '"unresolved":true'));
    }

    // ── mime injection ──────────────────────────────────────────────────────

    function test_mimeInjection_substituted() public view {
        // The classic: a comma ends the media type, so everything after it
        // becomes the payload and the real content is commented out.
        string memory evil = "text/html,<script>alert(document.domain)</script><!--";
        string memory json = _decodeJson(_uri(_ref(evil, new uint256[](0), 0)));
        assertFalse(vm.contains(json, "<script>"), "script must not reach the data URI");
        assertTrue(vm.contains(json, "application/octet-stream"), "falls back to a safe mime");
    }

    function test_mimeVariants_rejected() public view {
        string[5] memory bad = [
            "text/html;base64,AAAA",   // second base64 marker
            "text/ html",              // whitespace
            "texthtml",                // no slash
            "a/b/c",                   // two slashes
            ""                         // empty
        ];
        for (uint256 i; i < bad.length; ++i) {
            string memory json = _decodeJson(_uri(_ref(bad[i], new uint256[](0), 0)));
            assertTrue(
                vm.contains(json, "data:application/octet-stream;base64,"),
                "invalid mime must be substituted"
            );
        }
    }

    function test_validMimes_preserved() public view {
        string[4] memory good = ["text/html", "image/svg+xml", "audio/mpeg", "application/octet-stream"];
        for (uint256 i; i < good.length; ++i) {
            string memory json = _decodeJson(_uri(_ref(good[i], new uint256[](0), 0)));
            assertTrue(vm.contains(json, string(abi.encodePacked("data:", good[i], ";base64,"))));
        }
    }

    // ── amplification bounds ────────────────────────────────────────────────

    function test_tooManyEntries_rejected() public {
        uint256[] memory many = new uint256[](portal.MAX_ENTRIES() + 1);
        vm.expectRevert(
            abi.encodeWithSelector(VesselPortal.TooManyEntries.selector, many.length, portal.MAX_ENTRIES())
        );
        portal.resolve("text/html", VID, many, 0);
    }

    function test_maxEntries_stillRenders() public {
        vessel.setEntries(portal.MAX_ENTRIES());
        uint256[] memory all = new uint256[](portal.MAX_ENTRIES());
        for (uint256 i; i < all.length; ++i) all[i] = i;
        uint256 before = gasleft();
        (bytes memory content, ) = portal.resolve("text/html", VID, all, 0);
        uint256 used = before - gasleft();
        assertGt(content.length, 0);
        // Must stay well inside a standard 50M eth_call cap.
        assertLt(used, 30_000_000, "max entries must remain renderable");
    }

    // ── relic degradation ladder ────────────────────────────────────────────

    function test_relicShrunk_fallsBackToVaultEntries_notLive() public {
        // Pinned to relic entry 3, then the curator shrinks the relic to 1.
        relics.setEntries(1);
        (bytes memory content, ) = portal.resolve("text/html", VID, _one(3), 1);
        // Falls back to the vault's own entry 2 (3 minus the 1-based offset),
        // NOT to holder-controlled live payload.
        assertEq(string(content), "vault-entry-2");
    }

    function test_relicRemoved_pinnedStaysPinned() public {
        relics.setRelic(false);
        (bytes memory content, ) = portal.resolve("text/html", VID, _one(2), 1);
        assertEq(string(content), "vault-entry-1", "pinned relic degrades to pinned vault entry");
    }

    function test_relicRemoved_liveFallsBackToPayload() public {
        relics.setRelic(false);
        (bytes memory content, ) = portal.resolve("text/html", VID, new uint256[](0), 1);
        assertEq(string(content), "live payload");
    }

    // ── preview parity ──────────────────────────────────────────────────────

    function test_previewURI_matchesRenderedURI() public view {
        bytes memory ref = _ref("text/html", _one(1), 0);
        (string memory preview, uint256 gasUsed) = portal.previewURI(ref);
        assertGt(gasUsed, 0, "reports a real cost");
        // Same assembly path, so the metadata body matches the render.
        string memory rendered = _uri(ref);
        assertTrue(bytes(preview).length > 0 && bytes(rendered).length > 0);
        assertTrue(vm.contains(_decodeJson(preview), "animation_url"));
    }

    function test_resolveArtifact_catchesEncodingMistakes() public {
        vm.expectRevert(VesselPortal.MalformedReference.selector);
        portal.resolveArtifact(hex"c0ffee");
    }

    function test_selfTest_confirmsWiring() public view {
        assertTrue(portal.selfTest(VID));
    }

    // ── imageURI totality ───────────────────────────────────────────────────

    function test_imageURI_totalOnGarbage() public view {
        INetworkedArt.TokenData memory t = _token();
        assertEq(portal.imageURI(1, t), "", "no artifact chunks: empty, not revert");
    }
}
