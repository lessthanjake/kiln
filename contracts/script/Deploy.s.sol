// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { Script, console } from "forge-std/Script.sol";
import { VesselPortal } from "../src/VesselPortal.sol";

/// Deploys VesselPortal against mainnet's Vessel. Registration on a collection
/// is a separate, owner-signed call (Kiln offers it in-app):
///   collection.registerRenderer(<deployed address>)
///
/// Usage:
///   forge script script/Deploy.s.sol --rpc-url $MAINNET_RPC_URL \
///     --ledger|--interactive --broadcast
contract Deploy is Script {
    address constant VESSEL = 0xECb92Cc7112b80A2234936315BbB493fb48d1463;
    address constant RELICS = 0x48cB121Fa84b7C08692e74872D044B15369977CD;

    function run() external {
        vm.startBroadcast();
        VesselPortal vesselPortal = new VesselPortal(VESSEL, RELICS);
        vm.stopBroadcast();
        console.log("VesselPortal deployed:", address(vesselPortal));
    }
}
