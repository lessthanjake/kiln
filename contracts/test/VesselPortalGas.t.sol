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

    function _uriGas(uint256 contentSize) internal returns (uint256) {
        vessel.setSize(contentSize);
        INetworkedArt.TokenData memory t;
        t.name = "n";
        t.description = "d";
        bytes memory ref = abi.encode("data:image/png;base64,p", "text/html", uint256(1), new uint256[](0), uint8(0));
        uint256 before = gasleft();
        portal.uriFromArtifact(ref, t);
        return before - gasleft();
    }

    function test_gasProfile_documentsTheCeiling() public {
        uint256[6] memory sizes = [uint256(8_192), 16_384, 32_768, 65_536, 131_072, 196_608];
        console.log("content bytes -> uri() gas");
        uint256 largestUnderCap;
        for (uint256 i; i < sizes.length; ++i) {
            uint256 g = _uriGas(sizes[i]);
            console.log(sizes[i], g);
            if (g < RPC_GAS_CAP) largestUnderCap = sizes[i];
        }
        console.log("largest size under the 50M cap:", largestUnderCap);
        // The documented safe ceiling must hold. Kiln warns above it.
        assertGe(largestUnderCap, 65_536, "64KB must render within a standard RPC cap");
    }

    function test_worstLegalCase_isRefusedNotUnrenderable() public {
        // MAX_ENTRIES x a full vault slot would cost ~113M gas — renderable
        // nowhere. The content cap refuses it instead, so the token falls
        // back to its poster and stays viewable everywhere.
        vessel.setSize(10_000);
        uint256[] memory entries = new uint256[](portal.MAX_ENTRIES());
        for (uint256 i; i < entries.length; ++i) entries[i] = i;
        vm.expectRevert(
            abi.encodeWithSelector(
                VesselPortal.ContentTooLarge.selector, uint256(640_000), portal.MAX_CONTENT_BYTES()
            )
        );
        portal.resolve("text/html", 1, entries, 0);
    }

    function test_atTheCap_stillRendersUnderRpcLimit() public {
        // Exactly at the documented ceiling, assembled from many entries.
        uint256 per = portal.MAX_CONTENT_BYTES() / 16;
        vessel.setSize(per);
        uint256[] memory entries = new uint256[](16);
        for (uint256 i; i < entries.length; ++i) entries[i] = i;
        uint256 before = gasleft();
        (bytes memory content, ) = portal.resolve("text/html", 1, entries, 0);
        uint256 used = before - gasleft();
        console.log("content at cap:", content.length, "resolve gas:", used);
        assertEq(content.length, portal.MAX_CONTENT_BYTES());
        assertLt(used, RPC_GAS_CAP, "content at the cap must resolve inside an RPC budget");
    }
}
