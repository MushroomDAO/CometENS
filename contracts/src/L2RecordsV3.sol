// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import "./IRegistrarPlugin.sol";

/// @title L2Records V3
/// @notice Extends V2 functionality with ERC-721 subdomain ownership.
///         Each registered subdomain node maps 1:1 to an NFT token (tokenId = uint256(node)).
///         Transferring the NFT transfers subdomain ownership automatically.
///         V2 private mappings are reproduced here since Solidity does not expose private state
///         to child contracts; all V2 semantics are preserved verbatim.
contract L2RecordsV3 is ERC721, ReentrancyGuard {
    address public owner;

    // node => coinType => address bytes
    mapping(bytes32 => mapping(uint256 => bytes)) private _addrs;
    // node => key => value
    mapping(bytes32 => mapping(string => string)) private _texts;
    // node => contenthash bytes
    mapping(bytes32 => bytes) private _contenthashes;
    // node => DNS-encoded leaf name (e.g. "\x05alice\x00")
    mapping(bytes32 => bytes) private _names;
    // address => primary node
    mapping(address => bytes32) private _primaryNode;

    // ─── V2: Registrar model ────────────────────────────────────────────────────

    /// @notice parentNode => registrar address => is active
    mapping(bytes32 => mapping(address => bool)) private _registrars;

    /// @notice parentNode => registrar address => remaining quota
    mapping(bytes32 => mapping(address => uint256)) public registrarQuota;

    /// @notice parentNode => registrar address => expiry timestamp (0 = no expiry)
    mapping(bytes32 => mapping(address => uint256)) public registrarExpiry;

    // ─── V3: Plugin model ───────────────────────────────────────────────────────

    /// @notice parentNode => active IRegistrarPlugin (address(0) = no plugin, use registrar auth)
    mapping(bytes32 => IRegistrarPlugin) public registrarPlugin;

    /// @notice Pull-payment escrow: address => claimable ETH from plugin fees.
    ///         Using pull-payment prevents non-payable parentOwner contracts from
    ///         bricking registrations (push ETH would revert the whole tx).
    mapping(address => uint256) public pendingFees;

    // ─── Events ────────────────────────────────────────────────────────────────

    event AddrSet(bytes32 indexed node, uint256 coinType, bytes addr);
    event TextSet(bytes32 indexed node, string indexed key, string value);
    event ContenthashSet(bytes32 indexed node, bytes contenthash);
    event SubnodeOwnerSet(bytes32 indexed parentNode, bytes32 indexed labelhash, bytes32 indexed node, address subnodeOwner);
    event NameRegistered(bytes32 indexed node, bytes32 indexed parentNode, string label, address newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event RegistrarAdded(bytes32 indexed parentNode, address indexed registrar, uint256 quota, uint256 expiry);
    event RegistrarRemoved(bytes32 indexed parentNode, address indexed registrar);
    event RegistrarQuotaUpdated(bytes32 indexed parentNode, address indexed registrar, uint256 newQuota);
    event PluginSet(bytes32 indexed parentNode, address indexed plugin);
    event FeeAccrued(address indexed recipient, uint256 amount);
    event FeeWithdrawn(address indexed recipient, uint256 amount);

    // ─── Errors ─────────────────────────────────────────────────────────────────

    error Unauthorized();
    error ZeroAddress();
    error InvalidLabel();
    error InvalidAddrBytes();
    error AlreadyRegistered();
    error QuotaExceeded();
    error RegistrarExpired();
    error LabelMismatch();
    error PluginRejected();
    error InsufficientFee();
    error InvalidPlugin();

    // ─── Modifiers ───────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyOwnerOrRegistrar(bytes32 parentNode) {
        if (msg.sender != owner) {
            if (!_registrars[parentNode][msg.sender]) revert Unauthorized();
            uint256 exp = registrarExpiry[parentNode][msg.sender];
            if (exp != 0 && block.timestamp > exp) revert RegistrarExpired();
        }
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────────────

    constructor(address _owner) ERC721("L2RecordsV3 Subdomain", "L2R3") {
        if (_owner == address(0)) revert ZeroAddress();
        owner = _owner;
        emit OwnershipTransferred(address(0), _owner);
    }

    // ─── Ownership ───────────────────────────────────────────────────────────────

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ─── Pull-payment fee withdrawal ──────────────────────────────────────────

    /// @notice Withdraw accrued plugin fees for msg.sender.
    ///         Called by parentNode NFT owners after registrations with a fee plugin.
    function withdrawFees() external {
        uint256 amount = pendingFees[msg.sender];
        if (amount == 0) return;
        pendingFees[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "withdraw failed");
        emit FeeWithdrawn(msg.sender, amount);
    }

    // ─── V2: Registrar Management (Owner Only) ──────────────────────────────────

    /// @notice Add a registrar for a specific parent domain
    function addRegistrar(
        bytes32 parentNode,
        address registrar,
        uint256 quota,
        uint256 expiry
    ) external onlyOwner {
        if (registrar == address(0)) revert ZeroAddress();

        _registrars[parentNode][registrar] = true;
        uint256 storedQuota = quota == 0 ? type(uint256).max : quota;
        registrarQuota[parentNode][registrar] = storedQuota;
        registrarExpiry[parentNode][registrar] = expiry;

        emit RegistrarAdded(parentNode, registrar, storedQuota, expiry);
    }

    /// @notice Remove a registrar
    function removeRegistrar(bytes32 parentNode, address registrar) external onlyOwner {
        delete _registrars[parentNode][registrar];
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
        if (!_registrars[parentNode][registrar]) revert Unauthorized();
        uint256 exp = registrarExpiry[parentNode][registrar];
        if (exp != 0 && block.timestamp > exp) revert RegistrarExpired();
        uint256 stored = newQuota == 0 ? type(uint256).max : newQuota;
        registrarQuota[parentNode][registrar] = stored;
        emit RegistrarQuotaUpdated(parentNode, registrar, stored);
    }

    /// @notice Check if an address is an active registrar for a parent domain
    function isRegistrar(bytes32 parentNode, address addr_) external view returns (bool) {
        if (!_registrars[parentNode][addr_]) return false;
        uint256 expiry = registrarExpiry[parentNode][addr_];
        if (expiry != 0 && block.timestamp > expiry) return false;
        return true;
    }

    /// @notice Get registrar info. remainingQuota = type(uint256).max means unlimited.
    function getRegistrarInfo(bytes32 parentNode, address registrar) external view returns (
        bool isActive,
        uint256 remainingQuota,
        uint256 expiry
    ) {
        isActive = _registrars[parentNode][registrar];
        remainingQuota = registrarQuota[parentNode][registrar];
        expiry = registrarExpiry[parentNode][registrar];
        if (expiry != 0 && block.timestamp > expiry) isActive = false;
    }

    // ─── V3: Plugin Management ──────────────────────────────────────────────────

    /// @notice Attach a registrar plugin to a parent domain.
    ///         Only the parent domain's NFT owner (or the contract owner) may call this.
    ///         Pass plugin=address(0) to remove an existing plugin.
    /// @param parentNode The namehash of the parent domain.
    /// @param plugin     The IRegistrarPlugin implementation to attach.
    function setPlugin(bytes32 parentNode, IRegistrarPlugin plugin) external {
        // Contract owner may set a plugin on any parentNode.
        // Otherwise, the caller must own the parentNode NFT.
        if (msg.sender != owner) {
            address parentOwner = _ownerOf(uint256(parentNode));
            if (parentOwner == address(0) || parentOwner != msg.sender) revert Unauthorized();
        }
        // If a non-zero plugin address is provided, verify it implements IRegistrarPlugin.
        // Code-size check guards against EOAs; the ERC-165 call guards against incompatible contracts.
        // Using type(IRegistrarPlugin).interfaceId is the canonical Solidity approach — it equals
        // the XOR of selectors defined directly in IRegistrarPlugin (canRegister ^ registrationFee),
        // excluding inherited IERC165 functions. This avoids manual XOR and is consistent with
        // how plugin implementations should compute their own interfaceId.
        if (address(plugin) != address(0)) {
            uint256 codeSize;
            assembly { codeSize := extcodesize(plugin) }
            if (codeSize == 0) revert InvalidPlugin();
            try IERC165(address(plugin)).supportsInterface(type(IRegistrarPlugin).interfaceId) returns (bool supported) {
                if (!supported) revert InvalidPlugin();
            } catch {
                revert InvalidPlugin();
            }
        }
        registrarPlugin[parentNode] = plugin;
        emit PluginSet(parentNode, address(plugin));
    }

    // ─── Subdomain Registration ─────────────────────────────────────────────────

    /// @notice Register a subdomain (Owner or authorized Registrar).
    ///         If a plugin is set on parentNode, the plugin's canRegister() is consulted.
    function setSubnodeOwner(
        bytes32 parentNode,
        bytes32 labelhash,
        address newOwner,
        string calldata label
    ) external nonReentrant onlyOwnerOrRegistrar(parentNode) {
        _checkRegistrarQuota(parentNode);
        _checkPlugin(parentNode, label, newOwner);
        _registerNode(parentNode, labelhash, newOwner, label);
    }

    /// @notice Atomically register a subdomain and set its ETH address record.
    ///         If a plugin is set on parentNode, plugin fees and canRegister() are enforced.
    ///         Any ETH in excess of the plugin fee is forwarded to the parentNode NFT owner.
    function registerSubnode(
        bytes32 parentNode,
        bytes32 labelhash,
        address newOwner,
        string calldata label,
        bytes calldata addrBytes
    ) external payable nonReentrant onlyOwnerOrRegistrar(parentNode) {
        if (addrBytes.length != 20) revert InvalidAddrBytes();
        _checkRegistrarQuota(parentNode);
        _checkPluginWithFee(parentNode, label, newOwner);
        bytes32 node = _registerNode(parentNode, labelhash, newOwner, label);
        _addrs[node][60] = addrBytes;
        emit AddrSet(node, 60, addrBytes);
    }

    /// @notice Internal: check and decrement registrar quota.
    function _checkRegistrarQuota(bytes32 parentNode) internal {
        if (msg.sender != owner) {
            uint256 quota = registrarQuota[parentNode][msg.sender];
            if (quota != type(uint256).max) {
                if (quota == 0) revert QuotaExceeded();
                registrarQuota[parentNode][msg.sender] = quota - 1;
            }
        }
    }

    /// @notice Internal: consult the plugin's canRegister (no fee enforcement).
    ///         Used by setSubnodeOwner where msg.value is not available.
    function _checkPlugin(bytes32 parentNode, string calldata label, address requester) internal view {
        IRegistrarPlugin plugin = registrarPlugin[parentNode];
        if (address(plugin) == address(0)) return;
        if (!plugin.canRegister(parentNode, label, requester)) revert PluginRejected();
    }

    error UnexpectedValue();

    /// @notice Internal: consult the plugin's canRegister and enforce fee.
    ///         Reverts if msg.value is non-zero but no fee is required (prevents ETH lock-up).
    ///         Excess ETH above the required fee is refunded to the caller.
    function _checkPluginWithFee(bytes32 parentNode, string calldata label, address requester) internal {
        IRegistrarPlugin plugin = registrarPlugin[parentNode];
        if (address(plugin) == address(0)) {
            // No plugin: no fee expected. Reject any ETH to prevent lock-up.
            if (msg.value > 0) revert UnexpectedValue();
            return;
        }
        if (!plugin.canRegister(parentNode, label, requester)) revert PluginRejected();
        uint256 fee = plugin.registrationFee(parentNode, label, requester);
        if (fee == 0) {
            // Plugin allows free registration: reject any ETH to prevent lock-up.
            if (msg.value > 0) revert UnexpectedValue();
            return;
        }
        if (msg.value < fee) revert InsufficientFee();
        // Pull-payment: accrue fee to the parentNode NFT owner rather than pushing ETH.
        // This avoids reverting when the parentOwner is a non-payable contract, which would
        // otherwise brick all registrations under that domain permanently.
        address parentOwner = _ownerOf(uint256(parentNode));
        if (parentOwner != address(0)) {
            pendingFees[parentOwner] += fee;
            emit FeeAccrued(parentOwner, fee);
        }
        // Refund excess ETH to the caller immediately.
        uint256 excess = msg.value - fee;
        if (excess > 0) {
            (bool ok,) = msg.sender.call{value: excess}("");
            require(ok, "refund failed");
        }
    }

    // ─── V3: NFT-based ownership ─────────────────────────────────────────────────

    /// @notice Returns the subdomain owner by reading the NFT owner.
    ///         Returns address(0) if the token has not been minted.
    function subnodeOwner(bytes32 node) external view returns (address) {
        return _ownerOf(uint256(node));
    }

    /// @notice Transfer a subdomain NFT on behalf of its owner.
    ///         Called by the contract owner (Worker EOA) after verifying an EIP-712
    ///         TransferSubnode signature off-chain. Standard ERC-721 transferFrom
    ///         requires msg.sender == owner or approved; this gateway path delegates
    ///         that authority to the contract owner, who has verified the user's intent
    ///         cryptographically before calling.
    /// @param node The namehash (= tokenId) of the subdomain to transfer.
    /// @param from Current owner — must match ownerOf(tokenId) or call reverts.
    /// @param to   New owner.
    function transferSubnodeByGateway(bytes32 node, address from, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        _transfer(from, to, uint256(node));
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
    function setPrimaryNode(address addr_, bytes32 node) external onlyOwner {
        if (node != bytes32(0) && _ownerOf(uint256(node)) == address(0)) revert Unauthorized();
        _primaryNode[addr_] = node;
    }

    /// @notice Allows a subdomain owner to set their own primary node.
    function setPrimaryNodeSelf(bytes32 node) external {
        if (node != bytes32(0) && ownerOf(uint256(node)) != msg.sender) revert Unauthorized();
        _primaryNode[msg.sender] = node;
    }

    // ─── Write records ───────────────────────────────────────────────────────────
    //
    // V3: setAddr / setText / setContenthash allow the NFT owner (subnodeOwner) to call directly,
    // in addition to the contract owner. This enables true on-chain self-sovereign record management.

    /// @dev For coinType 60 (ETH), addrBytes must be exactly 20 bytes or empty (clear).
    function setAddr(bytes32 node, uint256 coinType, bytes calldata addrBytes) external {
        _requireNodeAuth(node);
        if (coinType == 60 && addrBytes.length != 0 && addrBytes.length != 20) revert InvalidAddrBytes();
        _addrs[node][coinType] = addrBytes;
        emit AddrSet(node, coinType, addrBytes);
    }

    function setText(bytes32 node, string calldata key, string calldata value) external {
        _requireNodeAuth(node);
        _texts[node][key] = value;
        emit TextSet(node, key, value);
    }

    function setContenthash(bytes32 node, bytes calldata hash) external {
        _requireNodeAuth(node);
        _contenthashes[node] = hash;
        emit ContenthashSet(node, hash);
    }

    // ─── Read records ────────────────────────────────────────────────────────────

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

    // ─── Private helpers ─────────────────────────────────────────────────────────

    /// @dev Authorize: contract owner OR current NFT owner of the node.
    function _requireNodeAuth(bytes32 node) internal view {
        if (msg.sender == owner) return;
        uint256 tokenId = uint256(node);
        address nftOwner = _ownerOf(tokenId);
        if (nftOwner == address(0) || nftOwner != msg.sender) revert Unauthorized();
    }

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
        // AlreadyRegistered: token must not already exist
        if (_ownerOf(uint256(node)) != address(0)) revert AlreadyRegistered();
        _names[node] = _encodeDnsName(label);
        if (_primaryNode[newOwner] == bytes32(0)) _primaryNode[newOwner] = node;
        // Mint the NFT — this is the canonical ownership record
        _mint(newOwner, uint256(node));
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
