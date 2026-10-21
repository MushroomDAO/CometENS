// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/G2LegacyMemberRecordLock.sol";

contract MockRecordRegistry {
    mapping(bytes32 => address) public owner;

    function setOwner(bytes32 node, address holder) external {
        owner[node] = holder;
    }
}

contract MockRecordWrapper {
    struct Data {
        address holder;
        uint32 fuses;
        uint64 expiry;
    }
    mapping(uint256 => Data) public data;

    function setData(uint256 node, address holder, uint32 fuses, uint64 expiry) external {
        data[node] = Data(holder, fuses, expiry);
    }

    function getData(uint256 node) external view returns (address, uint32, uint64) {
        Data memory d = data[node];
        return (d.holder, d.fuses, d.expiry);
    }
}

contract MockRecordRegistrar {
    mapping(uint256 => address) private holders;
    mapping(uint256 => uint256) private expiries;

    function setData(uint256 id, address holder, uint256 expiry) external {
        holders[id] = holder;
        expiries[id] = expiry;
    }

    function ownerOf(uint256 id) external view returns (address) {
        return holders[id];
    }

    function nameExpires(uint256 id) external view returns (uint256) {
        return expiries[id];
    }
}

contract G2LegacyMemberRecordLockTest is Test {
    bytes32 private constant PARENT = 0x220302cfbfda77f912157d62bd2a0d4553d6d73e677960d357c09235621436f8;
    bytes32 private constant CHILD = 0x920be32cb21d9f7c72e33677afd936bf66b421842fe22e98fd2a72b7ba81a65e;
    uint256 private constant LABEL_ID = uint256(keccak256("community"));
    address private member = makeAddr("native-member");
    address private parentHolder = makeAddr("parent-holder");
    address private outsider = makeAddr("outsider");

    MockRecordRegistry private registry;
    MockRecordWrapper private wrapper;
    MockRecordRegistrar private registrar;
    G2LegacyMemberRecordLock private store;

    function setUp() public {
        vm.chainId(11155111);
        vm.warp(1_000_000);
        address r = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
        address w = 0x0635513f179D50A207757E05759CbD106d7dFcE8;
        address b = 0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85;
        vm.etch(r, type(MockRecordRegistry).runtimeCode);
        vm.etch(w, type(MockRecordWrapper).runtimeCode);
        vm.etch(b, type(MockRecordRegistrar).runtimeCode);
        registry = MockRecordRegistry(r);
        wrapper = MockRecordWrapper(w);
        registrar = MockRecordRegistrar(b);
        registry.setOwner(PARENT, w);
        registry.setOwner(CHILD, w);
        wrapper.setData(uint256(PARENT), parentHolder, 1, uint64(block.timestamp + 40 days));
        wrapper.setData(uint256(CHILD), member, 1 | (1 << 16), uint64(block.timestamp + 7 days));
        registrar.setData(LABEL_ID, w, block.timestamp + 30 days);
        store = new G2LegacyMemberRecordLock("community", "alice", r.codehash, w.codehash, b.codehash);
    }

    function _lock() private {
        vm.prank(member);
        store.lock(member, hex"e30102", "name", "Alice");
    }

    function test_pinnedENSNamehashAndNoSovereigntyShortcut() public view {
        assertEq(store.parentNode(), PARENT);
        assertEq(store.node(), CHILD);
        assertFalse(store.sovereignReceipt());
        assertFalse(store.ensV2AuthorityVerified());
        assertFalse(store.nativeResolverPointerLockedVerified());
        assertFalse(store.locked());
    }

    function test_realMemberCanIrreversiblyLockDataWithoutAnyAdminEdit() public {
        _lock();
        assertTrue(store.locked());
        assertEq(store.lockedBy(), member);
        assertEq(store.addr(CHILD), member);
        assertEq(store.contenthash(CHILD), hex"e30102");
        assertEq(store.text(CHILD, "name"), "Alice");
        assertEq(store.text(CHILD, "other"), "");
        assertEq(store.addr(PARENT), address(0));
        assertEq(store.contenthash(PARENT), bytes(""));
        assertEq(store.text(PARENT, "name"), "");
        assertEq(store.recordCommitment(), keccak256(abi.encode(CHILD, member, hex"e30102", "name", "Alice")));
        for (uint256 i; i < 3; ++i) {
            vm.prank(i == 0 ? member : i == 1 ? parentHolder : outsider);
            vm.expectRevert(G2LegacyMemberRecordLock.AlreadyLocked.selector);
            store.lock(outsider, hex"", "name", "Malicious");
        }
    }

    function test_unapprovedParentOrPlatformCannotLockForMember() public {
        for (uint256 i; i < 2; ++i) {
            vm.prank(i == 0 ? parentHolder : outsider);
            vm.expectRevert(G2LegacyMemberRecordLock.InvalidMemberOrExpired.selector);
            store.lock(outsider, hex"", "name", "Wrong");
        }
        assertFalse(store.locked());
        _lock();
    }

    function test_malformedRecordsAndUnsafeLabelAreRejected() public {
        vm.prank(member);
        vm.expectRevert(G2LegacyMemberRecordLock.InvalidRecords.selector);
        store.lock(member, hex"", "", "empty key");
        vm.prank(member);
        vm.expectRevert(G2LegacyMemberRecordLock.InvalidRecords.selector);
        store.lock(member, hex"", "name", new string(4097));
        vm.expectRevert(G2LegacyMemberRecordLock.InvalidConfiguration.selector);
        new G2LegacyMemberRecordLock(
            "xn--bad", "alice", address(registry).codehash, address(wrapper).codehash, address(registrar).codehash
        );
        vm.expectRevert(G2LegacyMemberRecordLock.InvalidConfiguration.selector);
        new G2LegacyMemberRecordLock(
            "community", "-alice", address(registry).codehash, address(wrapper).codehash, address(registrar).codehash
        );
    }

    function test_parentOrChildFusesCannotBeMissing() public {
        wrapper.setData(uint256(PARENT), parentHolder, 0, uint64(block.timestamp + 40 days));
        vm.prank(member);
        vm.expectRevert(G2LegacyMemberRecordLock.InvalidMemberOrExpired.selector);
        store.lock(member, hex"", "name", "X");
        wrapper.setData(uint256(PARENT), parentHolder, 1, uint64(block.timestamp + 40 days));
        wrapper.setData(uint256(CHILD), member, 1, uint64(block.timestamp + 7 days));
        vm.prank(member);
        vm.expectRevert(G2LegacyMemberRecordLock.InvalidMemberOrExpired.selector);
        store.lock(member, hex"", "name", "X");
        // Existing tests covered CU-only; PCC-only must also reject.
        wrapper.setData(uint256(CHILD), member, uint32(1 << 16), uint64(block.timestamp + 7 days));
        vm.prank(member);
        vm.expectRevert(G2LegacyMemberRecordLock.InvalidMemberOrExpired.selector);
        store.lock(member, hex"", "name", "X");
    }

    function test_childExpiryExactlyOneDayFailsAndOneSecondAfterSucceeds() public {
        wrapper.setData(uint256(CHILD), member, 1 | (1 << 16), uint64(block.timestamp + 1 days));
        vm.prank(member);
        vm.expectRevert(G2LegacyMemberRecordLock.InvalidMemberOrExpired.selector);
        store.lock(member, hex"", "name", "X");
        wrapper.setData(uint256(CHILD), member, 1 | (1 << 16), uint64(block.timestamp + 1 days + 1));
        _lock();
    }

    function test_childRegistrarOneDayMarginIsInclusiveAndAboveRejected() public {
        uint64 childExpiry = uint64(block.timestamp + 7 days);
        wrapper.setData(uint256(CHILD), member, 1 | (1 << 16), childExpiry);
        registrar.setData(LABEL_ID, address(wrapper), uint256(childExpiry) + 1 days - 1);
        vm.prank(member);
        vm.expectRevert(G2LegacyMemberRecordLock.InvalidMemberOrExpired.selector);
        store.lock(member, hex"", "name", "X");
        registrar.setData(LABEL_ID, address(wrapper), uint256(childExpiry) + 1 days);
        _lock();
    }

    function test_registryRegistrarOrWrappedCustodyMismatchRefused() public {
        registry.setOwner(CHILD, outsider);
        vm.prank(member);
        vm.expectRevert(G2LegacyMemberRecordLock.InvalidMemberOrExpired.selector);
        store.lock(member, hex"", "name", "X");
        registry.setOwner(CHILD, address(wrapper));
        registrar.setData(LABEL_ID, outsider, block.timestamp + 30 days);
        vm.prank(member);
        vm.expectRevert(G2LegacyMemberRecordLock.InvalidMemberOrExpired.selector);
        store.lock(member, hex"", "name", "X");
        registrar.setData(LABEL_ID, address(wrapper), block.timestamp + 30 days);
        wrapper.setData(uint256(CHILD), outsider, 1 | (1 << 16), uint64(block.timestamp + 7 days));
        vm.prank(member);
        vm.expectRevert(G2LegacyMemberRecordLock.InvalidMemberOrExpired.selector);
        store.lock(member, hex"", "name", "X");
    }

    function test_registrarGraceAndBadChildExpiryNeverAuthorizeRecordLock() public {
        registrar.setData(LABEL_ID, address(wrapper), block.timestamp - 1);
        vm.prank(member);
        vm.expectRevert(G2LegacyMemberRecordLock.InvalidMemberOrExpired.selector);
        store.lock(member, hex"", "name", "X");
        registrar.setData(LABEL_ID, address(wrapper), block.timestamp + 30 days);
        wrapper.setData(uint256(CHILD), member, 1 | (1 << 16), uint64(block.timestamp + 40 days));
        vm.prank(member);
        vm.expectRevert(G2LegacyMemberRecordLock.InvalidMemberOrExpired.selector);
        store.lock(member, hex"", "name", "X");
    }

    function test_wrongChainOrRuntimeBytesNeverAccepted() public {
        vm.etch(address(wrapper), hex"60006000fd");
        vm.prank(member);
        vm.expectRevert(G2LegacyMemberRecordLock.InvalidConfiguration.selector);
        store.lock(member, hex"", "name", "X");
        vm.chainId(1);
        vm.expectRevert(G2LegacyMemberRecordLock.InvalidConfiguration.selector);
        new G2LegacyMemberRecordLock(
            "community", "alice", bytes32(uint256(1)), bytes32(uint256(1)), bytes32(uint256(1))
        );
    }
}
