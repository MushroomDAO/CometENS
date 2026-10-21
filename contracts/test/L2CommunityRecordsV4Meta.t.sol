// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/L2CommunityRecordsV4.sol";

/// A deliberately permissive EIP-1271 signer used ONLY in this local test.
/// It insists the nonce is consumed *before* the checker invokes its callback.
contract NonceWitness1271 {
    L2CommunityRecordsV4 private immutable records;

    constructor(L2CommunityRecordsV4 instance) { records = instance; }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function isValidSignature(bytes32, bytes calldata) external view returns (bytes4) {
        if (records.nonces(address(this)) != 1) return 0xffffffff;
        return 0x1626ba7e;
    }
}

contract L2CommunityRecordsV4MetaTest is Test {
    L2CommunityRecordsV4 private records;
    bytes32 private node;
    address private member;
    uint256 private memberKey;
    address private other;
    uint256 private otherKey;
    address private relayer = makeAddr("relayer");

    function setUp() public {
        (member, memberKey) = makeAddrAndKey("member");
        (other, otherKey) = makeAddrAndKey("other");
        records = new L2CommunityRecordsV4(keccak256("community.eth"), address(this));
        vm.warp(1_000_000);
        node = records.issue("alice", member, address(0));
    }

    function signAddressWithKey(address value, uint256 nonce, uint256 deadline, uint256 key)
        private returns (bytes memory)
    {
        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01", records.domainSeparator(),
            keccak256(abi.encode(records.SET_ADDR_TYPEHASH(), node, value, records.recordEpoch(node), nonce, deadline))
        ));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function signAddress(address value, uint256 nonce, uint256 deadline) private returns (bytes memory) {
        return signAddressWithKey(value, nonce, deadline, memberKey);
    }

    function test_oneNonceOnlyOneRelayerWins() public {
        uint256 deadline = block.timestamp + 600;
        bytes memory sig = signAddress(member, 0, deadline);
        vm.prank(relayer);
        records.setAddrBySig(node, member, 0, deadline, sig);
        assertEq(records.addr(node), member);
        assertEq(records.nonces(member), 1);
        vm.prank(other);
        vm.expectRevert(L2CommunityRecordsV4.InvalidNonce.selector);
        records.setAddrBySig(node, member, 0, deadline, sig);
    }

    function test_1271WalletSeesNonceConsumedBeforeValidation() public {
        NonceWitness1271 contractMember = new NonceWitness1271(records);
        bytes32 otherNode = records.issue("contractmember", address(contractMember), address(0));
        uint256 deadline = block.timestamp + 600;
        vm.prank(relayer);
        records.setAddrBySig(otherNode, member, 0, deadline, hex"abcd");
        assertEq(records.addr(otherNode), member);
        assertEq(records.nonces(address(contractMember)), 1);
        vm.prank(other);
        vm.expectRevert(L2CommunityRecordsV4.InvalidNonce.selector);
        records.setAddrBySig(otherNode, member, 0, deadline, hex"abcd");
    }

    function test_wrongSignerAndWrongChainDomainRejected() public {
        uint256 deadline = block.timestamp + 600;
        bytes memory forged = signAddressWithKey(other, 0, deadline, otherKey);
        vm.prank(relayer);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        records.setAddrBySig(node, other, 0, deadline, forged);

        bytes memory valid = signAddress(member, 0, deadline);
        // ChainId is part of EIP-712 domain. Signatures made for another chain
        // cannot be verified after EIP712 recomputes the domain separator.
        vm.chainId(block.chainid + 1);
        vm.prank(relayer);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        records.setAddrBySig(node, member, 0, deadline, valid);
        assertEq(records.nonces(member), 0);
    }

    function test_signedRecordBindsExactValueAndVerifyingContract() public {
        uint256 deadline = block.timestamp + 600;
        bytes memory signature = signAddress(member, 0, deadline);
        vm.prank(relayer);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        records.setAddrBySig(node, other, 0, deadline, signature);

        L2CommunityRecordsV4 otherDeployment = new L2CommunityRecordsV4(keccak256("community.eth"), address(this));
        bytes32 sameNode = otherDeployment.issue("alice", member, address(0));
        assertEq(sameNode, node);
        vm.prank(relayer);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        otherDeployment.setAddrBySig(node, member, 0, deadline, signature);
        assertEq(otherDeployment.nonces(member), 0);
    }

    function test_transferAndReturnCannotReviveOldMemberSignature() public {
        uint256 deadline = block.timestamp + 600;
        bytes memory oldSig = signAddress(member, 0, deadline);
        vm.prank(member);
        records.transferFrom(member, other, uint256(node));
        vm.prank(other);
        records.transferFrom(other, member, uint256(node));
        assertEq(records.recordEpoch(node), 2);
        vm.prank(relayer);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        records.setAddrBySig(node, member, 0, deadline, oldSig);
        assertEq(records.nonces(member), 0);
    }

    function test_expiredAndExcessivelyLongDeadlineRejectBeforeNonceConsumption() public {
        vm.prank(relayer);
        vm.expectRevert(L2CommunityRecordsV4.SignatureExpired.selector);
        records.setAddrBySig(node, member, 0, 1, hex"00");
        vm.prank(relayer);
        vm.expectRevert(L2CommunityRecordsV4.InvalidInput.selector);
        records.setAddrBySig(node, member, 0, block.timestamp + 2 days, hex"00");
        assertEq(records.nonces(member), 0);
    }

    function test_textAndContenthashShareAtomicMemberNonce() public {
        uint256 deadline = block.timestamp + 600;
        bytes32 typedText = keccak256(abi.encode(
            records.SET_TEXT_TYPEHASH(), node, keccak256("url"), keccak256("https://member.example"), records.recordEpoch(node), 0, deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", records.domainSeparator(), typedText));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(memberKey, digest);
        vm.prank(relayer);
        records.setTextBySig(node, "url", "https://member.example", 0, deadline, abi.encodePacked(r, s, v));
        assertEq(records.text(node, "url"), "https://member.example");
        assertEq(records.nonces(member), 1);

        bytes memory content = hex"1234";
        bytes32 typedContent = keccak256(abi.encode(
            records.SET_CONTENTHASH_TYPEHASH(), node, keccak256(content), records.recordEpoch(node), 1, deadline
        ));
        digest = keccak256(abi.encodePacked("\x19\x01", records.domainSeparator(), typedContent));
        (v, r, s) = vm.sign(memberKey, digest);
        vm.prank(relayer);
        records.setContenthashBySig(node, content, 1, deadline, abi.encodePacked(r, s, v));
        assertEq(records.contenthash(node), content);
        assertEq(records.nonces(member), 2);
    }
}
