// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/OffchainResolver.sol";

contract OffchainResolverTest is Test {
    OffchainResolver public resolver;
    address public contractOwner;
    address public alice;

    uint256 signerPrivateKey = 0xA11CE;
    address signerAddr;

    string constant GATEWAY = "https://gateway.example.com/{sender}/{data}.json";

    // Sample callData and extraData matching resolve() output
    bytes constant CALL_DATA = hex"3b3b57deabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab";
    bytes constant NAME_BYTES = bytes("alice.test.eth");

    function setUp() public {
        contractOwner = address(this);
        alice = makeAddr("alice");
        signerAddr = vm.addr(signerPrivateKey);
        resolver = new OffchainResolver(contractOwner, signerAddr, GATEWAY);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    /// @dev Builds a valid gateway response matching the EIP-3668 signing scheme.
    ///      Signs: keccak256(hex"1900" ++ resolver ++ expires ++ keccak256(callData) ++ keccak256(result))
    function _buildResponse(bytes memory result, uint64 expires, bytes memory callData)
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
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPrivateKey, ethHash);
        bytes memory sig = abi.encodePacked(r, s, v);
        response = abi.encode(result, expires, sig);
    }

    function _extraData() internal pure returns (bytes memory) {
        return abi.encode(NAME_BYTES, CALL_DATA);
    }

    // ─── Constructor ──────────────────────────────────────────────────────────

    function test_ownerAndSignerSet() public view {
        assertEq(resolver.owner(), contractOwner);
        assertEq(resolver.signerAddress(), signerAddr);
        assertEq(resolver.gatewayUrl(), GATEWAY);
    }

    function test_revertZeroOwner() public {
        vm.expectRevert(OffchainResolver.ZeroAddress.selector);
        new OffchainResolver(address(0), signerAddr, GATEWAY);
    }

    function test_revertZeroSigner() public {
        vm.expectRevert(OffchainResolver.ZeroAddress.selector);
        new OffchainResolver(contractOwner, address(0), GATEWAY);
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    function test_setSigner() public {
        resolver.setSigner(alice);
        assertEq(resolver.signerAddress(), alice);
    }

    function test_revertSetSignerNotOwner() public {
        vm.prank(alice);
        vm.expectRevert(OffchainResolver.Unauthorized.selector);
        resolver.setSigner(alice);
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

    // ─── resolveWithProof ─────────────────────────────────────────────────────

    function test_resolveWithProofValid() public {
        bytes memory result = abi.encode(alice);
        uint64 expires = uint64(block.timestamp + 3600);
        bytes memory response = _buildResponse(result, expires, CALL_DATA);

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

    function test_revertWrongSigner() public {
        bytes memory result = abi.encode(alice);
        uint64 expires = uint64(block.timestamp + 3600);

        bytes32 messageHash = keccak256(
            abi.encodePacked(
                hex"1900", address(resolver), expires,
                keccak256(CALL_DATA), keccak256(result)
            )
        );
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, ethHash);
        bytes memory sig = abi.encodePacked(r, s, v);
        bytes memory response = abi.encode(result, expires, sig);

        vm.expectRevert(OffchainResolver.InvalidSigner.selector);
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
}
