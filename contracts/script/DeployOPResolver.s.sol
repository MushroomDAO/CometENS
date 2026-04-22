// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/OPResolver.sol";

/// @notice Deploys OPResolver.
///
/// Required environment variables:
///   DEPLOYER_ADDRESS  — tx sender / contract owner
///   SIGNER_ADDRESS    — initial gateway signer (used in signature mode)
///   GATEWAY_URL       — CCIP-Read gateway URL template
///
/// Optional:
///   VERIFY_PROOFS     — set to "true" to start in proof mode (default: false)
contract DeployOPResolver is Script {
    function run() external {
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        address signerAddr = vm.envAddress("SIGNER_ADDRESS");
        string memory gatewayUrl = vm.envString("GATEWAY_URL");

        // Default to signature mode; C2 will flip this once proof verification
        // is implemented.
        bool verifyProofs = false;
        try vm.envBool("VERIFY_PROOFS") returns (bool v) {
            verifyProofs = v;
        } catch {}

        address[] memory initialSigners = new address[](1);
        initialSigners[0] = signerAddr;

        vm.startBroadcast();

        OPResolver resolver = new OPResolver(deployer, initialSigners, gatewayUrl, verifyProofs);

        vm.stopBroadcast();

        console.log("OPResolver deployed at:", address(resolver));
        console.log("Owner:        ", resolver.owner());
        console.log("IsSigner:     ", resolver.signers(signerAddr));
        console.log("Gateway:      ", resolver.gatewayUrl());
        console.log("VerifyProofs: ", resolver.verifyProofs());
    }
}
