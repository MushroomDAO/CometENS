// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/OffchainResolver.sol";

contract DeployOffchainResolver is Script {
    function run() external {
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        address signerAddr = vm.envAddress("SIGNER_ADDRESS");
        string memory gatewayUrl = vm.envString("GATEWAY_URL");

        address[] memory initialSigners = new address[](1);
        initialSigners[0] = signerAddr;

        vm.startBroadcast();

        OffchainResolver resolver = new OffchainResolver(deployer, initialSigners, gatewayUrl);

        vm.stopBroadcast();
        console.log("OffchainResolver deployed at:", address(resolver));
        console.log("Owner:", resolver.owner());
        console.log("IsSigner:", resolver.signers(signerAddr));
        console.log("Gateway:", resolver.gatewayUrl());
    }
}
