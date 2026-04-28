// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.23;

import "forge-std/Test.sol";
import "../src/OPResolver.sol";
import {IGatewayVerifier} from "@unruggable/contracts/IGatewayVerifier.sol";

/// @notice Unit tests for the new OPResolver (C3 — storage proof mode).
///         Proof-path integration tests require a live OP Sepolia fork and are
///         covered in test/e2e/op-resolver.test.ts.
contract OPResolverTest is Test {
    OPResolver public resolver;
    address public contractOwner;
    address public alice;

    // Minimal mock: satisfies IGatewayVerifier interface
    address constant MOCK_VERIFIER = address(0x1111111111111111111111111111111111111111);
    address constant MOCK_L2RECORDS = address(0x2222222222222222222222222222222222222222);

    // addr(bytes32 node) calldata — node = keccak256("alice.aastar.eth")
    bytes32 constant NODE = keccak256("alice.aastar.eth");
    bytes constant ADDR_CALL = abi.encodeWithSelector(bytes4(0x3b3b57de), NODE);
    bytes constant NAME_BYTES = bytes("alice.aastar.eth");

    function setUp() public {
        contractOwner = address(this);
        alice = makeAddr("alice");

        // Deploy with mock verifier (unit tests don't need real proof verification)
        vm.etch(MOCK_VERIFIER, hex"00"); // give it some code so address checks pass
        resolver = new OPResolver(
            contractOwner,
            IGatewayVerifier(MOCK_VERIFIER),
            MOCK_L2RECORDS
        );
    }

    // ─── Constructor ──────────────────────────────────────────────────────────

    function test_constructorSetsOwner() public view {
        assertEq(resolver.owner(), contractOwner);
    }

    function test_constructorSetsVerifier() public view {
        assertEq(address(resolver.verifier()), MOCK_VERIFIER);
    }

    function test_constructorSetsL2RecordsAddress() public view {
        assertEq(resolver.l2RecordsAddress(), MOCK_L2RECORDS);
    }

    function test_revertZeroOwner() public {
        vm.expectRevert(OPResolver.ZeroAddress.selector);
        new OPResolver(address(0), IGatewayVerifier(MOCK_VERIFIER), MOCK_L2RECORDS);
    }

    function test_revertZeroVerifier() public {
        vm.expectRevert(OPResolver.ZeroAddress.selector);
        new OPResolver(contractOwner, IGatewayVerifier(address(0)), MOCK_L2RECORDS);
    }

    function test_revertZeroL2Records() public {
        vm.expectRevert(OPResolver.ZeroAddress.selector);
        new OPResolver(contractOwner, IGatewayVerifier(MOCK_VERIFIER), address(0));
    }

    // ─── resolve() reverts with OffchainLookup ────────────────────────────────

    function test_resolveAddrRevertsOffchainLookup() public {
        // resolve() always reverts with OffchainLookup (triggers CCIP-Read client)
        vm.expectRevert();
        resolver.resolve(NAME_BYTES, ADDR_CALL);
    }

    function test_resolveUnsupportedSelectorReverts() public {
        bytes memory badCall = abi.encodeWithSelector(bytes4(0xdeadbeef), NODE);
        vm.expectRevert(abi.encodeWithSelector(OPResolver.UnsupportedSelector.selector, bytes4(0xdeadbeef)));
        resolver.resolve(NAME_BYTES, badCall);
    }

    // ─── setVerifier ──────────────────────────────────────────────────────────

    function test_ownerCanSetVerifier() public {
        address newVerifier = address(0x3333333333333333333333333333333333333333);
        vm.etch(newVerifier, hex"00");
        resolver.setVerifier(IGatewayVerifier(newVerifier));
        assertEq(address(resolver.verifier()), newVerifier);
    }

    function test_setVerifierEmitsEvent() public {
        address newVerifier = address(0x4444444444444444444444444444444444444444);
        vm.etch(newVerifier, hex"00");
        vm.expectEmit(true, true, false, false);
        emit OPResolver.VerifierUpdated(MOCK_VERIFIER, newVerifier);
        resolver.setVerifier(IGatewayVerifier(newVerifier));
    }

    function test_nonOwnerCannotSetVerifier() public {
        vm.prank(alice);
        vm.expectRevert(OPResolver.Unauthorized.selector);
        resolver.setVerifier(IGatewayVerifier(MOCK_VERIFIER));
    }

    function test_setVerifierRejectsZero() public {
        vm.expectRevert(OPResolver.ZeroAddress.selector);
        resolver.setVerifier(IGatewayVerifier(address(0)));
    }

    // ─── setL2RecordsAddress ──────────────────────────────────────────────────

    function test_ownerCanSetL2Records() public {
        address newAddr = address(0x5555555555555555555555555555555555555555);
        resolver.setL2RecordsAddress(newAddr);
        assertEq(resolver.l2RecordsAddress(), newAddr);
    }

    function test_nonOwnerCannotSetL2Records() public {
        vm.prank(alice);
        vm.expectRevert(OPResolver.Unauthorized.selector);
        resolver.setL2RecordsAddress(MOCK_L2RECORDS);
    }

    function test_setL2RecordsRejectsZero() public {
        vm.expectRevert(OPResolver.ZeroAddress.selector);
        resolver.setL2RecordsAddress(address(0));
    }

    // ─── transferOwnership ────────────────────────────────────────────────────

    function test_ownerCanTransfer() public {
        resolver.transferOwnership(alice);
        assertEq(resolver.owner(), alice);
    }

    function test_transferOwnershipEmitsEvent() public {
        vm.expectEmit(true, true, false, false);
        emit OPResolver.OwnershipTransferred(contractOwner, alice);
        resolver.transferOwnership(alice);
    }

    function test_nonOwnerCannotTransfer() public {
        vm.prank(alice);
        vm.expectRevert(OPResolver.Unauthorized.selector);
        resolver.transferOwnership(alice);
    }

    function test_transferOwnershipRejectsZero() public {
        vm.expectRevert(OPResolver.ZeroAddress.selector);
        resolver.transferOwnership(address(0));
    }

    // ─── supportsInterface ────────────────────────────────────────────────────

    function test_supportsIExtendedResolver() public view {
        assertTrue(resolver.supportsInterface(0x9061b923));
    }

    function test_supportsEIP165() public view {
        assertTrue(resolver.supportsInterface(0x01ffc9a7));
    }

    function test_doesNotSupportRandomInterface() public view {
        assertFalse(resolver.supportsInterface(0xdeadbeef));
    }

    function test_supportsAddrResolver() public view {
        assertTrue(resolver.supportsInterface(0x3b3b57de)); // IAddrResolver
    }

    function test_supportsAddressResolver() public view {
        assertTrue(resolver.supportsInterface(0xf1cb7e06)); // IAddressResolver
    }

    function test_supportsTextResolver() public view {
        assertTrue(resolver.supportsInterface(0x59d1d43c)); // ITextResolver
    }

    function test_supportsContentHashResolver() public view {
        assertTrue(resolver.supportsInterface(0xbc1c58d1)); // IContentHashResolver
    }

    // ─── resolve() short-calldata guard ──────────────────────────────────────

    function test_resolveShortCalldataReverts() public {
        bytes memory shortData = hex"aabbcc"; // 3 bytes < 4
        vm.expectRevert();
        resolver.resolve(NAME_BYTES, shortData);
    }

    // ─── addrCallback ─────────────────────────────────────────────────────────

    function test_addrCallback_ETH_returns_correct_address() public view {
        // ETH address stored as raw 20 bytes (left-aligned in memory)
        address expected = address(0x1234567890AbcdEF1234567890aBcdef12345678);
        bytes[] memory values = new bytes[](1);
        values[0] = abi.encodePacked(expected); // 20 raw bytes

        // carry = addr(bytes32 node) selector + node
        bytes memory carry = abi.encodeWithSelector(bytes4(0x3b3b57de), NODE);
        bytes memory result = resolver.addrCallback(values, 0, carry);
        address decoded = abi.decode(result, (address));
        assertEq(decoded, expected);
    }

    function test_addrCallback_ETH_zeroes_on_exitCode_nonzero() public view {
        bytes[] memory values = new bytes[](1);
        values[0] = abi.encodePacked(address(0x1234567890AbcdEF1234567890aBcdef12345678));
        bytes memory carry = abi.encodeWithSelector(bytes4(0x3b3b57de), NODE);
        bytes memory result = resolver.addrCallback(values, 1, carry);
        address decoded = abi.decode(result, (address));
        assertEq(decoded, address(0));
    }

    function test_addrCallback_ETH_zeroes_on_empty_values() public view {
        bytes[] memory values = new bytes[](0); // empty values array
        bytes memory carry = abi.encodeWithSelector(bytes4(0x3b3b57de), NODE);
        bytes memory result = resolver.addrCallback(values, 0, carry);
        address decoded = abi.decode(result, (address));
        assertEq(decoded, address(0));
    }

    function test_addrCallback_multiCoin_returns_raw_bytes() public view {
        bytes memory btcAddr = hex"deadbeefcafe";
        bytes[] memory values = new bytes[](1);
        values[0] = btcAddr;
        // carry = addr(bytes32 node, uint256 coinType) selector
        bytes memory carry = abi.encodeWithSelector(bytes4(0xf1cb7e06), NODE, uint256(0));
        bytes memory result = resolver.addrCallback(values, 0, carry);
        bytes memory decoded = abi.decode(result, (bytes));
        assertEq(decoded, btcAddr);
    }

    // ─── textCallback ─────────────────────────────────────────────────────────

    function test_textCallback_returns_string() public view {
        bytes[] memory values = new bytes[](1);
        values[0] = bytes("hello world");
        bytes memory result = resolver.textCallback(values, 0, "");
        string memory decoded = abi.decode(result, (string));
        assertEq(decoded, "hello world");
    }

    function test_textCallback_empty_on_exitCode_nonzero() public view {
        bytes[] memory values = new bytes[](1);
        values[0] = bytes("ignored");
        bytes memory result = resolver.textCallback(values, 1, "");
        string memory decoded = abi.decode(result, (string));
        assertEq(decoded, "");
    }

    function test_textCallback_empty_on_empty_values() public view {
        bytes[] memory values = new bytes[](0);
        bytes memory result = resolver.textCallback(values, 0, "");
        string memory decoded = abi.decode(result, (string));
        assertEq(decoded, "");
    }

    // ─── contenthashCallback ─────────────────────────────────────────────────

    function test_contenthashCallback_returns_bytes() public view {
        bytes memory ipfsHash = hex"e30101701220abcdef";
        bytes[] memory values = new bytes[](1);
        values[0] = ipfsHash;
        bytes memory result = resolver.contenthashCallback(values, 0, "");
        bytes memory decoded = abi.decode(result, (bytes));
        assertEq(decoded, ipfsHash);
    }

    function test_contenthashCallback_empty_on_exitCode_nonzero() public view {
        bytes[] memory values = new bytes[](1);
        values[0] = hex"e30101701220abcdef";
        bytes memory result = resolver.contenthashCallback(values, 1, "");
        bytes memory decoded = abi.decode(result, (bytes));
        assertEq(decoded.length, 0);
    }

    function test_contenthashCallback_empty_on_empty_values() public view {
        bytes[] memory values = new bytes[](0);
        bytes memory result = resolver.contenthashCallback(values, 0, "");
        bytes memory decoded = abi.decode(result, (bytes));
        assertEq(decoded.length, 0);
    }
}
