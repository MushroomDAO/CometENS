// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/L2Records.sol";

contract DeployL2Records is Script {
    function run() external {
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        vm.startBroadcast();

        L2Records records = new L2Records(deployer);

        vm.stopBroadcast();
        console.log("L2Records deployed at:", address(records));
        console.log("Owner:", records.owner());
    }
}
