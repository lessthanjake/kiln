// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;
import { Test, console } from "forge-std/Test.sol";
import { VesselPortal } from "../src/VesselPortal.sol";
import { INetworkedArt } from "../src/interfaces/INetworkedArt.sol";

contract BigVessel {
    uint256 public size = 256 * 1024;
    function craftToVaultStatus(uint256) external pure returns (bool) { return true; }
    function craftToEntry(uint256) external pure returns (uint256) { return 64; }
    function vaultToEntry(uint256, uint256) external view returns (bytes memory) { return new bytes(size); }
    function craftToPayload(uint256) external view returns (bytes memory) { return new bytes(size); }
}
contract StubRelics {
    function isRelic(uint256) external pure returns (bool) { return false; }
    function getTokenEntries(uint256) external pure returns (uint256) { return 0; }
    function relicToPayload(uint256) external pure returns (bytes memory) { return ""; }
    function vaultRelicToEntry(uint256, uint256) external pure returns (bytes memory) { return ""; }
}

/// Regression guards for the two most severe pre-deployment audit findings.
/// Both were measured in the billions of gas before the fixes; if either of
/// these ever gets cheap to exploit again, this suite fails.
/// contract. Both must now fail cheaply.
contract VerifyAuditFixes is Test {
    BigVessel vessel; VesselPortal portal;
    function setUp() public {
        vessel = new BigVessel();
        portal = new VesselPortal(address(vessel), address(new StubRelics()));
    }

    /// Audit 2 F1: 28.5 BILLION gas / 22 MB return from one permissionless call.
    function test_F1_unboundedBudgetAttack_isDead() public {
        uint256[] memory many = new uint256[](64);
        for (uint256 i; i < 64; ++i) many[i] = i;
        VesselPortal.Source memory s;
        s.kind = 0; s.tokenId = 1; s.entries = many; s.mime = "text/html";
        uint256 before = gasleft();
        vm.expectRevert(VesselPortal.NotSelf.selector);
        portal.renderForTotal(s, type(uint256).max);
        console.log("F1 attack now costs", before - gasleft(), "gas and returns nothing");
    }

    /// Audit 1 #1 / Audit 2 F2: 64 x 256KB materialised to enforce a 128KB cap
    /// (2.2 BILLION gas measured before the fix).
    function test_F2_quadraticRejection_isDead() public {
        uint256[] memory many = new uint256[](64);
        for (uint256 i; i < 64; ++i) many[i] = i;
        VesselPortal.Source memory s;
        s.kind = 0; s.tokenId = 1; s.entries = many; s.mime = "text/html";
        uint256 before = gasleft();
        try portal.resolveSource(s) { revert("should have failed"); } catch { }
        uint256 used = before - gasleft();
        console.log("F2 rejection now costs", used, "gas (was 2,198,380,752)");
        assertLt(used, 5_000_000);
    }

    /// And uri() must still be total under that same attack.
    function test_uriStaysTotal_underAttack() public view {
        uint256[] memory many = new uint256[](64);
        for (uint256 i; i < 64; ++i) many[i] = i;
        VesselPortal.Source memory poster;
        poster.kind = 2; poster.mime = "image/png"; poster.data = hex"89504e47"; poster.entries = new uint256[](0);
        VesselPortal.Source memory anim;
        anim.kind = 0; anim.tokenId = 1; anim.entries = many; anim.mime = "text/html";
        INetworkedArt.TokenData memory t; t.name = "x";
        string memory uri = portal.uriFromArtifact(abi.encode(poster, anim), t);
        assertGt(bytes(uri).length, 0, "uri must still return");
    }
}
