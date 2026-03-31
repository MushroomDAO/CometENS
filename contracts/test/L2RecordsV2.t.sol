// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/L2RecordsV2.sol";

contract L2RecordsV2Test is Test {
    L2RecordsV2 public records;
    address public owner;
    address public alice;
    address public registrar;

    bytes32 constant ROOT_NODE = bytes32(0);
    bytes32 constant LABEL_ALICE = keccak256("alice");
    bytes32 constant LABEL_BOB = keccak256("bob");

    function setUp() public {
        owner = address(this);
        alice = makeAddr("alice");
        registrar = makeAddr("registrar");
        records = new L2RecordsV2(owner);
    }

    function test_revertLabelMismatch() public {
        vm.expectRevert(L2RecordsV2.LabelMismatch.selector);
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "bob");
    }

    function test_revertZeroOwner() public {
        vm.expectRevert(L2RecordsV2.ZeroAddress.selector);
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, address(0), "alice");
    }

    function test_registrarExpiryEnforced() public {
        // Warp to a non-trivial timestamp so expiry = block.timestamp - 1 is not 0
        // (contract treats expiry=0 as "never expires")
        vm.warp(1000);
        records.addRegistrar(ROOT_NODE, registrar, 1, block.timestamp - 1);
        vm.prank(registrar);
        vm.expectRevert(L2RecordsV2.RegistrarExpired.selector);
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
    }

    function test_registrarQuotaDecrementsAndReverts() public {
        records.addRegistrar(ROOT_NODE, registrar, 1, 0);
        vm.prank(registrar);
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");

        vm.prank(registrar);
        vm.expectRevert(L2RecordsV2.QuotaExceeded.selector);
        records.setSubnodeOwner(ROOT_NODE, LABEL_BOB, alice, "bob");
    }

    function test_registerSubnodeRejectsBadAddrBytes() public {
        records.addRegistrar(ROOT_NODE, registrar, 1, 0);
        vm.prank(registrar);
        vm.expectRevert(L2RecordsV2.InvalidAddrBytes.selector);
        records.registerSubnode(ROOT_NODE, LABEL_ALICE, alice, "alice", hex"1234");
    }
}
