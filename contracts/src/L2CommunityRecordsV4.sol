// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @notice An isolated OP application record store for ONE community root.
/// This does NOT verify Ethereum L1 ENS ownership or create native ENS subnames.
/// It is not a Sovereign / NameWrapper implementation; G2.4/G2.7 are separate.
/// No proxy, global owner, platform rescue, or privileged NFT-transfer path.
contract L2CommunityRecordsV4 is ERC721 {
    uint256 public constant CAP_ISSUE = 1;
    uint256 public constant CAP_INITIAL_ADDR = 2;
    bytes32 public immutable parentNode;
    bool public constant l1OwnershipVerified = false;
    address public rootController;
    address public pendingController;
    uint64 public controllerEpoch = 1;

    struct Operator {
        uint256 permissions;
        uint64 remainingQuota;
        uint64 expiresAt;
        uint64 epoch;
    }
    mapping(address => Operator) public operators;

    struct AddressRecord { address value; uint64 epoch; }
    struct TextRecord { string value; uint64 epoch; }
    struct ContentRecord { bytes value; uint64 epoch; }
    mapping(bytes32 => uint64) public recordEpoch;
    mapping(bytes32 => AddressRecord) private _addresses;
    mapping(bytes32 => mapping(string => TextRecord)) private _texts;
    mapping(bytes32 => ContentRecord) private _contenthashes;

    error Unauthorized();
    error InvalidInput();
    error Expired();
    error QuotaExceeded();
    error AlreadyIssued();

    event ControllerProposed(address indexed previous, address indexed pending);
    event ControllerAccepted(address indexed previous, address indexed current, uint64 epoch);
    event OperatorGranted(address indexed operator, uint256 permissions, uint64 quota, uint64 expiresAt, uint64 epoch);
    event OperatorRevoked(address indexed operator, uint64 epoch);
    event SubnodeIssued(bytes32 indexed parent, bytes32 indexed node, address indexed holder, address issuer);
    event RecordInvalidated(bytes32 indexed node, uint64 version);
    event AddrSet(bytes32 indexed node, address value);
    event TextSet(bytes32 indexed node, string key, string value);
    event ContenthashSet(bytes32 indexed node, bytes value);

    modifier onlyController() {
        if (msg.sender != rootController) revert Unauthorized();
        _;
    }

    constructor(bytes32 parent, address controller) ERC721("CometENS Community V4", "CEV4") {
        if (parent == bytes32(0) || controller == address(0)) revert InvalidInput();
        parentNode = parent;
        rootController = controller;
    }

    /// @notice Two-step root rotation atomically invalidates EVERY old operator grant.
    function proposeController(address next) external onlyController {
        if (next == address(0) || next == rootController) revert InvalidInput();
        pendingController = next;
        emit ControllerProposed(rootController, next);
    }

    function acceptController() external {
        if (msg.sender != pendingController || pendingController == address(0)) revert Unauthorized();
        address previous = rootController;
        rootController = msg.sender;
        pendingController = address(0);
        ++controllerEpoch;
        emit ControllerAccepted(previous, msg.sender, controllerEpoch);
    }

    /// @notice CAP_INITIAL_ADDR only permits address initialization AT issuance.
    /// It NEVER permits editing an already-owned member token or its records.
    function grantOperator(address operator, uint256 permissions, uint64 quota, uint64 expiresAt)
        external onlyController
    {
        _grant(operator, permissions, quota, expiresAt);
    }

    function _grant(address operator, uint256 permissions, uint64 quota, uint64 expiresAt) internal {
        if (operator == address(0) || operator == rootController || quota == 0 ||
            expiresAt <= block.timestamp || (permissions & CAP_ISSUE) == 0 ||
            (permissions & ~(CAP_ISSUE | CAP_INITIAL_ADDR)) != 0) revert InvalidInput();
        operators[operator] = Operator(permissions, quota, expiresAt, controllerEpoch);
        emit OperatorGranted(operator, permissions, quota, expiresAt, controllerEpoch);
    }

    function revokeOperator(address operator) external onlyController {
        delete operators[operator];
        emit OperatorRevoked(operator, controllerEpoch);
    }

    /// @notice Atomic rotation, no interim old+new effective grants beyond this tx.
    function rotateOperator(address oldOperator, address next, uint256 permissions, uint64 quota, uint64 expiresAt)
        external onlyController
    {
        if (oldOperator == next) revert InvalidInput();
        _grant(next, permissions, quota, expiresAt);
        delete operators[oldOperator];
        emit OperatorRevoked(oldOperator, controllerEpoch);
    }

    function operatorActive(address operator, uint256 required) public view returns (bool) {
        Operator memory op = operators[operator];
        return required != 0 && op.epoch == controllerEpoch && (op.permissions & required) == required &&
            op.remainingQuota > 0 && op.expiresAt > block.timestamp;
    }

    function nodeOf(string memory label) public view returns (bytes32) {
        bytes memory b = bytes(label);
        if (b.length == 0 || b.length > 63) revert InvalidInput();
        if (b[0] == '-' || b[b.length - 1] == '-') revert InvalidInput();
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-')) revert InvalidInput();
        }
        return keccak256(abi.encodePacked(parentNode, keccak256(b)));
    }

    function issue(string calldata label, address member, address initialAddr) external returns (bytes32 node) {
        if (member == address(0)) revert InvalidInput();
        if (msg.sender != rootController) {
            Operator storage op = operators[msg.sender];
            if (op.epoch != controllerEpoch || (op.permissions & CAP_ISSUE) == 0) revert Unauthorized();
            if (op.expiresAt <= block.timestamp) revert Expired();
            if (op.remainingQuota == 0) revert QuotaExceeded();
            if (initialAddr != address(0) && (op.permissions & CAP_INITIAL_ADDR) == 0) revert Unauthorized();
            --op.remainingQuota; // successful tx commits quota and mint atomically
        }
        node = nodeOf(label);
        if (_ownerOf(uint256(node)) != address(0)) revert AlreadyIssued();
        if (initialAddr != address(0)) {
            _addresses[node] = AddressRecord(initialAddr, recordEpoch[node]);
            emit AddrSet(node, initialAddr);
        }
        // Set the proposed address before the receiver hook. If the member's
        // ERC721Receiver callback immediately sets its own record, its choice
        // wins; the operator cannot write over it after ownership is delivered.
        _safeMint(member, uint256(node));
        emit SubnodeIssued(parentNode, node, member, msg.sender);
    }

    function subnodeOwner(bytes32 node) external view returns (address) {
        return _ownerOf(uint256(node));
    }

    function _requireMember(bytes32 node) internal view {
        // NFT approval is for ERC721 transfers, not authorization to rewrite records.
        if (_ownerOf(uint256(node)) != msg.sender) revert Unauthorized();
    }

    function setAddr(bytes32 node, address value) external {
        _requireMember(node);
        _addresses[node] = AddressRecord(value, recordEpoch[node]);
        emit AddrSet(node, value);
    }

    function addr(bytes32 node) external view returns (address) {
        if (_ownerOf(uint256(node)) == address(0)) return address(0);
        AddressRecord storage record = _addresses[node];
        return record.epoch == recordEpoch[node] ? record.value : address(0);
    }

    function setText(bytes32 node, string calldata key, string calldata value) external {
        _requireMember(node);
        if (bytes(key).length == 0 || bytes(key).length > 256 || bytes(value).length > 4096) revert InvalidInput();
        _texts[node][key] = TextRecord(value, recordEpoch[node]);
        emit TextSet(node, key, value);
    }

    function text(bytes32 node, string calldata key) external view returns (string memory) {
        TextRecord storage record = _texts[node][key];
        return _ownerOf(uint256(node)) != address(0) && record.epoch == recordEpoch[node] ? record.value : "";
    }

    function setContenthash(bytes32 node, bytes calldata value) external {
        _requireMember(node);
        if (value.length > 512) revert InvalidInput();
        _contenthashes[node] = ContentRecord(value, recordEpoch[node]);
        emit ContenthashSet(node, value);
    }

    function contenthash(bytes32 node) external view returns (bytes memory) {
        ContentRecord storage record = _contenthashes[node];
        return _ownerOf(uint256(node)) != address(0) && record.epoch == recordEpoch[node] ? record.value : bytes("");
    }

    /// @notice A transfer automatically hides the old holder's records. New
    /// holder must explicitly publish their own records after transfer.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address previous) {
        previous = super._update(to, tokenId, auth);
        if (previous != address(0) && previous != to) {
            bytes32 node = bytes32(tokenId);
            ++recordEpoch[node];
            emit RecordInvalidated(node, recordEpoch[node]);
        }
    }
}
