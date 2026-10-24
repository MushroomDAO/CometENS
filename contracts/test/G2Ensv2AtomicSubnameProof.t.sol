// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/G2Ensv2AtomicSubnameProof.sol";

contract V2RegistryFixture is IG2Ensv2Registry {
    mapping(uint256 => State) internal entries;
    mapping(address => bool) public registrars;
    address public child;
    bool public mutateOwnerDuringMint;
    uint256 public parentId;
    V2RegistryFixture public externalParent;

    function setState(uint256 id, State calldata state_) external { entries[id] = state_; }
    function setChild(address next) external { child = next; }
    function setRegistrar(address who, bool yes) external { registrars[who] = yes; }
    function setMutate(bool yes, uint256 id, V2RegistryFixture target) external {
        mutateOwnerDuringMint = yes; parentId = id; externalParent = target;
    }
    function getState(uint256 id) external view returns (State memory) { return entries[id]; }
    function getSubregistry(string calldata) external view returns (address) { return child; }
    function hasRootRoles(uint256 roles, address who) external view returns (bool) {
        return roles == 1 && registrars[who];
    }
    function register(string calldata label, address owner, address, address, uint256, uint64 expiry)
        external returns (uint256 tokenId)
    {
        require(registrars[msg.sender]);
        uint256 id = uint256(keccak256(bytes(label)));
        require(entries[id].status == 0);
        tokenId = id | 1;
        entries[id] = State(2, expiry, owner, tokenId, id | 2);
        if (mutateOwnerDuringMint) {
            State memory changed = externalParent.getState(parentId);
            changed.latestOwner = address(0xBAD);
            externalParent.setState(parentId, changed);
        }
    }
}

contract G2Ensv2AtomicSubnameProofTest is Test {
    address holder = address(0xA11CE);
    address nextHolder = address(0xB0B);
    address member = address(0xCAFE);
    V2RegistryFixture eth;
    V2RegistryFixture child;
    G2Ensv2AtomicSubnameProof gate;
    uint256 id = uint256(keccak256("community"));

    function setUp() public {
        vm.chainId(11155111);
        vm.warp(10_000);
        eth = new V2RegistryFixture();
        child = new V2RegistryFixture();
        eth.setChild(address(child));
        eth.setState(id, IG2Ensv2Registry.State(2, uint64(block.timestamp + 3000), holder, 1, id | 2));
        gate = new G2Ensv2AtomicSubnameProof(address(eth), address(child), "community");
        child.setRegistrar(address(gate), true);
    }

    function issueAs(address who, string memory label) internal {
        vm.prank(who);
        gate.issue(label, member, address(0x1234), uint64(block.timestamp + 1000));
    }

    function test_currentHolderCanRegisterUsingActualV2FunctionSignature() public {
        issueAs(holder, "alice");
        assertEq(child.getState(uint256(keccak256("alice"))).latestOwner, member);
    }

    function test_transferBlocksOldHolderEvenWithUnchangedRegistrarGrant() public {
        eth.setState(id, IG2Ensv2Registry.State(2, uint64(block.timestamp + 3000), nextHolder, 2, id | 3));
        vm.expectRevert(G2Ensv2AtomicSubnameProof.InvalidAuthority.selector);
        issueAs(holder, "old");
        issueAs(nextHolder, "new");
    }

    function test_expiryMigrationAndMissingRegistrarDeny() public {
        vm.warp(block.timestamp + 3000);
        vm.expectRevert(G2Ensv2AtomicSubnameProof.InvalidAuthority.selector);
        issueAs(holder, "expired");
        vm.warp(10_000);
        eth.setChild(address(0xBAD));
        vm.expectRevert(G2Ensv2AtomicSubnameProof.InvalidAuthority.selector);
        issueAs(holder, "migrated");
        eth.setChild(address(child));
        child.setRegistrar(address(gate), false);
        vm.expectRevert(G2Ensv2AtomicSubnameProof.InvalidAuthority.selector);
        issueAs(holder, "nogrant");
    }

    function test_rejectsOccupiedChildAndOverlongExpiry() public {
        issueAs(holder, "taken");
        vm.expectRevert(G2Ensv2AtomicSubnameProof.InvalidIssuance.selector);
        issueAs(holder, "taken");
        vm.prank(holder);
        vm.expectRevert(G2Ensv2AtomicSubnameProof.InvalidIssuance.selector);
        gate.issue("late", member, address(0x1234), uint64(block.timestamp + 3500));
    }

    function test_registerSideEffectTransferRevertsNativeMintAndTransferTogether() public {
        child.setMutate(true, id, eth);
        vm.expectRevert(G2Ensv2AtomicSubnameProof.InvalidAuthority.selector);
        issueAs(holder, "racing");
        assertEq(child.getState(uint256(keccak256("racing"))).status, 0);
        assertEq(eth.getState(id).latestOwner, holder);
    }
}
