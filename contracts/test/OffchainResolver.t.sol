// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/OffchainResolver.sol";

contract OffchainResolverTest is Test {
    OffchainResolver public resolver;
    address public contractOwner;
    address public alice;

    uint256 signer1PrivateKey = 0xA11CE;
    uint256 signer2PrivateKey = 0xB0B;
    address signer1Addr;
    address signer2Addr;

    string constant GATEWAY = "https://gateway.example.com/{sender}/{data}.json";

    // Sample callData and extraData matching resolve() output
    bytes constant CALL_DATA = hex"3b3b57deabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab";
    bytes constant NAME_BYTES = bytes("alice.test.eth");

    function setUp() public {
        contractOwner = address(this);
        alice = makeAddr("alice");
        signer1Addr = vm.addr(signer1PrivateKey);
        signer2Addr = vm.addr(signer2PrivateKey);

        address[] memory initialSigners = new address[](2);
        initialSigners[0] = signer1Addr;
        initialSigners[1] = signer2Addr;
        resolver = new OffchainResolver(contractOwner, initialSigners, GATEWAY);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    /// @dev Builds a valid gateway response using the given private key.
    function _buildResponse(bytes memory result, uint64 expires, bytes memory callData, uint256 privateKey)
        internal
        view
        returns (bytes memory response)
    {
        bytes32 messageHash = keccak256(
            abi.encodePacked(
                hex"1900",
                address(resolver),
                expires,
                keccak256(callData),
                keccak256(result)
            )
        );
        bytes32 ethHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, ethHash);
        bytes memory sig = abi.encodePacked(r, s, v);
        response = abi.encode(result, expires, sig);
    }

    /// @dev Convenience: build response signed by signer1 (default).
    function _buildResponse(bytes memory result, uint64 expires, bytes memory callData)
        internal
        view
        returns (bytes memory response)
    {
        return _buildResponse(result, expires, callData, signer1PrivateKey);
    }

    function _extraData() internal pure returns (bytes memory) {
        return abi.encode(NAME_BYTES, CALL_DATA);
    }

    // ─── Constructor ──────────────────────────────────────────────────────────

    function test_ownerAndSignersSet() public view {
        assertEq(resolver.owner(), contractOwner);
        assertTrue(resolver.signers(signer1Addr), "signer1 should be active");
        assertTrue(resolver.signers(signer2Addr), "signer2 should be active");
        assertEq(resolver.gatewayUrl(), GATEWAY);
    }

    function test_revertZeroOwner() public {
        address[] memory s = new address[](1);
        s[0] = signer1Addr;
        vm.expectRevert(OffchainResolver.ZeroAddress.selector);
        new OffchainResolver(address(0), s, GATEWAY);
    }

    function test_revertZeroSigner() public {
        address[] memory s = new address[](1);
        s[0] = address(0);
        vm.expectRevert(OffchainResolver.ZeroAddress.selector);
        new OffchainResolver(contractOwner, s, GATEWAY);
    }

    function test_emptySignerArrayAllowed() public {
        address[] memory s = new address[](0);
        OffchainResolver r = new OffchainResolver(contractOwner, s, GATEWAY);
        assertEq(r.owner(), contractOwner);
    }

    // ─── addSigner / removeSigner ─────────────────────────────────────────────

    function test_addSigner() public {
        address newSigner = makeAddr("newSigner");
        assertFalse(resolver.signers(newSigner));
        resolver.addSigner(newSigner);
        assertTrue(resolver.signers(newSigner));
    }

    function test_addSignerEmitsEvent() public {
        address newSigner = makeAddr("newSigner");
        vm.expectEmit(true, false, false, false);
        emit OffchainResolver.SignerAdded(newSigner);
        resolver.addSigner(newSigner);
    }

    function test_revertAddSignerNotOwner() public {
        vm.prank(alice);
        vm.expectRevert(OffchainResolver.Unauthorized.selector);
        resolver.addSigner(alice);
    }

    function test_revertAddSignerZeroAddress() public {
        vm.expectRevert(OffchainResolver.ZeroAddress.selector);
        resolver.addSigner(address(0));
    }

    function test_removeSigner() public {
        assertTrue(resolver.signers(signer1Addr));
        resolver.removeSigner(signer1Addr);
        assertFalse(resolver.signers(signer1Addr));
    }

    function test_removeSignerEmitsEvent() public {
        vm.expectEmit(true, false, false, false);
        emit OffchainResolver.SignerRemoved(signer1Addr);
        resolver.removeSigner(signer1Addr);
    }

    function test_revertRemoveSignerNotOwner() public {
        vm.prank(alice);
        vm.expectRevert(OffchainResolver.Unauthorized.selector);
        resolver.removeSigner(signer1Addr);
    }

    function test_setGatewayUrl() public {
        resolver.setGatewayUrl("https://new-gateway.com/{sender}/{data}.json");
        assertEq(resolver.gatewayUrl(), "https://new-gateway.com/{sender}/{data}.json");
    }

    // ─── resolve() triggers OffchainLookup ───────────────────────────────────

    function test_resolveRevertsWithOffchainLookup() public {
        vm.expectRevert();
        resolver.resolve(NAME_BYTES, CALL_DATA);
    }

    // ─── resolveWithProof — multi-signer ─────────────────────────────────────

    function test_resolveWithProofSigner1() public {
        bytes memory result = abi.encode(alice);
        uint64 expires = uint64(block.timestamp + 3600);
        bytes memory response = _buildResponse(result, expires, CALL_DATA, signer1PrivateKey);

        bytes memory returned = resolver.resolveWithProof(response, _extraData());
        assertEq(abi.decode(returned, (address)), alice);
    }

    function test_resolveWithProofSigner2() public {
        bytes memory result = abi.encode(alice);
        uint64 expires = uint64(block.timestamp + 3600);
        bytes memory response = _buildResponse(result, expires, CALL_DATA, signer2PrivateKey);

        bytes memory returned = resolver.resolveWithProof(response, _extraData());
        assertEq(abi.decode(returned, (address)), alice);
    }

    function test_revertInvalidSignerNotInMapping() public {
        bytes memory result = abi.encode(alice);
        uint64 expires = uint64(block.timestamp + 3600);
        // 0xBAD is not in the signers mapping
        bytes memory response = _buildResponse(result, expires, CALL_DATA, 0xBAD);

        vm.expectRevert(OffchainResolver.InvalidSigner.selector);
        resolver.resolveWithProof(response, _extraData());
    }

    function test_revertAfterSignerRemoved() public {
        // Remove signer1 — their signatures should now be rejected
        resolver.removeSigner(signer1Addr);

        bytes memory result = abi.encode(alice);
        uint64 expires = uint64(block.timestamp + 3600);
        bytes memory response = _buildResponse(result, expires, CALL_DATA, signer1PrivateKey);

        vm.expectRevert(OffchainResolver.InvalidSigner.selector);
        resolver.resolveWithProof(response, _extraData());
    }

    function test_resolveWithProofAfterSignerAdded() public {
        uint256 newKey = 0xC0FFEE;
        address newSignerAddr = vm.addr(newKey);
        resolver.addSigner(newSignerAddr);

        bytes memory result = abi.encode(alice);
        uint64 expires = uint64(block.timestamp + 3600);
        bytes memory response = _buildResponse(result, expires, CALL_DATA, newKey);

        bytes memory returned = resolver.resolveWithProof(response, _extraData());
        assertEq(abi.decode(returned, (address)), alice);
    }

    function test_revertExpiredSignature() public {
        bytes memory result = abi.encode(alice);
        uint64 expires = uint64(block.timestamp - 1);
        bytes memory response = _buildResponse(result, expires, CALL_DATA);

        vm.expectRevert(OffchainResolver.SignatureExpired.selector);
        resolver.resolveWithProof(response, _extraData());
    }

    function test_revertInvalidSignatureLength() public {
        bytes memory result = abi.encode(alice);
        uint64 expires = uint64(block.timestamp + 3600);
        bytes memory badSig = hex"1234"; // too short
        bytes memory response = abi.encode(result, expires, badSig);

        vm.expectRevert(OffchainResolver.InvalidSignatureLength.selector);
        resolver.resolveWithProof(response, _extraData());
    }

    function test_revertSignatureDoesNotBindToCalldata() public {
        // Sign for different callData — should fail because calldata binding check fails
        bytes memory result = abi.encode(alice);
        uint64 expires = uint64(block.timestamp + 3600);
        bytes memory differentCallData = hex"deadbeef";
        bytes memory response = _buildResponse(result, expires, differentCallData);

        // resolveWithProof uses CALL_DATA from extraData, not differentCallData → sig mismatch
        vm.expectRevert(OffchainResolver.InvalidSigner.selector);
        resolver.resolveWithProof(response, _extraData());
    }

    // ─── supportsInterface ────────────────────────────────────────────────────

    function test_supportsEIP165() public view {
        assertTrue(resolver.supportsInterface(0x01ffc9a7));
    }

    function test_supportsExtendedResolver() public view {
        assertTrue(resolver.supportsInterface(0x9061b923));
    }

    function test_supportsIERC7996() public view {
        assertTrue(resolver.supportsInterface(0x582de3e7));
    }

    function test_supportsFeatureReturnsFalse() public view {
        assertFalse(resolver.supportsFeature(0x12345678));
        assertFalse(resolver.supportsFeature(0x00000000));
        assertFalse(resolver.supportsFeature(0xffffffff));
    }
}
