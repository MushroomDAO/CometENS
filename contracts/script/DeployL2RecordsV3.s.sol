// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/L2RecordsV3.sol";

contract DeployL2RecordsV3 is Script {
    function run() external {
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        require(deployer != address(0), "DEPLOYER_ADDRESS not set");

        vm.startBroadcast();

        L2RecordsV3 l2Records = new L2RecordsV3(deployer);

        vm.stopBroadcast();

        console.log("L2RecordsV3 deployed at:", address(l2Records));
        console.log("Owner:", deployer);
        console.log("ERC-721 name:", l2Records.name());
        console.log("ERC-721 symbol:", l2Records.symbol());
    }
}
