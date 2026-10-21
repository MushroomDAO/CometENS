// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

interface IG2RootInbox {
    function parentNode() external view returns (bytes32);
    function l1AuthorityAdapter() external view returns (address);
    function sourceEpoch() external view returns (uint64);
    function leaseUntil() external view returns (uint64);
    function rootController() external view returns (address);
    function activeController() external view returns (address);
}

interface IG2CommunityV4 {
    function parentNode() external view returns (bytes32);
    function rootController() external view returns (address);
    function pendingController() external view returns (address);
    function acceptController() external;
    function issue(string calldata label, address member, address initialAddr) external returns (bytes32);
}

/// @notice Optional OP V4 root controller adapter: short MANAGED lease only.
/// It does not verify *current* L1 owner or implement native ENS handoff.
/// Existing V4 must hand over rootController; direct V4 operator grants must
/// be invalidated by V4's controllerEpoch on that handoff.
contract G2ManagedLeaseIssuer {
    uint256 public constant OP_SEPOLIA_CHAIN_ID = 11155420;
    uint256 public constant CAP_ISSUE = 1;
    uint256 public constant CAP_INITIAL_ADDR = 2;
    bool public constant sovereignReceipt = false;
    bool public constant l1OwnershipVerified = false;

    address public immutable inbox;
    address public immutable records;
    address public immutable expectedL1Adapter;
    bytes32 public immutable expectedInboxCodeHash;
    bytes32 public immutable expectedRecordsCodeHash;
    bytes32 public immutable parentNode;

    struct Grant {
        uint256 permissions;
        uint64 remainingQuota;
        uint64 expiresAt;
        uint64 sourceEpoch;
    }

    mapping(address => Grant) public grants;

    error IdentityMismatch();
    error Unauthorized();
    error InvalidGrant();
    error LeaseInactive();

    event ManagedGrant(address indexed operator, uint256 permissions, uint64 quota, uint64 expiry, uint64 sourceEpoch);
    event ManagedRevoke(address indexed operator, uint64 sourceEpoch);
    event ManagedIssue(bytes32 indexed node, address indexed member, address indexed caller, uint64 sourceEpoch);

    constructor(
        address pinnedInbox,
        address pinnedRecords,
        address pinnedL1Adapter,
        bytes32 inboxCodeHash,
        bytes32 recordsCodeHash
    ) {
        if (
            block.chainid != OP_SEPOLIA_CHAIN_ID || pinnedInbox == address(0) || pinnedRecords == address(0)
                || pinnedL1Adapter == address(0) || inboxCodeHash == bytes32(0) || recordsCodeHash == bytes32(0)
        ) {
            revert IdentityMismatch();
        }
        inbox = pinnedInbox;
        records = pinnedRecords;
        expectedL1Adapter = pinnedL1Adapter;
        expectedInboxCodeHash = inboxCodeHash;
        expectedRecordsCodeHash = recordsCodeHash;
        bytes32 root = IG2RootInbox(pinnedInbox).parentNode();
        if (root == bytes32(0) || IG2CommunityV4(pinnedRecords).parentNode() != root) revert IdentityMismatch();
        parentNode = root;
        _verifyIdentity();
    }

    function _verifyIdentity() internal view {
        if (
            block.chainid != OP_SEPOLIA_CHAIN_ID || inbox.codehash != expectedInboxCodeHash
                || records.codehash != expectedRecordsCodeHash || IG2RootInbox(inbox).parentNode() != parentNode
                || IG2CommunityV4(records).parentNode() != parentNode
                || IG2RootInbox(inbox).l1AuthorityAdapter() != expectedL1Adapter
        ) revert IdentityMismatch();
    }

    function _active() internal view returns (address controller, uint64 epoch) {
        _verifyIdentity();
        controller = IG2RootInbox(inbox).activeController();
        epoch = IG2RootInbox(inbox).sourceEpoch();
        if (controller == address(0) || epoch == 0 || IG2RootInbox(inbox).leaseUntil() <= block.timestamp) {
            revert LeaseInactive();
        }
    }

    function _requireRoot() private view returns (uint64 epoch) {
        (address controller, uint64 sourceEpoch) = _active();
        if (msg.sender != controller || IG2CommunityV4(records).rootController() != address(this)) {
            revert Unauthorized();
        }
        return sourceEpoch;
    }

    /// @notice The CURRENT inbox controller finalizes a *pending* V4 handoff
    /// to this adapter while its canonical-message-derived lease is live.
    /// V4 controllerEpoch rotation invalidates previous V4 direct grants.
    function acceptControl() external {
        (address controller,) = _active();
        if (msg.sender != controller || IG2CommunityV4(records).pendingController() != address(this)) {
            revert Unauthorized();
        }
        IG2CommunityV4(records).acceptController();
        if (IG2CommunityV4(records).rootController() != address(this)) revert Unauthorized();
    }

    /// @notice Scoped delegates are stored ONLY here; never V4.grantOperator,
    /// so no external delegate can bypass a missing/expired OP inbox lease.
    function grant(address operator, uint256 permissions, uint64 quota, uint64 expiresAt) external {
        uint64 epoch = _requireRoot();
        if (
            operator == address(0) || operator == address(this) || operator == msg.sender || quota == 0
                || permissions & CAP_ISSUE == 0 || permissions & ~(CAP_ISSUE | CAP_INITIAL_ADDR) != 0
                || expiresAt <= block.timestamp || expiresAt > IG2RootInbox(inbox).leaseUntil()
        ) revert InvalidGrant();
        grants[operator] = Grant(permissions, quota, expiresAt, epoch);
        emit ManagedGrant(operator, permissions, quota, expiresAt, epoch);
    }

    function revoke(address operator) external {
        // Reduction-only actions remain available to the last authenticated
        // controller even after the lease lapses (no new privileges granted).
        _verifyIdentity();
        if (
            msg.sender != IG2RootInbox(inbox).rootController() || msg.sender == address(0)
                || IG2CommunityV4(records).rootController() != address(this)
        ) revert Unauthorized();
        uint64 epoch = IG2RootInbox(inbox).sourceEpoch();
        delete grants[operator];
        emit ManagedRevoke(operator, epoch);
    }

    function issue(string calldata label, address member, address initialAddr) external returns (bytes32 node) {
        (address controller, uint64 epoch) = _active();
        if (IG2CommunityV4(records).rootController() != address(this)) revert Unauthorized();
        if (msg.sender != controller) {
            Grant storage delegated = grants[msg.sender];
            if (
                delegated.sourceEpoch != epoch || delegated.permissions & CAP_ISSUE == 0
                    || delegated.remainingQuota == 0 || delegated.expiresAt <= block.timestamp
                    || (initialAddr != address(0) && delegated.permissions & CAP_INITIAL_ADDR == 0)
            ) {
                revert Unauthorized();
            }
            --delegated.remainingQuota;
        }
        // V4 sees this adapter as rootController. A revert rolls quota back.
        node = IG2CommunityV4(records).issue(label, member, initialAddr);
        emit ManagedIssue(node, member, msg.sender, epoch);
    }
}
