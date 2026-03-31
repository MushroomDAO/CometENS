// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title L2Records V2
/// @notice Stores ENS subdomain records on L2 (Optimism).
///         V2 adds registrar model for permissionless community registration.
///         Manages addr, text, and contenthash records per namehash node.
contract L2RecordsV2 {
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

    // ─── V2: Registrar model ────────────────────────────────────────────────────
    
    /// @notice parentNode => registrar address => is active
    /// @dev Use isRegistrar() for external queries — this raw slot does not account for expiry.
    mapping(bytes32 => mapping(address => bool)) private registrars;
    
    /// @notice parentNode => registrar address => remaining quota
    mapping(bytes32 => mapping(address => uint256)) public registrarQuota;
    
    /// @notice parentNode => registrar address => expiry timestamp (0 = no expiry)
    mapping(bytes32 => mapping(address => uint256)) public registrarExpiry;

    event AddrSet(bytes32 indexed node, uint256 coinType, bytes addr);
    event TextSet(bytes32 indexed node, string indexed key, string value);
    event ContenthashSet(bytes32 indexed node, bytes contenthash);
    event SubnodeOwnerSet(bytes32 indexed parentNode, bytes32 indexed labelhash, bytes32 indexed node, address subnodeOwner);
    event NameRegistered(bytes32 indexed node, bytes32 indexed parentNode, string label, address owner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    
    // ─── V2: New events ─────────────────────────────────────────────────────────
    event RegistrarAdded(bytes32 indexed parentNode, address indexed registrar, uint256 quota, uint256 expiry);
    event RegistrarRemoved(bytes32 indexed parentNode, address indexed registrar);
    event RegistrarQuotaUpdated(bytes32 indexed parentNode, address indexed registrar, uint256 newQuota);

    error Unauthorized();
    error ZeroAddress();
    error InvalidLabel();
    error InvalidAddrBytes();
    error AlreadyRegistered();
    error QuotaExceeded();
    error RegistrarExpired();
    error LabelMismatch();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyOwnerOrRegistrar(bytes32 parentNode) {
        if (msg.sender != owner) {
            if (!registrars[parentNode][msg.sender]) revert Unauthorized();
            uint256 exp = registrarExpiry[parentNode][msg.sender];
            if (exp != 0 && block.timestamp > exp) revert RegistrarExpired();
        }
        _;
    }

    constructor(address _owner) {
        if (_owner == address(0)) revert ZeroAddress();
        owner = _owner;
        emit OwnershipTransferred(address(0), _owner);
    }

    // ─── Ownership ──────────────────────────────────────────────────────────────

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ─── V2: Registrar Management (Owner Only) ──────────────────────────────────

    /// @notice Add a registrar for a specific parent domain
    /// @param parentNode The parent domain node (e.g., namehash("forest.aastar.eth"))
    /// @param registrar The address authorized to register subdomains
    /// @param quota Maximum number of registrations allowed (0 = unlimited)
    /// @param expiry Timestamp when registrar expires (0 = never)
    function addRegistrar(
        bytes32 parentNode,
        address registrar,
        uint256 quota,
        uint256 expiry
    ) external onlyOwner {
        if (registrar == address(0)) revert ZeroAddress();

        registrars[parentNode][registrar] = true;
        // 0 in external API = unlimited; stored as type(uint256).max to distinguish from exhausted (0)
        uint256 storedQuota = quota == 0 ? type(uint256).max : quota;
        registrarQuota[parentNode][registrar] = storedQuota;
        registrarExpiry[parentNode][registrar] = expiry;

        // Emit resolved quota so indexers/events reflect the actual stored sentinel
        emit RegistrarAdded(parentNode, registrar, storedQuota, expiry);
    }

    /// @notice Remove a registrar
    function removeRegistrar(bytes32 parentNode, address registrar) external onlyOwner {
        delete registrars[parentNode][registrar];
        delete registrarQuota[parentNode][registrar];
        delete registrarExpiry[parentNode][registrar];
        
        emit RegistrarRemoved(parentNode, registrar);
    }

    /// @notice Update quota for an existing (non-expired) registrar (0 = unlimited)
    function updateRegistrarQuota(
        bytes32 parentNode,
        address registrar,
        uint256 newQuota
    ) external onlyOwner {
        if (!registrars[parentNode][registrar]) revert Unauthorized();
        uint256 exp = registrarExpiry[parentNode][registrar];
        if (exp != 0 && block.timestamp > exp) revert RegistrarExpired();
        uint256 stored = newQuota == 0 ? type(uint256).max : newQuota;
        registrarQuota[parentNode][registrar] = stored;
        emit RegistrarQuotaUpdated(parentNode, registrar, stored);
    }

    /// @notice Check if an address is an active registrar for a parent domain
    function isRegistrar(bytes32 parentNode, address addr) external view returns (bool) {
        if (!registrars[parentNode][addr]) return false;
        
        uint256 expiry = registrarExpiry[parentNode][addr];
        if (expiry != 0 && block.timestamp > expiry) return false;
        
        return true;
    }

    /// @notice Get registrar info. remainingQuota = type(uint256).max means unlimited.
    function getRegistrarInfo(bytes32 parentNode, address registrar) external view returns (
        bool isActive,
        uint256 remainingQuota,
        uint256 expiry
    ) {
        isActive = registrars[parentNode][registrar];
        remainingQuota = registrarQuota[parentNode][registrar]; // max = unlimited, 0 = exhausted
        expiry = registrarExpiry[parentNode][registrar];
        if (expiry != 0 && block.timestamp > expiry) isActive = false;
    }

    // ─── Subdomain Registration ─────────────────────────────────────────────────

    /// @notice Register a subdomain (Owner or authorized Registrar)
    /// @dev V2: Now allows registrars to call this function
    function setSubnodeOwner(
        bytes32 parentNode, 
        bytes32 labelhash, 
        address newOwner, 
        string calldata label
    ) external onlyOwnerOrRegistrar(parentNode) {
        _checkRegistrarQuota(parentNode);
        _registerNode(parentNode, labelhash, newOwner, label);
    }

    /// @notice Atomically register a subdomain and set its ETH address record
    /// @dev V2: Now allows registrars to call this function
    function registerSubnode(
        bytes32 parentNode,
        bytes32 labelhash,
        address newOwner,
        string calldata label,
        bytes calldata addrBytes
    ) external onlyOwnerOrRegistrar(parentNode) {
        if (addrBytes.length != 20) revert InvalidAddrBytes();
        _checkRegistrarQuota(parentNode);
        bytes32 node = _registerNode(parentNode, labelhash, newOwner, label);
        _addrs[node][60] = addrBytes;
        emit AddrSet(node, 60, addrBytes);
    }

    /// @notice Internal function to check and decrement registrar quota.
    ///         Expiry is already enforced by the modifier; this handles quota only.
    function _checkRegistrarQuota(bytes32 parentNode) internal {
        if (msg.sender != owner) {
            uint256 quota = registrarQuota[parentNode][msg.sender];
            if (quota != type(uint256).max) {
                // limited quota: 0 = exhausted
                if (quota == 0) revert QuotaExceeded();
                registrarQuota[parentNode][msg.sender] = quota - 1;
            }
            // type(uint256).max = unlimited — no decrement needed
        }
    }

    function subnodeOwner(bytes32 node) external view returns (address) {
        return _owners[node];
    }

    // ─── Label/name storage ─────────────────────────────────────────────────────

    function nameOf(bytes32 node) external view returns (bytes memory) {
        return _names[node];
    }

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

    function primaryNode(address addr_) external view returns (bytes32) {
        return _primaryNode[addr_];
    }

    /// @notice Override the primary node for an address (owner only).
    ///         Pass node=0 to clear the primary. Reverts if node is non-zero and unregistered.
    function setPrimaryNode(address addr_, bytes32 node) external onlyOwner {
        if (node != bytes32(0) && _owners[node] == address(0)) revert Unauthorized();
        _primaryNode[addr_] = node;
    }

    /// @notice Allows a subdomain owner to set their own primary node.
    ///         Pass node=0 to clear. Reverts if node is non-zero and caller is not its owner.
    function setPrimaryNodeSelf(bytes32 node) external {
        if (node != bytes32(0) && _owners[node] != msg.sender) revert Unauthorized();
        _primaryNode[msg.sender] = node;
    }

    // ─── Write records ──────────────────────────────────────────────────────────
    //
    // @dev DESIGN: setAddr / setText / setContenthash are intentionally onlyOwner.
    //      Subdomain owners (tracked in _owners[node]) manage their records through
    //      the off-chain API gateway which holds the contract owner key. The gateway
    //      verifies the caller's EIP-712 signature against subnodeOwner(node) before
    //      forwarding the write. This avoids per-user on-chain tx costs while keeping
    //      the gateway accountable. Future: add an onlyOwnerOrSubnodeOwner modifier.

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

    // ─── Read records ───────────────────────────────────────────────────────────

    /// @dev Assembly explanation: see L2Records.addr() — same pattern, same correctness proof.
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

    function addr(bytes32 node, uint256 coinType) external view returns (bytes memory) {
        return _addrs[node][coinType];
    }

    function text(bytes32 node, string calldata key) external view returns (string memory) {
        return _texts[node][key];
    }

    function contenthash(bytes32 node) external view returns (bytes memory) {
        return _contenthashes[node];
    }

    // ─── Private helpers ────────────────────────────────────────────────────────

    function _registerNode(
        bytes32 parentNode,
        bytes32 labelhash,
        address newOwner,
        string calldata label
    ) private returns (bytes32 node) {
        if (newOwner == address(0)) revert ZeroAddress();
        bytes memory labelBytes = bytes(label);
        if (labelBytes.length == 0 || labelBytes.length > 63) revert InvalidLabel();
        if (labelhash != keccak256(labelBytes)) revert LabelMismatch();
        node = keccak256(abi.encodePacked(parentNode, labelhash));
        if (_owners[node] != address(0)) revert AlreadyRegistered();
        _owners[node] = newOwner;
        _names[node] = _encodeDnsName(label);
        if (_primaryNode[newOwner] == bytes32(0)) _primaryNode[newOwner] = node;
        emit SubnodeOwnerSet(parentNode, labelhash, node, newOwner);
        emit NameRegistered(node, parentNode, label, newOwner);
    }

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
