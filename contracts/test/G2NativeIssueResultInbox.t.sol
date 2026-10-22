// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/G2NativeIssueResultInbox.sol";

contract G2NativeIssueResultInboxTest is Test {
    bytes32 private constant PARENT = keccak256("community.eth");
    bytes32 private constant CHILD = keccak256(abi.encodePacked(PARENT, keccak256("alice")));
    bytes32 private constant OTHER_CHILD = keccak256(abi.encodePacked(PARENT, keccak256("bob")));

    G2NativeIssueResultInbox private inbox;
    address private requester = makeAddr("requester");
    address private member = makeAddr("member");
    address private emitter = makeAddr("pinned L1 emitter");
    address private stranger = makeAddr("stranger");

    function setUp() public {
        vm.chainId(11155420);
        vm.warp(2_000_000);
        inbox = new G2NativeIssueResultInbox(PARENT, emitter);
        _xSender(emitter);
    }

    function _xSender(address sender) private {
        vm.clearMockedCalls();
        vm.mockCall(
            inbox.OP_MESSENGER(),
            abi.encodeWithSelector(INativeResultOPMessenger.xDomainMessageSender.selector),
            abi.encode(sender)
        );
    }

    function _queue() private returns (bytes32 id) {
        vm.prank(requester);
        return inbox.queueIssue("alice", member, uint64(block.timestamp + 1 days));
    }

    function _result(bytes32 id) private view returns (G2NativeIssueResultInbox.NativeIssueResult memory c) {
        c = G2NativeIssueResultInbox.NativeIssueResult({
            sourceChainId: 11155111,
            destinationChainId: 11155420,
            sourceEmitter: emitter,
            destinationInbox: address(inbox),
            parentNode: PARENT,
            requestId: id,
            childNode: CHILD,
            requester: requester,
            member: member,
            expiry: uint64(block.timestamp + 1 days),
            nonce: 1,
            sourceBlockNumber: 12345,
            version: inbox.VERSION()
        });
    }

    function _deliver(G2NativeIssueResultInbox.NativeIssueResult memory c) private {
        vm.prank(inbox.OP_MESSENGER());
        inbox.observeResult(c);
    }

    function _reject(G2NativeIssueResultInbox.NativeIssueResult memory c) private {
        vm.prank(inbox.OP_MESSENGER());
        vm.expectRevert(G2NativeIssueResultInbox.InvalidResult.selector);
        inbox.observeResult(c);
    }

    function test_queuedIntentAndCanonicalResultOnlyMarkProvisionalObservation() public {
        bytes32 id = _queue();
        assertEq(inbox.nextNonce(requester), 1);
        (
            address req, bytes32 child, address to, uint64 expiry, uint256 nonce,
            G2NativeIssueResultInbox.Status beforeStatus, uint64 beforeBlock
        ) = inbox.requests(id);
        assertEq(req, requester);
        assertEq(child, CHILD);
        assertEq(to, member);
        assertEq(expiry, uint64(block.timestamp + 1 days));
        assertEq(nonce, 1);
        assertEq(uint8(beforeStatus), uint8(G2NativeIssueResultInbox.Status.PENDING));
        assertEq(beforeBlock, 0);

        _deliver(_result(id));
        (,,,,,G2NativeIssueResultInbox.Status afterStatus, uint64 sourceBlock) = inbox.requests(id);
        assertEq(uint8(afterStatus), uint8(G2NativeIssueResultInbox.Status.OBSERVED));
        assertEq(sourceBlock, 12345);
        assertFalse(inbox.sovereignReceipt());
        assertFalse(inbox.currentL1AuthorityVerified());
        assertFalse(inbox.finalizedL1IssuanceVerified());
        _reject(_result(id)); // duplicate/replay does not make another observation.
    }

    function test_strangerAndForgedMessengerSenderCannotSubmitAResult() public {
        bytes32 id = _queue();
        G2NativeIssueResultInbox.NativeIssueResult memory result = _result(id);
        vm.prank(stranger);
        vm.expectRevert(G2NativeIssueResultInbox.UnauthorizedMessenger.selector);
        inbox.observeResult(result);
        _xSender(stranger);
        vm.prank(inbox.OP_MESSENGER());
        vm.expectRevert(G2NativeIssueResultInbox.UnauthorizedMessenger.selector);
        inbox.observeResult(result);
        _xSender(emitter);
        _deliver(result);
    }

    function test_wrongChainVersionSourceDestinationAndParentCannotBeObserved() public {
        bytes32 id = _queue();
        G2NativeIssueResultInbox.NativeIssueResult memory c = _result(id);
        c.sourceChainId = 1;
        _reject(c);
        c = _result(id);
        c.destinationChainId = 10;
        _reject(c);
        c = _result(id);
        c.sourceEmitter = stranger;
        _reject(c);
        c = _result(id);
        c.destinationInbox = stranger;
        _reject(c);
        c = _result(id);
        c.parentNode = OTHER_CHILD;
        _reject(c);
        c = _result(id);
        c.version = bytes32(uint256(1));
        _reject(c);
        c = _result(id);
        c.sourceBlockNumber = 0;
        _reject(c);
        vm.chainId(1);
        _reject(_result(id));
    }

    function test_requestIdentityBindsChildMemberRequesterExpiryAndNonce() public {
        bytes32 id = _queue();
        G2NativeIssueResultInbox.NativeIssueResult memory c = _result(id);
        c.requestId = keccak256("fake");
        _reject(c);
        c = _result(id);
        c.childNode = OTHER_CHILD;
        _reject(c);
        c = _result(id);
        c.requester = stranger;
        _reject(c);
        c = _result(id);
        c.member = stranger;
        _reject(c);
        c = _result(id);
        c.expiry++;
        _reject(c);
        c = _result(id);
        c.nonce++;
        _reject(c);
        _deliver(_result(id));
    }

    function test_cancellationCannotBeReversedByStaleL1Result() public {
        bytes32 id = _queue();
        vm.prank(stranger);
        vm.expectRevert(G2NativeIssueResultInbox.InvalidRequest.selector);
        inbox.cancelIssue(id);
        vm.prank(requester);
        inbox.cancelIssue(id);
        vm.prank(requester);
        vm.expectRevert(G2NativeIssueResultInbox.InvalidRequest.selector);
        inbox.cancelIssue(id);
        _reject(_result(id));
        (,,,,,G2NativeIssueResultInbox.Status status,) = inbox.requests(id);
        assertEq(uint8(status), uint8(G2NativeIssueResultInbox.Status.CANCELLED));
    }

    function test_repeatRequestUsesNewNonceAndDoesNotReviveOldObservedResult() public {
        bytes32 oldId = _queue();
        _deliver(_result(oldId));
        bytes32 newId = _queue();
        assertTrue(oldId != newId);
        assertEq(inbox.nextNonce(requester), 2);
        G2NativeIssueResultInbox.NativeIssueResult memory newResult = _result(newId);
        _reject(newResult); // nonce 1 cannot be reused for new request.
        newResult.nonce = 2;
        _deliver(newResult);
        _reject(_result(oldId)); // replay of old valid message remains rejected.
    }

    function test_independentQueuedRequestsCanArriveOutOfOrderWithoutGlobalSequence() public {
        bytes32 first = _queue();
        bytes32 second = _queue();
        G2NativeIssueResultInbox.NativeIssueResult memory later = _result(second);
        later.nonce = 2;
        _deliver(later);
        (,,,,,G2NativeIssueResultInbox.Status firstStatus,) = inbox.requests(first);
        assertEq(uint8(firstStatus), uint8(G2NativeIssueResultInbox.Status.PENDING));
        _deliver(_result(first));
        (,,,,,G2NativeIssueResultInbox.Status afterStatus,) = inbox.requests(first);
        assertEq(uint8(afterStatus), uint8(G2NativeIssueResultInbox.Status.OBSERVED));
        vm.prank(requester);
        vm.expectRevert(G2NativeIssueResultInbox.InvalidRequest.selector);
        inbox.cancelIssue(first);
    }

    function test_arbitraryOPRequestDoesNotEstablishNativePermission() public {
        vm.prank(stranger);
        bytes32 id = inbox.queueIssue("bob", member, uint64(block.timestamp + 1));
        (,,,,,G2NativeIssueResultInbox.Status state,) = inbox.requests(id);
        assertEq(uint8(state), uint8(G2NativeIssueResultInbox.Status.PENDING));
        assertFalse(inbox.currentL1AuthorityVerified());
        assertFalse(inbox.sovereignReceipt());
        vm.prank(stranger);
        vm.expectRevert(G2NativeIssueResultInbox.InvalidRequest.selector);
        inbox.queueIssue("", member, uint64(block.timestamp + 1));
        vm.prank(stranger);
        vm.expectRevert(G2NativeIssueResultInbox.InvalidRequest.selector);
        inbox.queueIssue("xn--bad", member, uint64(block.timestamp + 1));
        vm.prank(stranger);
        vm.expectRevert(G2NativeIssueResultInbox.InvalidRequest.selector);
        inbox.queueIssue("alice", address(0), uint64(block.timestamp + 1));
        vm.prank(stranger);
        vm.expectRevert(G2NativeIssueResultInbox.InvalidRequest.selector);
        inbox.queueIssue("alice", member, uint64(block.timestamp));
        vm.chainId(11155111);
        vm.prank(stranger);
        vm.expectRevert(G2NativeIssueResultInbox.InvalidRequest.selector);
        inbox.queueIssue("alice", member, uint64(block.timestamp + 1));
    }

    function test_canonicalChildHashAndAsciiLabelBoundaries() public {
        vm.prank(requester);
        bytes32 id = inbox.queueIssue("member-7", member, uint64(block.timestamp + 2 days));
        (, bytes32 actualNode,,,,,) = inbox.requests(id);
        assertEq(actualNode, keccak256(abi.encodePacked(PARENT, keccak256("member-7"))));

        bytes memory longest = new bytes(63);
        bytes memory tooLong = new bytes(64);
        for (uint256 i; i < 64; ++i) {
            tooLong[i] = "a";
            if (i < 63) longest[i] = "a";
        }
        vm.prank(requester);
        bytes32 maxId = inbox.queueIssue(string(longest), member, uint64(block.timestamp + 1 days));
        (,,,,,G2NativeIssueResultInbox.Status maxStatus,) = inbox.requests(maxId);
        assertEq(uint8(maxStatus), uint8(G2NativeIssueResultInbox.Status.PENDING));

        string[8] memory badLabels = [
            string(tooLong), "Bad", "-bad", "bad-", "ab--cd", "bad.name", "bad{", "bad:"
        ];
        for (uint256 i; i < badLabels.length; ++i) {
            vm.prank(requester);
            vm.expectRevert(G2NativeIssueResultInbox.InvalidRequest.selector);
            inbox.queueIssue(badLabels[i], member, uint64(block.timestamp + 1 days));
        }
    }

    function test_queueCannotBeDeployedWithWrongChainOrMissingIdentity() public {
        vm.expectRevert(G2NativeIssueResultInbox.InvalidConfiguration.selector);
        new G2NativeIssueResultInbox(bytes32(0), emitter);
        vm.expectRevert(G2NativeIssueResultInbox.InvalidConfiguration.selector);
        new G2NativeIssueResultInbox(PARENT, address(0));
        vm.chainId(11155111);
        vm.expectRevert(G2NativeIssueResultInbox.InvalidConfiguration.selector);
        new G2NativeIssueResultInbox(PARENT, emitter);
    }
}
