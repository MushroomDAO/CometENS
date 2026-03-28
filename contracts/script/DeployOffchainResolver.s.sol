// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/OffchainResolver.sol";

contract DeployOffchainResolver is Script {
    function run() external {
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        address signerAddr = vm.envAddress("SIGNER_ADDRESS");
        string memory gatewayUrl = vm.envString("GATEWAY_URL");

        vm.startBroadcast();

        OffchainResolver resolver = new OffchainResolver(deployer, signerAddr, gatewayUrl);

        vm.stopBroadcast();
        console.log("OffchainResolver deployed at:", address(resolver));
        console.log("Owner:", resolver.owner());
        console.log("Signer:", resolver.signerAddress());
        console.log("Gateway:", resolver.gatewayUrl());
    }
}
