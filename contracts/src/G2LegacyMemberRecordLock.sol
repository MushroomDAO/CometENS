// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

interface ILegacyRecordLockRegistry {
    function owner(bytes32 node) external view returns (address);
}

interface ILegacyRecordLockWrapper {
    function getData(uint256 node) external view returns (address owner, uint32 fuses, uint64 expiry);
}

interface ILegacyRecordLockRegistrar {
    function ownerOf(uint256 labelId) external view returns (address);
    function nameExpires(uint256 labelId) external view returns (uint256);
}

/// @notice Optional ONE-TIME data lock for a LEGACY ENSv1 wrapped member name.
/// The actual ENS Registry resolver pointer is not changed or locked here.
/// Never represents independently verified SOVEREIGN / LOCKED_RECORD status.
contract G2LegacyMemberRecordLock {
    uint256 public constant L1_SEPOLIA_CHAIN_ID = 11155111;
    uint256 public constant MIN_VALIDITY = 1 days;
    uint32 public constant CANNOT_UNWRAP = 1;
    uint32 public constant PARENT_CANNOT_CONTROL = 1 << 16;
    bool public constant sovereignReceipt = false;
    bool public constant ensV2AuthorityVerified = false;
    bool public constant nativeResolverPointerLockedVerified = false;

    bytes32 private constant ETH_NODE = 0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae;
    address public constant REGISTRY = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address public constant WRAPPER = 0x0635513f179D50A207757E05759CbD106d7dFcE8;
    address public constant REGISTRAR = 0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85;

    bytes32 public immutable parentNode;
    bytes32 public immutable node;
    uint256 public immutable parentLabelId;
    bytes32 public immutable registryCodeHash;
    bytes32 public immutable wrapperCodeHash;
    bytes32 public immutable registrarCodeHash;

    bool public locked;
    // Original opt-in caller, not a guarantee that the member still owns the name.
    address public lockedBy;
    address private lockedAddr;
    bytes private lockedContenthash;
    string private lockedTextKey;
    string private lockedTextValue;
    bytes32 public recordCommitment;

    error InvalidConfiguration();
    error InvalidMemberOrExpired();
    error AlreadyLocked();
    error InvalidRecords();

    event MemberRecordsLocked(bytes32 indexed node, address indexed member, bytes32 recordCommitment);

    constructor(
        string memory parentLabel,
        string memory childLabel,
        bytes32 pinnedRegistryHash,
        bytes32 pinnedWrapperHash,
        bytes32 pinnedRegistrarHash
    ) {
        if (
            block.chainid != L1_SEPOLIA_CHAIN_ID || !_label(parentLabel) || !_label(childLabel)
                || pinnedRegistryHash == bytes32(0) || pinnedWrapperHash == bytes32(0)
                || pinnedRegistrarHash == bytes32(0)
        ) revert InvalidConfiguration();
        parentLabelId = uint256(keccak256(bytes(parentLabel)));
        parentNode = keccak256(abi.encodePacked(ETH_NODE, bytes32(parentLabelId)));
        node = keccak256(abi.encodePacked(parentNode, keccak256(bytes(childLabel))));
        registryCodeHash = pinnedRegistryHash;
        wrapperCodeHash = pinnedWrapperHash;
        registrarCodeHash = pinnedRegistrarHash;
        _checkIdentity();
    }

    function _label(string memory label) private pure returns (bool) {
        bytes memory data = bytes(label);
        if (data.length == 0 || data.length > 63 || data[0] == "-" || data[data.length - 1] == "-") {
            return false;
        }
        for (uint256 i; i < data.length; ++i) {
            bytes1 c = data[i];
            if (
                !((c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "-")
                    || (i == 2 && data.length >= 4 && data[2] == "-" && data[3] == "-")
            ) return false;
        }
        return true;
    }

    function _checkIdentity() private view {
        if (
            block.chainid != L1_SEPOLIA_CHAIN_ID || REGISTRY.codehash != registryCodeHash
                || WRAPPER.codehash != wrapperCodeHash || REGISTRAR.codehash != registrarCodeHash
        ) {
            revert InvalidConfiguration();
        }
    }

    /// @notice Irreversible member opt-in. A locked bundle cannot be edited by
    /// member, parent, platform or future controller through this code path.
    function lock(address value, bytes calldata contenthashValue, string calldata key, string calldata textValue)
        external
    {
        if (locked) revert AlreadyLocked();
        if (
            bytes(key).length == 0 || bytes(key).length > 256 || bytes(textValue).length > 4096
                || contenthashValue.length > 512
        ) revert InvalidRecords();
        _checkIdentity();
        if (
            ILegacyRecordLockRegistry(REGISTRY).owner(parentNode) != WRAPPER
                || ILegacyRecordLockRegistry(REGISTRY).owner(node) != WRAPPER
                || ILegacyRecordLockRegistrar(REGISTRAR).ownerOf(parentLabelId) != WRAPPER
        ) {
            revert InvalidMemberOrExpired();
        }
        (address parentHolder, uint32 parentFuses, uint64 parentExpiry) =
            ILegacyRecordLockWrapper(WRAPPER).getData(uint256(parentNode));
        (address member, uint32 fuses, uint64 childExpiry) = ILegacyRecordLockWrapper(WRAPPER).getData(uint256(node));
        uint256 registrarExpiry = ILegacyRecordLockRegistrar(REGISTRAR).nameExpires(parentLabelId);
        if (
            parentHolder == address(0) || member != msg.sender || (parentFuses & CANNOT_UNWRAP) == 0
                || (fuses & (CANNOT_UNWRAP | PARENT_CANNOT_CONTROL)) != (CANNOT_UNWRAP | PARENT_CANNOT_CONTROL)
                || registrarExpiry <= block.timestamp + MIN_VALIDITY || parentExpiry <= block.timestamp + MIN_VALIDITY
                || childExpiry <= block.timestamp + MIN_VALIDITY || childExpiry > parentExpiry
                || uint256(childExpiry) + MIN_VALIDITY > registrarExpiry
        ) revert InvalidMemberOrExpired();

        locked = true; // CEI, no external callbacks thereafter.
        lockedBy = msg.sender;
        lockedAddr = value;
        lockedContenthash = contenthashValue;
        lockedTextKey = key;
        lockedTextValue = textValue;
        recordCommitment = keccak256(abi.encode(node, value, contenthashValue, key, textValue));
        emit MemberRecordsLocked(node, msg.sender, recordCommitment);
    }

    function addr(bytes32 queryNode) external view returns (address) {
        return locked && queryNode == node ? lockedAddr : address(0);
    }

    function contenthash(bytes32 queryNode) external view returns (bytes memory) {
        return locked && queryNode == node ? lockedContenthash : bytes("");
    }

    function text(bytes32 queryNode, string calldata key) external view returns (string memory) {
        return
            locked && queryNode == node && keccak256(bytes(key)) == keccak256(bytes(lockedTextKey))
                ? lockedTextValue
                : "";
    }
}
