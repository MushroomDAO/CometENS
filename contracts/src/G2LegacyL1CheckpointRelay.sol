// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "./LegacyL1AuthorityCheckpoint.sol";
import "./G2RootCheckpointInbox.sol";

interface IL1CrossDomainMessengerRelay {
    function sendMessage(address target, bytes calldata message, uint32 minGasLimit) external;
}

/// @notice Permissionless legacy L1 Sepolia source-to-OP messenger adapter.
/// @dev A delivered checkpoint is only a bounded MANAGED lease, never ENS title.
contract G2LegacyL1CheckpointRelay {
    uint256 public constant L1_CHAIN_ID = 11155111;
    uint256 public constant OP_CHAIN_ID = 11155420;
    uint64 public constant MAX_LEASE = 2 hours;
    uint32 public constant MIN_MESSAGE_GAS = 200_000;
    uint32 public constant MAX_MESSAGE_GAS = 2_000_000;
    bytes32 public constant VERSION = keccak256("COMETENS_G2_ROOT_CHECKPOINT_V1");

    LegacyL1AuthorityCheckpoint public immutable source;
    address public immutable l1Messenger;
    address public immutable destinationInbox;
    bytes32 public immutable parentNode;
    bytes32 public immutable sourceRuntimeHash;
    bytes32 public immutable messengerRuntimeHash;
    uint64 public lastSentSequence;
    uint64 public lastSentEpoch;

    error InvalidConfiguration();
    error WrongChain();
    error IdentityChanged();
    error InvalidCheckpoint();
    error InvalidGasLimit();

    event CheckpointSent(
        uint64 indexed sourceEpoch, uint64 indexed sequence, address indexed controller, uint64 leaseUntil
    );

    constructor(
        address sourceAddress,
        bytes32 expectedSourceRuntimeHash,
        address messengerAddress,
        bytes32 expectedMessengerRuntimeHash,
        address inbox,
        bytes32 parent
    ) {
        if (block.chainid != L1_CHAIN_ID) revert WrongChain();
        if (
            sourceAddress == address(0) || messengerAddress == address(0) || inbox == address(0) || parent == bytes32(0)
                || expectedSourceRuntimeHash == bytes32(0) || expectedMessengerRuntimeHash == bytes32(0)
        ) revert InvalidConfiguration();
        source = LegacyL1AuthorityCheckpoint(sourceAddress);
        l1Messenger = messengerAddress;
        destinationInbox = inbox;
        parentNode = parent;
        sourceRuntimeHash = expectedSourceRuntimeHash;
        messengerRuntimeHash = expectedMessengerRuntimeHash;
        _checkIdentity();
    }

    /// @notice Anyone can relay the latest L1 source state; only the pinned
    /// messenger can authenticate this contract as sender on OP.
    function relay(uint32 minGasLimit) external {
        _checkIdentity();
        if (minGasLimit < MIN_MESSAGE_GAS || minGasLimit > MAX_MESSAGE_GAS) revert InvalidGasLimit();

        // Always recheck *current* native authority. If a known holder lost
        // it, create the source's permissionless freeze BEFORE taking state().
        (address holder, uint64 validUntil) = source.currentAuthority();
        (address previousHolder, address previousController,,,,) = source.state();
        if (previousController != address(0) && (holder == address(0) || holder != previousHolder)) {
            if (!source.observeLoss()) revert InvalidCheckpoint();
        }

        (
            address observedHolder,
            address controller,
            uint64 epoch,
            uint64 sequence,
            uint64 leaseUntil,
            uint64 l1ValidUntil
        ) = source.state();
        if (epoch == 0 || sequence <= lastSentSequence || epoch < lastSentEpoch) revert InvalidCheckpoint();
        if (controller == address(0)) {
            if (observedHolder != address(0) || leaseUntil != 0 || l1ValidUntil != 0) {
                revert InvalidCheckpoint();
            }
        } else if (
            holder == address(0) || observedHolder != holder || validUntil == 0 || l1ValidUntil > validUntil
                || leaseUntil <= block.timestamp || leaseUntil > block.timestamp + MAX_LEASE
                || leaseUntil > l1ValidUntil
        ) {
            revert InvalidCheckpoint();
        }

        G2RootCheckpointInbox.RootCheckpoint memory c = G2RootCheckpointInbox.RootCheckpoint({
            sourceChainId: L1_CHAIN_ID,
            destinationChainId: OP_CHAIN_ID,
            sourceAdapter: address(this), // OP xDomainMessageSender is THIS relay.
            destinationInbox: destinationInbox,
            parentNode: parentNode,
            controller: controller,
            sourceEpoch: epoch,
            sequence: sequence,
            leaseUntil: leaseUntil,
            l1ValidUntil: l1ValidUntil,
            authorityVersion: VERSION
        });

        // CEI: messenger callbacks cannot enqueue the same source sequence.
        lastSentSequence = sequence;
        lastSentEpoch = epoch;
        IL1CrossDomainMessengerRelay(l1Messenger)
            .sendMessage(destinationInbox, abi.encodeCall(G2RootCheckpointInbox.acceptCheckpoint, (c)), minGasLimit);
        emit CheckpointSent(epoch, sequence, controller, leaseUntil);
    }

    function _checkIdentity() private view {
        if (block.chainid != L1_CHAIN_ID) revert WrongChain();
        if (address(source).codehash != sourceRuntimeHash || l1Messenger.codehash != messengerRuntimeHash) {
            revert IdentityChanged();
        }
        if (
            source.parentNode() != parentNode || source.destinationInbox() != destinationInbox
                || source.SOURCE_CHAIN_ID() != L1_CHAIN_ID || source.DESTINATION_CHAIN_ID() != OP_CHAIN_ID
                || source.AUTHORITY_VERSION() != VERSION
        ) revert InvalidConfiguration();
    }
}
