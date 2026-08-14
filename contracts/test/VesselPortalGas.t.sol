// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Test, console } from "forge-std/Test.sol";
import { VesselPortal } from "../src/VesselPortal.sol";
import { INetworkedArt } from "../src/interfaces/INetworkedArt.sol";

contract SizedVessel {
    uint256 public size;
    function setSize(uint256 n) external { size = n; }
    function craftToVaultStatus(uint256) external pure returns (bool) { return true; }
    function craftToEntry(uint256) external pure returns (uint256) { return 64; }
    function vaultToEntry(uint256, uint256) external view returns (bytes memory) {
        return new bytes(size);
    }
    function craftToPayload(uint256) external view returns (bytes memory) {
        return new bytes(size);
    }
}

contract StubRelics {
    function isRelic(uint256) external pure returns (bool) { return false; }
    function getTokenEntries(uint256) external pure returns (uint256) { return 0; }
    function relicToPayload(uint256) external pure returns (bytes memory) { return ""; }
    function vaultRelicToEntry(uint256, uint256) external pure returns (bytes memory) { return ""; }
}

/// The renderer must stay inside the gas ceilings real clients impose.
/// geth's default --rpc.gascap is 50,000,000 and most managed RPCs sit at or
/// under it; a token that costs more renders nowhere, permanently.
contract VesselPortalGasTest is Test {
    uint256 constant RPC_GAS_CAP = 50_000_000;

    SizedVessel vessel;
    VesselPortal portal;

    function setUp() public {
        vessel = new SizedVessel();
        portal = new VesselPortal(address(vessel), address(new StubRelics()));
    }

    function _src(uint8 kind, uint256[] memory entries, string memory mime, bytes memory data)
        internal
        pure
        returns (VesselPortal.Source memory s)
    {
        s.kind = kind;
        s.tokenId = 1;
        s.entries = entries;
        s.mime = mime;
        s.data = data;
    }

    /// Image-only-style artifact: absent poster, one live-payload animation.
    /// Profiling with an absent poster isolates the animation curve; the two
    /// sources' interaction is covered by test_twoLargeSources_shareOneBudget.
    function _artifact(uint256[] memory entries) internal pure returns (bytes memory) {
        return abi.encode(
            _src(2, new uint256[](0), "", ""),
            _src(0, entries, "text/html", "")
        );
    }

    function _uriGas(uint256 contentSize) internal returns (uint256) {
        vessel.setSize(contentSize);
        INetworkedArt.TokenData memory t;
        t.name = "n";
        t.description = "d";
        bytes memory ref = _artifact(new uint256[](0));
        uint256 before = gasleft();
        portal.uriFromArtifact(ref, t);
        return before - gasleft();
    }

    function test_gasProfile_documentsTheCeiling() public {
        uint256[5] memory sizes = [uint256(8_192), 16_384, 32_768, 65_536, 131_072];
        console.log("content bytes -> uri() gas");
        uint256 largestUnderCap;
        for (uint256 i; i < sizes.length; ++i) {
            uint256 g = _uriGas(sizes[i]);
            console.log(sizes[i], g);
            if (g < RPC_GAS_CAP) largestUnderCap = sizes[i];
        }
        console.log("largest size under the 50M cap:", largestUnderCap);
        // The documented ceiling must hold. Note the effective animation
        // ceiling is MAX_CONTENT_BYTES minus whatever the poster consumes —
        // Kiln warns on the sum, not per source.
        assertEq(largestUnderCap, portal.MAX_CONTENT_BYTES(), "the full budget must render under the cap");
    }

    /// MAX_ENTRIES x a full vault slot is far past the budget. It must be
    /// refused as the reads arrive — cheaply — not after 640 KB has been
    /// materialised to enforce a 128 KB limit.
    function test_worstLegalCase_isRefusedCheaply() public {
        vessel.setSize(10_000);
        uint256[] memory entries = new uint256[](portal.MAX_ENTRIES());
        for (uint256 i; i < entries.length; ++i) entries[i] = i;
        uint256 before = gasleft();
        try portal.resolveSource(_src(0, entries, "text/html", "")) { revert("should have failed"); }
        catch { }
        uint256 used = before - gasleft();
        console.log("64 x 10KB refused in", used, "gas");
        assertLt(used, 5_000_000, "refusal must be cheap");
    }

    /// Two individually-legal sources must not add up to a token that renders
    /// nowhere: the budget is shared, so the second one degrades instead.
    function test_twoLargeSources_shareOneBudget() public {
        vessel.setSize(portal.MAX_CONTENT_BYTES()); // poster eats the whole budget
        INetworkedArt.TokenData memory t;
        t.name = "n";
        bytes memory ref = abi.encode(
            _src(0, new uint256[](0), "image/png", ""),
            _src(0, new uint256[](0), "text/html", "")
        );
        uint256 before = gasleft();
        string memory uri = portal.uriFromArtifact(ref, t);
        uint256 used = before - gasleft();
        console.log("poster at full budget, animation squeezed:", used, "gas");
        assertLt(used, RPC_GAS_CAP, "one token must stay inside an RPC budget");
        assertGt(bytes(uri).length, 0);
    }

    function test_atTheCap_stillRendersUnderRpcLimit() public {
        // Exactly at the documented ceiling, assembled from many entries.
        // Each read is capped at the REMAINING budget, so size them to fit.
        uint256 per = portal.MAX_CONTENT_BYTES() / 16;
        vessel.setSize(per);
        uint256[] memory entries = new uint256[](16);
        for (uint256 i; i < entries.length; ++i) entries[i] = i;
        uint256 before = gasleft();
        (bytes memory content, ) = portal.resolveSource(_src(0, entries, "text/html", ""));
        uint256 used = before - gasleft();
        console.log("content at cap:", content.length, "resolve gas:", used);
        assertEq(content.length, portal.MAX_CONTENT_BYTES());
        assertLt(used, RPC_GAS_CAP, "content at the cap must resolve inside an RPC budget");
    }
}
