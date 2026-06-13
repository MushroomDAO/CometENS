// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/L2RecordsV2.sol";

contract DeployL2RecordsV2 is Script {
    function run() external {
        address owner = vm.envAddress("DEPLOYER_ADDRESS");
        require(owner != address(0), "DEPLOYER_ADDRESS not set");

        vm.startBroadcast();
        
        L2RecordsV2 l2Records = new L2RecordsV2(owner);
        
        vm.stopBroadcast();

        console.log("L2RecordsV2 deployed at:", address(l2Records));
        console.log("Owner:", owner);
    }
}
