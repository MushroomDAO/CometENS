// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/L2CommunityRecordsV4.sol";

contract V4MemberReceiver {
    L2CommunityRecordsV4 private immutable records;
    address private immutable desiredAddr;

    constructor(L2CommunityRecordsV4 instance, address desired) {
        records = instance;
        desiredAddr = desired;
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external returns (bytes4) {
        // Owner is already minted before this callback: the member's choice
        // must win over the operator's proposed initial address.
        records.setAddr(bytes32(tokenId), desiredAddr);
        return this.onERC721Received.selector;
    }
}

contract L2CommunityRecordsV4Test is Test {
    bytes32 private constant ROOT_A = keccak256("community-a.eth");
    bytes32 private constant ROOT_B = keccak256("community-b.eth");
    address private controller = makeAddr("controller");
    address private controllerB = makeAddr("controllerB");
    address private operator = makeAddr("operator");
    address private newOperator = makeAddr("newOperator");
    address private alice = makeAddr("alice");
    address private bob = makeAddr("bob");

    L2CommunityRecordsV4 private a;
    L2CommunityRecordsV4 private b;

    function setUp() public {
        a = new L2CommunityRecordsV4(ROOT_A, controller);
        b = new L2CommunityRecordsV4(ROOT_B, controllerB);
        vm.warp(1_000_000);
    }

    function grant(uint256 caps, uint64 quota, uint64 expiry) private {
        vm.prank(controller);
        a.grantOperator(operator, caps, quota, expiry);
    }

    function issuedAlice() private returns (bytes32 node) {
        vm.prank(controller);
        node = a.issue("alice", alice, alice);
    }

    function test_noNativeENSOwnershipClaimAndOnlyOneRoot() public view {
        assertEq(a.parentNode(), ROOT_A);
        assertEq(a.rootController(), controller);
        assertFalse(a.l1OwnershipVerified());
        assertTrue(a.nodeOf("alice") != b.nodeOf("alice"));
    }

    function test_zeroRootOrControllerRejected() public {
        vm.expectRevert(L2CommunityRecordsV4.InvalidInput.selector);
        new L2CommunityRecordsV4(bytes32(0), controller);
        vm.expectRevert(L2CommunityRecordsV4.InvalidInput.selector);
        new L2CommunityRecordsV4(ROOT_A, address(0));
    }

    function test_otherParentCannotGrantOperatorOrIssue() public {
        vm.prank(controllerB);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        a.grantOperator(operator, 1, 2, uint64(block.timestamp + 100));

        grant(a.CAP_ISSUE(), 1, uint64(block.timestamp + 100));
        vm.prank(operator);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        b.issue("alice", alice, address(0));
        vm.prank(operator);
        bytes32 node = a.issue("alice", alice, address(0));
        assertEq(node, a.nodeOf("alice"));
        assertEq(a.subnodeOwner(node), alice);
        assertEq(b.subnodeOwner(b.nodeOf("alice")), address(0));
    }

    function test_grantLimitsMustBeExplicitAndSafe() public {
        vm.startPrank(controller);
        vm.expectRevert(L2CommunityRecordsV4.InvalidInput.selector);
        a.grantOperator(operator, 0, 1, uint64(block.timestamp + 1));
        vm.expectRevert(L2CommunityRecordsV4.InvalidInput.selector);
        a.grantOperator(operator, 2, 1, uint64(block.timestamp + 1));
        vm.expectRevert(L2CommunityRecordsV4.InvalidInput.selector);
        a.grantOperator(operator, 4, 1, uint64(block.timestamp + 1));
        vm.expectRevert(L2CommunityRecordsV4.InvalidInput.selector);
        a.grantOperator(operator, 1, 0, uint64(block.timestamp + 1));
        vm.expectRevert(L2CommunityRecordsV4.InvalidInput.selector);
        a.grantOperator(operator, 1, 1, uint64(block.timestamp));
        vm.stopPrank();
    }

    function test_operatorQuotaIsAtomicAndDuplicateDoesNotConsume() public {
        grant(a.CAP_ISSUE(), 2, uint64(block.timestamp + 100));
        vm.prank(operator);
        a.issue("alice", alice, address(0));
        ( ,uint64 remain,,) = a.operators(operator);
        assertEq(remain, 1);
        vm.prank(operator);
        vm.expectRevert(L2CommunityRecordsV4.AlreadyIssued.selector);
        a.issue("alice", bob, address(0));
        ( ,remain,,) = a.operators(operator);
        assertEq(remain, 1);
        vm.prank(operator);
        a.issue("bob", bob, address(0));
        vm.prank(operator);
        vm.expectRevert(L2CommunityRecordsV4.QuotaExceeded.selector);
        a.issue("carol", bob, address(0));
        assertFalse(a.operatorActive(operator, a.CAP_ISSUE()));
    }

    function test_grantedIssueCannotSetInitialRecordWithoutSeparateBit() public {
        grant(a.CAP_ISSUE(), 1, uint64(block.timestamp + 100));
        vm.prank(operator);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        a.issue("alice", alice, bob);
        ( ,uint64 remain,,) = a.operators(operator);
        assertEq(remain, 1);
        vm.prank(operator);
        a.issue("alice", alice, address(0));
        assertEq(a.addr(a.nodeOf("alice")), address(0));
    }

    function test_grantedInitialRecordIsEditableOnlyByMember() public {
        grant(a.CAP_ISSUE() | a.CAP_INITIAL_ADDR(), 1, uint64(block.timestamp + 100));
        vm.prank(operator);
        bytes32 node = a.issue("alice", alice, bob);
        assertEq(a.addr(node), bob);
        vm.prank(operator);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        a.setAddr(node, operator);
        vm.prank(controller);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        a.setAddr(node, controller);
        vm.prank(alice);
        a.setAddr(node, alice);
        assertEq(a.addr(node), alice);
    }

    function test_expiredAndRevokedOperatorCannotIssue() public {
        grant(a.CAP_ISSUE(), 5, uint64(block.timestamp + 10));
        vm.warp(block.timestamp + 10);
        vm.prank(operator);
        vm.expectRevert(L2CommunityRecordsV4.Expired.selector);
        a.issue("alice", alice, address(0));

        grant(a.CAP_ISSUE(), 5, uint64(block.timestamp + 100));
        vm.prank(controller);
        a.revokeOperator(operator);
        vm.prank(operator);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        a.issue("bob", bob, address(0));
    }

    function test_controllerRotationInvalidatesAllOldGrants() public {
        grant(a.CAP_ISSUE(), 5, uint64(block.timestamp + 100));
        vm.prank(controller);
        a.proposeController(controllerB);
        vm.prank(operator);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        a.acceptController();
        vm.prank(controllerB);
        a.acceptController();
        assertEq(a.rootController(), controllerB);
        assertEq(a.controllerEpoch(), 2);
        assertFalse(a.operatorActive(operator, a.CAP_ISSUE()));
        vm.prank(operator);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        a.issue("alice", alice, address(0));
        vm.prank(controller);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        a.issue("bob", bob, address(0));
        vm.prank(controllerB);
        a.issue("bob", bob, address(0));
        assertEq(a.subnodeOwner(a.nodeOf("bob")), bob);
    }

    function test_rotateOperatorAtomic() public {
        grant(a.CAP_ISSUE(), 1, uint64(block.timestamp + 100));
        vm.prank(controller);
        a.rotateOperator(operator, newOperator, 1, 2, uint64(block.timestamp + 100));
        assertFalse(a.operatorActive(operator, a.CAP_ISSUE()));
        assertTrue(a.operatorActive(newOperator, a.CAP_ISSUE()));
        vm.prank(operator);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        a.issue("alice", alice, address(0));
        vm.prank(newOperator);
        a.issue("alice", alice, address(0));
    }

    function test_memberTokenCannotBeSeizedByControllerOrOperator() public {
        bytes32 node = issuedAlice();
        vm.prank(controller);
        vm.expectRevert();
        a.transferFrom(alice, controller, uint256(node));
        vm.prank(operator);
        vm.expectRevert();
        a.transferFrom(alice, operator, uint256(node));
        assertEq(a.ownerOf(uint256(node)), alice);
    }

    function test_memberOwnsTextContenthashAndRecordsResetOnTransfer() public {
        bytes32 node = issuedAlice();
        vm.startPrank(alice);
        a.setText(node, "url", "https://alice.example");
        a.setContenthash(node, hex"1234");
        vm.stopPrank();
        vm.prank(controller);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        a.setText(node, "url", "malicious");
        vm.prank(operator);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        a.setContenthash(node, hex"aaaa");
        assertEq(a.addr(node), alice);
        assertEq(a.text(node, "url"), "https://alice.example");
        assertEq(a.contenthash(node), hex"1234");

        vm.prank(alice);
        a.transferFrom(alice, bob, uint256(node));
        assertEq(a.ownerOf(uint256(node)), bob);
        assertEq(a.addr(node), address(0));
        assertEq(a.text(node, "url"), "");
        assertEq(a.contenthash(node), bytes(""));
        vm.prank(alice);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        a.setAddr(node, alice);
        vm.startPrank(bob);
        a.setAddr(node, bob);
        a.setText(node, "url", "https://bob.example");
        a.setContenthash(node, hex"5678");
        vm.stopPrank();
        assertEq(a.addr(node), bob);
        assertEq(a.text(node, "url"), "https://bob.example");
        assertEq(a.contenthash(node), hex"5678");
    }

    function test_erc721ApprovalDoesNotPermitRecordOverwrite() public {
        bytes32 node = issuedAlice();
        vm.prank(alice);
        a.approve(operator, uint256(node));
        vm.prank(operator);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        a.setText(node, "url", "evil");
        assertEq(a.ownerOf(uint256(node)), alice);
    }

    function test_labelNormalizationAndDuplicateFails() public {
        vm.prank(controller);
        vm.expectRevert(L2CommunityRecordsV4.InvalidInput.selector);
        a.issue("Alice", alice, address(0));
        vm.prank(controller);
        vm.expectRevert(L2CommunityRecordsV4.InvalidInput.selector);
        a.issue("-alice", alice, address(0));
        issuedAlice();
        vm.prank(controller);
        vm.expectRevert(L2CommunityRecordsV4.AlreadyIssued.selector);
        a.issue("alice", bob, address(0));
    }

    function test_memberReceiverReentrancyCannotBeOverwrittenByIssuer() public {
        V4MemberReceiver receiver = new V4MemberReceiver(a, bob);
        grant(a.CAP_ISSUE() | a.CAP_INITIAL_ADDR(), 1, uint64(block.timestamp + 100));
        vm.prank(operator);
        bytes32 node = a.issue("receiver", address(receiver), alice);
        assertEq(a.ownerOf(uint256(node)), address(receiver));
        assertEq(a.addr(node), bob);
    }
}
