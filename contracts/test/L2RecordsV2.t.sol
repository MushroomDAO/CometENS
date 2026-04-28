// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/L2RecordsV2.sol";

contract L2RecordsV2Test is Test {
    L2RecordsV2 public records;
    address public owner;
    address public alice;
    address public bob;
    address public registrar;
    address public stranger;

    bytes32 constant ROOT_NODE = bytes32(0);
    bytes32 constant LABEL_ALICE = keccak256("alice");
    bytes32 constant LABEL_BOB   = keccak256("bob");
    bytes32 constant LABEL_CAROL = keccak256("carol");
    bytes32 NODE_ALICE;
    bytes32 NODE_BOB;

    function setUp() public {
        owner    = address(this);
        alice    = makeAddr("alice");
        bob      = makeAddr("bob");
        registrar = makeAddr("registrar");
        stranger = makeAddr("stranger");
        records  = new L2RecordsV2(owner);
        NODE_ALICE = keccak256(abi.encodePacked(ROOT_NODE, LABEL_ALICE));
        NODE_BOB   = keccak256(abi.encodePacked(ROOT_NODE, LABEL_BOB));
        vm.warp(1_000_000); // start at a non-trivial timestamp
    }

    // ─── Constructor ──────────────────────────────────────────────────────────

    function test_constructorSetsOwner() public view {
        assertEq(records.owner(), owner);
    }

    function test_constructorRejectsZeroOwner() public {
        vm.expectRevert(L2RecordsV2.ZeroAddress.selector);
        new L2RecordsV2(address(0));
    }

    // ─── Ownership ────────────────────────────────────────────────────────────

    function test_transferOwnership() public {
        records.transferOwnership(alice);
        assertEq(records.owner(), alice);
    }

    function test_transferOwnershipRejectsZero() public {
        vm.expectRevert(L2RecordsV2.ZeroAddress.selector);
        records.transferOwnership(address(0));
    }

    function test_transferOwnershipUnauthorized() public {
        vm.prank(stranger);
        vm.expectRevert(L2RecordsV2.Unauthorized.selector);
        records.transferOwnership(stranger);
    }

    // ─── Registrar management ─────────────────────────────────────────────────

    function test_addRegistrarUnlimited() public {
        records.addRegistrar(ROOT_NODE, registrar, 0, 0);
        assertTrue(records.isRegistrar(ROOT_NODE, registrar));
        assertEq(records.registrarQuota(ROOT_NODE, registrar), type(uint256).max);
    }

    function test_addRegistrarWithQuota() public {
        records.addRegistrar(ROOT_NODE, registrar, 5, 0);
        assertEq(records.registrarQuota(ROOT_NODE, registrar), 5);
    }

    function test_addRegistrarRejectsZeroAddress() public {
        vm.expectRevert(L2RecordsV2.ZeroAddress.selector);
        records.addRegistrar(ROOT_NODE, address(0), 0, 0);
    }

    function test_addRegistrarUnauthorized() public {
        vm.prank(stranger);
        vm.expectRevert(L2RecordsV2.Unauthorized.selector);
        records.addRegistrar(ROOT_NODE, registrar, 0, 0);
    }

    function test_addRegistrarEventEmitsResolvedQuota() public {
        // quota=0 stored as type(uint256).max; event must emit resolved value, not raw 0
        vm.expectEmit(true, true, false, true);
        emit L2RecordsV2.RegistrarAdded(ROOT_NODE, registrar, type(uint256).max, 0);
        records.addRegistrar(ROOT_NODE, registrar, 0, 0);
    }

    function test_removeRegistrar() public {
        records.addRegistrar(ROOT_NODE, registrar, 0, 0);
        records.removeRegistrar(ROOT_NODE, registrar);
        assertFalse(records.isRegistrar(ROOT_NODE, registrar));
    }

    function test_removeRegistrarUnauthorized() public {
        records.addRegistrar(ROOT_NODE, registrar, 0, 0);
        vm.prank(stranger);
        vm.expectRevert(L2RecordsV2.Unauthorized.selector);
        records.removeRegistrar(ROOT_NODE, registrar);
    }

    function test_updateRegistrarQuota() public {
        records.addRegistrar(ROOT_NODE, registrar, 5, 0);
        records.updateRegistrarQuota(ROOT_NODE, registrar, 10);
        assertEq(records.registrarQuota(ROOT_NODE, registrar), 10);
    }

    function test_updateRegistrarQuotaToUnlimited() public {
        records.addRegistrar(ROOT_NODE, registrar, 5, 0);
        records.updateRegistrarQuota(ROOT_NODE, registrar, 0);
        assertEq(records.registrarQuota(ROOT_NODE, registrar), type(uint256).max);
    }

    function test_updateRegistrarQuotaEventEmitsResolvedValue() public {
        // quota=0 stored as type(uint256).max; event must emit resolved sentinel, not raw 0
        records.addRegistrar(ROOT_NODE, registrar, 5, 0);
        vm.expectEmit(true, true, false, true);
        emit L2RecordsV2.RegistrarQuotaUpdated(ROOT_NODE, registrar, type(uint256).max);
        records.updateRegistrarQuota(ROOT_NODE, registrar, 0);
    }

    function test_updateRegistrarQuotaOnExpiredReverts() public {
        records.addRegistrar(ROOT_NODE, registrar, 5, block.timestamp + 100);
        vm.warp(block.timestamp + 200);
        vm.expectRevert(L2RecordsV2.RegistrarExpired.selector);
        records.updateRegistrarQuota(ROOT_NODE, registrar, 10);
    }

    function test_updateRegistrarQuotaOnNonRegistrarReverts() public {
        vm.expectRevert(L2RecordsV2.Unauthorized.selector);
        records.updateRegistrarQuota(ROOT_NODE, stranger, 5);
    }

    function test_isRegistrarFalseWhenExpired() public {
        records.addRegistrar(ROOT_NODE, registrar, 0, block.timestamp + 100);
        vm.warp(block.timestamp + 200);
        assertFalse(records.isRegistrar(ROOT_NODE, registrar));
    }

    function test_isRegistrarFalseWhenNotAdded() public view {
        assertFalse(records.isRegistrar(ROOT_NODE, stranger));
    }

    function test_getRegistrarInfo() public {
        records.addRegistrar(ROOT_NODE, registrar, 3, 0);
        (bool isActive, uint256 quota, uint256 expiry) = records.getRegistrarInfo(ROOT_NODE, registrar);
        assertTrue(isActive);
        assertEq(quota, 3);
        assertEq(expiry, 0);
    }

    // ─── Subdomain registration ───────────────────────────────────────────────

    function test_ownerCanRegister() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        assertEq(records.subnodeOwner(NODE_ALICE), alice);
    }

    function test_registrarCanRegister() public {
        records.addRegistrar(ROOT_NODE, registrar, 0, 0);
        vm.prank(registrar);
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        assertEq(records.subnodeOwner(NODE_ALICE), alice);
    }

    function test_strangerCannotRegister() public {
        vm.prank(stranger);
        vm.expectRevert(L2RecordsV2.Unauthorized.selector);
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
    }

    function test_revertLabelMismatch() public {
        vm.expectRevert(L2RecordsV2.LabelMismatch.selector);
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "bob");
    }

    function test_revertZeroOwner() public {
        vm.expectRevert(L2RecordsV2.ZeroAddress.selector);
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, address(0), "alice");
    }

    function test_revertAlreadyRegistered() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        vm.expectRevert(L2RecordsV2.AlreadyRegistered.selector);
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, bob, "alice");
    }

    function test_registrarExpiryEnforced() public {
        records.addRegistrar(ROOT_NODE, registrar, 1, block.timestamp - 1);
        vm.prank(registrar);
        vm.expectRevert(L2RecordsV2.RegistrarExpired.selector);
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
    }

    function test_registrarQuotaDecrements() public {
        records.addRegistrar(ROOT_NODE, registrar, 2, 0);
        vm.startPrank(registrar);
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        assertEq(records.registrarQuota(ROOT_NODE, registrar), 1);
        records.setSubnodeOwner(ROOT_NODE, LABEL_BOB, bob, "bob");
        assertEq(records.registrarQuota(ROOT_NODE, registrar), 0);
        vm.stopPrank();
    }

    function test_registrarQuotaExhaustedReverts() public {
        records.addRegistrar(ROOT_NODE, registrar, 1, 0);
        vm.prank(registrar);
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        vm.prank(registrar);
        vm.expectRevert(L2RecordsV2.QuotaExceeded.selector);
        records.setSubnodeOwner(ROOT_NODE, LABEL_BOB, bob, "bob");
    }

    function test_unlimitedRegistrarNoDecrement() public {
        records.addRegistrar(ROOT_NODE, registrar, 0, 0); // unlimited
        vm.startPrank(registrar);
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        records.setSubnodeOwner(ROOT_NODE, LABEL_BOB, bob, "bob");
        vm.stopPrank();
        // quota stays at max (unlimited sentinel never decrements)
        assertEq(records.registrarQuota(ROOT_NODE, registrar), type(uint256).max);
    }

    function test_ownerIgnoresQuota() public {
        // Owner bypasses quota entirely
        records.addRegistrar(ROOT_NODE, owner, 0, 0);
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        records.setSubnodeOwner(ROOT_NODE, LABEL_BOB, bob, "bob");
    }

    // ─── registerSubnode ─────────────────────────────────────────────────────

    function test_registerSubnodeSetsAddr() public {
        bytes memory addrBytes = abi.encodePacked(alice);
        records.registerSubnode(ROOT_NODE, LABEL_ALICE, alice, "alice", addrBytes);
        assertEq(records.addr(NODE_ALICE), alice);
    }

    function test_registerSubnodeRejectsBadAddrBytes() public {
        records.addRegistrar(ROOT_NODE, registrar, 1, 0);
        vm.prank(registrar);
        vm.expectRevert(L2RecordsV2.InvalidAddrBytes.selector);
        records.registerSubnode(ROOT_NODE, LABEL_ALICE, alice, "alice", hex"1234");
    }

    // ─── Label / name storage ─────────────────────────────────────────────────

    function test_labelOf() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        assertEq(records.labelOf(NODE_ALICE), "alice");
    }

    function test_labelOfUnregisteredReturnsEmpty() public view {
        assertEq(records.labelOf(bytes32(uint256(999))), "");
    }

    function test_nameOf() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        bytes memory name = records.nameOf(NODE_ALICE);
        // DNS encoding: \x05alice\x00
        assertEq(name.length, 7);
        assertEq(uint8(name[0]), 5);
    }

    // ─── primaryNode ──────────────────────────────────────────────────────────

    function test_primaryNodeSetOnFirstRegistration() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        assertEq(records.primaryNode(alice), NODE_ALICE);
    }

    function test_primaryNodeNotOverwrittenOnSecondRegistration() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        // register a second subdomain to the same owner under a different label
        bytes32 labelCarol = keccak256("carol");
        bytes32 nodeCarol = keccak256(abi.encodePacked(ROOT_NODE, labelCarol));
        records.setSubnodeOwner(ROOT_NODE, labelCarol, alice, "carol");
        // primary remains the first one
        assertEq(records.primaryNode(alice), NODE_ALICE);
        assertFalse(records.primaryNode(alice) == nodeCarol);
    }

    function test_setPrimaryNode() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        records.setSubnodeOwner(ROOT_NODE, LABEL_BOB, alice, "bob");
        records.setPrimaryNode(alice, NODE_BOB);
        assertEq(records.primaryNode(alice), NODE_BOB);
    }

    function test_setPrimaryNodeRejectsUnregisteredNode() public {
        vm.expectRevert(L2RecordsV2.Unauthorized.selector);
        records.setPrimaryNode(alice, bytes32(uint256(999)));
    }

    function test_setPrimaryNodeClearWithZero() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        records.setPrimaryNode(alice, bytes32(0));
        assertEq(records.primaryNode(alice), bytes32(0));
    }

    function test_setPrimaryNodeUnauthorized() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        vm.prank(stranger);
        vm.expectRevert(L2RecordsV2.Unauthorized.selector);
        records.setPrimaryNode(alice, NODE_ALICE);
    }

    function test_setPrimaryNodeSelf() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        records.setSubnodeOwner(ROOT_NODE, LABEL_BOB, alice, "bob");
        vm.prank(alice);
        records.setPrimaryNodeSelf(NODE_BOB);
        assertEq(records.primaryNode(alice), NODE_BOB);
    }

    function test_setPrimaryNodeSelfRejectsNonOwnerNode() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        vm.prank(bob);
        vm.expectRevert(L2RecordsV2.Unauthorized.selector);
        records.setPrimaryNodeSelf(NODE_ALICE);
    }

    function test_setPrimaryNodeSelfClearWithZero() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        vm.prank(alice);
        records.setPrimaryNodeSelf(bytes32(0));
        assertEq(records.primaryNode(alice), bytes32(0));
    }

    // ─── setAddr ─────────────────────────────────────────────────────────────

    function test_setAddrValid() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        records.setAddr(NODE_ALICE, 60, abi.encodePacked(alice));
        assertEq(records.addr(NODE_ALICE), alice);
    }

    function test_setAddrClearWithEmpty() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        records.setAddr(NODE_ALICE, 60, abi.encodePacked(alice));
        records.setAddr(NODE_ALICE, 60, hex""); // clear
        assertEq(records.addr(NODE_ALICE), address(0));
    }

    function test_setAddrRejectsInvalidLength() public {
        vm.expectRevert(L2RecordsV2.InvalidAddrBytes.selector);
        records.setAddr(NODE_ALICE, 60, hex"1234"); // 2 bytes — not 0 or 20
    }

    function test_setAddrNonEthCoinTypeAnyLength() public {
        // Non-ETH coin types do not enforce length
        records.setAddr(NODE_ALICE, 0, hex"cafebabe");
        assertEq(records.addr(NODE_ALICE, 0), hex"cafebabe");
    }

    function test_setAddrUnauthorized() public {
        vm.prank(stranger);
        vm.expectRevert(L2RecordsV2.Unauthorized.selector);
        records.setAddr(NODE_ALICE, 60, abi.encodePacked(alice));
    }

    function test_addrReturnsBoundary() public {
        // Exactly 20 bytes: addr() should return the correct address
        records.setAddr(NODE_ALICE, 60, abi.encodePacked(alice));
        assertEq(records.addr(NODE_ALICE), alice);
    }

    function test_addrReturnsZeroForEmpty() public view {
        assertEq(records.addr(NODE_ALICE), address(0));
    }

    // ─── setText ─────────────────────────────────────────────────────────────

    function test_setText() public {
        records.setText(NODE_ALICE, "avatar", "https://example.com/img.png");
        assertEq(records.text(NODE_ALICE, "avatar"), "https://example.com/img.png");
    }

    function test_setTextUnauthorized() public {
        vm.prank(stranger);
        vm.expectRevert(L2RecordsV2.Unauthorized.selector);
        records.setText(NODE_ALICE, "avatar", "evil");
    }

    // ─── setContenthash ───────────────────────────────────────────────────────

    function test_setContenthash() public {
        bytes memory ch = hex"e3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eff1894f";
        records.setContenthash(NODE_ALICE, ch);
        assertEq(records.contenthash(NODE_ALICE), ch);
    }

    function test_setContenthashUnauthorized() public {
        vm.prank(stranger);
        vm.expectRevert(L2RecordsV2.Unauthorized.selector);
        records.setContenthash(NODE_ALICE, hex"cafe");
    }
}
