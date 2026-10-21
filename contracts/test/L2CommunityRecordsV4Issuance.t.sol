// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/L2CommunityRecordsV4.sol";

/// @dev Contract controller exercises ERC-1271 and a forbidden nested state write.
contract Issuance1271Controller {
    L2CommunityRecordsV4 public records;

    function setRecords(L2CommunityRecordsV4 instance) external {
        records = instance;
    }

    function grant(address operator, uint256 permissions, uint64 quota, uint64 expiry) external {
        records.grantOperator(operator, permissions, quota, expiry);
    }

    function revoke(address operator) external {
        records.revokeOperator(operator);
    }

    function isValidSignature(bytes32, bytes calldata) external view returns (bytes4) {
        // The contract must consume the permit BEFORE this external check.
        if (records.issuanceNonce() != 1) return 0xffffffff;
        // Attempt to reenter issuance from static context as the controller.
        // Any successful state change or mutable callback is a failure.
        (bool ok,) = address(records)
            .staticcall(abi.encodeWithSelector(records.issue.selector, "evil", address(this), address(0)));
        return ok ? bytes4(0xffffffff) : bytes4(0x1626ba7e);
    }
}

contract L2CommunityRecordsV4IssuanceTest is Test {
    bytes32 private constant PARENT = keccak256("community.eth");
    L2CommunityRecordsV4 private records;
    address private controller;
    uint256 private controllerKey;
    address private secondController;
    uint256 private secondKey;
    address private operator = makeAddr("operator");
    address private otherOperator = makeAddr("otherOperator");
    address private member = makeAddr("member");
    address private newMember = makeAddr("newMember");

    function setUp() public {
        (controller, controllerKey) = makeAddrAndKey("controller");
        (secondController, secondKey) = makeAddrAndKey("secondController");
        vm.chainId(31337);
        vm.warp(1_000_000);
        records = new L2CommunityRecordsV4(PARENT, controller);
        _grant(operator, records.CAP_ISSUE() | records.CAP_SIGNED_ISSUE(), 4, 1000);
    }

    function _grant(address who, uint256 caps, uint64 quota, uint64 duration) private {
        vm.prank(controller);
        records.grantOperator(who, caps, quota, uint64(block.timestamp + duration));
    }

    function _digest(
        L2CommunityRecordsV4 instance,
        string memory label,
        address holder,
        address initialAddr,
        address signerOperator,
        uint256 nonce,
        uint256 deadline
    ) private view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                instance.ISSUE_TYPEHASH(),
                keccak256(bytes(label)),
                holder,
                initialAddr,
                signerOperator,
                instance.controllerEpoch(),
                instance.operatorRevision(signerOperator),
                nonce,
                deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", instance.domainSeparator(), structHash));
    }

    function _sign(
        L2CommunityRecordsV4 instance,
        string memory label,
        address holder,
        address initialAddr,
        address issuer,
        uint256 nonce,
        uint256 deadline,
        uint256 key
    ) private view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(key, _digest(instance, label, holder, initialAddr, issuer, nonce, deadline));
        return abi.encodePacked(r, s, v);
    }

    function _permit(string memory label, address holder, uint256 nonce, uint256 deadline)
        private
        view
        returns (bytes memory)
    {
        return _sign(records, label, holder, address(0), operator, nonce, deadline, controllerKey);
    }

    function test_signedOnlyGrantCannotIssueUnsignedAndConsumesNonceQuota() public {
        vm.prank(operator);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        records.issue("alice", member, address(0));
        uint256 deadline = block.timestamp + 600;
        bytes memory permit = _permit("alice", member, 0, deadline);
        vm.prank(operator);
        bytes32 node = records.issueBySig("alice", member, address(0), 0, deadline, permit);
        assertEq(records.ownerOf(uint256(node)), member);
        assertEq(records.issuanceNonce(), 1);
        (, uint64 quota,,) = records.operators(operator);
        assertEq(quota, 3);
        vm.prank(operator);
        vm.expectRevert(L2CommunityRecordsV4.InvalidNonce.selector);
        records.issueBySig("alice", member, address(0), 0, deadline, permit);
        assertEq(records.issuanceNonce(), 1);
    }

    function test_signedPayloadBindsMemberLabelOperatorAndInitialRecord() public {
        _grant(operator, records.CAP_ISSUE() | records.CAP_SIGNED_ISSUE() | records.CAP_INITIAL_ADDR(), 4, 1000);
        uint256 deadline = block.timestamp + 600;
        bytes memory permit = _permit("alice", member, 0, deadline);
        _grant(otherOperator, records.CAP_ISSUE() | records.CAP_SIGNED_ISSUE(), 2, 1000);
        vm.startPrank(operator);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        records.issueBySig("alice", newMember, address(0), 0, deadline, permit);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        records.issueBySig("bob", member, address(0), 0, deadline, permit);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        records.issueBySig("alice", member, newMember, 0, deadline, permit);
        vm.stopPrank();
        vm.prank(otherOperator);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        records.issueBySig("alice", member, address(0), 0, deadline, permit);
        assertEq(records.issuanceNonce(), 0);
        (, uint64 quota,,) = records.operators(operator);
        assertEq(quota, 4);
    }

    function test_malformedNameAndDuplicateCannotGriefNonceOrQuota() public {
        uint256 deadline = block.timestamp + 600;
        bytes memory bad = _permit("ALICE", member, 0, deadline);
        vm.prank(operator);
        vm.expectRevert(L2CommunityRecordsV4.InvalidInput.selector);
        records.issueBySig("ALICE", member, address(0), 0, deadline, bad);
        assertEq(records.issuanceNonce(), 0);
        (, uint64 quota,,) = records.operators(operator);
        assertEq(quota, 4);

        vm.prank(controller);
        records.issue("alice", member, address(0));
        bytes memory duplicate = _permit("alice", member, 0, deadline);
        vm.prank(operator);
        vm.expectRevert(L2CommunityRecordsV4.AlreadyIssued.selector);
        records.issueBySig("alice", member, address(0), 0, deadline, duplicate);
        assertEq(records.issuanceNonce(), 0);
        (, quota,,) = records.operators(operator);
        assertEq(quota, 4);
    }

    function test_revokeRegrantExpiryAndQuotaAlwaysEnforced() public {
        uint256 deadline = block.timestamp + 600;
        bytes memory oldPermit = _permit("alice", member, 0, deadline);
        vm.prank(controller);
        records.revokeOperator(operator);
        vm.prank(operator);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        records.issueBySig("alice", member, address(0), 0, deadline, oldPermit);

        _grant(operator, records.CAP_ISSUE() | records.CAP_SIGNED_ISSUE(), 1, 5);
        vm.prank(operator);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        records.issueBySig("alice", member, address(0), 0, deadline, oldPermit);

        bytes memory renewedPermit = _permit("alice", member, 0, deadline);
        vm.warp(block.timestamp + 5);
        vm.prank(operator);
        vm.expectRevert(L2CommunityRecordsV4.Expired.selector);
        records.issueBySig("alice", member, address(0), 0, deadline, renewedPermit);
        _grant(operator, records.CAP_ISSUE() | records.CAP_SIGNED_ISSUE(), 1, 500);
        bytes memory activePermit = _permit("alice", member, 0, deadline);
        vm.prank(operator);
        records.issueBySig("alice", member, address(0), 0, deadline, activePermit);
        bytes memory secondPermit = _permit("bob", member, 1, deadline);
        vm.prank(operator);
        vm.expectRevert(L2CommunityRecordsV4.QuotaExceeded.selector);
        records.issueBySig("bob", member, address(0), 1, deadline, secondPermit);
    }

    function test_ownerCancelsAndDeadlineBlocksReplay() public {
        uint256 deadline = block.timestamp + 600;
        bytes memory oldPermit = _permit("alice", member, 0, deadline);
        vm.prank(controller);
        records.invalidateIssuanceNonce(4);
        vm.prank(operator);
        vm.expectRevert(L2CommunityRecordsV4.InvalidNonce.selector);
        records.issueBySig("alice", member, address(0), 0, deadline, oldPermit);
        bytes memory permit = _permit("alice", member, 4, deadline);
        vm.warp(deadline + 1);
        vm.prank(operator);
        vm.expectRevert(L2CommunityRecordsV4.SignatureExpired.selector);
        records.issueBySig("alice", member, address(0), 4, deadline, permit);
        assertEq(records.issuanceNonce(), 4);
    }

    function test_crossChainContractAndControllerEpochInvalidateSignature() public {
        uint256 deadline = block.timestamp + 600;
        bytes memory permit = _permit("alice", member, 0, deadline);
        vm.chainId(31338);
        vm.prank(operator);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        records.issueBySig("alice", member, address(0), 0, deadline, permit);
        vm.chainId(31337);

        L2CommunityRecordsV4 other = new L2CommunityRecordsV4(PARENT, controller);
        uint256 signedCaps = other.CAP_ISSUE() | other.CAP_SIGNED_ISSUE();
        vm.prank(controller);
        other.grantOperator(operator, signedCaps, 2, uint64(deadline));
        vm.prank(operator);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        other.issueBySig("alice", member, address(0), 0, deadline, permit);

        vm.prank(controller);
        records.proposeController(secondController);
        vm.prank(secondController);
        records.acceptController();
        signedCaps = records.CAP_ISSUE() | records.CAP_SIGNED_ISSUE();
        vm.prank(secondController);
        records.grantOperator(operator, signedCaps, 2, uint64(deadline));
        vm.prank(operator);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        records.issueBySig("alice", member, address(0), 0, deadline, permit);
        bytes memory newPermit = _sign(records, "alice", member, address(0), operator, 0, deadline, secondKey);
        vm.prank(operator);
        records.issueBySig("alice", member, address(0), 0, deadline, newPermit);
    }

    function test_ERC1271ControllerSeesPreconsumedNonceAndCannotReenter() public {
        Issuance1271Controller wallet = new Issuance1271Controller();
        L2CommunityRecordsV4 controlled = new L2CommunityRecordsV4(PARENT, address(wallet));
        wallet.setRecords(controlled);
        wallet.grant(operator, controlled.CAP_ISSUE() | controlled.CAP_SIGNED_ISSUE(), 1, uint64(block.timestamp + 100));
        vm.prank(operator);
        bytes32 node = controlled.issueBySig("alice", member, address(0), 0, block.timestamp + 60, hex"abcd");
        assertEq(controlled.ownerOf(uint256(node)), member);
        assertEq(controlled.issuanceNonce(), 1);
        assertEq(controlled.subnodeOwner(controlled.nodeOf("evil")), address(0));
        (, uint64 quota,,) = controlled.operators(operator);
        assertEq(quota, 0);
    }

    function test_transferStillInvalidatesInitialRecordsAndProtectsMemberAuthority() public {
        uint256 deadline = block.timestamp + 600;
        _grant(operator, records.CAP_ISSUE() | records.CAP_SIGNED_ISSUE() | records.CAP_INITIAL_ADDR(), 2, 1000);
        bytes memory permit = _sign(records, "alice", member, newMember, operator, 0, deadline, controllerKey);
        vm.prank(operator);
        bytes32 node = records.issueBySig("alice", member, newMember, 0, deadline, permit);
        assertEq(records.addr(node), newMember);
        vm.prank(operator);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        records.setAddr(node, operator);
        vm.prank(member);
        records.transferFrom(member, newMember, uint256(node));
        assertEq(records.addr(node), address(0));
        assertEq(records.recordEpoch(node), 1);
        vm.prank(newMember);
        records.setAddr(node, member);
        assertEq(records.addr(node), member);
    }
}
