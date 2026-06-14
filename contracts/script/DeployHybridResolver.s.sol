// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.23;

import "forge-std/Script.sol";
import "../src/HybridResolver.sol";
import {OPFaultVerifier} from "@unruggable/contracts/op/OPFaultVerifier.sol";
import {OPFaultGameFinder} from "@unruggable/contracts/op/OPFaultGameFinder.sol";
import {EthVerifierHooks} from "@unruggable/contracts/eth/EthVerifierHooks.sol";
import {OPFaultParams, IAnchorStateRegistry, IOPFaultGameFinder} from "@unruggable/contracts/op/OPInterfaces.sol";
import {IGatewayVerifier} from "@unruggable/contracts/IGatewayVerifier.sol";
import {IVerifierHooks} from "@unruggable/contracts/IVerifierHooks.sol";

/// @notice Deploys HybridResolver + its OPFaultVerifier stack (finalized-proof config).
///
/// Required env:
///   DEPLOYER_ADDRESS       — tx sender / owner
///   L2_RECORDS_ADDRESS     — L2RecordsV3 on OP
///   ANCHOR_STATE_REGISTRY  — OP Stack ASR on L1 (must match the unruggable gateways lib config)
///   GATEWAY_URL            — hybrid gateway endpoint, e.g. https://.../hybrid (NOT templated)
///   SIGNER_ADDRESS         — gateway signing address (PRIVATE_KEY_SUPPLIER's address)
///
/// Optional:
///   MIN_AGE_SEC (default 0 = finalized-only — the hybrid strategy)
///   WINDOW_SEC  (default 604800 = 7d, must cover finalized-game lag)
contract DeployHybridResolver is Script {
    function _deployVerifier(address asrAddr, string memory gatewayUrl)
        internal
        returns (IGatewayVerifier)
    {
        uint256 minAgeSec = 0;
        try vm.envUint("MIN_AGE_SEC") returns (uint256 v) { minAgeSec = v; } catch {}
        uint256 windowSec = 604_800;
        try vm.envUint("WINDOW_SEC") returns (uint256 v) { windowSec = v; } catch {}

        OPFaultParams memory params = OPFaultParams({
            asr: IAnchorStateRegistry(asrAddr),
            minAgeSec: minAgeSec,
            allowedGameTypes: new uint256[](0),
            allowedProposers: new address[](0)
        });
        string[] memory urls = new string[](1);
        urls[0] = gatewayUrl;

        IGatewayVerifier v = new OPFaultVerifier(
            urls,
            windowSec,
            IVerifierHooks(address(new EthVerifierHooks())),
            IOPFaultGameFinder(address(new OPFaultGameFinder())),
            params
        );
        console.log("OPFaultVerifier:  ", address(v));
        console.log("  minAgeSec:", minAgeSec, "(0 = finalized-only)");
        return v;
    }

    function run() external {
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        string memory gatewayUrl = vm.envString("GATEWAY_URL");
        address signerAddr = vm.envAddress("SIGNER_ADDRESS");

        vm.startBroadcast();

        IGatewayVerifier verifier = _deployVerifier(vm.envAddress("ANCHOR_STATE_REGISTRY"), gatewayUrl);

        address[] memory signers = new address[](1);
        signers[0] = signerAddr;
        HybridResolver resolver = new HybridResolver(
            deployer, verifier, vm.envAddress("L2_RECORDS_ADDRESS"), signers, gatewayUrl
        );

        vm.stopBroadcast();

        console.log("HybridResolver:   ", address(resolver));
        console.log("  owner:    ", resolver.owner());
        console.log("  l2Records:", resolver.l2RecordsAddress());
        console.log("  signer:   ", signerAddr);
        console.log("Next: aastar.eth resolver =", address(resolver));
        console.log("      gateway ALLOWED_SENDERS =", address(resolver), "; gatewayUrl(POST /hybrid) =", gatewayUrl);
    }
}
