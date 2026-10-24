// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Test.sol";

interface ILiveV2Registry {
    struct State { uint8 status; uint64 expiry; address latestOwner; uint256 tokenId; uint256 resource; }
    function getState(uint256) external view returns (State memory);
    function getSubregistry(string calldata) external view returns (address);
    function hasRootRoles(uint256, address) external view returns (bool);
    function roleCount(uint256) external view returns (uint256);
    function grantRootRoles(uint256, address) external;
    function grantRoles(uint256, uint256, address) external;
    function setResolver(uint256, address) external;
}

/// @notice Mandatory Anvil/Foundry fork test against actual deployed Sepolia code.
/// @dev No vm.etch/mockCall, transaction signatures or live writes.
contract G2Ensv2LiveSepoliaForkTest is Test {
    address constant ROOT = 0xB458D6a3a77919449d03e7A6903C26827c1eC43f;
    address constant ETH = 0xD4eBcbBdF463C9c45784603Db0dDD499BC44A8B4;
    address constant ATTACKER = 0x000000000000000000000000000000000000bEEF;
    uint256 constant ROLE_SET_RESOLVER = 1 << 24;
    uint256 constant ROLE_UPGRADE_ADMIN = uint256(1) << 252;
    uint256 constant ETH_LABEL = uint256(keccak256("eth"));
    // Exact custom-error selectors observed against official Sepolia deployed
    // runtime at the pinned fork block. An unknown function's empty revert
    // must never be accepted as EAC authorization evidence.
    bytes4 constant ROLE_GRANT_DENIED = 0xd1a3b355;
    bytes4 constant RESOLVER_WRITE_DENIED = 0x4b27a133;

    function setUp() public {
        if (block.chainid != 11155111) { vm.skip(true); return; }
        require(ROOT.code.length > 0 && ETH.code.length > 0, "missing real ENSv2 runtime");
        require(ILiveV2Registry(ROOT).getSubregistry("eth") == ETH, "unexpected ENSv2 hierarchy");
    }

    function test_currentParentStateComesFromRealDeployedRegistry() public view {
        ILiveV2Registry.State memory s = ILiveV2Registry(ROOT).getState(ETH_LABEL);
        assertEq(s.status, 2);
        assertTrue(s.latestOwner != address(0));
        assertTrue(s.expiry > block.timestamp);
        assertTrue(s.resource != 0);
    }

    function test_unprivilegedActorCannotGrantRootRegistryAdmin() public {
        vm.prank(ATTACKER);
        vm.expectPartialRevert(ROLE_GRANT_DENIED);
        ILiveV2Registry(ROOT).grantRootRoles(ROLE_UPGRADE_ADMIN, ATTACKER);
    }

    function test_unprivilegedActorCannotGrantEthRegistryRootResolverRole() public {
        vm.prank(ATTACKER);
        vm.expectPartialRevert(ROLE_GRANT_DENIED);
        ILiveV2Registry(ETH).grantRootRoles(ROLE_SET_RESOLVER, ATTACKER);
    }

    function test_unprivilegedActorCannotRewriteEthResolver() public {
        vm.prank(ATTACKER);
        vm.expectPartialRevert(RESOLVER_WRITE_DENIED);
        ILiveV2Registry(ROOT).setResolver(ETH_LABEL, ATTACKER);
    }

    function test_unprivilegedActorCannotGrantEthResolverRole() public {
        vm.prank(ATTACKER);
        vm.expectPartialRevert(ROLE_GRANT_DENIED);
        ILiveV2Registry(ROOT).grantRoles(ETH_LABEL, ROLE_SET_RESOLVER, ATTACKER);
    }
}
