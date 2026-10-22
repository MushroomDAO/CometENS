// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/G2LegacyL1NativeIssuerProof.sol";
import "./LegacyL1AuthorityCheckpoint.t.sol";

contract NativeIssueRegistryFixture {
    mapping(bytes32 => address) public owner;
    mapping(bytes32 => address) public resolver;

    function setRecord(bytes32 node, address nextOwner, address nextResolver) external {
        owner[node] = nextOwner;
        resolver[node] = nextResolver;
    }
}

interface INativeIssueReceiver {
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external returns (bytes4);
}

contract NativeIssueWrapperFixture {
    struct Child {
        address holder;
        uint32 fuses;
        uint64 expiry;
    }
    bytes32 public immutable parent;
    address public immutable registry;
    address public holder;
    uint64 public parentExpiry;
    uint32 public parentFuses = 1;
    bool public returnWrongNode;
    bool public omitFuses;
    bool public forgeChildDataOwner;
    bool public forgeChildTokenOwner;
    bool public forgeChildExpiry;
    bool public forgeChildRegistryOwner;
    mapping(address => mapping(address => bool)) public approved;
    mapping(bytes32 => Child) public children;

    constructor(bytes32 p, address reg) {
        parent = p;
        registry = reg;
    }

    function setHolder(address who) external {
        holder = who;
    }

    function setParentExpiry(uint64 when_) external {
        parentExpiry = when_;
    }

    function setParentFuses(uint32 fuses) external {
        parentFuses = fuses;
    }

    function setReturnWrongNode(bool enabled) external {
        returnWrongNode = enabled;
    }

    function setOmitFuses(bool enabled) external {
        omitFuses = enabled;
    }

    function setForgedPostconditions(bool dataOwner, bool tokenOwner, bool expiry, bool registryOwner) external {
        forgeChildDataOwner = dataOwner;
        forgeChildTokenOwner = tokenOwner;
        forgeChildExpiry = expiry;
        forgeChildRegistryOwner = registryOwner;
    }

    function seedUnregisteredChild(bytes32 node, address childOwner, uint64 expiry) external {
        children[node] = Child(childOwner, 0, expiry);
    }

    function setApprovalForAll(address operator, bool enabled) external {
        approved[msg.sender][operator] = enabled;
    }

    function ownerOf(uint256 id) external view returns (address) {
        if (id == uint256(parent)) return holder;
        address childHolder = children[bytes32(id)].holder;
        return forgeChildTokenOwner && childHolder != address(0) ? address(0xBAD) : childHolder;
    }

    function getData(uint256 id) external view returns (address, uint32, uint64) {
        if (id == uint256(parent)) return (holder, parentFuses, parentExpiry);
        Child memory child = children[bytes32(id)];
        if (child.holder != address(0)) {
            if (forgeChildDataOwner) child.holder = address(0xBAD);
            if (forgeChildExpiry) child.expiry -= 1;
        }
        return (child.holder, child.fuses, child.expiry);
    }

    function setSubnodeRecord(
        bytes32 p,
        string calldata label,
        address member,
        address resolver,
        uint64 ttl,
        uint32 fuses,
        uint64 expiry
    ) external returns (bytes32 node) {
        require(p == parent && ttl == 0, "wrong native call");
        require(approved[holder][msg.sender], "NameWrapper operator missing");
        node = keccak256(abi.encodePacked(p, keccak256(bytes(label))));
        require(NativeIssueRegistryFixture(registry).owner(node) == address(0), "already issued");
        NativeIssueRegistryFixture(registry).setRecord(
            node, forgeChildRegistryOwner ? address(0xBAD) : address(this), resolver
        );
        children[node] = Child(member, omitFuses ? 0 : fuses, expiry);
        if (member.code.length > 0) {
            require(
                INativeIssueReceiver(member).onERC1155Received(msg.sender, address(0), uint256(node), 1, "")
                    == INativeIssueReceiver.onERC1155Received.selector,
                "receiver declined"
            );
        }
        if (returnWrongNode) return bytes32(uint256(999));
    }
}

contract TransferDuringMintReceiver is INativeIssueReceiver {
    address private immutable wrapper;
    address private immutable newOwner;

    constructor(address wrapper_, address newOwner_) {
        wrapper = wrapper_;
        newOwner = newOwner_;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external returns (bytes4) {
        NativeIssueWrapperFixture(wrapper).setHolder(newOwner);
        return this.onERC1155Received.selector;
    }
}

contract NativeIssueGuardHarness is G2LegacyL1NativeActionGuard {
    constructor(address source, bytes32 hash, bytes32 parent)
        G2LegacyL1NativeActionGuard(source, hash, parent)
    {}

    function check() external onlyCurrentLegacyNativeHolder returns (bool) {
        return true;
    }
}

contract G2LegacyL1NativeIssuerProofTest is Test {
    address private constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address private constant WRAPPER = 0x0635513f179D50A207757E05759CbD106d7dFcE8;
    address private constant REGISTRAR = 0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85;
    bytes32 private constant PARENT = 0x220302cfbfda77f912157d62bd2a0d4553d6d73e677960d357c09235621436f8;
    address private oldHolder = makeAddr("old-holder");
    address private newHolder = makeAddr("new-holder");
    address private member = makeAddr("member");
    address private resolver = makeAddr("member-resolver");
    G2LegacyL1NativeIssuerProof private issuer;
    NativeIssueWrapperFixture private wrapper;
    NativeIssueRegistryFixture private registry;

    function setUp() public {
        vm.warp(2_000_000);
        vm.chainId(11155111);
        vm.etch(ENS, address(new NativeIssueRegistryFixture()).code);
        vm.etch(WRAPPER, address(new NativeIssueWrapperFixture(PARENT, ENS)).code);
        vm.etch(REGISTRAR, address(new LegacyRegistrarFixture()).code);
        registry = NativeIssueRegistryFixture(ENS);
        wrapper = NativeIssueWrapperFixture(WRAPPER);
        registry.setRecord(PARENT, WRAPPER, address(0));
        LegacyRegistrarFixture(REGISTRAR).setOwner(WRAPPER);
        LegacyRegistrarFixture(REGISTRAR).setExpiry(block.timestamp + 4 days);
        wrapper.setHolder(oldHolder);
        wrapper.setParentFuses(1);
        wrapper.setParentExpiry(uint64(block.timestamp + 94 days));
        LegacyL1AuthorityCheckpoint source = new LegacyL1AuthorityCheckpoint(
            "community", address(0x9876), ENS.codehash, WRAPPER.codehash, REGISTRAR.codehash
        );
        assertEq(source.parentNode(), PARENT);
        issuer = new G2LegacyL1NativeIssuerProof(address(source), address(source).codehash, PARENT);
        vm.prank(oldHolder);
        wrapper.setApprovalForAll(address(issuer), true);
    }

    function _issue(address caller, string memory label, address recipient) private returns (bytes32) {
        vm.prank(caller);
        return issuer.issueNative(label, recipient, resolver, uint64(block.timestamp + 2 days));
    }

    function test_nativeMintAndTransferImmediatelyRevokesFormerHolder() public {
        bytes32 first = _issue(oldHolder, "alice", member);
        assertEq(first, keccak256(abi.encodePacked(PARENT, keccak256("alice"))));
        assertEq(registry.owner(first), WRAPPER);
        assertEq(registry.resolver(first), resolver);
        (address child, uint32 fuses, uint64 expiry) = wrapper.getData(uint256(first));
        assertEq(child, member);
        assertEq(fuses, (1 << 16) | 1);
        assertEq(expiry, block.timestamp + 2 days);

        wrapper.setHolder(newHolder); // canonical L1 title moves; OP checkpoint is untouched
        vm.prank(oldHolder);
        vm.expectRevert(G2LegacyL1NativeActionGuard.NotCurrentNativeHolder.selector);
        issuer.issueNative("bob", member, resolver, uint64(block.timestamp + 2 days));
        assertEq(registry.owner(keccak256(abi.encodePacked(PARENT, keccak256("bob")))), address(0));
        vm.prank(newHolder);
        wrapper.setApprovalForAll(address(issuer), true);
        _issue(newHolder, "bob", member);
        assertEq(wrapper.ownerOf(uint256(first)), member); // existing member child remains untouched
    }

    function test_rejectsDuplicateNameAndInvalidLabels() public {
        _issue(oldHolder, "alice", member);
        vm.prank(oldHolder);
        vm.expectRevert(G2LegacyL1NativeIssuerProof.InvalidNativeIssue.selector);
        issuer.issueNative("alice", newHolder, resolver, uint64(block.timestamp + 2 days));
        vm.prank(oldHolder);
        vm.expectRevert(G2LegacyL1NativeIssuerProof.InvalidNativeIssue.selector);
        issuer.issueNative("-bad", member, resolver, uint64(block.timestamp + 2 days));
        vm.prank(oldHolder);
        vm.expectRevert(G2LegacyL1NativeIssuerProof.InvalidNativeIssue.selector);
        issuer.issueNative("bad.domain", member, resolver, uint64(block.timestamp + 2 days));
        vm.prank(oldHolder);
        vm.expectRevert(G2LegacyL1NativeIssuerProof.InvalidNativeIssue.selector);
        issuer.issueNative("ab--cd", member, resolver, uint64(block.timestamp + 2 days));
    }

    function test_rejectsExpiryAndUnlockedParentAndWrongChain() public {
        vm.prank(oldHolder);
        vm.expectRevert(G2LegacyL1NativeIssuerProof.InvalidNativeIssue.selector);
        issuer.issueNative("late", member, resolver, uint64(block.timestamp + 4 days));
        wrapper.setParentFuses(0);
        vm.prank(oldHolder);
        vm.expectRevert(G2LegacyL1NativeIssuerProof.ParentNotLocked.selector);
        issuer.issueNative("unlocked", member, resolver, uint64(block.timestamp + 2 days));
        wrapper.setParentFuses(1);
        LegacyRegistrarFixture(REGISTRAR).setExpiry(block.timestamp + 24 hours);
        vm.prank(oldHolder);
        vm.expectRevert(G2LegacyL1NativeActionGuard.NotCurrentNativeHolder.selector);
        issuer.issueNative("expired", member, resolver, uint64(block.timestamp + 2 days));
        vm.chainId(11155420);
        vm.prank(oldHolder);
        vm.expectRevert(G2LegacyL1NativeActionGuard.WrongChain.selector);
        issuer.issueNative("op", member, resolver, uint64(block.timestamp + 2 days));
    }

    function test_nativeWrapperApprovalIsRequired() public {
        vm.prank(oldHolder);
        wrapper.setApprovalForAll(address(issuer), false);
        vm.prank(oldHolder);
        vm.expectRevert(bytes("NameWrapper operator missing"));
        issuer.issueNative("fail", member, resolver, uint64(block.timestamp + 2 days));
    }

    function test_receiverCallbackTransferRevertsEntireMintAndTransfer() public {
        TransferDuringMintReceiver receiver = new TransferDuringMintReceiver(WRAPPER, newHolder);
        bytes32 child = keccak256(abi.encodePacked(PARENT, keccak256("callback")));
        vm.prank(oldHolder);
        vm.expectRevert(G2LegacyL1NativeActionGuard.NotCurrentNativeHolder.selector);
        issuer.issueNative("callback", address(receiver), resolver, uint64(block.timestamp + 2 days));
        assertEq(wrapper.ownerOf(uint256(PARENT)), oldHolder);
        assertEq(registry.owner(child), address(0));
        assertEq(wrapper.ownerOf(uint256(child)), address(0));
    }

    function test_nativePostconditionRejectsTamperedWrapperOutput() public {
        wrapper.setOmitFuses(true);
        vm.prank(oldHolder);
        vm.expectRevert(G2LegacyL1NativeIssuerProof.NativeIssueMismatch.selector);
        issuer.issueNative("missing-fuses", member, resolver, uint64(block.timestamp + 2 days));
        bytes32 child = keccak256(abi.encodePacked(PARENT, keccak256("missing-fuses")));
        assertEq(registry.owner(child), address(0));
        wrapper.setOmitFuses(false);
        wrapper.setReturnWrongNode(true);
        vm.prank(oldHolder);
        vm.expectRevert(G2LegacyL1NativeIssuerProof.NativeIssueMismatch.selector);
        issuer.issueNative("wrong-node", member, resolver, uint64(block.timestamp + 2 days));
    }

    function test_postWriteAssertionsRejectEachIndependentForgedENSField() public {
        // Each malicious wrapper response changes exactly one property. When
        // its corresponding issuer condition is removed, no other check saves it.
        for (uint256 i; i < 4; ++i) {
            wrapper.setForgedPostconditions(i == 0, i == 1, i == 2, i == 3);
            string memory label = i == 0 ? "wrong-data-owner" : i == 1 ? "wrong-token-owner"
                : i == 2 ? "short-expiry" : "wrong-registry-owner";
            bytes32 node = keccak256(abi.encodePacked(PARENT, keccak256(bytes(label))));
            vm.prank(oldHolder);
            vm.expectRevert(G2LegacyL1NativeIssuerProof.NativeIssueMismatch.selector);
            issuer.issueNative(label, member, resolver, uint64(block.timestamp + 2 days));
            assertEq(registry.owner(node), address(0), "bad mint must rollback");
        }
    }

    function test_vacancyChecksIndependentlyRejectOrphanOwnerResidualExpiryAndRegistryOccupation() public {
        uint64 requestedExpiry = uint64(block.timestamp + 2 days);
        bytes32 orphanNode = keccak256(abi.encodePacked(PARENT, keccak256("orphan")));
        wrapper.seedUnregisteredChild(orphanNode, member, 0);
        vm.prank(oldHolder);
        vm.expectRevert(G2LegacyL1NativeIssuerProof.InvalidNativeIssue.selector);
        issuer.issueNative("orphan", member, resolver, requestedExpiry);

        bytes32 residualNode = keccak256(abi.encodePacked(PARENT, keccak256("residual")));
        wrapper.seedUnregisteredChild(residualNode, address(0), requestedExpiry + 1);
        vm.prank(oldHolder);
        vm.expectRevert(G2LegacyL1NativeIssuerProof.InvalidNativeIssue.selector);
        issuer.issueNative("residual", member, resolver, requestedExpiry);

        bytes32 occupiedNode = keccak256(abi.encodePacked(PARENT, keccak256("occupied")));
        registry.setRecord(occupiedNode, newHolder, address(0));
        vm.prank(oldHolder);
        vm.expectRevert(G2LegacyL1NativeIssuerProof.InvalidNativeIssue.selector);
        issuer.issueNative("occupied", member, resolver, requestedExpiry);
    }

    function test_issueExpiryBoundaryMemberAndLabelDigitLimits() public {
        vm.prank(oldHolder);
        vm.expectRevert(G2LegacyL1NativeIssuerProof.InvalidNativeIssue.selector);
        issuer.issueNative("now", member, resolver, uint64(block.timestamp));
        vm.prank(oldHolder);
        vm.expectRevert(G2LegacyL1NativeIssuerProof.InvalidNativeIssue.selector);
        issuer.issueNative("zero", address(0), resolver, uint64(block.timestamp + 2 days));

        bytes memory maxLabel = new bytes(63);
        bytes memory overlong = new bytes(64);
        for (uint256 i; i < 64; ++i) {
            overlong[i] = "a";
            if (i < 63) maxLabel[i] = "a";
        }
        _issue(oldHolder, string(maxLabel), member); // exact 63-byte upper boundary
        vm.prank(oldHolder);
        vm.expectRevert(G2LegacyL1NativeIssuerProof.InvalidNativeIssue.selector);
        issuer.issueNative(string(overlong), member, resolver, uint64(block.timestamp + 2 days));
        bytes32 digitNode = _issue(oldHolder, "member1", member);
        assertEq(wrapper.ownerOf(uint256(digitNode)), member, "ASCII digit must stay valid");
    }

    function test_guardChecksZeroHolderAndExpiredAuthorityAndWrongChainAtConstruction() public {
        LegacyL1AuthorityCheckpoint source = issuer.nativeSource();
        NativeIssueGuardHarness harness = new NativeIssueGuardHarness(
            address(source), address(source).codehash, PARENT
        );
        vm.mockCall(
            address(source), abi.encodeWithSelector(LegacyL1AuthorityCheckpoint.currentAuthority.selector),
            abi.encode(oldHolder, uint64(block.timestamp))
        );
        vm.prank(oldHolder);
        vm.expectRevert(G2LegacyL1NativeActionGuard.NotCurrentNativeHolder.selector);
        harness.check();
        vm.clearMockedCalls();

        vm.mockCall(
            address(source), abi.encodeWithSelector(LegacyL1AuthorityCheckpoint.currentAuthority.selector),
            abi.encode(address(0), uint64(block.timestamp + 1 days))
        );
        vm.prank(address(0));
        vm.expectRevert(G2LegacyL1NativeActionGuard.NotCurrentNativeHolder.selector);
        harness.check();
        vm.clearMockedCalls();

        vm.chainId(11155420);
        vm.expectRevert(G2LegacyL1NativeActionGuard.WrongChain.selector);
        new NativeIssueGuardHarness(address(source), address(source).codehash, PARENT);
    }
}
