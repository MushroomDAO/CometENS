// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title L2Records
/// @notice Stores ENS subdomain records on L2 (Optimism).
///         Manages addr, text, and contenthash records per namehash node,
///         and tracks subdomain ownership via setSubnodeOwner.
///         Stores label text on-chain (Durin-style) enabling reverse lookup.
contract L2Records {
    address public owner;

    // node => coinType => address bytes
    mapping(bytes32 => mapping(uint256 => bytes)) private _addrs;
    // node => key => value
    mapping(bytes32 => mapping(string => string)) private _texts;
    // node => contenthash bytes
    mapping(bytes32 => bytes) private _contenthashes;
    // node => owner address
    mapping(bytes32 => address) private _owners;
    // node => DNS-encoded leaf name (e.g. "\x05alice\x00")
    mapping(bytes32 => bytes) private _names;
    // address => primary node (first subdomain registered by this address under any parent)
    mapping(address => bytes32) private _primaryNode;

    event AddrSet(bytes32 indexed node, uint256 coinType, bytes addr);
    event TextSet(bytes32 indexed node, string indexed key, string value);
    event ContenthashSet(bytes32 indexed node, bytes contenthash);
    event SubnodeOwnerSet(bytes32 indexed parentNode, bytes32 indexed labelhash, bytes32 indexed node, address subnodeOwner);
    event NameRegistered(bytes32 indexed node, bytes32 indexed parentNode, string label, address owner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error Unauthorized();
    error ZeroAddress();
    error InvalidAddrBytes();
    error LabelMismatch();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(address _owner) {
        if (_owner == address(0)) revert ZeroAddress();
        owner = _owner;
        emit OwnershipTransferred(address(0), _owner);
    }

    // ─── Ownership ────────────────────────────────────────────────────────────

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ─── Subdomain ownership ──────────────────────────────────────────────────

    /// @notice Assigns ownership of a subdomain node. Node = keccak256(abi.encodePacked(parentNode, labelhash)).
    ///         Also stores the label in DNS wire format and sets primaryNode for first-time registrants.
    function setSubnodeOwner(bytes32 parentNode, bytes32 labelhash, address newOwner, string calldata label) external onlyOwner {
        _registerNode(parentNode, labelhash, newOwner, label);
    }

    /// @notice Atomically registers a subdomain and sets its ETH address record in one transaction.
    function registerSubnode(
        bytes32 parentNode,
        bytes32 labelhash,
        address newOwner,
        string calldata label,
        bytes calldata addrBytes
    ) external onlyOwner {
        bytes32 node = _registerNode(parentNode, labelhash, newOwner, label);
        _addrs[node][60] = addrBytes;
        emit AddrSet(node, 60, addrBytes);
    }

    function subnodeOwner(bytes32 node) external view returns (address) {
        return _owners[node];
    }

    // ─── Label/name storage ───────────────────────────────────────────────────

    /// @notice Returns the stored DNS-encoded name for a node
    function nameOf(bytes32 node) external view returns (bytes memory) {
        return _names[node];
    }

    /// @notice Returns the label string for a node (decoded from stored DNS name)
    function labelOf(bytes32 node) external view returns (string memory) {
        bytes memory encoded = _names[node];
        if (encoded.length < 2) return "";
        uint8 len = uint8(encoded[0]);
        if (encoded.length < uint256(len) + 2) return "";
        bytes memory label = new bytes(len);
        for (uint i = 0; i < len; i++) {
            label[i] = encoded[i + 1];
        }
        return string(label);
    }

    /// @notice Returns the primary node for an address (first registered subdomain)
    function primaryNode(address addr_) external view returns (bytes32) {
        return _primaryNode[addr_];
    }

    // ─── Write records ────────────────────────────────────────────────────────

    /// @dev For coinType 60 (ETH), addrBytes must be exactly 20 bytes or empty (clear).
    function setAddr(bytes32 node, uint256 coinType, bytes calldata addrBytes) external onlyOwner {
        if (coinType == 60 && addrBytes.length != 0 && addrBytes.length != 20) revert InvalidAddrBytes();
        _addrs[node][coinType] = addrBytes;
        emit AddrSet(node, coinType, addrBytes);
    }

    function setText(bytes32 node, string calldata key, string calldata value) external onlyOwner {
        _texts[node][key] = value;
        emit TextSet(node, key, value);
    }

    function setContenthash(bytes32 node, bytes calldata hash) external onlyOwner {
        _contenthashes[node] = hash;
        emit ContenthashSet(node, hash);
    }

    // ─── Read records ─────────────────────────────────────────────────────────

    /// @notice Returns the ETH address (coinType 60) as an address type.
    /// @dev Assembly: b points to the length slot (32 bytes). mload(b+20) reads bytes
    ///      [b+20..b+51]: the last 12 bytes of the length slot (zeroes) + all 20 address
    ///      bytes. Casting to address takes the low 160 bits = the address. Correct ✓.
    ///      Guarded: b.length < 20 returns address(0) to prevent reading uninitialized memory.
    function addr(bytes32 node) external view returns (address) {
        bytes memory b = _addrs[node][60];
        if (b.length < 20) return address(0);
        address result;
        assembly {
            result := mload(add(b, 20))
        }
        return result;
    }

    /// @notice Returns address bytes for any coin type.
    function addr(bytes32 node, uint256 coinType) external view returns (bytes memory) {
        return _addrs[node][coinType];
    }

    function text(bytes32 node, string calldata key) external view returns (string memory) {
        return _texts[node][key];
    }

    function contenthash(bytes32 node) external view returns (bytes memory) {
        return _contenthashes[node];
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    /// @dev Core registration logic shared by setSubnodeOwner and registerSubnode.
    function _registerNode(
        bytes32 parentNode,
        bytes32 labelhash,
        address newOwner,
        string calldata label
    ) private returns (bytes32 node) {
        if (newOwner == address(0)) revert ZeroAddress();
        if (labelhash != keccak256(bytes(label))) revert LabelMismatch();
        node = keccak256(abi.encodePacked(parentNode, labelhash));
        _owners[node] = newOwner;
        _names[node] = _encodeDnsName(label);
        if (_primaryNode[newOwner] == bytes32(0)) _primaryNode[newOwner] = node;
        emit SubnodeOwnerSet(parentNode, labelhash, node, newOwner);
        emit NameRegistered(node, parentNode, label, newOwner);
    }

    /// @dev Encodes a label in DNS wire format: <len><label bytes><0x00>
    function _encodeDnsName(string calldata label) private pure returns (bytes memory) {
        bytes memory labelBytes = bytes(label);
        bytes memory encoded = new bytes(labelBytes.length + 2);
        encoded[0] = bytes1(uint8(labelBytes.length));
        for (uint i = 0; i < labelBytes.length; i++) {
            encoded[i + 1] = labelBytes[i];
        }
        encoded[labelBytes.length + 1] = 0x00;
        return encoded;
    }
}
