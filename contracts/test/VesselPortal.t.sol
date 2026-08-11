// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Test } from "forge-std/Test.sol";

import { Base64 } from "vendor/Base64.sol";
import { VesselPortal, IVessel, IRelics } from "../src/VesselPortal.sol";
import { INetworkedArt } from "../src/interfaces/INetworkedArt.sol";
import { IRenderer } from "../src/interfaces/IRenderer.sol";

interface IRelicsAdmin {
    function owner() external view returns (address);
    function removeRelic(uint256 tokenId) external;
}

interface INetworkedArtFactory {
    function cloneCollection(string calldata name, string calldata symbol, address expectedAuctions)
        external
        returns (address art, address edition);
    function auctions() external view returns (address);
}

interface IERC721URI {
    function tokenURI(uint256 tokenId) external view returns (string memory);
}

/// Fork tests against mainnet state: the real factory, the real Vessel,
/// the real RGB Carrier bytes (vessel #3348).
contract VesselPortalForkTest is Test {
    address constant FACTORY = 0x0c2705cF48e49Cc896252dd16Dc8c5d31DF753B2;
    address constant VESSEL  = 0xECb92Cc7112b80A2234936315BbB493fb48d1463;
    address constant RELICS  = 0x48cB121Fa84b7C08692e74872D044B15369977CD;
    uint256 constant RGB_CARRIER = 3348;
    uint256 constant CAPSULE_RELIC = 9656; // Manhattan Blocks, non-vault
    uint256 constant VAULT_RELIC = 9778; // Manhattan Blocks, 1 entry

    address artist = makeAddr("artist");

    INetworkedArt art;
    VesselPortal vesselPortal;
    uint256 rendererIndex;

    string constant POSTER = "data:image/png;base64,poster";

    function setUp() public {
        // Live state (vessel holders, the relics curator) can change these
        // fixtures under the suite, so pin when an archive RPC is available:
        //   FORK_BLOCK=25733153 MAINNET_RPC_URL=<archive> forge test
        // Public non-archive endpoints reject historical state, so the pin is
        // opt-in rather than default.
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string("https://ethereum-rpc.publicnode.com"));
        uint256 pinned = vm.envOr("FORK_BLOCK", uint256(0));
        if (pinned == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, pinned);

        INetworkedArtFactory factory = INetworkedArtFactory(FACTORY);
        vm.startPrank(artist);
        (address artAddr, ) = factory.cloneCollection("VesselPortal Test", "PRTHL", factory.auctions());
        art = INetworkedArt(artAddr);

        vesselPortal = new VesselPortal(VESSEL, RELICS);
        rendererIndex = art.registerRenderer(address(vesselPortal));
        vm.stopPrank();
    }

    function _reference(uint256 vesselTokenId, uint256[] memory entries)
        internal
        pure
        returns (bytes[] memory artifact)
    {
        return _referenceFrom(vesselTokenId, entries, 0);
    }

    function _relicReference(uint256 vesselTokenId, uint256[] memory entries)
        internal
        pure
        returns (bytes[] memory artifact)
    {
        return _referenceFrom(vesselTokenId, entries, 1);
    }

    function _referenceFrom(uint256 vesselTokenId, uint256[] memory entries, uint8 source)
        internal
        pure
        returns (bytes[] memory artifact)
    {
        artifact = new bytes[](1);
        artifact[0] = abi.encode(POSTER, "text/html", vesselTokenId, entries, source);
    }

    function _mint(uint256 tokenId, bytes[] memory artifact) internal {
        vm.prank(artist);
        art.mint(INetworkedArt.MintParams({
            tokenId: tokenId,
            artifact: artifact,
            name: "Through the VesselPortal",
            description: "test",
            rendererIndex: uint32(rendererIndex),
            rendererData: 0
        }));
    }

    function test_registersAtIndexTwo() public view {
        assertEq(rendererIndex, 2);
        assertEq(art.rendererAt(2), address(vesselPortal));
    }

    function test_pinnedEntry_matchesDirectVesselRead() public {
        uint256[] memory entries = new uint256[](1);
        entries[0] = 5;
        _mint(1, _reference(RGB_CARRIER, entries));

        bytes memory direct = IVessel(VESSEL).vaultToEntry(RGB_CARRIER, 5);
        assertGt(direct.length, 0);

        string memory expected =
            string(abi.encodePacked("data:text/html;base64,", Base64.encode(direct)));
        INetworkedArt.TokenData memory data = art.tokenData(1);
        assertEq(vesselPortal.animationURI(1, data), expected);
        assertEq(vesselPortal.imageURI(1, data), POSTER);
    }

    function test_multiEntry_concatenatesInOrder() public {
        uint256[] memory entries = new uint256[](2);
        entries[0] = 1;
        entries[1] = 2;
        _mint(1, _reference(RGB_CARRIER, entries));

        bytes memory expectedContent = bytes.concat(
            IVessel(VESSEL).vaultToEntry(RGB_CARRIER, 1),
            IVessel(VESSEL).vaultToEntry(RGB_CARRIER, 2)
        );
        string memory expected =
            string(abi.encodePacked("data:text/html;base64,", Base64.encode(expectedContent)));
        assertEq(vesselPortal.animationURI(1, art.tokenData(1)), expected);
    }

    function test_liveMode_matchesCraftToPayload() public {
        _mint(1, _reference(RGB_CARRIER, new uint256[](0)));

        bytes memory payload = IVessel(VESSEL).craftToPayload(RGB_CARRIER);
        string memory expected =
            string(abi.encodePacked("data:text/html;base64,", Base64.encode(payload)));
        assertEq(vesselPortal.animationURI(1, art.tokenData(1)), expected);
    }

    function test_tokenURI_isBase64JsonWithAnimation() public {
        uint256[] memory entries = new uint256[](1);
        entries[0] = 5;
        _mint(1, _reference(RGB_CARRIER, entries));

        string memory uri = IERC721URI(address(art)).tokenURI(1);
        assertTrue(_startsWith(uri, "data:application/json;base64,"));

        // The exact JSON the AnimationRenderer format prescribes.
        bytes memory direct = IVessel(VESSEL).vaultToEntry(RGB_CARRIER, 5);
        bytes memory json = abi.encodePacked(
            '{"name":"Through the VesselPortal","description":"test","image":"', POSTER,
            '","animation_url":"data:text/html;base64,', Base64.encode(direct), '"}'
        );
        string memory expected =
            string(abi.encodePacked("data:application/json;base64,", Base64.encode(json)));
        assertEq(uri, expected);
    }

    function test_chunkedReference_reassembles() public {
        // A reference split across two SSTORE2 chunks must decode identically.
        uint256[] memory entries = new uint256[](1);
        entries[0] = 5;
        bytes memory ref = abi.encode(POSTER, "text/html", RGB_CARRIER, entries, uint8(0));
        bytes[] memory artifact = new bytes[](2);
        uint256 cut = ref.length / 2;
        artifact[0] = new bytes(cut);
        artifact[1] = new bytes(ref.length - cut);
        for (uint256 i; i < ref.length; ++i) {
            if (i < cut) artifact[0][i] = ref[i];
            else artifact[1][i - cut] = ref[i];
        }
        _mint(1, artifact);

        assertEq(vesselPortal.imageURI(1, art.tokenData(1)), POSTER);
    }

    function test_revert_nonVaultPinned() public {
        // Vessel #1500-range Machine types are not vaults. Find one cheaply:
        // craftToVaultStatus is false for non-vaults; RGB_CARRIER+offset probing
        // is fragile, so use a known Machine from the architecture docs (#9994 is
        // a vault, #2623 is a vault) — instead assert via craftToVaultStatus scan.
        uint256 nonVault = 0;
        for (uint256 id = 1; id <= 20; ++id) {
            if (!IVessel(VESSEL).craftToVaultStatus(id)) { nonVault = id; break; }
        }
        assertGt(nonVault, 0, "no non-vault token found in probe range");

        uint256[] memory entries = new uint256[](1);
        entries[0] = 0;
        _mint(1, _reference(nonVault, entries));

        INetworkedArt.TokenData memory data = art.tokenData(1);
        vm.expectRevert(abi.encodeWithSelector(VesselPortal.NotAVault.selector, nonVault));
        vesselPortal.animationURI(1, data);
    }

    function test_revert_entryOutOfRange() public {
        uint256 count = IVessel(VESSEL).craftToEntry(RGB_CARRIER);
        uint256[] memory entries = new uint256[](1);
        entries[0] = count; // one past the end
        _mint(1, _reference(RGB_CARRIER, entries));

        INetworkedArt.TokenData memory data = art.tokenData(1);
        vm.expectRevert(
            abi.encodeWithSelector(VesselPortal.EntryOutOfRange.selector, RGB_CARRIER, count, count)
        );
        vesselPortal.animationURI(1, data);
    }

    function test_resolve_previewMatchesRender() public {
        uint256[] memory entries = new uint256[](1);
        entries[0] = 5;
        (bytes memory content, string memory animation) =
            vesselPortal.resolve("text/html", RGB_CARRIER, entries, 0);
        assertEq(content, IVessel(VESSEL).vaultToEntry(RGB_CARRIER, 5));

        _mint(1, _reference(RGB_CARRIER, entries));
        assertEq(animation, vesselPortal.animationURI(1, art.tokenData(1)));
    }

    // ── relics ──────────────────────────────────────────────────────────────

    function test_relicLive_matchesRelicToPayload() public {
        _mint(1, _relicReference(CAPSULE_RELIC, new uint256[](0)));

        bytes memory payload = IRelics(RELICS).relicToPayload(CAPSULE_RELIC);
        assertGt(payload.length, 0);
        string memory expected =
            string(abi.encodePacked("data:text/html;base64,", Base64.encode(payload)));
        assertEq(vesselPortal.animationURI(1, art.tokenData(1)), expected);
    }

    function test_relicPinned_matchesVaultRelicToEntry() public {
        uint256[] memory entries = new uint256[](1);
        entries[0] = 1; // relic entries are 1-based
        _mint(1, _relicReference(VAULT_RELIC, entries));

        bytes memory direct = IRelics(RELICS).vaultRelicToEntry(VAULT_RELIC, 1);
        assertGt(direct.length, 0);
        string memory expected =
            string(abi.encodePacked("data:text/html;base64,", Base64.encode(direct)));
        assertEq(vesselPortal.animationURI(1, art.tokenData(1)), expected);
    }

    /// Entry 0 is never a valid relic index (they are 1-based). It falls
    /// through the ladder to the vault's own entries, and vessel #9778 has
    /// none of its own — so the strict path reverts while `uri()` stays
    /// viewable. Both halves matter: tooling sees the error, collectors
    /// keep a token.
    function test_relicPinned_entryZero_degradesNotBricks() public {
        uint256[] memory entries = new uint256[](1);
        entries[0] = 0;
        _mint(1, _relicReference(VAULT_RELIC, entries));
        INetworkedArt.TokenData memory data = art.tokenData(1);

        uint256 vaultEntries = IVessel(VESSEL).craftToEntry(VAULT_RELIC);
        vm.expectRevert(
            abi.encodeWithSelector(VesselPortal.EntryOutOfRange.selector, VAULT_RELIC, 0, vaultEntries)
        );
        vesselPortal.animationURI(1, data);

        string memory json = _decodeJson(IERC721URI(address(art)).tokenURI(1));
        assertTrue(vm.contains(json, '"unresolved":true'), "uri must stay total");
        assertTrue(vm.contains(json, POSTER), "poster survives");
    }

    /// The curator shrinking or re-creating a relic must not brick a token.
    function test_relicPinned_pastEnd_degradesNotBricks() public {
        uint256 available = IRelics(RELICS).getTokenEntries(VAULT_RELIC);
        uint256[] memory entries = new uint256[](1);
        entries[0] = available + 1;
        _mint(1, _relicReference(VAULT_RELIC, entries));

        string memory json = _decodeJson(IERC721URI(address(art)).tokenURI(1));
        assertTrue(vm.contains(json, '"unresolved":true'));
        assertTrue(vm.contains(json, POSTER));
    }

    /// A pinned reference to a non-vault relic can't use relic entries, so it
    /// degrades to the relic's own payload rather than reverting forever.
    function test_relicPinned_nonVault_degradesToPayload() public {
        uint256[] memory entries = new uint256[](1);
        entries[0] = 1;
        _mint(1, _relicReference(CAPSULE_RELIC, entries));

        bytes memory payload = IVessel(VESSEL).craftToPayload(CAPSULE_RELIC);
        string memory expected =
            string(abi.encodePacked("data:text/html;base64,", Base64.encode(payload)));
        assertEq(vesselPortal.animationURI(1, art.tokenData(1)), expected);
    }

    function test_relicRemoved_fallsBackToVessel() public {
        _mint(1, _relicReference(CAPSULE_RELIC, new uint256[](0)));

        vm.prank(IRelicsAdmin(RELICS).owner());
        IRelicsAdmin(RELICS).removeRelic(CAPSULE_RELIC);
        assertFalse(IRelics(RELICS).isRelic(CAPSULE_RELIC));

        // The minted token must keep rendering: vessel resolution takes over.
        bytes memory vesselPayload = IVessel(VESSEL).craftToPayload(CAPSULE_RELIC);
        string memory expected =
            string(abi.encodePacked("data:text/html;base64,", Base64.encode(vesselPayload)));
        assertEq(vesselPortal.animationURI(1, art.tokenData(1)), expected);
    }

    function test_resolve_relicPreviewMatchesRender() public {
        uint256[] memory entries = new uint256[](1);
        entries[0] = 1;
        (bytes memory content, string memory animation) =
            vesselPortal.resolve("text/html", VAULT_RELIC, entries, 1);
        assertEq(content, IRelics(RELICS).vaultRelicToEntry(VAULT_RELIC, 1));

        _mint(1, _relicReference(VAULT_RELIC, entries));
        assertEq(animation, vesselPortal.animationURI(1, art.tokenData(1)));
    }

    function _decodeJson(string memory uri) internal pure returns (string memory) {
        bytes memory b = bytes(uri);
        uint256 comma;
        for (uint256 i; i < b.length; ++i) if (b[i] == ",") { comma = i; break; }
        bytes memory tail = new bytes(b.length - comma - 1);
        for (uint256 i; i < tail.length; ++i) tail[i] = b[comma + 1 + i];
        return string(Base64.decode(string(tail)));
    }

    function _startsWith(string memory s, string memory prefix) internal pure returns (bool) {
        bytes memory sb = bytes(s);
        bytes memory pb = bytes(prefix);
        if (sb.length < pb.length) return false;
        for (uint256 i; i < pb.length; ++i) {
            if (sb[i] != pb[i]) return false;
        }
        return true;
    }
}
