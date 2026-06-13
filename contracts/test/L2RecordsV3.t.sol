// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/L2RecordsV3.sol";

contract L2RecordsV3Test is Test {
    L2RecordsV3 public records;
    address public owner;
    address public alice;
    address public bob;
    address public registrar;
    address public stranger;

    bytes32 constant ROOT_NODE  = bytes32(0);
    bytes32 constant LABEL_ALICE = keccak256("alice");
    bytes32 constant LABEL_BOB   = keccak256("bob");
    bytes32 constant LABEL_CAROL = keccak256("carol");
    bytes32 NODE_ALICE;
    bytes32 NODE_BOB;
    bytes32 NODE_CAROL;

    function setUp() public {
        owner     = address(this);
        alice     = makeAddr("alice");
        bob       = makeAddr("bob");
        registrar = makeAddr("registrar");
        stranger  = makeAddr("stranger");
        records   = new L2RecordsV3(owner);
        NODE_ALICE = keccak256(abi.encodePacked(ROOT_NODE, LABEL_ALICE));
        NODE_BOB   = keccak256(abi.encodePacked(ROOT_NODE, LABEL_BOB));
        NODE_CAROL = keccak256(abi.encodePacked(ROOT_NODE, LABEL_CAROL));
        vm.warp(1_000_000);
    }

    // ─── Constructor ──────────────────────────────────────────────────────────

    function test_constructorSetsOwner() public view {
        assertEq(records.owner(), owner);
    }

    function test_constructorRejectsZeroOwner() public {
        vm.expectRevert(L2RecordsV3.ZeroAddress.selector);
        new L2RecordsV3(address(0));
    }

    // ─── V3: NFT minting on registration ─────────────────────────────────────

    /// @notice After registerSubnode, ownerOf(uint256(node)) == newOwner
    function test_registerSubnodeMintNFT() public {
        bytes memory addrBytes = abi.encodePacked(alice);
        records.registerSubnode(ROOT_NODE, LABEL_ALICE, alice, "alice", addrBytes);

        assertEq(records.ownerOf(uint256(NODE_ALICE)), alice);
    }

    /// @notice subnodeOwner(node) returns the NFT owner
    function test_subnodeOwnerReadsNFT() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        assertEq(records.subnodeOwner(NODE_ALICE), alice);
    }

    /// @notice subnodeOwner returns address(0) for unminted token
    function test_subnodeOwnerZeroForUnminted() public view {
        assertEq(records.subnodeOwner(NODE_ALICE), address(0));
    }

    /// @notice transferFrom changes the result of subnodeOwner
    function test_transferNFTTransfersOwnership() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        assertEq(records.subnodeOwner(NODE_ALICE), alice);

        vm.prank(alice);
        records.transferFrom(alice, bob, uint256(NODE_ALICE));

        assertEq(records.subnodeOwner(NODE_ALICE), bob);
        assertEq(records.ownerOf(uint256(NODE_ALICE)), bob);
    }

    /// @notice safeTransferFrom also updates subnodeOwner
    function test_safeTransferNFTTransfersOwnership() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");

        vm.prank(alice);
        records.safeTransferFrom(alice, bob, uint256(NODE_ALICE));

        assertEq(records.subnodeOwner(NODE_ALICE), bob);
    }

    // ─── V3: setAddr authorization ────────────────────────────────────────────

    /// @notice NFT owner can setAddr directly without going through contract owner
    function test_nftOwnerCanSetAddr() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");

        vm.prank(alice);
        records.setAddr(NODE_ALICE, 60, abi.encodePacked(alice));

        assertEq(records.addr(NODE_ALICE), alice);
    }

    /// @notice Non-owner (stranger) cannot setAddr
    function test_setAddrRequiresNFTOwner() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");

        vm.prank(stranger);
        vm.expectRevert(L2RecordsV3.Unauthorized.selector);
        records.setAddr(NODE_ALICE, 60, abi.encodePacked(stranger));
    }

    /// @notice After NFT transfer, new owner can setAddr but old owner cannot
    function test_setAddrFollowsNFTOwnership() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");

        vm.prank(alice);
        records.transferFrom(alice, bob, uint256(NODE_ALICE));

        // bob (new owner) can set addr
        vm.prank(bob);
        records.setAddr(NODE_ALICE, 60, abi.encodePacked(bob));
        assertEq(records.addr(NODE_ALICE), bob);

        // alice (former owner) cannot
        vm.prank(alice);
        vm.expectRevert(L2RecordsV3.Unauthorized.selector);
        records.setAddr(NODE_ALICE, 60, abi.encodePacked(alice));
    }

    /// @notice Contract owner can always setAddr regardless of NFT ownership
    function test_contractOwnerCanAlwaysSetAddr() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        records.setAddr(NODE_ALICE, 60, abi.encodePacked(alice));
        assertEq(records.addr(NODE_ALICE), alice);
    }

    // ─── V3: setText / setContenthash authorization ───────────────────────────

    /// @notice NFT owner can setText directly
    function test_nftOwnerCanSetText() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");

        vm.prank(alice);
        records.setText(NODE_ALICE, "avatar", "https://example.com/img.png");

        assertEq(records.text(NODE_ALICE, "avatar"), "https://example.com/img.png");
    }

    /// @notice Non-owner cannot setText
    function test_setTextRequiresNFTOwner() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");

        vm.prank(stranger);
        vm.expectRevert(L2RecordsV3.Unauthorized.selector);
        records.setText(NODE_ALICE, "avatar", "evil");
    }

    /// @notice NFT owner can setContenthash directly
    function test_nftOwnerCanSetContenthash() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        bytes memory ch = hex"e3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eff1894f";

        vm.prank(alice);
        records.setContenthash(NODE_ALICE, ch);

        assertEq(records.contenthash(NODE_ALICE), ch);
    }

    // ─── V3: Registrar flow ───────────────────────────────────────────────────

    /// @notice Registrar can still register and recipient gets the NFT
    function test_registrarCanStillRegister() public {
        records.addRegistrar(ROOT_NODE, registrar, 0, 0);

        vm.prank(registrar);
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");

        assertEq(records.subnodeOwner(NODE_ALICE), alice);
        assertEq(records.ownerOf(uint256(NODE_ALICE)), alice);
    }

    /// @notice Registrar registerSubnode flow mints NFT
    function test_registrarRegisterSubnodeMintNFT() public {
        records.addRegistrar(ROOT_NODE, registrar, 1, 0);
        bytes memory addrBytes = abi.encodePacked(alice);

        vm.prank(registrar);
        records.registerSubnode(ROOT_NODE, LABEL_ALICE, alice, "alice", addrBytes);

        assertEq(records.ownerOf(uint256(NODE_ALICE)), alice);
        assertEq(records.addr(NODE_ALICE), alice);
    }

    // ─── V3: Standard ERC-721 transfer auth ──────────────────────────────────

    /// @notice Non-owner cannot transfer an NFT they don't own
    function test_nonOwnerCannotTransferNFT() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");

        vm.prank(stranger);
        vm.expectRevert();
        records.transferFrom(alice, stranger, uint256(NODE_ALICE));
    }

    /// @notice Approved address can transfer NFT
    function test_approvedCanTransferNFT() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");

        vm.prank(alice);
        records.approve(bob, uint256(NODE_ALICE));

        vm.prank(bob);
        records.transferFrom(alice, bob, uint256(NODE_ALICE));

        assertEq(records.ownerOf(uint256(NODE_ALICE)), bob);
    }

    // ─── V3: primaryNode not auto-updated on transfer ─────────────────────────

    /// @notice Transferring the NFT does NOT auto-update primaryNode
    function test_transferNFTDoesNotUpdatePrimaryNode() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        assertEq(records.primaryNode(alice), NODE_ALICE);

        vm.prank(alice);
        records.transferFrom(alice, bob, uint256(NODE_ALICE));

        // alice's primaryNode is unchanged (still points to NODE_ALICE even though she lost it)
        assertEq(records.primaryNode(alice), NODE_ALICE);
        // bob's primaryNode is unset
        assertEq(records.primaryNode(bob), bytes32(0));
    }

    // ─── Compatibility: inherited V2 features ────────────────────────────────

    function test_ownershipTransfer() public {
        records.transferOwnership(alice);
        assertEq(records.owner(), alice);
    }

    function test_addAndRemoveRegistrar() public {
        records.addRegistrar(ROOT_NODE, registrar, 5, 0);
        assertTrue(records.isRegistrar(ROOT_NODE, registrar));
        records.removeRegistrar(ROOT_NODE, registrar);
        assertFalse(records.isRegistrar(ROOT_NODE, registrar));
    }

    function test_registrarQuotaDecrementsCorrectly() public {
        records.addRegistrar(ROOT_NODE, registrar, 2, 0);

        vm.startPrank(registrar);
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        assertEq(records.registrarQuota(ROOT_NODE, registrar), 1);
        records.setSubnodeOwner(ROOT_NODE, LABEL_BOB, bob, "bob");
        assertEq(records.registrarQuota(ROOT_NODE, registrar), 0);
        vm.stopPrank();
    }

    function test_registrarQuotaExhaustedReverts() public {
        records.addRegistrar(ROOT_NODE, registrar, 1, 0);
        vm.prank(registrar);
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");

        vm.prank(registrar);
        vm.expectRevert(L2RecordsV3.QuotaExceeded.selector);
        records.setSubnodeOwner(ROOT_NODE, LABEL_BOB, bob, "bob");
    }

    function test_revertAlreadyRegistered() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        vm.expectRevert(L2RecordsV3.AlreadyRegistered.selector);
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, bob, "alice");
    }

    function test_labelAndNameStorage() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        assertEq(records.labelOf(NODE_ALICE), "alice");
        bytes memory name = records.nameOf(NODE_ALICE);
        assertEq(name.length, 7);
        assertEq(uint8(name[0]), 5);
    }

    function test_primaryNodeSetOnFirstRegistration() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        assertEq(records.primaryNode(alice), NODE_ALICE);
    }

    function test_setPrimaryNodeSelf() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        records.setSubnodeOwner(ROOT_NODE, LABEL_BOB, alice, "bob");

        vm.prank(alice);
        records.setPrimaryNodeSelf(NODE_BOB);
        assertEq(records.primaryNode(alice), NODE_BOB);
    }

    function test_strangerCannotRegister() public {
        vm.prank(stranger);
        vm.expectRevert(L2RecordsV3.Unauthorized.selector);
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
    }

    function test_addrReturnsZeroForEmpty() public view {
        assertEq(records.addr(NODE_ALICE), address(0));
    }

    function test_setAddrRejectsInvalidLength() public {
        vm.expectRevert(L2RecordsV3.InvalidAddrBytes.selector);
        records.setAddr(NODE_ALICE, 60, hex"1234");
    }

    function test_registerSubnodeRejectsBadAddrBytes() public {
        vm.expectRevert(L2RecordsV3.InvalidAddrBytes.selector);
        records.registerSubnode(ROOT_NODE, LABEL_ALICE, alice, "alice", hex"1234");
    }

    function test_erc721Name() public view {
        assertEq(records.name(), "L2RecordsV3 Subdomain");
        assertEq(records.symbol(), "L2R3");
    }

    // ─── transferSubnodeByGateway ─────────────────────────────────────────────

    function test_gatewayTransfer_succeeds() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        assertEq(records.subnodeOwner(NODE_ALICE), alice);

        // Contract owner (gateway) can transfer on behalf of alice.
        records.transferSubnodeByGateway(NODE_ALICE, alice, bob);
        assertEq(records.subnodeOwner(NODE_ALICE), bob);
    }

    function test_gatewayTransfer_wrongFromReverts() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        // Passing wrong `from` should revert (ERC-721 enforces ownerOf == from).
        vm.expectRevert();
        records.transferSubnodeByGateway(NODE_ALICE, bob, bob);
    }

    function test_gatewayTransfer_zeroToReverts() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        vm.expectRevert(L2RecordsV3.ZeroAddress.selector);
        records.transferSubnodeByGateway(NODE_ALICE, alice, address(0));
    }

    function test_gatewayTransfer_nonOwnerReverts() public {
        records.setSubnodeOwner(ROOT_NODE, LABEL_ALICE, alice, "alice");
        vm.prank(stranger);
        vm.expectRevert(L2RecordsV3.Unauthorized.selector);
        records.transferSubnodeByGateway(NODE_ALICE, alice, bob);
    }
}
