// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/LegacyL1AuthorityCheckpoint.sol";

contract LegacyRegistryFixture {
    address public nameOwner;

    function setOwner(address addr) external {
        nameOwner = addr;
    }

    function owner(bytes32) external view returns (address) {
        return nameOwner;
    }
}

contract LegacyWrapperFixture {
    address public holder;
    uint64 public expiry;
    bool public mismatch;

    function setHolder(address addr) external {
        holder = addr;
    }

    function setExpiry(uint64 value) external {
        expiry = value;
    }

    function setMismatch(bool value) external {
        mismatch = value;
    }

    function ownerOf(uint256) external view returns (address) {
        return holder;
    }

    function getData(uint256) external view returns (address, uint32, uint64) {
        return (mismatch ? address(0xBEEF) : holder, 0, expiry);
    }
}

contract LegacyRegistrarFixture {
    address public nftOwner;
    uint256 public expiry;

    function setOwner(address addr) external {
        nftOwner = addr;
    }

    function setExpiry(uint256 value) external {
        expiry = value;
    }

    function ownerOf(uint256) external view returns (address) {
        require(expiry > block.timestamp, "expired/burned");
        return nftOwner;
    }

    function nameExpires(uint256) external view returns (uint256) {
        return expiry;
    }
}

contract NativeHolderSmartAccountFixture {
    function authorize(LegacyL1AuthorityCheckpoint source, address controller, uint64 lease) external {
        source.bindOrRenew(controller, lease);
    }

    function stop(LegacyL1AuthorityCheckpoint source) external {
        source.cancel();
    }
}

contract LegacyL1AuthorityCheckpointTest is Test {
    address private constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address private constant WRAPPER = 0x0635513f179D50A207757E05759CbD106d7dFcE8;
    address private constant REGISTRAR = 0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85;
    address private constant INBOX = address(0x9876);
    address private holder = makeAddr("nativeHolder");
    address private nextHolder = makeAddr("nextHolder");
    address private attack = makeAddr("attacker");
    address private controller = makeAddr("controller");
    address private otherController = makeAddr("otherController");
    LegacyL1AuthorityCheckpoint private source;

    function setUp() public {
        vm.chainId(11155111);
        vm.warp(2_000_000);
        vm.etch(ENS, address(new LegacyRegistryFixture()).code);
        vm.etch(WRAPPER, address(new LegacyWrapperFixture()).code);
        vm.etch(REGISTRAR, address(new LegacyRegistrarFixture()).code);
        LegacyRegistryFixture(ENS).setOwner(WRAPPER);
        LegacyRegistrarFixture(REGISTRAR).setOwner(WRAPPER);
        LegacyRegistrarFixture(REGISTRAR).setExpiry(block.timestamp + 3 days);
        LegacyWrapperFixture(WRAPPER).setHolder(holder);
        LegacyWrapperFixture(WRAPPER).setExpiry(uint64(block.timestamp + 93 days));
        source = new LegacyL1AuthorityCheckpoint("community", INBOX, ENS.codehash, WRAPPER.codehash, REGISTRAR.codehash);
    }

    function bind(address who, address desired, uint64 lease) private {
        vm.prank(who);
        source.bindOrRenew(desired, lease);
    }

    function test_constructorBindsNativeLabelAndPinnedIdentity() public view {
        assertEq(
            source.parentNode(),
            keccak256(
                abi.encodePacked(
                    bytes32(0x93cdeb708b7545dc668eb9280176169d4e3fc8d4018eea69e45fdc04d3da4a3d), keccak256("community")
                )
            )
        );
        assertEq(source.labelId(), uint256(keccak256("community")));
        assertEq(source.destinationInbox(), INBOX);
        assertEq(source.SOURCE_CHAIN_ID(), 11155111);
        assertEq(source.DESTINATION_CHAIN_ID(), 11155420);
        assertEq(source.MAX_LEASE(), 7200);
    }

    function test_currentHolderMustAuthorizeAtExecutionNotByPayloadOrWorker() public {
        (address nowHolder, uint64 validUntil) = source.currentAuthority();
        assertEq(nowHolder, holder);
        assertEq(validUntil, block.timestamp + 2 days);
        vm.prank(attack);
        vm.expectRevert(LegacyL1AuthorityCheckpoint.Unauthorized.selector);
        source.bindOrRenew(controller, 3600);
        bind(holder, controller, 3600);
        (
            address nativeHolder,
            address currentController,
            uint64 epoch,
            uint64 sequence,
            uint64 leaseUntil,
            uint64 l1ValidUntil
        ) = source.state();
        assertEq(nativeHolder, holder);
        assertEq(currentController, controller);
        assertEq(epoch, 1);
        assertEq(sequence, 1);
        assertEq(leaseUntil, block.timestamp + 3600);
        assertEq(l1ValidUntil, block.timestamp + 2 days);
        assertFalse(source.observeLoss());
        (,,, sequence,,) = source.state();
        assertEq(sequence, 1);
    }

    function test_renewMonotonicSequenceAndRotationIncrementsEpoch() public {
        bind(holder, controller, 3600);
        vm.warp(block.timestamp + 900);
        bind(holder, controller, 3000);
        (, address active, uint64 epoch, uint64 sequence,,) = source.state();
        assertEq(active, controller);
        assertEq(epoch, 1);
        assertEq(sequence, 2);
        bind(holder, otherController, 2000);
        (, active, epoch, sequence,,) = source.state();
        assertEq(active, otherController);
        assertEq(epoch, 2);
        assertEq(sequence, 3);
    }

    function test_transferObservedFreezeOnlyOnL1AndOldHolderCannotRebind() public {
        bind(holder, controller, 7200);
        LegacyWrapperFixture(WRAPPER).setHolder(nextHolder);
        (, address oldController,,,,) = source.state();
        assertEq(oldController, controller); // async transfer race: stale L1 checkpoint until observed.
        vm.prank(attack); // caller cannot forge a new controller, but can request loss refresh.
        assertTrue(source.observeLoss());
        (address nativeHolder, address active, uint64 epoch, uint64 sequence, uint64 lease,) = source.state();
        assertEq(nativeHolder, address(0));
        assertEq(active, address(0));
        assertEq(epoch, 2);
        assertEq(sequence, 2);
        assertEq(lease, 0);
        vm.expectRevert(LegacyL1AuthorityCheckpoint.Unauthorized.selector);
        source.cancel();
        vm.prank(holder);
        vm.expectRevert(LegacyL1AuthorityCheckpoint.Unauthorized.selector);
        source.bindOrRenew(controller, 3600);
        bind(nextHolder, controller, 3600);
        (, active, epoch, sequence,,) = source.state();
        assertEq(active, controller);
        assertEq(epoch, 3); // old OP operator epochs must be invalidated by consumers.
        assertEq(sequence, 3);
    }

    function test_publicLossCheckDoesNotAllowForgedFreezeWhenHolderUnchanged() public {
        bind(holder, controller, 3600);
        vm.prank(attack);
        assertFalse(source.observeLoss());
        (, address active, uint64 epoch, uint64 sequence,,) = source.state();
        assertEq(active, controller);
        assertEq(epoch, 1);
        assertEq(sequence, 1);
        vm.prank(attack);
        vm.expectRevert(LegacyL1AuthorityCheckpoint.Unauthorized.selector);
        source.cancel();
    }

    function test_holderCancelAndRebindAlwaysEpochBump() public {
        bind(holder, controller, 3600);
        vm.prank(holder);
        source.cancel();
        (, address active, uint64 epoch, uint64 sequence,,) = source.state();
        assertEq(active, address(0));
        assertEq(epoch, 2);
        assertEq(sequence, 2);
        bind(holder, controller, 3600);
        (, active, epoch, sequence,,) = source.state();
        assertEq(active, controller);
        assertEq(epoch, 3);
        assertEq(sequence, 3);
    }

    function test_nativeHolderCanBeSmartAccountWithoutEOASignature() public {
        NativeHolderSmartAccountFixture safe = new NativeHolderSmartAccountFixture();
        LegacyWrapperFixture(WRAPPER).setHolder(address(safe));
        safe.authorize(source, controller, 3600);
        (address observed, address active, uint64 epoch,,,) = source.state();
        assertEq(observed, address(safe));
        assertEq(active, controller);
        assertEq(epoch, 1);
        vm.prank(attack);
        vm.expectRevert(LegacyL1AuthorityCheckpoint.Unauthorized.selector);
        source.bindOrRenew(controller, 3600); // no operator or forwarded EOA shortcut
        safe.stop(source);
        (, active, epoch,,,) = source.state();
        assertEq(active, address(0));
        assertEq(epoch, 2);
    }

    function test_checkpointEventHasPinnedDomainAndMonotonicL1Fields() public {
        vm.recordLogs();
        bind(holder, controller, 3600);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(source));
        assertEq(logs[0].topics.length, 2);
        assertEq(
            logs[0].topics[0],
            keccak256(
                "Checkpoint((uint256,uint256,address,address,bytes32,address,uint64,uint64,uint64,uint64,bytes32),bytes32)"
            )
        );
        assertEq(logs[0].topics[1], keccak256("BIND_OR_RENEW"));
        LegacyL1AuthorityCheckpoint.RootCheckpoint memory proof =
            abi.decode(logs[0].data, (LegacyL1AuthorityCheckpoint.RootCheckpoint));
        assertEq(proof.sourceChainId, 11155111);
        assertEq(proof.destinationChainId, 11155420);
        assertEq(proof.sourceAdapter, address(source));
        assertEq(proof.destinationInbox, INBOX);
        assertEq(proof.parentNode, source.parentNode());
        assertEq(proof.controller, controller);
        assertEq(proof.sourceEpoch, 1);
        assertEq(proof.sequence, 1);
        assertEq(proof.leaseUntil, uint64(block.timestamp + 3600));
        assertEq(proof.l1ValidUntil, uint64(block.timestamp + 2 days));
        assertEq(proof.authorityVersion, source.AUTHORITY_VERSION());
    }

    function test_expiryOrUnwrapCanBePermissionlesslyFrozen() public {
        bind(holder, controller, 3600);
        // Contract holder still reports same owner, but registrar is now in grace.
        LegacyRegistrarFixture(REGISTRAR).setExpiry(block.timestamp - 1);
        vm.prank(attack);
        assertTrue(source.observeLoss());
        (, address active, uint64 epoch, uint64 sequence, uint64 lease,) = source.state();
        assertEq(active, address(0));
        assertEq(epoch, 2);
        assertEq(sequence, 2);
        assertEq(lease, 0);

        LegacyRegistrarFixture(REGISTRAR).setExpiry(block.timestamp + 3 days);
        bind(holder, controller, 3600);
        LegacyRegistryFixture(ENS).setOwner(holder); // unwrap without touching wrapper ERC1155.
        assertTrue(source.observeLoss());
        (, active, epoch, sequence,,) = source.state();
        assertEq(active, address(0));
        assertEq(epoch, 4);
        assertEq(sequence, 4);
    }

    function test_graceOrTooShortExpiryNeverExtendsManagedLease() public {
        vm.expectRevert(LegacyL1AuthorityCheckpoint.InvalidLease.selector);
        vm.prank(holder);
        source.bindOrRenew(controller, 7201);
        vm.prank(holder);
        vm.expectRevert(LegacyL1AuthorityCheckpoint.InvalidLease.selector);
        source.bindOrRenew(controller, 0);
        LegacyRegistrarFixture(REGISTRAR).setExpiry(block.timestamp + 24 hours + 100);
        vm.prank(holder);
        vm.expectRevert(LegacyL1AuthorityCheckpoint.InvalidLease.selector);
        source.bindOrRenew(controller, 101);
        LegacyRegistrarFixture(REGISTRAR).setExpiry(block.timestamp - 1); // grace is NOT registration validity.
        (address nativeHolder,) = source.currentAuthority();
        assertEq(nativeHolder, address(0)); // ownerOf would revert, but expiry check runs first.
        vm.prank(holder);
        vm.expectRevert(LegacyL1AuthorityCheckpoint.InvalidNativeAuthority.selector);
        source.bindOrRenew(controller, 1);
    }

    function test_staleCustodyOrWrapperExpiryDeniesPositiveCheckpoints() public {
        LegacyRegistrarFixture(REGISTRAR).setOwner(attack);
        (address checkedHolder,) = source.currentAuthority();
        assertEq(checkedHolder, address(0));
        vm.prank(holder);
        vm.expectRevert(LegacyL1AuthorityCheckpoint.InvalidNativeAuthority.selector);
        source.bindOrRenew(controller, 100);
        LegacyRegistrarFixture(REGISTRAR).setOwner(WRAPPER);
        LegacyRegistryFixture(ENS).setOwner(attack);
        (checkedHolder,) = source.currentAuthority();
        assertEq(checkedHolder, address(0));
        LegacyRegistryFixture(ENS).setOwner(WRAPPER);
        LegacyWrapperFixture(WRAPPER).setExpiry(uint64(block.timestamp + 24 hours));
        (checkedHolder,) = source.currentAuthority();
        assertEq(checkedHolder, address(0));
    }

    function test_runtimePinAndChainFailClosed() public {
        vm.etch(REGISTRAR, hex"60006000fd");
        vm.prank(holder);
        vm.expectRevert(LegacyL1AuthorityCheckpoint.ContractIdentityChanged.selector);
        source.bindOrRenew(controller, 3600);
        vm.etch(REGISTRAR, address(new LegacyRegistrarFixture()).code);
        vm.chainId(1);
        vm.expectRevert(LegacyL1AuthorityCheckpoint.WrongChain.selector);
        source.observeLoss();
    }
}
