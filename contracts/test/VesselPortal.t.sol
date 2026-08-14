// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Test } from "forge-std/Test.sol";

import { Base64 } from "vendor/Base64.sol";
import { VesselPortal, IVessel, IRelics } from "../src/VesselPortal.sol";
import { INetworkedArt } from "../src/interfaces/INetworkedArt.sol";
import { IRenderer } from "../src/interfaces/IRenderer.sol";

interface INetworkedArtFactory {
    function cloneCollection(string calldata name, string calldata symbol, address expectedAuctions)
        external
        returns (address art, address edition);
    function auctions() external view returns (address);
}

interface IERC721URI {
    function tokenURI(uint256 tokenId) external view returns (string memory);
}

interface IRelicsAdmin {
    function owner() external view returns (address);
    function removeRelic(uint256 tokenId) external;
}

/// Fork tests against mainnet state: the real factory, the real Vessel, the
/// real Relics contract, and real artwork bytes.
contract VesselPortalForkTest is Test {
    address constant FACTORY = 0x0c2705cF48e49Cc896252dd16Dc8c5d31DF753B2;
    address constant VESSEL  = 0xECb92Cc7112b80A2234936315BbB493fb48d1463;
    address constant RELICS  = 0x48cB121Fa84b7C08692e74872D044B15369977CD;

    // Public on-chain fixtures held by several different collectors, chosen
    // for the shapes they exercise rather than for who owns them. Any vault
    // with enough entries substitutes; nothing here is special to the
    // renderer.
    uint256 constant VAULT         = 2623; // 156 entries, ~2.6 KB each
    uint256 constant MULTI_VAULT   = 8615; // 7 entries, ~8.6 KB each
    uint256 constant SHARDED       = 9994; // 41 entries; 32-38 are one HTML document
    uint256 constant CAPSULE_RELIC = 9656; // curated relic (unclaimed), non-vault
    uint256 constant VAULT_RELIC   = 9778; // curated relic (unclaimed) on a vault

    address artist = makeAddr("artist");

    INetworkedArt art;
    VesselPortal portal;
    uint256 rendererIndex;

    string constant POSTER = "data:image/png;base64,cG9zdGVy";

    function setUp() public {
        // Live state (vessel holders, the relics curator) can change these
        // fixtures under the suite, so pin when an archive RPC is available:
        //   FORK_BLOCK=25733153 MAINNET_RPC_URL=<archive> forge test
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string("https://ethereum-rpc.publicnode.com"));
        uint256 pinned = vm.envOr("FORK_BLOCK", uint256(0));
        if (pinned == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, pinned);

        INetworkedArtFactory factory = INetworkedArtFactory(FACTORY);
        vm.startPrank(artist);
        (address artAddr, ) = factory.cloneCollection("Portal Test", "PRTL", factory.auctions());
        art = INetworkedArt(artAddr);
        portal = new VesselPortal(VESSEL, RELICS);
        rendererIndex = art.registerRenderer(address(portal));
        vm.stopPrank();
    }

    // ── source builders ─────────────────────────────────────────────────────

    function _inline(string memory mime, bytes memory data)
        internal
        pure
        returns (VesselPortal.Source memory s)
    {
        s.kind = 2;
        s.mime = mime;
        s.data = data;
        s.entries = new uint256[](0);
    }

    /// The absent source: inline with no bytes.
    function _none() internal pure returns (VesselPortal.Source memory s) {
        return _inline("", "");
    }

    function _inlinePoster() internal pure returns (VesselPortal.Source memory) {
        return _inline("image/png", bytes(POSTER));
    }

    function _vesselSource(uint256 tokenId, uint256[] memory entries, string memory mime)
        internal
        pure
        returns (VesselPortal.Source memory s)
    {
        s.kind = 0;
        s.tokenId = tokenId;
        s.entries = entries;
        s.mime = mime;
    }

    function _relicSource(uint256 tokenId, uint256[] memory entries, string memory mime)
        internal
        pure
        returns (VesselPortal.Source memory s)
    {
        s.kind = 1;
        s.tokenId = tokenId;
        s.entries = entries;
        s.mime = mime;
    }

    function _one(uint256 v) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = v;
    }

    function _artifact(VesselPortal.Source memory poster, VesselPortal.Source memory animation)
        internal
        pure
        returns (bytes[] memory chunks)
    {
        chunks = new bytes[](1);
        chunks[0] = abi.encode(poster, animation);
    }

    function _mint(uint256 tokenId, bytes[] memory chunks) internal {
        vm.prank(artist);
        art.mint(INetworkedArt.MintParams({
            tokenId: tokenId,
            artifact: chunks,
            name: "Through the Portal",
            description: "test",
            rendererIndex: uint32(rendererIndex),
            rendererData: 0
        }));
    }

    function _json(string memory uri) internal pure returns (string memory) {
        bytes memory b = bytes(uri);
        uint256 comma;
        for (uint256 i; i < b.length; ++i) if (b[i] == ",") { comma = i; break; }
        bytes memory tail = new bytes(b.length - comma - 1);
        for (uint256 i; i < tail.length; ++i) tail[i] = b[comma + 1 + i];
        return string(Base64.decode(string(tail)));
    }

    function _expectedURI(string memory mime, bytes memory content)
        internal
        pure
        returns (string memory)
    {
        return string(abi.encodePacked("data:", mime, ";base64,", Base64.encode(content)));
    }

    // ── registration ────────────────────────────────────────────────────────

    function test_registersAtIndexTwo() public view {
        assertEq(rendererIndex, 2);
        assertEq(art.rendererAt(2), address(portal));
        assertEq(portal.name(), "VesselPortal");
    }

    function test_supportsInterface() public view {
        assertTrue(portal.supportsInterface(type(IRenderer).interfaceId));
        assertTrue(portal.supportsInterface(0x01ffc9a7)); // ERC-165
        assertFalse(portal.supportsInterface(0xffffffff));
    }

    // ── the point of this version: a poster held on the Vessel ──────────────

    function test_posterFromVaultEntry_neverStoresTheImage() public {
        // #9994 entry 40 is a 9,994-byte SVG already on-chain.
        VesselPortal.Source memory poster = _vesselSource(SHARDED, _one(40), "image/svg+xml");
        VesselPortal.Source memory anim = _vesselSource(VAULT, _one(5), "text/html");
        bytes[] memory chunks = _artifact(poster, anim);

        // The whole artifact is a reference — far smaller than the artwork.
        assertLt(chunks[0].length, 1024, "referenced mint must stay tiny");
        _mint(1, chunks);

        bytes memory posterBytes = IVessel(VESSEL).vaultToEntry(SHARDED, 40);
        assertGt(posterBytes.length, 9_000);
        assertEq(
            portal.imageURI(1, art.tokenData(1)),
            _expectedURI("image/svg+xml", posterBytes),
            "poster resolves from the vault"
        );
    }

    function test_bothSourcesReferenced_artifactIsFlat() public {
        uint256[] memory doc = new uint256[](7);
        for (uint256 i; i < 7; ++i) doc[i] = 32 + i; // one HTML document, sharded
        bytes memory ref = abi.encode(
            _vesselSource(SHARDED, _one(40), "image/svg+xml"),
            _vesselSource(SHARDED, doc, "text/html")
        );
        // 65 KB of artwork + 10 KB of poster, referenced in well under 1 KB.
        assertLt(ref.length, 1024);
    }

    // ── inline poster (what v1 did) still works ─────────────────────────────

    function test_inlinePoster_withVesselAnimation() public {
        _mint(1, _artifact(_inlinePoster(), _vesselSource(VAULT, _one(5), "text/html")));

        bytes memory direct = IVessel(VESSEL).vaultToEntry(VAULT, 5);
        INetworkedArt.TokenData memory data = art.tokenData(1);
        assertEq(portal.imageURI(1, data), _expectedURI("image/png", bytes(POSTER)));
        assertEq(portal.animationURI(1, data), _expectedURI("text/html", direct));
    }

    function test_tokenURI_shape() public {
        _mint(1, _artifact(_inlinePoster(), _vesselSource(VAULT, _one(5), "text/html")));

        string memory uri = IERC721URI(address(art)).tokenURI(1);
        assertTrue(vm.contains(uri, "data:application/json;base64,"));
        string memory json = _json(uri);
        assertTrue(vm.contains(json, '"name":"Through the Portal"'));
        assertTrue(vm.contains(json, '"image":"data:image/png;base64,'));
        assertTrue(vm.contains(json, '"animation_url":"data:text/html;base64,'));
        assertFalse(vm.contains(json, "unresolved"));
    }

    function test_imageOnlyToken_omitsAnimation() public {
        _mint(1, _artifact(_vesselSource(SHARDED, _one(40), "image/svg+xml"), _none()));

        string memory json = _json(IERC721URI(address(art)).tokenURI(1));
        assertTrue(vm.contains(json, '"image":"data:image/svg+xml;base64,'));
        assertFalse(vm.contains(json, "animation_url"), "absent animation is omitted");
        assertFalse(vm.contains(json, "unresolved"), "absent is not broken");
        assertEq(portal.animationURI(1, art.tokenData(1)), "");
    }

    // ── vessel sources ──────────────────────────────────────────────────────

    function test_pinnedEntry_matchesDirectRead() public {
        _mint(1, _artifact(_inlinePoster(), _vesselSource(VAULT, _one(5), "text/html")));
        assertEq(
            portal.animationURI(1, art.tokenData(1)),
            _expectedURI("text/html", IVessel(VESSEL).vaultToEntry(VAULT, 5))
        );
    }

    function test_multiEntry_concatenatesInSelectionOrder() public {
        uint256[] memory entries = new uint256[](2);
        entries[0] = 5;
        entries[1] = 2; // deliberately not ascending
        _mint(1, _artifact(_inlinePoster(), _vesselSource(VAULT, entries, "text/html")));

        bytes memory expected = bytes.concat(
            IVessel(VESSEL).vaultToEntry(VAULT, 5),
            IVessel(VESSEL).vaultToEntry(VAULT, 2)
        );
        assertEq(portal.animationURI(1, art.tokenData(1)), _expectedURI("text/html", expected));
    }

    function test_shardedDocument_reassembles() public {
        uint256[] memory doc = new uint256[](7);
        for (uint256 i; i < 7; ++i) doc[i] = 32 + i;
        _mint(1, _artifact(_inlinePoster(), _vesselSource(SHARDED, doc, "text/html")));

        bytes memory expected;
        for (uint256 i; i < 7; ++i) {
            expected = bytes.concat(expected, IVessel(VESSEL).vaultToEntry(SHARDED, 32 + i));
        }
        assertEq(expected.length, 65_105, "the real document size");
        assertEq(portal.animationURI(1, art.tokenData(1)), _expectedURI("text/html", expected));
    }

    function test_liveMode_matchesCraftToPayload() public {
        uint256[] memory none = new uint256[](0);
        _mint(1, _artifact(_inlinePoster(), _vesselSource(VAULT, none, "text/html")));
        assertEq(
            portal.animationURI(1, art.tokenData(1)),
            _expectedURI("text/html", IVessel(VESSEL).craftToPayload(VAULT))
        );
    }

    function test_chunkedArtifact_reassembles() public {
        bytes memory ref = abi.encode(
            _inlinePoster(),
            _vesselSource(VAULT, _one(5), "text/html")
        );
        bytes[] memory chunks = new bytes[](2);
        uint256 cut = ref.length / 2;
        chunks[0] = new bytes(cut);
        chunks[1] = new bytes(ref.length - cut);
        for (uint256 i; i < ref.length; ++i) {
            if (i < cut) chunks[0][i] = ref[i];
            else chunks[1][i - cut] = ref[i];
        }
        _mint(1, chunks);
        assertEq(portal.imageURI(1, art.tokenData(1)), _expectedURI("image/png", bytes(POSTER)));
    }

    // ── relic sources ───────────────────────────────────────────────────────

    function test_relicLive_matchesRelicToPayload() public {
        uint256[] memory none = new uint256[](0);
        _mint(1, _artifact(_inlinePoster(), _relicSource(CAPSULE_RELIC, none, "text/html")));
        assertEq(
            portal.animationURI(1, art.tokenData(1)),
            _expectedURI("text/html", IRelics(RELICS).relicToPayload(CAPSULE_RELIC))
        );
    }

    function test_relicPinned_matchesVaultRelicToEntry() public {
        _mint(1, _artifact(_inlinePoster(), _relicSource(VAULT_RELIC, _one(1), "text/html")));
        assertEq(
            portal.animationURI(1, art.tokenData(1)),
            _expectedURI("text/html", IRelics(RELICS).vaultRelicToEntry(VAULT_RELIC, 1))
        );
    }

    function test_relicRemoved_keepsRendering() public {
        uint256[] memory none = new uint256[](0);
        _mint(1, _artifact(_inlinePoster(), _relicSource(CAPSULE_RELIC, none, "text/html")));

        vm.prank(IRelicsAdmin(RELICS).owner());
        IRelicsAdmin(RELICS).removeRelic(CAPSULE_RELIC);
        assertFalse(IRelics(RELICS).isRelic(CAPSULE_RELIC));

        assertEq(
            portal.animationURI(1, art.tokenData(1)),
            _expectedURI("text/html", IVessel(VESSEL).craftToPayload(CAPSULE_RELIC)),
            "a curator cannot brick a minted token"
        );
    }

    function test_relicPinned_outOfRange_degradesNotBricks() public {
        uint256 available = IRelics(RELICS).getTokenEntries(VAULT_RELIC);
        _mint(1, _artifact(_inlinePoster(), _relicSource(VAULT_RELIC, _one(available + 1), "text/html")));

        string memory json = _json(IERC721URI(address(art)).tokenURI(1));
        assertTrue(vm.contains(json, '"unresolved":true'));
        // The poster is independent of the broken animation.
        assertTrue(vm.contains(json, '"image":"data:image/png;base64,'), "poster survives");
        assertFalse(vm.contains(json, "animation_url"));
    }

    // ── independent degradation ─────────────────────────────────────────────

    function test_brokenPoster_keepsGoodAnimation() public {
        // A pinned vessel entry that does not exist.
        uint256 count = IVessel(VESSEL).craftToEntry(VAULT);
        _mint(1, _artifact(
            _vesselSource(VAULT, _one(count + 5), "image/png"),
            _vesselSource(VAULT, _one(5), "text/html")
        ));

        string memory json = _json(IERC721URI(address(art)).tokenURI(1));
        assertTrue(vm.contains(json, '"image":""'), "poster degrades to empty");
        assertTrue(vm.contains(json, '"animation_url":"data:text/html;base64,'), "animation unaffected");
        assertTrue(vm.contains(json, '"unresolved":true'));
        assertEq(portal.imageURI(1, art.tokenData(1)), "", "imageURI stays total");
    }

    function test_strictPathStillReverts() public {
        uint256 count = IVessel(VESSEL).craftToEntry(VAULT);
        _mint(1, _artifact(_inlinePoster(), _vesselSource(VAULT, _one(count), "text/html")));

        INetworkedArt.TokenData memory data = art.tokenData(1);
        vm.expectRevert(
            abi.encodeWithSelector(VesselPortal.EntryOutOfRange.selector, VAULT, count, count)
        );
        portal.animationURI(1, data);
    }

    // ── preview parity ──────────────────────────────────────────────────────

    function test_resolveArtifact_matchesRender() public {
        bytes memory ref = abi.encode(
            _vesselSource(SHARDED, _one(40), "image/svg+xml"),
            _vesselSource(VAULT, _one(5), "text/html")
        );
        (string memory image, string memory animation) = portal.resolveArtifact(ref);

        bytes[] memory chunks = new bytes[](1);
        chunks[0] = ref;
        _mint(1, chunks);
        INetworkedArt.TokenData memory data = art.tokenData(1);
        assertEq(image, portal.imageURI(1, data));
        assertEq(animation, portal.animationURI(1, data));
    }

    function test_selfTest() public view {
        assertTrue(portal.selfTest(VAULT));
    }
}
