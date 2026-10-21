// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/G2LegacyL1CheckpointRelay.sol";
import "./LegacyL1AuthorityCheckpoint.t.sol";

contract MockL1CrossDomainMessenger {
    address public lastTarget;
    bytes public lastMessage;
    uint32 public lastGas;
    uint256 public sends;
    bool public mustRevert;
    G2LegacyL1CheckpointRelay public reentryTarget;

    function setMustRevert(bool value) external {
        mustRevert = value;
    }

    function setReentry(G2LegacyL1CheckpointRelay relay) external {
        reentryTarget = relay;
    }

    function sendMessage(address target, bytes calldata message, uint32 minGasLimit) external {
        require(!mustRevert, "mock messenger failed");
        lastTarget = target;
        lastMessage = message;
        lastGas = minGasLimit;
        ++sends;
        if (address(reentryTarget) != address(0)) {
            (bool ok,) = address(reentryTarget).call(abi.encodeCall(reentryTarget.relay, (minGasLimit)));
            require(!ok, "duplicate reentry accepted");
        }
    }
}

contract G2LegacyL1CheckpointRelayTest is Test {
    address private constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address private constant WRAPPER = 0x0635513f179D50A207757E05759CbD106d7dFcE8;
    address private constant REGISTRAR = 0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85;
    address private constant INBOX = address(0x9876);

    address private holder = makeAddr("original-owner");
    address private nextHolder = makeAddr("new-owner");
    address private controller = makeAddr("managed-controller");
    address private stranger = makeAddr("stranger");
    LegacyL1AuthorityCheckpoint private source;
    G2LegacyL1CheckpointRelay private relayAdapter;
    MockL1CrossDomainMessenger private messenger;

    function setUp() public {
        vm.chainId(11155111);
        vm.warp(2_000_000);
        vm.etch(ENS, address(new LegacyRegistryFixture()).code);
        vm.etch(WRAPPER, address(new LegacyWrapperFixture()).code);
        vm.etch(REGISTRAR, address(new LegacyRegistrarFixture()).code);
        LegacyRegistryFixture(ENS).setOwner(WRAPPER);
        LegacyRegistrarFixture(REGISTRAR).setOwner(WRAPPER);
        LegacyRegistrarFixture(REGISTRAR).setExpiry(block.timestamp + 3 days);
        LegacyWrapperFixture(WRAPPER).setHolder(holder);
        LegacyWrapperFixture(WRAPPER).setExpiry(uint64(block.timestamp + 93 days));
        source = new LegacyL1AuthorityCheckpoint("community", INBOX, ENS.codehash, WRAPPER.codehash, REGISTRAR.codehash);
        messenger = new MockL1CrossDomainMessenger();
        relayAdapter = new G2LegacyL1CheckpointRelay(
            address(source),
            address(source).codehash,
            address(messenger),
            address(messenger).codehash,
            INBOX,
            source.parentNode()
        );
    }

    function _bind(uint64 secondsToLease) private {
        vm.prank(holder);
        source.bindOrRenew(controller, secondsToLease);
    }

    function _sent() private view returns (G2RootCheckpointInbox.RootCheckpoint memory c) {
        bytes memory message = messenger.lastMessage();
        assertEq(bytes4(message), G2RootCheckpointInbox.acceptCheckpoint.selector);
        c = abi.decode(_slice(message, 4), (G2RootCheckpointInbox.RootCheckpoint));
    }

    function _slice(bytes memory full, uint256 skip) private pure returns (bytes memory out) {
        out = new bytes(full.length - skip);
        for (uint256 i; i < out.length; ++i) {
            out[i] = full[skip + i];
        }
    }

    function test_permissionlessRelayEncodesCanonicalInboxSenderAndDomains() public {
        _bind(3600);
        vm.prank(stranger);
        relayAdapter.relay(250_000);
        assertEq(messenger.sends(), 1);
        assertEq(messenger.lastTarget(), INBOX);
        assertEq(messenger.lastGas(), 250_000);
        G2RootCheckpointInbox.RootCheckpoint memory c = _sent();
        assertEq(c.sourceAdapter, address(relayAdapter));
        assertTrue(c.sourceAdapter != address(source));
        assertEq(c.destinationInbox, INBOX);
        assertEq(c.parentNode, source.parentNode());
        assertEq(c.authorityVersion, relayAdapter.VERSION());
        assertEq(c.sourceChainId, 11155111);
        assertEq(c.destinationChainId, 11155420);
        assertEq(c.controller, controller);
        assertEq(c.sequence, 1);
        assertEq(c.sourceEpoch, 1);
        assertEq(c.leaseUntil, uint64(block.timestamp + 3600));
        assertEq(relayAdapter.lastSentSequence(), 1);

        // OP-side mock of canonical xDomainMessageSender: must equal L1 relay.
        vm.chainId(11155420);
        G2RootCheckpointInbox deployed = new G2RootCheckpointInbox(c.parentNode, address(relayAdapter));
        vm.etch(INBOX, address(deployed).code);
        bytes memory payload = messenger.lastMessage();
        vm.prank(stranger);
        vm.expectRevert(G2RootCheckpointInbox.UnauthorizedMessenger.selector);
        G2RootCheckpointInbox(INBOX).acceptCheckpoint(c);
        vm.mockCall(
            G2RootCheckpointInbox(INBOX).OP_MESSENGER(),
            abi.encodeWithSelector(IOPCrossDomainMessenger.xDomainMessageSender.selector),
            abi.encode(address(source)) // signed source is not the cross-domain sender.
        );
        vm.prank(G2RootCheckpointInbox(INBOX).OP_MESSENGER());
        vm.expectRevert(G2RootCheckpointInbox.UnauthorizedMessenger.selector);
        G2RootCheckpointInbox(INBOX).acceptCheckpoint(c);
        vm.mockCall(
            G2RootCheckpointInbox(INBOX).OP_MESSENGER(),
            abi.encodeWithSelector(IOPCrossDomainMessenger.xDomainMessageSender.selector),
            abi.encode(address(relayAdapter))
        );
        vm.prank(G2RootCheckpointInbox(INBOX).OP_MESSENGER());
        (bool accepted,) = INBOX.call(payload);
        assertTrue(accepted);
        assertEq(G2RootCheckpointInbox(INBOX).activeController(), controller);
        assertFalse(G2RootCheckpointInbox(INBOX).sovereignReceipt());
        vm.warp(block.timestamp + 3600);
        assertEq(G2RootCheckpointInbox(INBOX).activeController(), address(0));
    }

    function test_duplicateAndFailedMessengerCannotConsumeSourceState() public {
        _bind(3600);
        messenger.setMustRevert(true);
        vm.expectRevert("mock messenger failed");
        relayAdapter.relay(250_000);
        assertEq(relayAdapter.lastSentSequence(), 0);
        messenger.setMustRevert(false);
        messenger.setReentry(relayAdapter);
        relayAdapter.relay(250_000);
        assertEq(relayAdapter.lastSentSequence(), 1);
        vm.expectRevert(G2LegacyL1CheckpointRelay.InvalidCheckpoint.selector);
        relayAdapter.relay(250_000);
        vm.prank(holder);
        source.bindOrRenew(controller, 3600);
        relayAdapter.relay(250_000);
        assertEq(relayAdapter.lastSentSequence(), 2);
        assertEq(messenger.sends(), 2);
    }

    function test_holderTransferAutomaticallyFreezesThenPreventsPositive() public {
        _bind(3600);
        relayAdapter.relay(250_000);
        LegacyWrapperFixture(WRAPPER).setHolder(nextHolder);
        // An earlier positive lease on OP is not magically withdrawn by transfer.
        assertEq(relayAdapter.lastSentSequence(), 1);
        vm.prank(stranger);
        relayAdapter.relay(250_000);
        G2RootCheckpointInbox.RootCheckpoint memory c = _sent();
        assertEq(c.controller, address(0));
        assertEq(c.leaseUntil, 0);
        assertEq(c.l1ValidUntil, 0);
        assertEq(c.sourceEpoch, 2);
        assertEq(c.sequence, 2);
        assertEq(relayAdapter.lastSentSequence(), 2);
        vm.expectRevert(G2LegacyL1CheckpointRelay.InvalidCheckpoint.selector);
        relayAdapter.relay(250_000);
        vm.prank(nextHolder);
        source.bindOrRenew(controller, 600);
        relayAdapter.relay(250_000);
        assertEq(_sent().sourceEpoch, 3);
        assertEq(relayAdapter.lastSentSequence(), 3);
    }

    function test_expiredSourceLeaseCannotBeRelayedOrExtended() public {
        _bind(60);
        vm.warp(block.timestamp + 60);
        vm.expectRevert(G2LegacyL1CheckpointRelay.InvalidCheckpoint.selector);
        relayAdapter.relay(250_000);
        assertEq(relayAdapter.lastSentSequence(), 0);
        vm.prank(holder);
        source.bindOrRenew(controller, 120);
        relayAdapter.relay(250_000);
        assertEq(_sent().leaseUntil, uint64(block.timestamp + 120));
    }

    function test_registrarExpiryReductionCannotExtendOldPositiveState() public {
        _bind(3600);
        // Lease still has one hour, but the current native validity became
        // shorter than the source's previously recorded native validity.
        LegacyRegistrarFixture(REGISTRAR).setExpiry(block.timestamp + 24 hours + 1800);
        vm.expectRevert(G2LegacyL1CheckpointRelay.InvalidCheckpoint.selector);
        relayAdapter.relay(250_000);
        assertEq(relayAdapter.lastSentSequence(), 0);
        LegacyRegistrarFixture(REGISTRAR).setExpiry(block.timestamp - 1);
        relayAdapter.relay(250_000);
        assertEq(_sent().controller, address(0));
        assertEq(relayAdapter.lastSentSequence(), 2);
    }

    function test_migrationLikeCustodyChangeSendsOnlyFreeze() public {
        _bind(3600);
        LegacyRegistryFixture(ENS).setOwner(nextHolder);
        relayAdapter.relay(250_000);
        assertEq(_sent().controller, address(0));
        assertEq(_sent().sourceEpoch, 2);
    }

    function test_wrongGasChainMessengerAndRuntimePinsFailClosed() public {
        _bind(3600);
        vm.expectRevert(G2LegacyL1CheckpointRelay.InvalidGasLimit.selector);
        relayAdapter.relay(0);
        vm.expectRevert(G2LegacyL1CheckpointRelay.InvalidGasLimit.selector);
        relayAdapter.relay(2_000_001);
        vm.chainId(1);
        vm.expectRevert(G2LegacyL1CheckpointRelay.WrongChain.selector);
        relayAdapter.relay(250_000);
        vm.chainId(11155111);
        vm.etch(address(messenger), hex"60006000fd");
        vm.expectRevert(G2LegacyL1CheckpointRelay.IdentityChanged.selector);
        relayAdapter.relay(250_000);
        vm.etch(address(messenger), address(new MockL1CrossDomainMessenger()).code);
        vm.etch(address(source), hex"60006000fd");
        vm.expectRevert(G2LegacyL1CheckpointRelay.IdentityChanged.selector);
        relayAdapter.relay(250_000);
    }

    function test_wrongSourceIdentityParentOrDestinationRejected() public {
        bytes32 sourceHash = address(source).codehash;
        bytes32 messengerHash = address(messenger).codehash;
        bytes32 parent = source.parentNode();
        vm.expectRevert(G2LegacyL1CheckpointRelay.IdentityChanged.selector);
        new G2LegacyL1CheckpointRelay(
            address(source), bytes32(uint256(1)), address(messenger), messengerHash, INBOX, parent
        );

        vm.expectRevert(G2LegacyL1CheckpointRelay.InvalidConfiguration.selector);
        new G2LegacyL1CheckpointRelay(
            address(source), sourceHash, address(messenger), messengerHash, INBOX, bytes32(uint256(1))
        );

        vm.expectRevert(G2LegacyL1CheckpointRelay.InvalidConfiguration.selector);
        new G2LegacyL1CheckpointRelay(
            address(source), sourceHash, address(messenger), messengerHash, address(0x123), parent
        );

        LegacyL1AuthorityCheckpoint alternative =
            new LegacyL1AuthorityCheckpoint("different", INBOX, ENS.codehash, WRAPPER.codehash, REGISTRAR.codehash);
        bytes32 alternativeHash = address(alternative).codehash;
        vm.expectRevert(G2LegacyL1CheckpointRelay.InvalidConfiguration.selector);
        new G2LegacyL1CheckpointRelay(
            address(alternative), alternativeHash, address(messenger), messengerHash, INBOX, parent
        );
    }
}
