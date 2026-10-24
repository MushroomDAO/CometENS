// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/G2Ensv2AtomicSubnameProof.sol";

/// @notice Actual deployed ENSv2 runtime; no mocked registry or live transaction.
contract G2Ensv2NativeActualForkTest is Test {
    address constant ROOT = 0xB458D6a3a77919449d03e7A6903C26827c1eC43f;
    address constant ETH = 0xD4eBcbBdF463C9c45784603Db0dDD499BC44A8B4;
    address constant STRANGER = address(0xBEEF);
    address constant MEMBER = address(0xCAFE);
    uint256 constant ETH_ID = uint256(keccak256("eth"));
    G2Ensv2AtomicSubnameProof gate;
    address holder;
    uint64 expiry;

    function setUp() public {
        if (block.chainid != 11155111) { vm.skip(true); return; }
        assertEq(IG2Ensv2Registry(ROOT).getSubregistry("eth"), ETH);
        IG2Ensv2Registry.State memory parent = IG2Ensv2Registry(ROOT).getState(ETH_ID);
        assertEq(parent.status, 2);
        holder = parent.latestOwner;
        expiry = parent.expiry;
        assertGt(expiry, block.timestamp);
        gate = new G2Ensv2AtomicSubnameProof(ROOT, ETH, "eth");
    }

    function _issue(address caller, string memory label) private {
        vm.prank(caller);
        gate.issue(label, MEMBER, address(0x1234), uint64(block.timestamp + 100));
    }

    function test_realRuntimeUnknownActorCannotUseNativeEntry() public {
        vm.expectRevert(G2Ensv2AtomicSubnameProof.InvalidAuthority.selector);
        _issue(STRANGER, "alien");
    }

    function test_realRuntimeHolderCannotUseUnapprovedNewIssuer() public {
        // Critical real-world prerequisite: parent holder cannot implicitly
        // make an arbitrary contract the child registry's root registrar.
        assertFalse(IG2Ensv2Registry(ETH).hasRootRoles(1, address(gate)));
        vm.expectRevert(G2Ensv2AtomicSubnameProof.InvalidAuthority.selector);
        _issue(holder, "needsgrant");
    }

    function test_parentExpiryDeniesEvenPreviouslyRecognizedHolder() public {
        vm.warp(uint256(expiry) + 1);
        vm.expectRevert(G2Ensv2AtomicSubnameProof.InvalidAuthority.selector);
        _issue(holder, "expirednative");
    }

    function test_registryMigrationAndReRegistrationCannotBeAssumedFromHistoricalOwner() public {
        // The current runtime is the only authority; unauthorized outsiders
        // cannot change the registry link or register a substitute parent.
        vm.prank(STRANGER);
        (bool changed,) = ROOT.call(abi.encodeWithSignature("setSubregistry(string,address)", "eth", STRANGER));
        assertFalse(changed);
        assertEq(IG2Ensv2Registry(ROOT).getSubregistry("eth"), ETH);
        vm.expectRevert(G2Ensv2AtomicSubnameProof.InvalidAuthority.selector);
        _issue(STRANGER, "reregister");
    }
}
