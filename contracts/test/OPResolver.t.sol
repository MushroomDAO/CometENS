// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/OPResolver.sol";

contract OPResolverTest is Test {
    OPResolver public resolver;
    address public contractOwner;
    address public alice;

    uint256 signer1PrivateKey = 0xA11CE;
    uint256 signer2PrivateKey = 0xB0B;
    address signer1Addr;
    address signer2Addr;

    string constant GATEWAY = "https://gateway.example.com/{sender}/{data}.json";

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
        // Deploy in signature mode (verifyProofs = false)
        resolver = new OPResolver(contractOwner, initialSigners, GATEWAY, false);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    /// @dev Builds a valid EIP-3668 gateway response using the given private key.
    function _buildSignatureResponse(
        bytes memory result,
        uint64 expires,
        bytes memory callData,
        uint256 privateKey
    ) internal view returns (bytes memory response) {
        bytes32 messageHash = keccak256(
            abi.encodePacked(
                hex"1900",
                address(resolver),
                expires,
                keccak256(callData),
                keccak256(result)
            )
        );
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, ethHash);
        bytes memory sig = abi.encodePacked(r, s, v);
        response = abi.encode(result, expires, sig);
    }

    function _buildSignatureResponse(bytes memory result, uint64 expires, bytes memory callData)
        internal
        view
        returns (bytes memory)
    {
        return _buildSignatureResponse(result, expires, callData, signer1PrivateKey);
    }

    function _extraData() internal pure returns (bytes memory) {
        return abi.encode(NAME_BYTES, CALL_DATA);
    }

    /// @dev Builds a minimal proof-mode response (stateRoot + empty storageProof).
    function _buildProofResponse(bytes memory result) internal pure returns (bytes memory) {
        bytes32 stateRoot = keccak256("dummy-state-root");
        bytes[] memory storageProof = new bytes[](0);
        bytes memory proof = abi.encode(stateRoot, storageProof);
        return abi.encode(result, proof);
    }

    // ─── Constructor ──────────────────────────────────────────────────────────

    function test_ownerSignersAndFlagSet() public view {
        assertEq(resolver.owner(), contractOwner);
        assertTrue(resolver.signers(signer1Addr));
        assertTrue(resolver.signers(signer2Addr));
        assertEq(resolver.gatewayUrl(), GATEWAY);
        assertFalse(resolver.verifyProofs(), "should start in signature mode");
    }

    function test_revertZeroOwner() public {
        address[] memory s = new address[](0);
        vm.expectRevert(OPResolver.ZeroAddress.selector);
        new OPResolver(address(0), s, GATEWAY, false);
    }

    function test_revertZeroSigner() public {
        address[] memory s = new address[](1);
        s[0] = address(0);
        vm.expectRevert(OPResolver.ZeroAddress.selector);
        new OPResolver(contractOwner, s, GATEWAY, false);
    }

    // ─── resolve() always reverts with OffchainLookup ─────────────────────────

    function test_resolveRevertsWithOffchainLookup() public {
        vm.expectRevert();
        resolver.resolve(NAME_BYTES, CALL_DATA);
    }

    function test_resolveRevertsInProofModeAlso() public {
        resolver.setVerifyProofs(true);
        vm.expectRevert();
        resolver.resolve(NAME_BYTES, CALL_DATA);
    }

    // ─── resolveWithProof — signature mode ───────────────────────────────────

    function test_resolveWithProofSignatureMode() public view {
        bytes memory result = abi.encode(alice);
        uint64 expires = uint64(block.timestamp + 3600);
        bytes memory response = _buildSignatureResponse(result, expires, CALL_DATA);

        bytes memory returned = resolver.resolveWithProof(response, _extraData());
        assertEq(abi.decode(returned, (address)), alice);
    }

    function test_resolveWithProofSigner2SignatureMode() public view {
        bytes memory result = abi.encode(alice);
        uint64 expires = uint64(block.timestamp + 3600);
        bytes memory response = _buildSignatureResponse(result, expires, CALL_DATA, signer2PrivateKey);

        bytes memory returned = resolver.resolveWithProof(response, _extraData());
        assertEq(abi.decode(returned, (address)), alice);
    }

    function test_revertExpiredSignature() public {
        bytes memory result = abi.encode(alice);
        uint64 expires = uint64(block.timestamp - 1);
        bytes memory response = _buildSignatureResponse(result, expires, CALL_DATA);

        vm.expectRevert(OPResolver.SignatureExpired.selector);
        resolver.resolveWithProof(response, _extraData());
    }

    function test_revertInvalidSigner() public {
        bytes memory result = abi.encode(alice);
        uint64 expires = uint64(block.timestamp + 3600);
        bytes memory response = _buildSignatureResponse(result, expires, CALL_DATA, 0xBAD);

        vm.expectRevert(OPResolver.InvalidSigner.selector);
        resolver.resolveWithProof(response, _extraData());
    }

    function test_revertInvalidSignatureLength() public {
        bytes memory result = abi.encode(alice);
        uint64 expires = uint64(block.timestamp + 3600);
        bytes memory badSig = hex"1234";
        bytes memory response = abi.encode(result, expires, badSig);

        vm.expectRevert(OPResolver.InvalidSignatureLength.selector);
        resolver.resolveWithProof(response, _extraData());
    }

    function test_revertSignatureCalldataBindingMismatch() public {
        bytes memory result = abi.encode(alice);
        uint64 expires = uint64(block.timestamp + 3600);
        bytes memory differentCallData = hex"deadbeef";
        bytes memory response = _buildSignatureResponse(result, expires, differentCallData);

        vm.expectRevert(OPResolver.InvalidSigner.selector);
        resolver.resolveWithProof(response, _extraData());
    }

    function test_revertAfterSignerRemoved() public {
        resolver.removeSigner(signer1Addr);

        bytes memory result = abi.encode(alice);
        uint64 expires = uint64(block.timestamp + 3600);
        bytes memory response = _buildSignatureResponse(result, expires, CALL_DATA, signer1PrivateKey);

        vm.expectRevert(OPResolver.InvalidSigner.selector);
        resolver.resolveWithProof(response, _extraData());
    }

    // ─── resolveWithProof — proof mode (C2 stub) ─────────────────────────────

    function test_resolveWithProofModeRevertsNotImplemented() public {
        resolver.setVerifyProofs(true);

        bytes memory result = abi.encode(alice);
        bytes memory response = _buildProofResponse(result);

        vm.expectRevert(OPResolver.ProofVerificationNotImplemented.selector);
        resolver.resolveWithProof(response, _extraData());
    }

    // ─── setVerifyProofs — toggle ─────────────────────────────────────────────

    function test_toggleVerifyProofs() public {
        assertFalse(resolver.verifyProofs());

        resolver.setVerifyProofs(true);
        assertTrue(resolver.verifyProofs());

        resolver.setVerifyProofs(false);
        assertFalse(resolver.verifyProofs());
    }

    function test_toggleEmitsEvent() public {
        vm.expectEmit(false, false, false, true);
        emit OPResolver.VerifyProofsToggled(true);
        resolver.setVerifyProofs(true);
    }

    function test_nonOwnerCannotToggle() public {
        vm.prank(alice);
        vm.expectRevert(OPResolver.Unauthorized.selector);
        resolver.setVerifyProofs(true);
    }

    // ─── Admin helpers ────────────────────────────────────────────────────────

    function test_addSigner() public {
        address newSigner = makeAddr("newSigner");
        resolver.addSigner(newSigner);
        assertTrue(resolver.signers(newSigner));
    }

    function test_nonOwnerCannotAddSigner() public {
        vm.prank(alice);
        vm.expectRevert(OPResolver.Unauthorized.selector);
        resolver.addSigner(alice);
    }

    function test_transferOwnership() public {
        resolver.transferOwnership(alice);
        assertEq(resolver.owner(), alice);
    }

    function test_nonOwnerCannotTransferOwnership() public {
        vm.prank(alice);
        vm.expectRevert(OPResolver.Unauthorized.selector);
        resolver.transferOwnership(alice);
    }

    // ─── supportsInterface ────────────────────────────────────────────────────

    function test_supportsIExtendedResolver() public view {
        assertTrue(resolver.supportsInterface(0x9061b923));
    }

    function test_supportsEIP165() public view {
        assertTrue(resolver.supportsInterface(0x01ffc9a7));
    }

    function test_supportsIERC7996() public view {
        assertTrue(resolver.supportsInterface(0x582de3e7));
    }

    function test_supportsFeatureReturnsFalse() public view {
        assertFalse(resolver.supportsFeature(0x12345678));
    }
}
