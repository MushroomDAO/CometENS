// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/G2LegacyL1NativeResultRelay.sol";
import "./G2LegacyL1NativeIssuerProof.t.sol";

contract NativeResultMessengerFixture {
    address public target;
    bytes public payload;
    uint32 public gasLimit;
    uint256 public sends;
    bool public failSend;
    address public callbackWrapper;
    address public callbackNewHolder;

    function setFail(bool value) external { failSend = value; }
    function setCallbackTransfer(address wrapper, address nextHolder) external {
        callbackWrapper = wrapper;
        callbackNewHolder = nextHolder;
    }

    function sendMessage(address dest, bytes calldata data, uint32 gas_) external {
        require(!failSend, "messenger unavailable");
        target = dest;
        payload = data;
        gasLimit = gas_;
        sends++;
        if (callbackWrapper != address(0)) {
            NativeIssueWrapperFixture(callbackWrapper).setHolder(callbackNewHolder);
        }
    }
}

contract G2LegacyL1NativeResultRelayTest is Test {
    address private constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address private constant WRAPPER = 0x0635513f179D50A207757E05759CbD106d7dFcE8;
    address private constant REGISTRAR = 0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85;
    address private constant INBOX = address(0x9876);
    bytes32 private constant PARENT = 0x220302cfbfda77f912157d62bd2a0d4553d6d73e677960d357c09235621436f8;

    address private holder = makeAddr("parent owner");
    address private nextHolder = makeAddr("new parent owner");
    address private member = makeAddr("child member");
    address private requester = makeAddr("OP requester");
    address private badRequester = makeAddr("foreign requester");
    address private resolver = makeAddr("resolver");

    NativeResultMessengerFixture private messenger;
    NativeIssueWrapperFixture private wrapper;
    NativeIssueRegistryFixture private registry;
    G2LegacyL1NativeResultRelay private relay;
    G2NativeIssueResultInbox private inbox;
    uint64 private childExpiry;
    bytes32 private queuedId;

    function setUp() public {
        vm.chainId(11155111);
        vm.warp(2_000_000);
        vm.etch(ENS, address(new NativeIssueRegistryFixture()).code);
        vm.etch(WRAPPER, address(new NativeIssueWrapperFixture(PARENT, ENS)).code);
        vm.etch(REGISTRAR, address(new LegacyRegistrarFixture()).code);
        registry = NativeIssueRegistryFixture(ENS);
        wrapper = NativeIssueWrapperFixture(WRAPPER);
        registry.setRecord(PARENT, WRAPPER, address(0));
        LegacyRegistrarFixture(REGISTRAR).setOwner(WRAPPER);
        LegacyRegistrarFixture(REGISTRAR).setExpiry(block.timestamp + 4 days);
        wrapper.setHolder(holder);
        wrapper.setParentFuses(1);
        wrapper.setParentExpiry(uint64(block.timestamp + 94 days));
        LegacyL1AuthorityCheckpoint source = new LegacyL1AuthorityCheckpoint(
            "community", INBOX, ENS.codehash, WRAPPER.codehash, REGISTRAR.codehash
        );
        messenger = new NativeResultMessengerFixture();
        relay = new G2LegacyL1NativeResultRelay(
            address(source), address(source).codehash, PARENT,
            address(messenger), address(messenger).codehash, INBOX
        );
        vm.prank(holder);
        wrapper.setApprovalForAll(address(relay), true);
        childExpiry = uint64(block.timestamp + 2 days);

        // Local fixture simulates OP chain state using the same EVM test process.
        vm.chainId(11155420);
        G2NativeIssueResultInbox deployed = new G2NativeIssueResultInbox(PARENT, address(relay));
        vm.etch(INBOX, address(deployed).code);
        inbox = G2NativeIssueResultInbox(INBOX);
        vm.mockCall(
            inbox.OP_MESSENGER(),
            abi.encodeWithSelector(INativeResultOPMessenger.xDomainMessageSender.selector),
            abi.encode(address(relay))
        );
        vm.prank(requester);
        queuedId = inbox.queueIssue("alice", member, childExpiry);
        vm.chainId(11155111);
    }

    function _issue(address opRequester, uint256 nonce) private returns (bytes32) {
        vm.prank(holder);
        return relay.issueAndRelay("alice", member, resolver, childExpiry, opRequester, nonce, 300_000);
    }

    function _child() private pure returns (bytes32) {
        return keccak256(abi.encodePacked(PARENT, keccak256("alice")));
    }

    function test_atomicNativeIssueEmitsExactBoundMessageAndOPProvisionalResult() public {
        bytes32 id = _issue(requester, 1);
        assertEq(id, queuedId);
        assertTrue(relay.sentRequest(id));
        assertEq(registry.owner(_child()), WRAPPER);
        assertEq(wrapper.ownerOf(uint256(_child())), member);
        assertEq(messenger.sends(), 1);
        assertEq(messenger.target(), INBOX);
        assertEq(messenger.gasLimit(), 300_000);

        bytes memory payload = messenger.payload();
        assertEq(bytes4(payload), inbox.observeResult.selector);
        vm.chainId(11155420);
        vm.prank(inbox.OP_MESSENGER());
        (bool ok,) = INBOX.call(payload);
        assertTrue(ok, "authenticated OP provisional mirror failed");
        (,,,,,G2NativeIssueResultInbox.Status status, uint64 sourceBlock) = inbox.requests(queuedId);
        assertEq(uint8(status), uint8(G2NativeIssueResultInbox.Status.OBSERVED));
        assertEq(sourceBlock, uint64(block.number));
        assertFalse(inbox.sovereignReceipt());
        assertFalse(inbox.finalizedL1IssuanceVerified());
        assertFalse(inbox.currentL1AuthorityVerified());
        vm.prank(inbox.OP_MESSENGER());
        (bool replay,) = INBOX.call(payload);
        assertFalse(replay, "same canonical messenger payload replayed");
    }

    function test_noNativeIssueIfMessengerFailsAndNoRequestConsumed() public {
        messenger.setFail(true);
        vm.prank(holder);
        vm.expectRevert(bytes("messenger unavailable"));
        relay.issueAndRelay("alice", member, resolver, childExpiry, requester, 1, 300_000);
        assertEq(registry.owner(_child()), address(0));
        assertEq(wrapper.ownerOf(uint256(_child())), address(0));
        assertFalse(relay.sentRequest(queuedId));
        messenger.setFail(false);
        _issue(requester, 1);
        assertEq(messenger.sends(), 1);
    }

    function test_nativeHolderTransferImmediatelyBlocksOldRequesterDespiteQueuedOPIntent() public {
        wrapper.setHolder(nextHolder);
        vm.prank(holder);
        vm.expectRevert(G2LegacyL1NativeActionGuard.NotCurrentNativeHolder.selector);
        relay.issueAndRelay("alice", member, resolver, childExpiry, requester, 1, 300_000);
        assertEq(registry.owner(_child()), address(0));
        assertEq(messenger.sends(), 0);
        vm.prank(nextHolder);
        wrapper.setApprovalForAll(address(relay), true);
        vm.prank(nextHolder);
        relay.issueAndRelay("alice", member, resolver, childExpiry, requester, 1, 300_000);
        assertEq(messenger.sends(), 1);
    }

    function test_wrongOpRequestBindingStillIssuesNativeButCannotMarkAnotherOPRequest() public {
        bytes32 id = _issue(badRequester, 1);
        assertTrue(id != queuedId);
        assertEq(registry.owner(_child()), WRAPPER);
        vm.chainId(11155420);
        vm.prank(inbox.OP_MESSENGER());
        (bool accepted,) = INBOX.call(messenger.payload());
        assertFalse(accepted, "nonmatching OP queue consumed");
        (,,,,,G2NativeIssueResultInbox.Status status,) = inbox.requests(queuedId);
        assertEq(uint8(status), uint8(G2NativeIssueResultInbox.Status.PENDING));
    }

    function test_nativeIssueValidationGasBoundsAndWrongChainFailClosed() public {
        vm.prank(holder);
        vm.expectRevert(G2LegacyL1NativeResultRelay.InvalidRelayRequest.selector);
        relay.issueAndRelay("alice", member, resolver, childExpiry, requester, 0, 300_000);
        vm.prank(holder);
        vm.expectRevert(G2LegacyL1NativeResultRelay.InvalidRelayRequest.selector);
        relay.issueAndRelay("alice", member, resolver, childExpiry, address(0), 1, 300_000);
        vm.prank(holder);
        vm.expectRevert(G2LegacyL1NativeResultRelay.InvalidRelayRequest.selector);
        relay.issueAndRelay("alice", member, resolver, childExpiry, requester, 1, 0);
        vm.prank(holder);
        vm.expectRevert(G2LegacyL1NativeResultRelay.InvalidRelayRequest.selector);
        relay.issueAndRelay("alice", member, resolver, childExpiry, requester, 1, 2_000_001);
        vm.chainId(11155420);
        vm.prank(holder);
        vm.expectRevert(G2LegacyL1NativeActionGuard.WrongChain.selector);
        relay.issueAndRelay("alice", member, resolver, childExpiry, requester, 1, 300_000);
    }

    function test_nativeResultSenderCannotBeReplacedAndParentCallbackMustRemainAuthorized() public {
        vm.etch(address(messenger), hex"60006000fd");
        vm.prank(holder);
        vm.expectRevert(G2LegacyL1NativeResultRelay.RelayIdentityChanged.selector);
        relay.issueAndRelay("alice", member, resolver, childExpiry, requester, 1, 300_000);
        assertEq(registry.owner(_child()), address(0));
    }

    function test_parentTransferDuringL1MessengerCallbackRevertsNativeMintAndQueuedMessage() public {
        messenger.setCallbackTransfer(WRAPPER, nextHolder);
        vm.prank(holder);
        vm.expectRevert(G2LegacyL1NativeActionGuard.NotCurrentNativeHolder.selector);
        relay.issueAndRelay("alice", member, resolver, childExpiry, requester, 1, 300_000);
        assertEq(wrapper.ownerOf(uint256(PARENT)), holder);
        assertEq(registry.owner(_child()), address(0));
        assertFalse(relay.sentRequest(queuedId));
        assertEq(messenger.sends(), 0, "messenger state rolled back with native issue");
    }
}
