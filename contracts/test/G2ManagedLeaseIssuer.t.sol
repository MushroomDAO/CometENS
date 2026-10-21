// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/L2CommunityRecordsV4.sol";
import "../src/G2RootCheckpointInbox.sol";
import "../src/G2ManagedLeaseIssuer.sol";

contract G2ManagedLeaseIssuerTest is Test {
    bytes32 private constant ROOT = keccak256("example-community.eth");
    address private owner = makeAddr("active-native-holder");
    address private rotatedOwner = makeAddr("new-native-holder");
    address private l1Adapter = makeAddr("pinned-l1-adapter");
    address private delegated = makeAddr("scoped-op-delegate");
    address private staleV4Delegate = makeAddr("old-v4-operator");
    address private member = makeAddr("member");
    address private hostile = makeAddr("hostile");

    G2RootCheckpointInbox private inbox;
    L2CommunityRecordsV4 private records;
    G2ManagedLeaseIssuer private issuer;

    function setUp() public {
        vm.chainId(11155420);
        vm.warp(1_000_000);
        inbox = new G2RootCheckpointInbox(ROOT, l1Adapter);
        records = new L2CommunityRecordsV4(ROOT, owner);
        issuer = new G2ManagedLeaseIssuer(
            address(inbox), address(records), l1Adapter, address(inbox).codehash, address(records).codehash
        );

        // An earlier deployment operator must become ineffective on control
        // handoff: direct V4 grants otherwise bypass the outer OP lease guard.
        vm.prank(owner);
        records.grantOperator(staleV4Delegate, 1, 3, uint64(block.timestamp + 1000));
        vm.prank(owner);
        records.proposeController(address(issuer));

        vm.mockCall(
            inbox.OP_MESSENGER(),
            abi.encodeWithSelector(IOPCrossDomainMessenger.xDomainMessageSender.selector),
            abi.encode(l1Adapter)
        );
        _checkpoint(1, 1, owner, 3600);
        vm.prank(hostile);
        vm.expectRevert(G2ManagedLeaseIssuer.Unauthorized.selector);
        issuer.acceptControl();
        vm.prank(owner);
        issuer.acceptControl();
    }

    function _checkpoint(uint64 epoch, uint64 sequence, address controller, uint64 secondsAhead) private {
        G2RootCheckpointInbox.RootCheckpoint memory cp = G2RootCheckpointInbox.RootCheckpoint({
            sourceChainId: 11155111,
            destinationChainId: 11155420,
            sourceAdapter: l1Adapter,
            destinationInbox: address(inbox),
            parentNode: ROOT,
            controller: controller,
            sourceEpoch: epoch,
            sequence: sequence,
            leaseUntil: controller == address(0) ? 0 : uint64(block.timestamp + secondsAhead),
            l1ValidUntil: controller == address(0) ? 0 : uint64(block.timestamp + secondsAhead + 3600),
            authorityVersion: inbox.MESSAGE_VERSION()
        });
        vm.prank(inbox.OP_MESSENGER());
        inbox.acceptCheckpoint(cp);
    }

    function _grant(uint256 permissions, uint64 quota, uint64 expiry) private {
        vm.prank(owner);
        issuer.grant(delegated, permissions, quota, expiry);
    }

    function test_beforeExistingV4OperatorIsRevokedByTwoPhaseHandoff() public {
        assertEq(records.rootController(), address(issuer));
        assertEq(records.controllerEpoch(), 2); // V4 constructor starts at epoch=1.
        assertFalse(records.operatorActive(staleV4Delegate, records.CAP_ISSUE()));
        vm.prank(staleV4Delegate);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        records.issue("stale", member, address(0));
        vm.prank(owner);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        records.issue("controller-bypass", member, address(0));
        assertFalse(issuer.sovereignReceipt());
        assertFalse(issuer.l1OwnershipVerified());
    }

    function test_opManagedIssuerAllowsCurrentControllerAndScopedDelegates() public {
        vm.prank(owner);
        bytes32 a = issuer.issue("rootmint", member, member);
        assertEq(records.subnodeOwner(a), member);
        _grant(issuer.CAP_ISSUE() | issuer.CAP_INITIAL_ADDR(), 1, uint64(block.timestamp + 1000));
        vm.prank(delegated);
        bytes32 b = issuer.issue("delegate", member, member);
        assertEq(records.subnodeOwner(b), member);
        (, uint64 quota,,) = issuer.grants(delegated);
        assertEq(quota, 0);
        vm.prank(delegated);
        vm.expectRevert(G2ManagedLeaseIssuer.Unauthorized.selector);
        issuer.issue("second", member, address(0));
    }

    function test_rejectsUnknownOrOverlongOrEscapingGrants() public {
        vm.startPrank(owner);
        vm.expectRevert(G2ManagedLeaseIssuer.InvalidGrant.selector);
        issuer.grant(delegated, 0, 1, uint64(block.timestamp + 1000));
        vm.expectRevert(G2ManagedLeaseIssuer.InvalidGrant.selector);
        issuer.grant(delegated, 4, 1, uint64(block.timestamp + 1000));
        vm.expectRevert(G2ManagedLeaseIssuer.InvalidGrant.selector);
        issuer.grant(delegated, 1, 0, uint64(block.timestamp + 1000));
        vm.expectRevert(G2ManagedLeaseIssuer.InvalidGrant.selector);
        issuer.grant(delegated, 1, 1, uint64(block.timestamp + 4000));
        vm.expectRevert(G2ManagedLeaseIssuer.InvalidGrant.selector);
        issuer.grant(owner, 1, 1, uint64(block.timestamp + 1000));
        vm.stopPrank();
        vm.prank(hostile);
        vm.expectRevert(G2ManagedLeaseIssuer.Unauthorized.selector);
        issuer.grant(delegated, 1, 1, uint64(block.timestamp + 1000));
    }

    function test_operatorInitialAddressRightsAndGrantRevoke() public {
        _grant(issuer.CAP_ISSUE(), 2, uint64(block.timestamp + 1000));
        vm.prank(delegated);
        vm.expectRevert(G2ManagedLeaseIssuer.Unauthorized.selector);
        issuer.issue("forbiddenaddr", member, member);
        vm.prank(delegated);
        issuer.issue("allowed", member, address(0));
        vm.prank(owner);
        issuer.revoke(delegated);
        vm.prank(delegated);
        vm.expectRevert(G2ManagedLeaseIssuer.Unauthorized.selector);
        issuer.issue("revoked", member, address(0));
    }

    function test_expiredLeaseBlocksOwnerAndDelegateAndUnderlyingV4DirectPaths() public {
        vm.prank(owner);
        bytes32 memberNode = issuer.issue("memberkeepproof", member, member);
        _grant(issuer.CAP_ISSUE(), 3, uint64(block.timestamp + 3600));
        vm.warp(block.timestamp + 3600);
        vm.prank(owner);
        vm.expectRevert(G2ManagedLeaseIssuer.LeaseInactive.selector);
        issuer.issue("expiredcontroller", member, address(0));
        vm.prank(delegated);
        vm.expectRevert(G2ManagedLeaseIssuer.LeaseInactive.selector);
        issuer.issue("expireddelegate", member, address(0));
        vm.prank(owner);
        issuer.revoke(delegated); // Expiry freezes issuance, not revocation.
        (, uint64 remaining,,) = issuer.grants(delegated);
        assertEq(remaining, 0);
        vm.prank(owner);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        records.issue("v4direct", member, address(0));
        // Lease loss cannot claw back or block the independent member's own
        // application-level NFT/record updates.
        vm.prank(member);
        records.setAddr(memberNode, delegated);
        assertEq(records.subnodeOwner(memberNode), member);
        assertEq(records.addr(memberNode), delegated);
    }

    function test_authorityEpochChangeInvalidatesDelegatesEvenWithSameController() public {
        _grant(issuer.CAP_ISSUE(), 2, uint64(block.timestamp + 1000));
        _checkpoint(2, 2, owner, 3600);
        vm.prank(delegated);
        vm.expectRevert(G2ManagedLeaseIssuer.Unauthorized.selector);
        issuer.issue("staleepoch", member, address(0));
        vm.prank(owner);
        issuer.issue("freshroot", member, address(0));
    }

    function test_authenticatedFreezeStillAllowsOriginalGrantorToRevoke() public {
        _grant(issuer.CAP_ISSUE(), 2, uint64(block.timestamp + 1000));
        assertEq(issuer.grantorOf(delegated), owner);
        _checkpoint(2, 2, address(0), 0);
        vm.prank(hostile);
        vm.expectRevert(G2ManagedLeaseIssuer.Unauthorized.selector);
        issuer.revoke(delegated);
        vm.prank(owner);
        issuer.revoke(delegated);
        assertEq(issuer.grantorOf(delegated), address(0));
        (, uint64 quota,,) = issuer.grants(delegated);
        assertEq(quota, 0);
        vm.prank(owner);
        vm.expectRevert(G2ManagedLeaseIssuer.LeaseInactive.selector);
        issuer.issue("frozen", member, address(0));
    }

    function test_oldGrantorCannotRevokeNewControllerRegrant() public {
        _grant(issuer.CAP_ISSUE(), 3, uint64(block.timestamp + 1000));
        _checkpoint(2, 2, rotatedOwner, 3600);
        vm.prank(rotatedOwner);
        issuer.grant(delegated, 1, 1, uint64(block.timestamp + 1000));
        assertEq(issuer.grantorOf(delegated), rotatedOwner);
        vm.prank(owner);
        vm.expectRevert(G2ManagedLeaseIssuer.Unauthorized.selector);
        issuer.revoke(delegated);
        vm.prank(delegated);
        issuer.issue("freshgrant", member, address(0));
    }

    function test_rotatedControllerCannotBeOverriddenByOldOwner() public {
        _checkpoint(2, 2, rotatedOwner, 3600);
        vm.prank(owner);
        vm.expectRevert(G2ManagedLeaseIssuer.Unauthorized.selector);
        issuer.issue("oldroot", member, address(0));
        vm.prank(rotatedOwner);
        issuer.issue("newroot", member, address(0));
    }

    function test_untrustedRuntimeOrNetworkChangeFailsClosed() public {
        vm.etch(address(inbox), hex"60006000fd");
        vm.prank(owner);
        vm.expectRevert(G2ManagedLeaseIssuer.IdentityMismatch.selector);
        issuer.issue("wronginboxcode", member, address(0));
    }

    function test_constructorRejectsSpoofedParentAdapterOrRuntimeHash() public {
        bytes32 wrongRoot = keccak256("another-community.eth");
        L2CommunityRecordsV4 other = new L2CommunityRecordsV4(wrongRoot, owner);
        vm.expectRevert(G2ManagedLeaseIssuer.IdentityMismatch.selector);
        new G2ManagedLeaseIssuer(
            address(inbox), address(other), l1Adapter, address(inbox).codehash, address(other).codehash
        );

        vm.expectRevert(G2ManagedLeaseIssuer.IdentityMismatch.selector);
        new G2ManagedLeaseIssuer(
            address(inbox), address(records), hostile, address(inbox).codehash, address(records).codehash
        );

        vm.expectRevert(G2ManagedLeaseIssuer.IdentityMismatch.selector);
        new G2ManagedLeaseIssuer(
            address(inbox), address(records), l1Adapter, bytes32(uint256(1)), address(records).codehash
        );

        vm.chainId(10);
        vm.expectRevert(G2ManagedLeaseIssuer.IdentityMismatch.selector);
        new G2ManagedLeaseIssuer(
            address(inbox), address(records), l1Adapter, address(inbox).codehash, address(records).codehash
        );
    }

    function test_rootHandoffRequiresActualPendingController() public {
        vm.expectRevert(G2ManagedLeaseIssuer.Unauthorized.selector);
        issuer.acceptControl(); // A second handoff cannot occur without new pending.
    }
}
