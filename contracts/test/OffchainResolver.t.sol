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

    function setUp() public {
        contractOwner = address(this);
        alice = makeAddr("alice");
        signerAddr = vm.addr(signerPrivateKey);
        resolver = new OffchainResolver(contractOwner, signerAddr, GATEWAY);
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

    // ─── resolve() triggers OffchainLookup ────────────────────────────────────

    function test_resolveRevertsWithOffchainLookup() public {
        bytes memory name = bytes("alice.test.eth");
        bytes memory data = hex"3b3b57de"; // addr(bytes32)

        vm.expectRevert();
        resolver.resolve(name, data);
    }

    // ─── resolveWithProof ─────────────────────────────────────────────────────

    function _buildResponse(bytes memory result, uint64 expires)
        internal
        view
        returns (bytes memory response)
    {
        bytes32 messageHash = keccak256(
            abi.encodePacked(hex"1900", address(resolver), expires, keccak256(result))
        );
        bytes32 ethHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPrivateKey, ethHash);
        bytes memory sig = abi.encodePacked(r, s, v);
        response = abi.encode(result, expires, sig);
    }

    function test_resolveWithProofValid() public {
        bytes memory result = abi.encode(alice);
        uint64 expires = uint64(block.timestamp + 3600);
        bytes memory response = _buildResponse(result, expires);

        bytes memory returned = resolver.resolveWithProof(response, "");
        assertEq(abi.decode(returned, (address)), alice);
    }

    function test_revertExpiredSignature() public {
        bytes memory result = abi.encode(alice);
        uint64 expires = uint64(block.timestamp - 1);
        bytes memory response = _buildResponse(result, expires);

        vm.expectRevert(OffchainResolver.SignatureExpired.selector);
        resolver.resolveWithProof(response, "");
    }

    function test_revertWrongSigner() public {
        bytes memory result = abi.encode(alice);
        uint64 expires = uint64(block.timestamp + 3600);

        // Sign with a different key
        bytes32 messageHash = keccak256(
            abi.encodePacked(hex"1900", address(resolver), expires, keccak256(result))
        );
        bytes32 ethHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
        );
        uint256 wrongKey = 0xBAD;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongKey, ethHash);
        bytes memory sig = abi.encodePacked(r, s, v);
        bytes memory response = abi.encode(result, expires, sig);

        vm.expectRevert(OffchainResolver.InvalidSigner.selector);
        resolver.resolveWithProof(response, "");
    }

    // ─── supportsInterface ────────────────────────────────────────────────────

    function test_supportsEIP165() public view {
        assertTrue(resolver.supportsInterface(0x01ffc9a7));
    }

    function test_supportsExtendedResolver() public view {
        assertTrue(resolver.supportsInterface(0x9061b923));
    }
}
