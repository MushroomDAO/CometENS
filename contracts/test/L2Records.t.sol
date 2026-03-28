// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/L2Records.sol";

contract L2RecordsTest is Test {
    L2Records public records;
    address public contractOwner;
    address public alice;

    bytes32 constant ROOT_NODE = bytes32(0);
    bytes32 constant LABEL_ALICE = keccak256("alice");
    bytes32 immutable ALICE_NODE = keccak256(abi.encodePacked(ROOT_NODE, LABEL_ALICE));

    function setUp() public {
        contractOwner = address(this);
        alice = makeAddr("alice");
        records = new L2Records(contractOwner);
    }

    // ─── Ownership ────────────────────────────────────────────────────────────

    function test_ownerIsSetOnDeploy() public view {
        assertEq(records.owner(), contractOwner);
    }

    function test_transferOwnership() public {
        records.transferOwnership(alice);
        assertEq(records.owner(), alice);
    }

    function test_revertTransferOwnershipNotOwner() public {
        vm.prank(alice);
        vm.expectRevert(L2Records.Unauthorized.selector);
        records.transferOwnership(alice);
    }

    function test_revertTransferOwnershipZeroAddress() public {
        vm.expectRevert(L2Records.ZeroAddress.selector);
        records.transferOwnership(address(0));
    }

    // ─── setSubnodeOwner ──────────────────────────────────────────────────────

    function test_setSubnodeOwner() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice);
        assertEq(records.subnodeOwner(ALICE_NODE), alice);
    }

    function test_revertSetSubnodeOwnerNotOwner() public {
        vm.prank(alice);
        vm.expectRevert(L2Records.Unauthorized.selector);
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice);
    }

    function test_setSubnodeOwnerEmitsEvent() public {
        vm.expectEmit(true, true, true, true);
        emit L2Records.SubnodeOwnerSet(ROOT_NODE, LABEL_ALICE, ALICE_NODE, alice);
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice);
    }

    // ─── addr ─────────────────────────────────────────────────────────────────

    function test_setAndGetAddr() public {
        bytes memory addrBytes = abi.encodePacked(alice);
        records.setAddr(ALICE_NODE, 60, addrBytes);
        assertEq(records.addr(ALICE_NODE), alice);
    }

    function test_setAndGetAddrCoinType() public {
        bytes memory addrBytes = hex"deadbeef";
        records.setAddr(ALICE_NODE, 0, addrBytes);
        assertEq(records.addr(ALICE_NODE, 0), addrBytes);
    }

    function test_addrDefaultsToZero() public view {
        assertEq(records.addr(ALICE_NODE), address(0));
    }

    function test_revertSetAddrNotOwner() public {
        vm.prank(alice);
        vm.expectRevert(L2Records.Unauthorized.selector);
        records.setAddr(ALICE_NODE, 60, abi.encodePacked(alice));
    }

    // ─── text ─────────────────────────────────────────────────────────────────

    function test_setAndGetText() public {
        records.setText(ALICE_NODE, "com.twitter", "@alice");
        assertEq(records.text(ALICE_NODE, "com.twitter"), "@alice");
    }

    function test_textDefaultsToEmpty() public view {
        assertEq(records.text(ALICE_NODE, "com.twitter"), "");
    }

    function test_revertSetTextNotOwner() public {
        vm.prank(alice);
        vm.expectRevert(L2Records.Unauthorized.selector);
        records.setText(ALICE_NODE, "com.twitter", "@alice");
    }

    // ─── contenthash ──────────────────────────────────────────────────────────

    function test_setAndGetContenthash() public {
        bytes memory hash = hex"e301017012201234";
        records.setContenthash(ALICE_NODE, hash);
        assertEq(records.contenthash(ALICE_NODE), hash);
    }

    function test_contenthashDefaultsToEmpty() public view {
        assertEq(records.contenthash(ALICE_NODE).length, 0);
    }

    function test_revertSetContenthashNotOwner() public {
        vm.prank(alice);
        vm.expectRevert(L2Records.Unauthorized.selector);
        records.setContenthash(ALICE_NODE, hex"1234");
    }
}
