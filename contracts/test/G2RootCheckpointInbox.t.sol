// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/G2RootCheckpointInbox.sol";

contract G2RootCheckpointInboxTest is Test {
    bytes32 private constant ROOT = keccak256("one-community.eth");
    address private adapter = makeAddr("native-l1-authority-adapter");
    address private holder = makeAddr("community-multisig");
    address private stranger = makeAddr("stranger");
    G2RootCheckpointInbox private inbox;

    function setUp() public {
        vm.chainId(11155420);
        vm.warp(1_000_000);
        inbox = new G2RootCheckpointInbox(ROOT, adapter);
        _messengerSender(adapter);
    }

    function _messengerSender(address source) internal {
        vm.mockCall(
            inbox.OP_MESSENGER(),
            abi.encodeWithSelector(IOPCrossDomainMessenger.xDomainMessageSender.selector),
            abi.encode(source)
        );
    }

    function _checkpoint() internal view returns (G2RootCheckpointInbox.RootCheckpoint memory c) {
        c = G2RootCheckpointInbox.RootCheckpoint({
            sourceChainId: 11155111,
            destinationChainId: 11155420,
            sourceAdapter: adapter,
            destinationInbox: address(inbox),
            parent: ROOT,
            controller: holder,
            epoch: 1,
            sequence: 1,
            validUntil: uint64(block.timestamp + 100),
            l1ValidUntil: uint64(block.timestamp + 200),
            version: inbox.MESSAGE_VERSION()
        });
    }

    function _deliver(G2RootCheckpointInbox.RootCheckpoint memory c) internal {
        vm.prank(inbox.OP_MESSENGER());
        inbox.acceptCheckpoint(c);
    }

    function _reject(G2RootCheckpointInbox.RootCheckpoint memory c) internal {
        vm.prank(inbox.OP_MESSENGER());
        vm.expectRevert(G2RootCheckpointInbox.InvalidCheckpoint.selector);
        inbox.acceptCheckpoint(c);
    }

    function test_explicitManagedOnlyAndShortLease() public {
        assertFalse(inbox.sovereignReceipt());
        assertFalse(inbox.l1OwnershipVerified());
        assertEq(inbox.parentNode(), ROOT);
        _deliver(_checkpoint());
        assertEq(inbox.activeController(), holder);
        assertEq(inbox.sequence(), 1);
        vm.warp(block.timestamp + 100);
        assertEq(inbox.activeController(), address(0));
        // An old snapshot is NOT native L1 ownership after the lease expires.
        assertEq(inbox.rootController(), holder);
    }

    function test_rejectsUntrustedMessengerOrWrongL1Sender() public {
        G2RootCheckpointInbox.RootCheckpoint memory c = _checkpoint();
        vm.prank(stranger);
        vm.expectRevert(G2RootCheckpointInbox.UnauthorizedMessenger.selector);
        inbox.acceptCheckpoint(c);

        _messengerSender(stranger);
        vm.prank(inbox.OP_MESSENGER());
        vm.expectRevert(G2RootCheckpointInbox.UnauthorizedMessenger.selector);
        inbox.acceptCheckpoint(c);
        _messengerSender(adapter);
        _deliver(c);
    }

    function test_wrongChainOrDestinationOrVersionRejected() public {
        G2RootCheckpointInbox.RootCheckpoint memory c = _checkpoint();
        c.sourceChainId = 1;
        _reject(c);
        c = _checkpoint();
        c.destinationChainId = 10;
        _reject(c);
        c = _checkpoint();
        c.sourceAdapter = stranger;
        _reject(c);
        c = _checkpoint();
        c.destinationInbox = stranger;
        _reject(c);
        c = _checkpoint();
        c.parent = bytes32(uint256(1));
        _reject(c);
        c = _checkpoint();
        c.version = bytes32(uint256(1));
        _reject(c);
        c = _checkpoint();
        vm.chainId(10);
        _reject(c);
    }

    function test_invalidLeaseAndImpossibleExpiryRejected() public {
        G2RootCheckpointInbox.RootCheckpoint memory c = _checkpoint();
        c.validUntil = uint64(block.timestamp);
        _reject(c);
        c = _checkpoint();
        c.validUntil = uint64(block.timestamp + 2 hours + 1);
        c.l1ValidUntil = uint64(block.timestamp + 1 days);
        _reject(c);
        c = _checkpoint();
        c.l1ValidUntil = c.validUntil - 1;
        _reject(c);
        c = _checkpoint();
        c.controller = address(0);
        _reject(c);
    }

    function test_noReplayOutOfOrderOrControllerSwapWithoutEpoch() public {
        _deliver(_checkpoint());
        _reject(_checkpoint());
        G2RootCheckpointInbox.RootCheckpoint memory c = _checkpoint();
        c.sequence = 2;
        c.epoch = 0;
        _reject(c);
        c = _checkpoint();
        c.sequence = 2;
        c.controller = stranger;
        _reject(c);
        c.epoch = 2;
        _deliver(c);
        assertEq(inbox.activeController(), stranger);
        c.sequence = 3;
        c.epoch = 1;
        _reject(c);
        c.sequence = 3;
        c.epoch = 2;
        c.controller = holder;
        _reject(c);
    }

    function test_authenticatedFreezeInvalidatesActiveControllerAndOldMessages() public {
        _deliver(_checkpoint());
        G2RootCheckpointInbox.RootCheckpoint memory c = _checkpoint();
        c.controller = address(0);
        c.validUntil = 0;
        c.l1ValidUntil = 0;
        c.epoch = 2;
        c.sequence = 2;
        _deliver(c);
        assertEq(inbox.activeController(), address(0));
        c = _checkpoint();
        c.sequence = 3;
        _reject(c); // old source epoch cannot resurrect controller
        c.epoch = 3;
        c.sequence = 3;
        _deliver(c);
        assertEq(inbox.activeController(), holder);
    }

    function test_constructorBindsOPSepoliaAndNonzeroSource() public {
        vm.expectRevert(G2RootCheckpointInbox.InvalidCheckpoint.selector);
        new G2RootCheckpointInbox(bytes32(0), adapter);
        vm.expectRevert(G2RootCheckpointInbox.InvalidCheckpoint.selector);
        new G2RootCheckpointInbox(ROOT, address(0));
        vm.chainId(10);
        vm.expectRevert(G2RootCheckpointInbox.InvalidCheckpoint.selector);
        new G2RootCheckpointInbox(ROOT, adapter);
    }
}
