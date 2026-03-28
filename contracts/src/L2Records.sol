// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title L2Records
/// @notice Stores ENS subdomain records on L2 (Optimism).
///         Manages addr, text, and contenthash records per namehash node,
///         and tracks subdomain ownership via setSubnodeOwner.
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

    event AddrSet(bytes32 indexed node, uint256 coinType, bytes addr);
    event TextSet(bytes32 indexed node, string indexed key, string value);
    event ContenthashSet(bytes32 indexed node, bytes contenthash);
    event SubnodeOwnerSet(bytes32 indexed parentNode, bytes32 indexed labelhash, bytes32 indexed node, address subnodeOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error Unauthorized();
    error ZeroAddress();

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
    function setSubnodeOwner(bytes32 parentNode, bytes32 labelhash, address newOwner) external onlyOwner {
        bytes32 node = keccak256(abi.encodePacked(parentNode, labelhash));
        _owners[node] = newOwner;
        emit SubnodeOwnerSet(parentNode, labelhash, node, newOwner);
    }

    function subnodeOwner(bytes32 node) external view returns (address) {
        return _owners[node];
    }

    // ─── Write records ────────────────────────────────────────────────────────

    function setAddr(bytes32 node, uint256 coinType, bytes calldata addrBytes) external onlyOwner {
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
    function addr(bytes32 node) external view returns (address) {
        bytes memory b = _addrs[node][60];
        if (b.length == 0) return address(0);
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
}
