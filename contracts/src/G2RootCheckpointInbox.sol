// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

interface IOPCrossDomainMessenger {
    function xDomainMessageSender() external view returns (address);
}

/// @notice Authenticated L1-to-OP checkpoint inbox for ONE community parent.
/// Checkpoints represent bounded MANAGED leases, NOT current L1 ENS ownership.
/// A trusted L1 source adapter and canonical messenger must be separately audited.
/// No admin, upgrade, proxy, member-token transfer, or emergency override exists.
contract G2RootCheckpointInbox {
    address public constant OP_MESSENGER = 0x4200000000000000000000000000000000000007;
    uint256 public constant OP_SEPOLIA_CHAIN_ID = 11155420;
    uint256 public constant L1_SEPOLIA_CHAIN_ID = 11155111;
    uint64 public constant MAX_LEASE_SECONDS = 2 hours;
    bytes32 public constant MESSAGE_VERSION = keccak256("COMETENS_G2_ROOT_CHECKPOINT_V1");
    bool public constant sovereignReceipt = false;
    bool public constant l1OwnershipVerified = false;

    bytes32 public immutable parentNode;
    address public immutable l1AuthorityAdapter;
    uint64 public sourceEpoch;
    uint64 public sequence;
    uint64 public leaseUntil;
    address public rootController;

    struct RootCheckpoint {
        uint256 sourceChainId;
        uint256 destinationChainId;
        address sourceAdapter;
        address destinationInbox;
        bytes32 parentNode;
        address controller;
        uint64 sourceEpoch;
        uint64 sequence;
        uint64 leaseUntil;
        uint64 l1ValidUntil;
        bytes32 authorityVersion;
    }

    error UnauthorizedMessenger();
    error InvalidCheckpoint();

    event CheckpointAccepted(
        bytes32 indexed parent, address indexed controller, uint64 epoch, uint64 sequence, uint64 leaseUntil
    );

    constructor(bytes32 parent, address adapter) {
        if (block.chainid != OP_SEPOLIA_CHAIN_ID || parent == bytes32(0) || adapter == address(0)) {
            revert InvalidCheckpoint();
        }
        parentNode = parent;
        l1AuthorityAdapter = adapter;
    }

    /// @notice This only checks authenticated message origin and short OP lease.
    /// L1 ownership can transfer while a previous message is in flight or unexpired.
    function acceptCheckpoint(RootCheckpoint calldata c) external {
        if (
            msg.sender != OP_MESSENGER
                || IOPCrossDomainMessenger(OP_MESSENGER).xDomainMessageSender() != l1AuthorityAdapter
        ) {
            revert UnauthorizedMessenger();
        }
        if (
            block.chainid != OP_SEPOLIA_CHAIN_ID || c.sourceChainId != L1_SEPOLIA_CHAIN_ID
                || c.destinationChainId != OP_SEPOLIA_CHAIN_ID || c.sourceAdapter != l1AuthorityAdapter
                || c.destinationInbox != address(this) || c.parentNode != parentNode
                || c.authorityVersion != MESSAGE_VERSION || c.sequence <= sequence || c.sourceEpoch == 0
                || c.sourceEpoch < sourceEpoch
        ) revert InvalidCheckpoint();

        // A controller change or emergency freeze must advance the source epoch.
        if (c.controller != rootController && c.sourceEpoch <= sourceEpoch) revert InvalidCheckpoint();
        if (c.controller == address(0)) {
            if (c.leaseUntil != 0 || c.l1ValidUntil != 0) revert InvalidCheckpoint();
        } else if (
            c.leaseUntil <= block.timestamp || c.leaseUntil > block.timestamp + MAX_LEASE_SECONDS
                || c.leaseUntil > c.l1ValidUntil
        ) {
            revert InvalidCheckpoint();
        }

        sourceEpoch = c.sourceEpoch;
        sequence = c.sequence;
        rootController = c.controller;
        leaseUntil = c.leaseUntil;
        emit CheckpointAccepted(parentNode, c.controller, c.sourceEpoch, c.sequence, c.leaseUntil);
    }

    /// @notice Never use this alone as an ENS-native ownership assertion.
    function activeController() external view returns (address) {
        return leaseUntil > block.timestamp ? rootController : address(0);
    }
}
