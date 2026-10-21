// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/L2CommunityRecordsV4.sol";

/// @dev Test-only ERC-1271 wallet; its policy inspects the nonce during staticcall.
contract DirectMember1271 {
    L2CommunityRecordsV4 immutable records;
    uint256 public expectedNonce;

    constructor(L2CommunityRecordsV4 instance) {
        records = instance;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function isValidSignature(bytes32, bytes calldata) external view returns (bytes4) {
        return records.nonces(address(this)) == expectedNonce ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }

    function expectNonce(uint256 next) external {
        expectedNonce = next;
    }

    function directWrite(bytes32 node, address value) external {
        records.setAddr(node, value);
    }

    function cancel(bytes32 node, uint256 next) external {
        records.invalidateNonce(node, next);
    }
}

contract L2CommunityRecordsV4NonceGuardTest is Test {
    event MemberNonceAdvanced(address indexed holder, bytes32 indexed node, uint256 previousNonce, uint256 newNonce);
    event MemberNonceConsumed(address indexed holder, bytes32 indexed node, uint256 nonce);
    L2CommunityRecordsV4 private records;
    bytes32 private node;
    address private member;
    uint256 private memberKey;
    address private other;
    address private relayer = makeAddr("relayer");

    function setUp() public {
        (member, memberKey) = makeAddrAndKey("member");
        other = makeAddr("other");
        records = new L2CommunityRecordsV4(keccak256("community.eth"), address(this));
        vm.warp(1_000_000);
        vm.chainId(31337);
        node = records.issue("alice", member, address(0));
    }

    function _sign(bytes32 digest) private view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(memberKey, digest);
        return abi.encodePacked(r, s, v);
    }

    // Foundry's EIP-712 JSON encoder, not the contract's abi.encode/typehash.
    // The type definitions deliberately live here as independent golden vectors.
    function _vector(string memory primary, string memory fields, string memory message)
        private
        view
        returns (bytes32)
    {
        string memory json = string.concat(
            '{"types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},',
            '{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],"',
            primary,
            '":',
            fields,
            '},"primaryType":"',
            primary,
            '","domain":{"name":"CometENS Community V4","version":"1","chainId":',
            vm.toString(block.chainid),
            ',"verifyingContract":"',
            vm.toString(address(records)),
            '"},"message":',
            message,
            "}"
        );
        return vm.eip712HashTypedData(json);
    }

    function _afterTransferRoundTrip() private {
        vm.prank(member);
        records.transferFrom(member, other, uint256(node));
        vm.prank(other);
        records.transferFrom(other, member, uint256(node));
        assertEq(records.recordEpoch(node), 2);
    }

    function test_directWritesInvalidateOutstandingRelayAcrossTypesAndNodes() public {
        uint256 deadline = block.timestamp + 600;
        bytes32 signedDigest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                records.domainSeparator(),
                keccak256(abi.encode(records.SET_ADDR_TYPEHASH(), node, other, uint64(0), uint256(0), deadline))
            )
        );
        bytes memory oldSig = _sign(signedDigest);
        bytes32 secondNode = records.issue("bob", member, other);

        vm.expectEmit(true, true, false, true, address(records));
        emit MemberNonceAdvanced(member, node, 0, 1);
        vm.prank(member);
        records.setAddr(node, member);
        assertEq(records.nonces(member), 1);
        vm.prank(relayer);
        vm.expectRevert(L2CommunityRecordsV4.InvalidNonce.selector);
        records.setAddrBySig(node, other, 0, deadline, oldSig);
        assertEq(records.addr(node), member);
        assertEq(records.addr(secondNode), other); // shared nonce is NOT a shared record version

        vm.prank(member);
        records.setText(secondNode, "bio", "new");
        vm.prank(member);
        records.setContenthash(node, hex"abcd");
        assertEq(records.nonces(member), 3);
        assertEq(records.text(secondNode, "bio"), "new");
        assertEq(records.contenthash(node), hex"abcd");
        assertEq(records.recordEpoch(node), 0); // only NFT transfers clear other record types
    }

    function test_currentHolderCanSkipNoncesButStrangerAndOldOwnerCannot() public {
        vm.prank(other);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        records.invalidateNonce(node, 10);
        vm.prank(member);
        vm.expectRevert(L2CommunityRecordsV4.InvalidNonce.selector);
        records.invalidateNonce(node, 0);
        vm.prank(member);
        records.invalidateNonce(node, 10);
        assertEq(records.nonces(member), 10);
        vm.prank(member);
        vm.expectRevert(L2CommunityRecordsV4.InvalidNonce.selector);
        records.invalidateNonce(node, 9);
        vm.prank(member);
        vm.expectRevert(L2CommunityRecordsV4.InvalidNonce.selector);
        records.invalidateNonce(node, type(uint256).max);

        vm.prank(member);
        records.transferFrom(member, other, uint256(node));
        vm.prank(member);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        records.invalidateNonce(node, 11);
        vm.prank(other);
        records.invalidateNonce(node, 2);
        assertEq(records.nonces(other), 2);
        assertEq(records.nonces(member), 10);
    }

    function test_nonceSkipRejectsSignedFutureMessageAndAllowsNewCurrentNonce() public {
        uint256 deadline = block.timestamp + 600;
        bytes32 staleDigest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                records.domainSeparator(),
                keccak256(abi.encode(records.SET_ADDR_TYPEHASH(), node, other, uint64(0), uint256(1), deadline))
            )
        );
        bytes memory staleSig = _sign(staleDigest);
        vm.prank(member);
        records.invalidateNonce(node, 2);
        vm.expectRevert(L2CommunityRecordsV4.InvalidNonce.selector);
        records.setAddrBySig(node, other, 1, deadline, staleSig);

        bytes32 freshDigest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                records.domainSeparator(),
                keccak256(abi.encode(records.SET_ADDR_TYPEHASH(), node, member, uint64(0), uint256(2), deadline))
            )
        );
        vm.expectEmit(true, true, false, true, address(records));
        emit MemberNonceConsumed(member, node, 2);
        records.setAddrBySig(node, member, 2, deadline, _sign(freshDigest));
        assertEq(records.nonces(member), 3);
        assertEq(records.addr(node), member);
    }

    function test_relayCannotConsumeNonceForUnissuedToken() public {
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        records.setAddrBySig(keccak256("missing"), member, 0, block.timestamp + 600, hex"1234");
        assertEq(records.nonces(member), 0);
    }

    function test_7702StyleEOAWithCodeDoesNotFallbackToECDSA() public {
        uint256 deadline = block.timestamp + 600;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                records.domainSeparator(),
                keccak256(abi.encode(records.SET_ADDR_TYPEHASH(), node, other, uint64(0), uint256(0), deadline))
            )
        );
        bytes memory validEoaSignature = _sign(digest);
        vm.etch(member, hex"60006000fd"); // EIP-7702-like code holder without ERC-1271
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        records.setAddrBySig(node, other, 0, deadline, validEoaSignature);
        assertEq(records.nonces(member), 0);
    }

    function test_1271HolderDirectWriteAndCancelThenRelayUsesAdvancedNonce() public {
        DirectMember1271 wallet = new DirectMember1271(records);
        bytes32 walletNode = records.issue("wallet", address(wallet), address(0));
        wallet.directWrite(walletNode, member);
        assertEq(records.nonces(address(wallet)), 1);
        wallet.cancel(walletNode, 8);
        assertEq(records.nonces(address(wallet)), 8);
        wallet.expectNonce(9); // SignatureChecker's ERC-1271 staticcall sees n+1
        vm.prank(relayer);
        records.setAddrBySig(walletNode, other, 8, block.timestamp + 600, hex"beef");
        assertEq(records.nonces(address(wallet)), 9);
        assertEq(records.addr(walletNode), other);
    }

    function test_eip712IndependentSetAddrVectorWithNonzeroRecordEpoch() public {
        _afterTransferRoundTrip();
        uint256 deadline = block.timestamp + 500;
        bytes32 digest = _vector(
            "SetAddr",
            '[{"name":"node","type":"bytes32"},{"name":"value","type":"address"},{"name":"recordEpoch","type":"uint64"},{"name":"nonce","type":"uint256"},{"name":"deadline","type":"uint256"}]',
            string.concat(
                '{"node":"',
                vm.toString(node),
                '","value":"',
                vm.toString(member),
                '","recordEpoch":2,"nonce":0,"deadline":',
                vm.toString(deadline),
                "}"
            )
        );
        bytes memory signature = _sign(digest);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        records.setAddrBySig(node, other, 0, deadline, signature);
        records.setAddrBySig(node, member, 0, deadline, signature);
        assertEq(records.addr(node), member);
    }

    function test_eip712IndependentSetTextVectorAndFieldMutation() public {
        _afterTransferRoundTrip();
        uint256 deadline = block.timestamp + 500;
        bytes32 digest = _vector(
            "SetText",
            '[{"name":"node","type":"bytes32"},{"name":"key","type":"string"},{"name":"value","type":"string"},{"name":"recordEpoch","type":"uint64"},{"name":"nonce","type":"uint256"},{"name":"deadline","type":"uint256"}]',
            string.concat(
                '{"node":"',
                vm.toString(node),
                '","key":"avatar","value":"blue sky","recordEpoch":2,"nonce":0,"deadline":',
                vm.toString(deadline),
                "}"
            )
        );
        bytes memory signature = _sign(digest);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        records.setTextBySig(node, "url", "blue sky", 0, deadline, signature);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        records.setTextBySig(node, "avatar", "different value", 0, deadline, signature);
        records.setTextBySig(node, "avatar", "blue sky", 0, deadline, signature);
        assertEq(records.text(node, "avatar"), "blue sky");
        assertEq(records.text(node, "url"), "");
    }

    function test_eip712IndependentContenthashVectorAndFieldMutation() public {
        _afterTransferRoundTrip();
        uint256 deadline = block.timestamp + 500;
        bytes32 digest = _vector(
            "SetContenthash",
            '[{"name":"node","type":"bytes32"},{"name":"value","type":"bytes"},{"name":"recordEpoch","type":"uint64"},{"name":"nonce","type":"uint256"},{"name":"deadline","type":"uint256"}]',
            string.concat(
                '{"node":"',
                vm.toString(node),
                '","value":"0x1234abcd","recordEpoch":2,"nonce":0,"deadline":',
                vm.toString(deadline),
                "}"
            )
        );
        bytes memory signature = _sign(digest);
        vm.expectRevert(L2CommunityRecordsV4.Unauthorized.selector);
        records.setContenthashBySig(node, hex"1234abce", 0, deadline, signature);
        records.setContenthashBySig(node, hex"1234abcd", 0, deadline, signature);
        assertEq(records.contenthash(node), hex"1234abcd");
    }
}
