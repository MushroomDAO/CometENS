// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import "../src/L2RecordsV3.sol";
import "../src/IRegistrarPlugin.sol";
import "../src/plugins/FreePlugin.sol";
import "../src/plugins/WhitelistPlugin.sol";
import "../src/plugins/FlatFeePlugin.sol";

/// @dev A helper plugin that always rejects — for negative canRegister testing.
contract RejectPlugin is ERC165, IRegistrarPlugin {
    function supportsInterface(bytes4 interfaceId) public view override(ERC165, IERC165) returns (bool) {
        bytes4 ifaceId = IRegistrarPlugin.canRegister.selector ^ IRegistrarPlugin.registrationFee.selector;
        return interfaceId == ifaceId || super.supportsInterface(interfaceId);
    }
    function canRegister(bytes32, string calldata, address) external pure returns (bool) {
        revert("rejected");
    }
    function registrationFee(bytes32, string calldata, address) external pure returns (uint256) {
        return 0;
    }
}

contract L2RecordsV3PluginTest is Test {
    L2RecordsV3 public records;

    address public owner;
    address public alice;
    address public bob;
    address public stranger;
    address public registrar;

    bytes32 constant ROOT_NODE   = bytes32(0);
    bytes32 constant LABEL_ALICE = keccak256("alice");
    bytes32 constant LABEL_BOB   = keccak256("bob");
    bytes32 constant LABEL_CAROL = keccak256("carol");
    bytes32 constant LABEL_DAN   = keccak256("dan");

    bytes32 NODE_ALICE;
    bytes32 NODE_BOB;
    bytes32 NODE_CAROL;
    bytes32 NODE_DAN;

    function setUp() public {
        owner     = address(this);
        alice     = makeAddr("alice");
        bob       = makeAddr("bob");
        stranger  = makeAddr("stranger");
        registrar = makeAddr("registrar");

        records = new L2RecordsV3(owner);

        NODE_ALICE = keccak256(abi.encodePacked(ROOT_NODE, LABEL_ALICE));
        NODE_BOB   = keccak256(abi.encodePacked(ROOT_NODE, LABEL_BOB));
        NODE_CAROL = keccak256(abi.encodePacked(ROOT_NODE, LABEL_CAROL));
        NODE_DAN   = keccak256(abi.encodePacked(ROOT_NODE, LABEL_DAN));

        vm.warp(1_000_000);
    }

    // ─── Helper ───────────────────────────────────────────────────────────────

    /// @dev Register alice's subdomain and give her some ETH for fee tests.
    function _mintAliceAndFund() internal returns (bytes32 aliceNode) {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        aliceNode = NODE_ALICE;
        vm.deal(alice, 10 ether);
    }

    // ─── setPlugin access control ─────────────────────────────────────────────

    function test_setPlugin_ownerCanSetOnAnyNode() public {
        FreePlugin plugin = new FreePlugin();
        records.setPlugin(ROOT_NODE, IRegistrarPlugin(address(plugin)));
        assertEq(address(records.registrarPlugin(ROOT_NODE)), address(plugin));
    }

    function test_setPlugin_nftOwnerCanSetOnTheirNode() public {
        // alice owns NODE_ALICE after registration
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        FreePlugin plugin = new FreePlugin();
        vm.prank(alice);
        records.setPlugin(NODE_ALICE, IRegistrarPlugin(address(plugin)));
        assertEq(address(records.registrarPlugin(NODE_ALICE)), address(plugin));
    }

    function test_setPlugin_strangerCannotSet() public {
        FreePlugin plugin = new FreePlugin();
        vm.prank(stranger);
        vm.expectRevert(L2RecordsV3.Unauthorized.selector);
        records.setPlugin(ROOT_NODE, IRegistrarPlugin(address(plugin)));
    }

    function test_setPlugin_registrarCannotSetPlugin() public {
        // Even an authorized registrar cannot set a plugin — only NFT owner or contract owner.
        records.addRegistrar(ROOT_NODE, registrar, 0, 0);
        FreePlugin plugin = new FreePlugin();
        vm.prank(registrar);
        vm.expectRevert(L2RecordsV3.Unauthorized.selector);
        records.setPlugin(ROOT_NODE, IRegistrarPlugin(address(plugin)));
    }

    function test_setPlugin_emitsEvent() public {
        FreePlugin plugin = new FreePlugin();
        vm.expectEmit(true, true, false, false);
        emit L2RecordsV3.PluginSet(ROOT_NODE, address(plugin));
        records.setPlugin(ROOT_NODE, IRegistrarPlugin(address(plugin)));
    }

    function test_setPlugin_clearWithAddressZero() public {
        FreePlugin plugin = new FreePlugin();
        records.setPlugin(ROOT_NODE, IRegistrarPlugin(address(plugin)));
        records.setPlugin(ROOT_NODE, IRegistrarPlugin(address(0)));
        assertEq(address(records.registrarPlugin(ROOT_NODE)), address(0));
    }

    // ─── FreePlugin ───────────────────────────────────────────────────────────

    function test_freePlugin_anyoneCanRegister() public {
        FreePlugin plugin = new FreePlugin();
        records.setPlugin(ROOT_NODE, IRegistrarPlugin(address(plugin)));
        records.addRegistrar(ROOT_NODE, stranger, 0, 0);

        vm.prank(stranger);
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        assertEq(records.subnodeOwner(NODE_ALICE), alice);
    }

    function test_freePlugin_feeIsZero() public {
        FreePlugin plugin = new FreePlugin();
        assertEq(plugin.registrationFee(ROOT_NODE, "alice", alice), 0);
    }

    function test_freePlugin_registerSubnodeNoFeeRequired() public {
        FreePlugin plugin = new FreePlugin();
        records.setPlugin(ROOT_NODE, IRegistrarPlugin(address(plugin)));
        records.addRegistrar(ROOT_NODE, registrar, 0, 0);

        vm.prank(registrar);
        records.registerSubnode(ROOT_NODE, LABEL_ALICE, alice, "alice", abi.encodePacked(alice));
        assertEq(records.subnodeOwner(NODE_ALICE), alice);
        assertEq(records.addr(NODE_ALICE), alice);
    }

    // ─── WhitelistPlugin ──────────────────────────────────────────────────────

    function test_whitelistPlugin_allowedAddressCanRegister() public {
        WhitelistPlugin wl = new WhitelistPlugin(owner);
        wl.setAllowlist(alice, true);
        records.setPlugin(ROOT_NODE, IRegistrarPlugin(address(wl)));
        records.addRegistrar(ROOT_NODE, alice, 0, 0);

        vm.prank(alice);
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        assertEq(records.subnodeOwner(NODE_ALICE), alice);
    }

    function test_whitelistPlugin_blockedAddressReverts() public {
        WhitelistPlugin wl = new WhitelistPlugin(owner);
        // bob NOT in allowlist
        records.setPlugin(ROOT_NODE, IRegistrarPlugin(address(wl)));
        records.addRegistrar(ROOT_NODE, bob, 0, 0);

        vm.prank(bob);
        vm.expectRevert(WhitelistPlugin.NotAllowed.selector);
        records.setSubnodeOwner(ROOT_NODE, LABEL_BOB, bob, "bob");
    }

    function test_whitelistPlugin_revokedAddressReverts() public {
        WhitelistPlugin wl = new WhitelistPlugin(owner);
        wl.setAllowlist(alice, true);
        wl.setAllowlist(alice, false); // revoke
        records.setPlugin(ROOT_NODE, IRegistrarPlugin(address(wl)));
        records.addRegistrar(ROOT_NODE, alice, 0, 0);

        vm.prank(alice);
        vm.expectRevert(WhitelistPlugin.NotAllowed.selector);
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
    }

    function test_whitelistPlugin_feeIsZero() public {
        WhitelistPlugin wl = new WhitelistPlugin(owner);
        assertEq(wl.registrationFee(ROOT_NODE, "alice", alice), 0);
    }

    function test_whitelistPlugin_onlyOwnerCanSetAllowlist() public {
        WhitelistPlugin wl = new WhitelistPlugin(owner);
        vm.prank(stranger);
        vm.expectRevert(WhitelistPlugin.Unauthorized.selector);
        wl.setAllowlist(alice, true);
    }

    // ─── FlatFeePlugin ────────────────────────────────────────────────────────

    function test_flatFeePlugin_correctFeeAllowsRegistration() public {
        uint256 FEE = 0.01 ether;
        FlatFeePlugin ffp = new FlatFeePlugin(FEE);
        records.setPlugin(ROOT_NODE, IRegistrarPlugin(address(ffp)));
        records.addRegistrar(ROOT_NODE, alice, 0, 0);

        // Mint a parent owner for ROOT_NODE so fees can be forwarded.
        // ROOT_NODE is bytes32(0) — no NFT owner, so fee goes to address(0) which is skipped.
        // We use alice as registrar and give her funds.
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        records.registerSubnode{value: FEE}(ROOT_NODE, LABEL_ALICE, alice, "alice", abi.encodePacked(alice));
        assertEq(records.subnodeOwner(NODE_ALICE), alice);
    }

    function test_flatFeePlugin_insufficientFeeReverts() public {
        uint256 FEE = 0.01 ether;
        FlatFeePlugin ffp = new FlatFeePlugin(FEE);
        records.setPlugin(ROOT_NODE, IRegistrarPlugin(address(ffp)));
        records.addRegistrar(ROOT_NODE, alice, 0, 0);

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(L2RecordsV3.InsufficientFee.selector);
        records.registerSubnode{value: FEE - 1}(ROOT_NODE, LABEL_ALICE, alice, "alice", abi.encodePacked(alice));
    }

    function test_flatFeePlugin_excessEthRefundedToCaller() public {
        uint256 FEE = 0.01 ether;
        uint256 OVERPAY = 0.05 ether;
        FlatFeePlugin ffp = new FlatFeePlugin(FEE);
        records.setPlugin(ROOT_NODE, IRegistrarPlugin(address(ffp)));
        records.addRegistrar(ROOT_NODE, alice, 0, 0);

        vm.deal(alice, 1 ether);
        uint256 before = alice.balance;

        vm.prank(alice);
        records.registerSubnode{value: OVERPAY}(ROOT_NODE, LABEL_ALICE, alice, "alice", abi.encodePacked(alice));

        // alice spent exactly FEE (excess was refunded)
        assertEq(alice.balance, before - FEE);
    }

    function test_flatFeePlugin_feeForwardedToParentOwner() public {
        uint256 FEE = 0.05 ether;
        // Set up: owner registers a "parent" subdomain for bob, then bob sets a plugin on it.
        records.setSubnodeOwner(ROOT_NODE, LABEL_BOB, bob, "bob");

        FlatFeePlugin ffp = new FlatFeePlugin(FEE);
        vm.prank(bob);
        records.setPlugin(NODE_BOB, IRegistrarPlugin(address(ffp)));

        // Add alice as a registrar under NODE_BOB.
        records.addRegistrar(NODE_BOB, alice, 0, 0);

        bytes32 LABEL_SUB = keccak256("sub");
        address charlie = makeAddr("charlie");

        vm.deal(alice, 1 ether);

        vm.prank(alice);
        records.registerSubnode{value: FEE}(
            NODE_BOB, LABEL_SUB, charlie, "sub", abi.encodePacked(charlie)
        );

        // Pull-payment: fee is accrued in pendingFees[bob], not pushed directly.
        assertEq(records.pendingFees(bob), FEE);

        // bob withdraws and receives the fee.
        uint256 bobBefore = bob.balance;
        vm.prank(bob);
        records.withdrawFees();
        assertEq(bob.balance, bobBefore + FEE);
        assertEq(records.pendingFees(bob), 0);
    }

    function test_flatFeePlugin_canRegisterIsAlwaysTrue() public {
        FlatFeePlugin ffp = new FlatFeePlugin(0.01 ether);
        assertTrue(ffp.canRegister(ROOT_NODE, "x", alice));
    }

    // ─── No plugin: original registrar-auth logic still applies ──────────────

    function test_noPlugin_ownerCanRegister() public {
        // No plugin set — registrar check still applies.
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        assertEq(records.subnodeOwner(NODE_ALICE), alice);
    }

    function test_noPlugin_strangerStillReverts() public {
        vm.prank(stranger);
        vm.expectRevert(L2RecordsV3.Unauthorized.selector);
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
    }

    function test_noPlugin_registrarCanRegister() public {
        records.addRegistrar(ROOT_NODE, registrar, 0, 0);
        vm.prank(registrar);
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        assertEq(records.subnodeOwner(NODE_ALICE), alice);
    }

    function test_noPlugin_registrarSubnodePayable_zeroValue() public {
        // registerSubnode with no plugin + 0 value is fine.
        records.addRegistrar(ROOT_NODE, registrar, 0, 0);
        vm.prank(registrar);
        records.registerSubnode{value: 0}(ROOT_NODE, LABEL_ALICE, alice, "alice", abi.encodePacked(alice));
        assertEq(records.addr(NODE_ALICE), alice);
    }

    function test_noPlugin_unexpectedValue_reverts() public {
        // Sending ETH when no plugin is attached should revert to prevent ETH lock-up.
        records.addRegistrar(ROOT_NODE, registrar, 0, 0);
        vm.deal(registrar, 1 ether);
        vm.prank(registrar);
        vm.expectRevert(L2RecordsV3.UnexpectedValue.selector);
        records.registerSubnode{value: 0.01 ether}(ROOT_NODE, LABEL_ALICE, alice, "alice", abi.encodePacked(alice));
    }

    function test_freePlugin_unexpectedValue_reverts() public {
        // FreePlugin has fee=0 — sending ETH should revert.
        FreePlugin fp = new FreePlugin();
        records.setPlugin(ROOT_NODE, IRegistrarPlugin(address(fp)));
        records.addRegistrar(ROOT_NODE, registrar, 0, 0);
        vm.deal(registrar, 1 ether);
        vm.prank(registrar);
        vm.expectRevert(L2RecordsV3.UnexpectedValue.selector);
        records.registerSubnode{value: 0.01 ether}(ROOT_NODE, LABEL_ALICE, alice, "alice", abi.encodePacked(alice));
    }

    function test_setPlugin_EOA_reverts() public {
        // Setting an EOA as plugin should revert — would brick registrations.
        address eoa = makeAddr("notAContract");
        vm.expectRevert(L2RecordsV3.InvalidPlugin.selector);
        records.setPlugin(ROOT_NODE, IRegistrarPlugin(eoa));
    }

    function test_setPlugin_zero_removes() public {
        FreePlugin fp = new FreePlugin();
        records.setPlugin(ROOT_NODE, IRegistrarPlugin(address(fp)));
        // Remove plugin by setting to address(0) — should succeed (no code-size check for zero)
        records.setPlugin(ROOT_NODE, IRegistrarPlugin(address(0)));
        assertEq(address(records.registrarPlugin(ROOT_NODE)), address(0));
    }

    // ─── Plugin removed: registration falls back to registrar auth ────────────

    function test_removePlugin_registrationRestored() public {
        WhitelistPlugin wl = new WhitelistPlugin(owner);
        records.setPlugin(ROOT_NODE, IRegistrarPlugin(address(wl)));

        // alice is NOT in whitelist — should fail
        records.addRegistrar(ROOT_NODE, alice, 0, 0);
        vm.prank(alice);
        vm.expectRevert(WhitelistPlugin.NotAllowed.selector);
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");

        // Remove plugin
        records.setPlugin(ROOT_NODE, IRegistrarPlugin(address(0)));

        // Now alice (as registrar) can register without plugin check
        vm.prank(alice);
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        assertEq(records.subnodeOwner(NODE_ALICE), alice);
    }
}
