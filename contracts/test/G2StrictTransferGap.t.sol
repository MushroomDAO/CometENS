// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/G2LegacyL1NativeActionGuard.sol";
import "../src/G2RootCheckpointInbox.sol";
import "../src/G2ManagedLeaseIssuer.sol";
import "../src/L2CommunityRecordsV4.sol";
import "./LegacyL1AuthorityCheckpoint.t.sol";

/// @dev A deliberately non-native action, proving the guard's call-time ACL.
contract GuardedL1ActionFixture is G2LegacyL1NativeActionGuard {
    uint256 public acceptedActions;

    constructor(address source, bytes32 hash, bytes32 parent) G2LegacyL1NativeActionGuard(source, hash, parent) {}

    function guardedAction() external onlyCurrentLegacyNativeHolder {
        ++acceptedActions;
    }
}

contract NativeHolderContractFixture {
    function execute(GuardedL1ActionFixture guarded) external {
        guarded.guardedAction();
    }
}

contract G2StrictTransferGapTest is Test {
    address private constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address private constant WRAPPER = 0x0635513f179D50A207757E05759CbD106d7dFcE8;
    address private constant REGISTRAR = 0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85;
    address private constant L1_RELAY = address(0x9870);
    address private owner = makeAddr("original-native-holder");
    address private nextOwner = makeAddr("next-native-holder");
    address private delegate = makeAddr("old-scoped-delegate");
    address private member = makeAddr("issued-member");

    LegacyL1AuthorityCheckpoint private source;
    GuardedL1ActionFixture private guard;
    G2RootCheckpointInbox private inbox;
    G2ManagedLeaseIssuer private issuer;
    L2CommunityRecordsV4 private records;

    function setUp() public {
        vm.warp(2_000_000);
        vm.chainId(11155111);
        vm.etch(ENS, address(new LegacyRegistryFixture()).code);
        vm.etch(WRAPPER, address(new LegacyWrapperFixture()).code);
        vm.etch(REGISTRAR, address(new LegacyRegistrarFixture()).code);
        LegacyRegistryFixture(ENS).setOwner(WRAPPER);
        LegacyRegistrarFixture(REGISTRAR).setOwner(WRAPPER);
        LegacyRegistrarFixture(REGISTRAR).setExpiry(block.timestamp + 4 days);
        LegacyWrapperFixture(WRAPPER).setHolder(owner);
        LegacyWrapperFixture(WRAPPER).setExpiry(uint64(block.timestamp + 94 days));
        source = new LegacyL1AuthorityCheckpoint("community", address(0x9988), ENS.codehash, WRAPPER.codehash, REGISTRAR.codehash);
        guard = new GuardedL1ActionFixture(address(source), address(source).codehash, source.parentNode());
        vm.prank(owner);
        source.bindOrRenew(owner, 3600);

        // Model already-delivered canonical L1 checkpoint while native title
        // is still A. OP thereafter sees this snapshot, not L1's later state.
        vm.chainId(11155420);
        inbox = new G2RootCheckpointInbox(source.parentNode(), L1_RELAY);
        records = new L2CommunityRecordsV4(source.parentNode(), owner);
        issuer = new G2ManagedLeaseIssuer(
            address(inbox), address(records), L1_RELAY, address(inbox).codehash, address(records).codehash
        );
        vm.mockCall(
            inbox.OP_MESSENGER(),
            abi.encodeWithSelector(IOPCrossDomainMessenger.xDomainMessageSender.selector),
            abi.encode(L1_RELAY)
        );
        _checkpoint(owner, 1, 1, 3600);
        vm.prank(owner);
        records.proposeController(address(issuer));
        vm.prank(owner);
        issuer.acceptControl();
        uint256 capIssue = issuer.CAP_ISSUE();
        vm.prank(owner);
        issuer.grant(delegate, capIssue, 2, uint64(block.timestamp + 1800));
    }

    function _checkpoint(address controller, uint64 epoch, uint64 seq, uint64 secondsAhead) private {
        _deliverCheckpoint(controller, epoch, seq, secondsAhead, false);
    }

    function _deliverCheckpoint(address controller, uint64 epoch, uint64 seq, uint64 secondsAhead, bool rejected) private {
        G2RootCheckpointInbox.RootCheckpoint memory c = G2RootCheckpointInbox.RootCheckpoint({
            sourceChainId: 11155111,
            destinationChainId: 11155420,
            sourceAdapter: L1_RELAY,
            destinationInbox: address(inbox),
            parentNode: source.parentNode(),
            controller: controller,
            sourceEpoch: epoch,
            sequence: seq,
            leaseUntil: controller == address(0) ? 0 : uint64(block.timestamp + secondsAhead),
            l1ValidUntil: controller == address(0) ? 0 : uint64(block.timestamp + secondsAhead + 3600),
            authorityVersion: inbox.MESSAGE_VERSION()
        });
        address messenger = inbox.OP_MESSENGER();
        if (rejected) vm.expectRevert(G2RootCheckpointInbox.InvalidCheckpoint.selector);
        vm.prank(messenger);
        inbox.acceptCheckpoint(c);
    }

    function _transferL1() private {
        vm.chainId(11155111);
        LegacyWrapperFixture(WRAPPER).setHolder(nextOwner);
        (address holder,) = source.currentAuthority();
        assertEq(holder, nextOwner);
    }

    function test_strictL1GuardChecksActualHolderAtExecutionAfterTransfer() public {
        vm.chainId(11155111);
        vm.prank(owner);
        guard.guardedAction();
        assertEq(guard.acceptedActions(), 1);
        _transferL1();
        vm.prank(owner);
        vm.expectRevert(G2LegacyL1NativeActionGuard.NotCurrentNativeHolder.selector);
        guard.guardedAction();
        vm.prank(delegate);
        vm.expectRevert(G2LegacyL1NativeActionGuard.NotCurrentNativeHolder.selector);
        guard.guardedAction();
        vm.prank(nextOwner);
        guard.guardedAction();
        assertEq(guard.acceptedActions(), 2);
    }

    function test_currentNativeHolderCanBeSmartAccountAndOldEOACannotAct() public {
        vm.chainId(11155111);
        NativeHolderContractFixture wallet = new NativeHolderContractFixture();
        LegacyWrapperFixture(WRAPPER).setHolder(address(wallet));
        vm.prank(owner);
        vm.expectRevert(G2LegacyL1NativeActionGuard.NotCurrentNativeHolder.selector);
        guard.guardedAction();
        wallet.execute(guard);
        assertEq(guard.acceptedActions(), 1);
    }

    function test_previouslyDeliveredOPLeaseStillLetsOldControllerAndDelegateIssueAfterL1Transfer() public {
        _transferL1();
        vm.chainId(11155420);
        assertEq(inbox.activeController(), owner);
        assertEq(inbox.sourceEpoch(), 1);
        // EXPECTED COUNTEREXAMPLE: this succeeds with current production OP
        // code before any subsequent L1->OP freeze is delivered.
        vm.prank(owner);
        bytes32 byFormerOwner = issuer.issue("stale-controller", member, address(0));
        vm.prank(delegate);
        bytes32 byFormerDelegate = issuer.issue("stale-delegate", member, address(0));
        assertEq(records.subnodeOwner(byFormerOwner), member);
        assertEq(records.subnodeOwner(byFormerDelegate), member);
        assertEq(inbox.sourceEpoch(), 1);

        // Delivery (if it happens) eventually freezes both routes.
        _checkpoint(address(0), 2, 2, 0);
        vm.prank(owner);
        vm.expectRevert(G2ManagedLeaseIssuer.LeaseInactive.selector);
        issuer.issue("late-controller", member, address(0));
        vm.prank(delegate);
        vm.expectRevert(G2ManagedLeaseIssuer.LeaseInactive.selector);
        issuer.issue("late-delegate", member, address(0));
    }

    function test_transferWindowAllowsFormerHolderToCreateNewIssuingDelegate() public {
        _transferL1();
        vm.chainId(11155420);
        address lateDelegate = makeAddr("delegate-created-after-native-transfer");
        uint256 capIssue = issuer.CAP_ISSUE();
        vm.prank(owner);
        issuer.grant(lateDelegate, capIssue, 2, uint64(block.timestamp + 1800));
        // Counterexample: privileges can expand AFTER native transfer, not
        // merely survive as a grant created while the owner was legitimate.
        vm.prank(lateDelegate);
        bytes32 node = issuer.issue("post-transfer-grant", member, address(0));
        assertEq(records.subnodeOwner(node), member);
        assertEq(issuer.grantorOf(lateDelegate), owner);
        (, uint64 quota,, uint64 epoch) = issuer.grants(lateDelegate);
        assertEq(quota, 1);
        assertEq(epoch, 1);

        _checkpoint(address(0), 2, 2, 0);
        vm.prank(owner);
        vm.expectRevert(G2ManagedLeaseIssuer.LeaseInactive.selector);
        issuer.grant(lateDelegate, capIssue, 9, uint64(block.timestamp + 1800));
        vm.prank(lateDelegate);
        vm.expectRevert(G2ManagedLeaseIssuer.LeaseInactive.selector);
        issuer.issue("post-freeze-grant", member, address(0));
        assertEq(records.subnodeOwner(node), member);
    }

    function test_freezeRejectsDelayedCheckpointsAndNewEpochDoesNotReviveOldGrant() public {
        _transferL1();
        vm.chainId(11155420);
        vm.prank(delegate);
        bytes32 node = issuer.issue("before-freeze", member, address(0));
        _checkpoint(address(0), 2, 2, 0);
        // Reject reordered sequence, old epoch even with a fresh sequence,
        // and an attempted unfreeze without an epoch advance.
        _deliverCheckpoint(owner, 1, 1, 3600, true);
        _deliverCheckpoint(owner, 1, 3, 3600, true);
        _deliverCheckpoint(owner, 2, 3, 3600, true);
        assertEq(inbox.activeController(), address(0));
        assertEq(inbox.sequence(), 2);
        assertEq(inbox.sourceEpoch(), 2);

        _checkpoint(nextOwner, 3, 3, 3600);
        vm.prank(owner);
        vm.expectRevert(G2ManagedLeaseIssuer.Unauthorized.selector);
        issuer.issue("former-holder", member, address(0));
        vm.prank(delegate);
        vm.expectRevert(G2ManagedLeaseIssuer.Unauthorized.selector);
        issuer.issue("former-delegate", member, address(0));
        (, uint64 quota,, uint64 epoch) = issuer.grants(delegate);
        assertEq(quota, 1);
        assertEq(epoch, 1);
        vm.prank(nextOwner);
        bytes32 fresh = issuer.issue("new-holder", member, address(0));
        assertEq(records.subnodeOwner(fresh), member);
        assertEq(records.subnodeOwner(node), member);
    }

    function test_guardRejectsExpiryNetworkAndRuntimeMismatch() public {
        vm.chainId(11155111);
        LegacyRegistrarFixture(REGISTRAR).setExpiry(block.timestamp + 24 hours);
        vm.prank(owner);
        vm.expectRevert(G2LegacyL1NativeActionGuard.NotCurrentNativeHolder.selector);
        guard.guardedAction();
        LegacyRegistrarFixture(REGISTRAR).setExpiry(block.timestamp + 4 days);
        vm.chainId(11155420);
        vm.prank(owner);
        vm.expectRevert(G2LegacyL1NativeActionGuard.WrongChain.selector);
        guard.guardedAction();
        vm.chainId(11155111);
        vm.etch(address(source), hex"60006000fd");
        vm.prank(owner);
        vm.expectRevert(G2LegacyL1NativeActionGuard.InvalidNativeSource.selector);
        guard.guardedAction();
    }

    function test_guardRejectsWrongPinnedParentAndSource() public {
        vm.chainId(11155111);
        bytes32 parent = source.parentNode();
        bytes32 sourceHash = address(source).codehash;
        vm.expectRevert(G2LegacyL1NativeActionGuard.InvalidNativeSource.selector);
        new GuardedL1ActionFixture(address(source), sourceHash, bytes32(uint256(123)));
        vm.expectRevert(G2LegacyL1NativeActionGuard.InvalidNativeSource.selector);
        new GuardedL1ActionFixture(address(source), bytes32(uint256(123)), parent);
        vm.expectRevert(G2LegacyL1NativeActionGuard.InvalidNativeSource.selector);
        new GuardedL1ActionFixture(address(0), bytes32(uint256(123)), parent);
    }
    function _rejectDelayedPositive(address controller, uint64 epoch) private {
        G2RootCheckpointInbox.RootCheckpoint memory c = G2RootCheckpointInbox.RootCheckpoint({
            sourceChainId: 11155111, destinationChainId: 11155420,
            sourceAdapter: L1_RELAY, destinationInbox: address(inbox),
            parentNode: source.parentNode(), controller: controller,
            sourceEpoch: epoch, sequence: 4,
            leaseUntil: uint64(block.timestamp + 3600),
            l1ValidUntil: uint64(block.timestamp + 7200),
            authorityVersion: inbox.MESSAGE_VERSION()
        });
        vm.prank(inbox.OP_MESSENGER());
        vm.expectRevert(G2RootCheckpointInbox.InvalidCheckpoint.selector);
        inbox.acceptCheckpoint(c);
    }

    function test_delayedPositiveCheckpointCannotResurrectAfterAuthenticatedFreeze() public {
        _transferL1();
        vm.chainId(11155420);
        assertEq(inbox.activeController(), owner);
        _checkpoint(address(0), 2, 2, 0);
        assertEq(inbox.activeController(), address(0));
        vm.prank(owner);
        vm.expectRevert(G2ManagedLeaseIssuer.LeaseInactive.selector);
        issuer.issue("blocked-after-freeze", member, address(0));
        _rejectDelayedPositive(owner, 1);
        _rejectDelayedPositive(owner, 2);
        assertEq(inbox.activeController(), address(0));
    }

}
