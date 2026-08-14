// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Test } from "forge-std/Test.sol";
import { Base64 } from "vendor/Base64.sol";

import { VesselPortal } from "../src/VesselPortal.sol";
import { INetworkedArt } from "../src/interfaces/INetworkedArt.sol";

/// A Vessel whose behaviour we can make hostile.
contract MockVessel {
    enum Mode { NORMAL, REVERT, BOMB, BURN }
    Mode public mode;
    bool public vaultStatus = true;
    uint256 public entries = 3;
    bytes public payload = "live payload";

    function setMode(Mode m) external { mode = m; }
    function setVaultStatus(bool v) external { vaultStatus = v; }
    function setEntries(uint256 n) external { entries = n; }
    function setPayload(bytes calldata p) external { payload = p; }
    uint256 public entrySize;
    function setSize(uint256 n) external { entrySize = n; }

    function craftToVaultStatus(uint256) external view returns (bool) { return vaultStatus; }
    function craftToEntry(uint256) external view returns (uint256) { return entries; }

    function vaultToEntry(uint256, uint256 entry) external view returns (bytes memory) {
        _attack();
        if (entrySize != 0) return new bytes(entrySize);
        return abi.encodePacked("vault-entry-", bytes1(uint8(48 + entry)));
    }

    function craftToPayload(uint256) external view returns (bytes memory) {
        _attack();
        return payload;
    }

    function _attack() internal view {
        if (mode == Mode.REVERT) revert("hostile machine");
        if (mode == Mode.BOMB) {
            bytes memory huge = new bytes(6_000_000);
            assembly { return(add(huge, 0x20), mload(huge)) }
        }
        if (mode == Mode.BURN) {
            uint256 x;
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

    bytes constant POSTER_BYTES = hex"89504e470d0a1a0a"; // PNG magic; raw, not a data URI
    string constant POSTER_URI = "data:image/png;base64,iVBORw0KGgo=";
    uint256 constant VID = 42;

    function setUp() public {
        vessel = new MockVessel();
        relics = new MockRelics();
        portal = new VesselPortal(address(vessel), address(relics));
    }

    // ── builders ────────────────────────────────────────────────────────────

    function _src(uint8 kind, uint256 tokenId, uint256[] memory entries, string memory mime, bytes memory data)
        internal
        pure
        returns (VesselPortal.Source memory s)
    {
        s.kind = kind;
        s.tokenId = tokenId;
        s.entries = entries;
        s.mime = mime;
        s.data = data;
    }

    function _poster() internal pure returns (VesselPortal.Source memory) {
        return _src(2, 0, new uint256[](0), "image/png", POSTER_BYTES);
    }

    function _none() internal pure returns (VesselPortal.Source memory) {
        return _src(2, 0, new uint256[](0), "", "");
    }

    function _vessel(uint256[] memory entries, string memory mime)
        internal
        pure
        returns (VesselPortal.Source memory)
    {
        return _src(0, VID, entries, mime, "");
    }

    function _relic(uint256[] memory entries, string memory mime)
        internal
        pure
        returns (VesselPortal.Source memory)
    {
        return _src(1, VID, entries, mime, "");
    }

    function _one(uint256 v) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = v;
    }

    function _uri(bytes memory artifact) internal view returns (string memory) {
        INetworkedArt.TokenData memory t;
        t.name = "Test";
        t.description = "d";
        return _json(portal.uriFromArtifact(artifact, t));
    }

    function _json(string memory uri) internal pure returns (string memory) {
        bytes memory b = bytes(uri);
        uint256 comma;
        for (uint256 i; i < b.length; ++i) if (b[i] == ",") { comma = i; break; }
        bytes memory tail = new bytes(b.length - comma - 1);
        for (uint256 i; i < tail.length; ++i) tail[i] = b[comma + 1 + i];
        return string(Base64.decode(string(tail)));
    }

    // ── constructor ─────────────────────────────────────────────────────────

    function test_constructor_rejectsNonContract() public {
        vm.expectRevert(abi.encodeWithSelector(VesselPortal.NotAContract.selector, address(0)));
        new VesselPortal(address(0), address(relics));

        address eoa = makeAddr("eoa");
        vm.expectRevert(abi.encodeWithSelector(VesselPortal.NotAContract.selector, eoa));
        new VesselPortal(address(vessel), eoa);
    }

    // ── uri() is total ──────────────────────────────────────────────────────

    function test_hostileRevert_degradesToPoster() public {
        vessel.setMode(MockVessel.Mode.REVERT);
        string memory json = _uri(abi.encode(_poster(), _vessel(new uint256[](0), "text/html")));
        assertTrue(vm.contains(json, '"unresolved":true'));
        assertTrue(vm.contains(json, POSTER_URI), "inline poster survives a hostile animation");
        assertFalse(vm.contains(json, "animation_url"));
    }

    function test_returndataBomb_refusedNotCopied() public {
        vessel.setMode(MockVessel.Mode.BOMB);
        uint256 before = gasleft();
        string memory json = _uri(abi.encode(_poster(), _vessel(new uint256[](0), "text/html")));
        uint256 used = before - gasleft();
        assertTrue(vm.contains(json, '"unresolved":true'));
        assertLt(used, 5_000_000, "a 6MB bomb must not be copied into memory");
    }

    function test_gasBurn_cappedAndDegrades() public {
        vessel.setMode(MockVessel.Mode.BURN);
        string memory json = _uri(abi.encode(_poster(), _vessel(new uint256[](0), "text/html")));
        assertTrue(vm.contains(json, '"unresolved":true'));
        assertTrue(vm.contains(json, POSTER_URI));
    }

    function test_hostilePoster_degradesIndependently() public {
        vessel.setMode(MockVessel.Mode.REVERT);
        // Poster from the hostile vessel; animation inline and fine.
        string memory json = _uri(abi.encode(
            _vessel(new uint256[](0), "image/png"),
            _src(2, 0, new uint256[](0), "text/html", "<b>hi</b>")
        ));
        assertTrue(vm.contains(json, '"image":""'), "poster degrades to empty");
        assertTrue(vm.contains(json, '"animation_url":"data:text/html;base64,'), "animation unaffected");
        assertTrue(vm.contains(json, '"unresolved":true'));
    }

    function test_malformedArtifact_degrades() public view {
        string memory json = _uri(hex"deadbeef");
        assertTrue(vm.contains(json, '"unresolved":true'));
        assertTrue(vm.contains(json, '"image":""'));
    }

    function test_unknownKind_rejectedAtDecode() public {
        bytes memory bad = abi.encode(_poster(), _src(7, VID, new uint256[](0), "text/html", ""));
        vm.expectRevert(abi.encodeWithSelector(VesselPortal.UnknownKind.selector, uint8(7)));
        portal.decodeArtifact(bad);
        // …and the total path degrades rather than reverting.
        assertTrue(vm.contains(_uri(bad), '"unresolved":true'));
    }

    function test_absentSources_areNotFailures() public view {
        string memory json = _uri(abi.encode(_poster(), _none()));
        assertTrue(vm.contains(json, POSTER_URI));
        assertFalse(vm.contains(json, "animation_url"));
        assertFalse(vm.contains(json, "unresolved"), "absent is not broken");
    }

    // ── mime injection ──────────────────────────────────────────────────────

    function test_mimeInjection_substituted() public view {
        string memory evil = "text/html,<script>alert(document.domain)</script><!--";
        string memory json = _uri(abi.encode(
            _poster(), _src(2, 0, new uint256[](0), evil, "payload")
        ));
        assertFalse(vm.contains(json, "<script>"), "script must not reach the data URI");
        assertTrue(vm.contains(json, "application/octet-stream"));
    }

    function test_mimeInjection_onPosterToo() public view {
        string memory evil = "image/png,<script>x</script><!--";
        string memory json = _uri(abi.encode(
            _src(2, 0, new uint256[](0), evil, "poster"), _none()
        ));
        assertFalse(vm.contains(json, "<script>"));
        assertTrue(vm.contains(json, "application/octet-stream"));
    }

    function test_mimeVariants_rejected() public view {
        string[5] memory bad = [
            "text/html;base64,AAAA", "text/ html", "texthtml", "a/b/c", ""
        ];
        for (uint256 i; i < bad.length; ++i) {
            string memory json = _uri(abi.encode(
                _poster(), _src(2, 0, new uint256[](0), bad[i], "payload")
            ));
            assertTrue(
                vm.contains(json, "data:application/octet-stream;base64,"),
                "invalid mime must be substituted"
            );
        }
    }

    function test_validMimes_preserved() public view {
        string[4] memory good = ["text/html", "image/svg+xml", "audio/mpeg", "application/octet-stream"];
        for (uint256 i; i < good.length; ++i) {
            string memory json = _uri(abi.encode(
                _poster(), _src(2, 0, new uint256[](0), good[i], "payload")
            ));
            assertTrue(vm.contains(json, string(abi.encodePacked("data:", good[i], ";base64,"))));
        }
    }

    // ── amplification bounds, per source ────────────────────────────────────

    function test_tooManyEntries_rejected() public {
        uint256[] memory many = new uint256[](portal.MAX_ENTRIES() + 1);
        VesselPortal.Source memory s = _vessel(many, "text/html");
        vm.expectRevert(
            abi.encodeWithSelector(VesselPortal.TooManyEntries.selector, many.length, portal.MAX_ENTRIES())
        );
        portal.resolveSource(s);
    }

    function test_inlineContentCap() public {
        bytes memory huge = new bytes(portal.MAX_CONTENT_BYTES() + 1);
        VesselPortal.Source memory s = _src(2, 0, new uint256[](0), "text/html", huge);
        vm.expectRevert(
            abi.encodeWithSelector(
                VesselPortal.ContentTooLarge.selector, huge.length, portal.MAX_CONTENT_BYTES()
            )
        );
        portal.resolveSource(s);
    }

    /// Just over budget: the ABI envelope allowance (96 bytes) means this is
    /// copied and then rejected on its unwrapped length. Bounded overshoot.
    function test_livePayloadCap_justOver() public {
        vessel.setPayload(new bytes(portal.MAX_CONTENT_BYTES() + 1));
        VesselPortal.Source memory s = _vessel(new uint256[](0), "text/html");
        vm.expectRevert(
            abi.encodeWithSelector(
                VesselPortal.ContentTooLarge.selector,
                portal.MAX_CONTENT_BYTES() + 1,
                portal.MAX_CONTENT_BYTES()
            )
        );
        portal.resolveSource(s);
    }

    /// Grossly over budget: refused at the read boundary, never copied. This
    /// is the path that keeps a hostile source from making a token cost more
    /// gas than any RPC will spend.
    function test_livePayloadCap_wayOver() public {
        vessel.setPayload(new bytes(portal.MAX_READ_BYTES()));
        VesselPortal.Source memory s = _vessel(new uint256[](0), "text/html");
        uint256 before = gasleft();
        try portal.resolveSource(s) { revert("should have failed"); }
        catch (bytes memory err) {
            assertEq(bytes4(err), VesselPortal.ReadFailed.selector, "refused before the copy");
        }
        assertLt(before - gasleft(), 2_000_000, "refusal must not pay for the payload");
    }

    // ── relic degradation ladder ────────────────────────────────────────────

    function test_relicShrunk_fallsBackToVaultEntries() public {
        relics.setEntries(1);
        (bytes memory content, ) = portal.resolveSource(_relic(_one(3), "text/html"));
        assertEq(string(content), "vault-entry-2", "pinned relic degrades to pinned vault entry");
    }

    function test_relicRemoved_pinnedStaysPinned() public {
        relics.setRelic(false);
        (bytes memory content, ) = portal.resolveSource(_relic(_one(2), "text/html"));
        assertEq(string(content), "vault-entry-1");
    }

    function test_relicRemoved_liveFallsBackToPayload() public {
        relics.setRelic(false);
        (bytes memory content, ) = portal.resolveSource(_relic(new uint256[](0), "text/html"));
        assertEq(string(content), "live payload");
    }

    function test_relicPinned_nonVault_degradesToPayload() public {
        vessel.setVaultStatus(false);
        (bytes memory content, ) = portal.resolveSource(_relic(_one(1), "text/html"));
        assertEq(string(content), "live payload");
    }

    // ── preview ─────────────────────────────────────────────────────────────

    function test_previewURI_reportsCost() public view {
        bytes memory ref = abi.encode(_poster(), _vessel(_one(1), "text/html"));
        INetworkedArt.TokenData memory t;
        t.name = "Test";
        (string memory metadata, uint256 gasUsed, bool unresolved) = portal.previewURI(ref, t);
        assertGt(gasUsed, 0);
        assertFalse(unresolved, "a healthy artifact must not preview as broken");
        assertTrue(vm.contains(_json(metadata), "animation_url"));
    }

    function test_resolveArtifact_catchesEncodingMistakes() public {
        vm.expectRevert(VesselPortal.MalformedReference.selector);
        portal.resolveArtifact(hex"c0ffee");
    }

    function test_imageURI_totalOnEmptyArtifact() public view {
        INetworkedArt.TokenData memory t;
        assertEq(portal.imageURI(1, t), "");
    }

    // ── audit fixes ─────────────────────────────────────────────────────────

    /// The budget argument is the amplification limiter for the whole
    /// contract; an open endpoint taking it measured 28.5 BILLION gas.
    function test_selfCallHelpers_areGated() public {
        VesselPortal.Source memory s = _vessel(_one(1), "text/html");
        vm.expectRevert(VesselPortal.NotSelf.selector);
        portal.renderForTotal(s, type(uint256).max);

        INetworkedArt.TokenData memory t;
        vm.expectRevert(VesselPortal.NotSelf.selector);
        portal.decodeArtifactFromToken(t);
    }

    /// Over-budget sources must be refused as reads arrive, not after all of
    /// them have been paid for and copied.
    function test_overBudgetSource_refusedCheaply() public {
        vessel.setSize(portal.MAX_READ_BYTES()); // 256 KB per entry
        vessel.setEntries(64);
        uint256[] memory many = new uint256[](64);
        for (uint256 i; i < 64; ++i) many[i] = i;

        uint256 before = gasleft();
        try portal.resolveSource(_vessel(many, "text/html")) { revert("should have failed"); }
        catch { }
        uint256 used = before - gasleft();
        // Before the fix this materialised up to 16 MB to enforce a 128 KB cap.
        assertLt(used, 10_000_000, "rejection must be cheap, not quadratic");
    }

    function test_crossFieldValidation() public {
        // dead `data` on a reference source is carried through every frame
        VesselPortal.Source memory bad = _src(0, VID, new uint256[](0), "text/html", "dead weight");
        vm.expectRevert(VesselPortal.MalformedReference.selector);
        portal.decodeArtifact(abi.encode(_poster(), bad));

        // entries on an inline source are meaningless
        VesselPortal.Source memory bad2 = _src(2, 0, _one(1), "text/html", "x");
        vm.expectRevert(VesselPortal.MalformedReference.selector);
        portal.decodeArtifact(abi.encode(_poster(), bad2));
    }

    function test_emptyContent_isAFailureNotAHealthyBlank() public {
        vessel.setPayload("");
        string memory json = _uri(abi.encode(_poster(), _vessel(new uint256[](0), "text/html")));
        assertTrue(vm.contains(json, '"unresolved":true'), "empty must not read as healthy");
        assertFalse(vm.contains(json, '"animation_url":"data:text/html;base64,"'));
    }

    function test_mutableMarker() public view {
        // live vessel payload → mutable
        assertTrue(vm.contains(
            _uri(abi.encode(_poster(), _vessel(new uint256[](0), "text/html"))), '"mutable":true'
        ));
        // relic source → mutable even when pinned (curator can editRelic)
        assertTrue(vm.contains(
            _uri(abi.encode(_poster(), _relic(_one(1), "text/html"))), '"mutable":true'
        ));
        // pinned vault entries + inline poster → immutable, no marker
        assertFalse(vm.contains(
            _uri(abi.encode(_poster(), _vessel(_one(1), "text/html"))), "mutable"
        ));
    }

    function test_mimeHash_rejected() public view {
        // '#' opens a URI fragment and silently truncates the payload
        string memory json = _uri(abi.encode(
            _poster(), _src(2, 0, new uint256[](0), "text/html#x", "payload")
        ));
        assertTrue(vm.contains(json, "data:application/octet-stream;base64,"));
    }

    function test_longNameTruncated() public view {
        bytes memory huge = new bytes(64 * 1024);
        for (uint256 i; i < huge.length; ++i) huge[i] = 0x01; // 6x escape expansion
        INetworkedArt.TokenData memory t;
        t.name = string(huge);
        uint256 before = gasleft();
        portal.uriFromArtifact(abi.encode(_poster(), _none()), t);
        uint256 used = before - gasleft();
        assertLt(used, 5_000_000, "an unbounded title is its own denial of render");
    }

    function test_selfTest() public view {
        assertTrue(portal.selfTest(VID));
    }
}
