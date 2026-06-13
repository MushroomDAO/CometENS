// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.23;

import "forge-std/Script.sol";
import "../src/OPResolver.sol";
import {OPFaultVerifier} from "@unruggable/contracts/op/OPFaultVerifier.sol";
import {OPFaultGameFinder} from "@unruggable/contracts/op/OPFaultGameFinder.sol";
import {EthVerifierHooks} from "@unruggable/contracts/eth/EthVerifierHooks.sol";
import {OPFaultParams, IAnchorStateRegistry, IOPFaultGameFinder} from "@unruggable/contracts/op/OPInterfaces.sol";
import {IGatewayVerifier} from "@unruggable/contracts/IGatewayVerifier.sol";
import {IVerifierHooks} from "@unruggable/contracts/IVerifierHooks.sol";

/// @notice Deploys OPResolver with OPFaultVerifier + OPFaultGameFinder (C3).
///
/// Required environment variables:
///   DEPLOYER_ADDRESS       — tx sender / contract owner
///   GATEWAY_URL            — CCIP-Read gateway URL (https://cometens-gateway.*.workers.dev/{sender}/{data})
///   L2_RECORDS_ADDRESS     — L2RecordsV3 contract on OP (e.g. 0x...)
///   ANCHOR_STATE_REGISTRY  — OP Stack AnchorStateRegistry on L1 Sepolia
///                            OP Sepolia: 0x218CD9489199F321E1177b56385d333c7876e1d3
///
/// Optional:
///   MIN_AGE_SEC            — Minimum age (seconds) for finalized dispute game (default: 0 for testnet)
///   WINDOW_SEC             — How far back gateway state can be (default: 86400 = 1 day)
contract DeployOPResolver is Script {
    function run() external {
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        string memory gatewayUrl = vm.envString("GATEWAY_URL");
        address l2RecordsAddr = vm.envAddress("L2_RECORDS_ADDRESS");
        address asrAddr = vm.envAddress("ANCHOR_STATE_REGISTRY");

        uint256 minAgeSec = 0;
        try vm.envUint("MIN_AGE_SEC") returns (uint256 v) { minAgeSec = v; } catch {}
        uint256 windowSec = 86_400;
        try vm.envUint("WINDOW_SEC") returns (uint256 v) { windowSec = v; } catch {}

        vm.startBroadcast();

        // 1. Deploy EthVerifierHooks (Ethereum MPT proof verification)
        EthVerifierHooks hooks = new EthVerifierHooks();

        // 2. Deploy OPFaultGameFinder (finds latest resolved FaultDisputeGame)
        OPFaultGameFinder gameFinder = new OPFaultGameFinder();

        // 3. Build OPFaultParams (no proposer whitelist on testnet)
        uint256[] memory allowedGameTypes = new uint256[](0); // accept all game types
        address[] memory allowedProposers = new address[](0); // no proposer restriction

        OPFaultParams memory params = OPFaultParams({
            asr: IAnchorStateRegistry(asrAddr),
            minAgeSec: minAgeSec,
            allowedGameTypes: allowedGameTypes,
            allowedProposers: allowedProposers
        });

        // 4. Deploy OPFaultVerifier (L1 proof verifier)
        string[] memory urls = new string[](1);
        urls[0] = gatewayUrl;
        OPFaultVerifier faultVerifier = new OPFaultVerifier(
            urls,
            windowSec,
            IVerifierHooks(address(hooks)),
            IOPFaultGameFinder(address(gameFinder)),
            params
        );

        // 5. Deploy OPResolver (the ENS L1 resolver)
        OPResolver resolver = new OPResolver(
            deployer,
            IGatewayVerifier(address(faultVerifier)),
            l2RecordsAddr
        );

        vm.stopBroadcast();

        console.log("=== C3 Deployment Complete ===");
        console.log("EthVerifierHooks:", address(hooks));
        console.log("OPFaultGameFinder:", address(gameFinder));
        console.log("OPFaultVerifier: ", address(faultVerifier));
        console.log("  AnchorStateRegistry used:", asrAddr);
        console.log("OPResolver:      ", address(resolver));
        console.log("  owner:         ", resolver.owner());
        console.log("  verifier:      ", address(resolver.verifier()));
        console.log("  l2Records:     ", resolver.l2RecordsAddress());
        console.log("");
        console.log("IMPORTANT: Verify AnchorStateRegistry matches @unruggable/gateways sepoliaConfig:");
        console.log("  Run: grep -A5 sepoliaConfig workers/gateway/node_modules/@unruggable/gateways/dist/cjs/op/OPFaultRollup.cjs | grep AnchorStateRegistry");
        console.log("  The address above MUST match. If not, redeploy with the correct address.");
        console.log("");
        console.log("Next steps:");
        console.log("  1. set aastar.eth resolver to", address(resolver), "on L1 Sepolia");
        console.log("  2. set ALLOWED_SENDERS =", address(resolver), "in workers/gateway/wrangler.toml");
    }
}
