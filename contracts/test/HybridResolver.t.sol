// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.23;

import "forge-std/Test.sol";
import {HybridResolver} from "../src/HybridResolver.sol";
import {GatewayRequest} from "@unruggable/contracts/GatewayRequest.sol";
import {IGatewayVerifier} from "@unruggable/contracts/IGatewayVerifier.sol";

/// @dev Mock verifier: returns preset values for the PROOF path and a fixed
///      context/urls. We assert HybridResolver decodes verified values correctly;
///      the real OPFaultVerifier's proof verification is exercised on-chain (Sepolia).
contract MockVerifier is IGatewayVerifier {
    bytes[] public retValues;
    uint8 public retExit;

    function setReturn(bytes[] memory v, uint8 exitCode) external {
        delete retValues;
        for (uint256 i = 0; i < v.length; i++) retValues.push(v[i]);
        retExit = exitCode;
    }

    function getLatestContext() external pure returns (bytes memory) {
        return hex"c0ffee";
    }

    function gatewayURLs() external pure returns (string[] memory u) {
        u = new string[](1);
        u[0] = "https://gw.example/{sender}/{data}";
    }

    function getStorageValues(bytes memory, GatewayRequest memory, bytes memory)
        external
        view
        returns (bytes[] memory, uint8)
    {
        return (retValues, retExit);
    }
}

contract HybridResolverTest is Test {
    HybridResolver resolver;
    MockVerifier verifier;

    uint256 signerPk = 0xA11CE;
    address signer;
    address owner = address(this);
    address constant L2 = address(0xBEEF);

    bytes4 constant SEL_ADDR  = 0x3b3b57de;
    bytes4 constant SEL_TEXT  = 0x59d1d43c;
    bytes4 constant SEL_CHASH = 0xbc1c58d1;

    bytes32 constant NODE = keccak256("alice.aastar.eth");
    address constant ALICE = address(0x1234567890AbcdEF1234567890aBcdef12345678);

    function setUp() public {
        signer = vm.addr(signerPk);
        verifier = new MockVerifier();
        address[] memory signers = new address[](1);
        signers[0] = signer;
        resolver = new HybridResolver(owner, IGatewayVerifier(address(verifier)), L2, signers, "https://gw/{sender}/{data}");
    }

    // ─── resolve() emits OffchainLookup ──────────────────────────────────────────
    function test_resolveRevertsWithOffchainLookup() public {
        bytes memory data = abi.encodeWithSelector(SEL_ADDR, NODE);
        vm.expectRevert(); // OffchainLookup(this, urls, blob, hybridCallback.selector, blob)
        resolver.resolve("\x05alice", data);
    }

    // ─── SIG path ────────────────────────────────────────────────────────────────
    function _signResponse(bytes memory result, uint64 expires, bytes memory data, uint256 pk)
        internal
        view
        returns (bytes memory)
    {
        bytes32 messageHash = keccak256(
            abi.encodePacked(hex"1900", address(resolver), expires, keccak256(data), keccak256(result))
        );
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, ethHash);
        bytes memory sig = abi.encodePacked(r, s, v);
        return abi.encode(uint8(0), abi.encode(result, expires, sig)); // mode 0 = SIG
    }

    function _carry(bytes memory data) internal pure returns (bytes memory) {
        GatewayRequest memory req = GatewayRequest({ops: hex""});
        return abi.encode(hex"c0ffee", req, data);
    }

    function test_sigPath_validSignatureResolves() public view {
        bytes memory data = abi.encodeWithSelector(SEL_ADDR, NODE);
        bytes memory result = abi.encode(ALICE);
        bytes memory response = _signResponse(result, uint64(block.timestamp + 3600), data, signerPk);
        bytes memory out = resolver.hybridCallback(response, _carry(data));
        assertEq(abi.decode(out, (address)), ALICE);
    }

    function test_sigPath_expiredReverts() public {
        bytes memory data = abi.encodeWithSelector(SEL_ADDR, NODE);
        bytes memory result = abi.encode(ALICE);
        // expires in the past
        vm.warp(10_000);
        bytes memory response = _signResponse(result, uint64(9_000), data, signerPk);
        vm.expectRevert(HybridResolver.SignatureExpired.selector);
        resolver.hybridCallback(response, _carry(data));
    }

    function test_sigPath_wrongSignerReverts() public {
        bytes memory data = abi.encodeWithSelector(SEL_ADDR, NODE);
        bytes memory result = abi.encode(ALICE);
        bytes memory response = _signResponse(result, uint64(block.timestamp + 3600), data, 0xBADBAD);
        vm.expectRevert(HybridResolver.InvalidSigner.selector);
        resolver.hybridCallback(response, _carry(data));
    }

    function test_sigPath_badSigLengthReverts() public {
        bytes memory data = abi.encodeWithSelector(SEL_ADDR, NODE);
        bytes memory badResp =
            abi.encode(uint8(0), abi.encode(abi.encode(ALICE), uint64(block.timestamp + 3600), hex"1234"));
        vm.expectRevert(HybridResolver.InvalidSignatureLength.selector);
        resolver.hybridCallback(badResp, _carry(data));
    }

    function test_sigPath_removedSignerReverts() public {
        resolver.removeSigner(signer);
        bytes memory data = abi.encodeWithSelector(SEL_ADDR, NODE);
        bytes memory response = _signResponse(abi.encode(ALICE), uint64(block.timestamp + 3600), data, signerPk);
        vm.expectRevert(HybridResolver.InvalidSigner.selector);
        resolver.hybridCallback(response, _carry(data));
    }

    // ─── PROOF path (decoding of verified values) ────────────────────────────────
    function _proofResponse() internal pure returns (bytes memory) {
        return abi.encode(uint8(1), bytes("")); // mode 1 = PROOF; payload unused by mock
    }

    function test_proofPath_addrDecodes() public {
        bytes memory data = abi.encodeWithSelector(SEL_ADDR, NODE);
        bytes[] memory v = new bytes[](1);
        v[0] = abi.encodePacked(ALICE); // 20 bytes, left-aligned consumed via shr(96)
        verifier.setReturn(v, 0);
        bytes memory out = resolver.hybridCallback(_proofResponse(), _carry(data));
        assertEq(abi.decode(out, (address)), ALICE);
    }

    function test_proofPath_addrEmptyReturnsZero() public {
        bytes memory data = abi.encodeWithSelector(SEL_ADDR, NODE);
        bytes[] memory v = new bytes[](0);
        verifier.setReturn(v, 0);
        bytes memory out = resolver.hybridCallback(_proofResponse(), _carry(data));
        assertEq(abi.decode(out, (address)), address(0));
    }

    function test_proofPath_textDecodes() public {
        bytes memory data = abi.encodeWithSelector(SEL_TEXT, NODE, "com.twitter");
        bytes[] memory v = new bytes[](1);
        v[0] = bytes("@alice");
        verifier.setReturn(v, 0);
        bytes memory out = resolver.hybridCallback(_proofResponse(), _carry(data));
        assertEq(abi.decode(out, (string)), "@alice");
    }

    function test_proofPath_exitCodeNonzeroReturnsEmpty() public {
        bytes memory data = abi.encodeWithSelector(SEL_TEXT, NODE, "com.twitter");
        bytes[] memory v = new bytes[](1);
        v[0] = bytes("@alice");
        verifier.setReturn(v, 1); // exitCode != 0 → treated as not found
        bytes memory out = resolver.hybridCallback(_proofResponse(), _carry(data));
        assertEq(abi.decode(out, (string)), "");
    }

    function test_proofPath_contenthashDecodes() public {
        bytes memory data = abi.encodeWithSelector(SEL_CHASH, NODE);
        bytes[] memory v = new bytes[](1);
        v[0] = hex"e30101701220abcd";
        verifier.setReturn(v, 0);
        bytes memory out = resolver.hybridCallback(_proofResponse(), _carry(data));
        assertEq(abi.decode(out, (bytes)), hex"e30101701220abcd");
    }

    // ─── mode branching ──────────────────────────────────────────────────────────
    function test_unknownModeReverts() public {
        bytes memory data = abi.encodeWithSelector(SEL_ADDR, NODE);
        bytes memory response = abi.encode(uint8(2), bytes(""));
        vm.expectRevert(abi.encodeWithSelector(HybridResolver.UnknownMode.selector, uint8(2)));
        resolver.hybridCallback(response, _carry(data));
    }

    // ─── admin / access control ──────────────────────────────────────────────────
    function test_onlyOwnerSetVerifier() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert(HybridResolver.Unauthorized.selector);
        resolver.setVerifier(IGatewayVerifier(address(0x9999)));
    }

    function test_addRemoveSigner() public {
        address s2 = address(0xCAFE);
        resolver.addSigner(s2);
        assertTrue(resolver.signers(s2));
        resolver.removeSigner(s2);
        assertFalse(resolver.signers(s2));
    }

    function test_setVerifierUpdates() public {
        MockVerifier v2 = new MockVerifier();
        resolver.setVerifier(IGatewayVerifier(address(v2)));
        assertEq(address(resolver.verifier()), address(v2));
    }

    function test_supportsInterface() public view {
        assertTrue(resolver.supportsInterface(0x9061b923)); // IExtendedResolver
        assertTrue(resolver.supportsInterface(0x3b3b57de)); // addr
        assertFalse(resolver.supportsInterface(0xffffffff));
    }
}
