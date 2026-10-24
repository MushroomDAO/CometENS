// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/// @notice ENSv2 PermissionedRegistry ABI subset; see docs.ens.domains/ensv2/permissioned-registry.
interface IG2Ensv2Registry {
    struct State {
        uint8 status;
        uint64 expiry;
        address latestOwner;
        uint256 tokenId;
        uint256 resource;
    }
    function getState(uint256 anyId) external view returns (State memory);
    function getSubregistry(string calldata label) external view returns (address);
    function hasRootRoles(uint256 roleBitmap, address account) external view returns (bool);
    function register(
        string calldata label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry
    ) external returns (uint256 tokenId);
}

/// @notice Experimental same-transaction L1 gate for direct ENSv2 registries.
/// @dev NOT a sovereign receipt. Cannot prohibit parent root-role/upgrade governance.
///      Parent owner must explicitly grant this contract ROLE_REGISTRAR on child ROOT_RESOURCE.
contract G2Ensv2AtomicSubnameProof {
    uint256 public constant L1_SEPOLIA = 11155111;
    uint256 private constant ROLE_REGISTRAR = 1;
    uint256 private constant ROLE_SET_RESOLVER = 1 << 24;
    uint256 private constant ROLE_SET_SUBREGISTRY = 1 << 20;
    uint256 private constant ROLE_CAN_TRANSFER_ADMIN = uint256(1) << 156;

    IG2Ensv2Registry public immutable ethRegistry;
    IG2Ensv2Registry public immutable childRegistry;
    uint256 public immutable parentLabelhash;
    bytes32 public immutable ethRegistryHash;
    bytes32 public immutable childRegistryHash;

    error InvalidAuthority();
    error InvalidIssuance();
    event NativeCandidate(uint256 indexed tokenId, address indexed member);

    constructor(address eth, address child, string memory parentLabel) {
        if (block.chainid != L1_SEPOLIA || eth == address(0) || child == address(0)
            || eth == child || bytes(parentLabel).length == 0 || eth.code.length == 0 || child.code.length == 0)
            revert InvalidAuthority();
        ethRegistry = IG2Ensv2Registry(eth);
        childRegistry = IG2Ensv2Registry(child);
        parentLabelhash = uint256(keccak256(bytes(parentLabel)));
        ethRegistryHash = eth.codehash;
        childRegistryHash = child.codehash;
        _label = parentLabel;
    }

    function _requireHolder(address holder) internal view returns (uint64 parentExpiry) {
        if (block.chainid != L1_SEPOLIA || address(ethRegistry).codehash != ethRegistryHash
            || address(childRegistry).codehash != childRegistryHash
            || ethRegistry.getSubregistry(_parentLabel()) != address(childRegistry))
            revert InvalidAuthority();
        IG2Ensv2Registry.State memory parent = ethRegistry.getState(parentLabelhash);
        if (parent.status != 2 || parent.latestOwner != holder || holder == address(0)
            || parent.expiry <= block.timestamp || parent.resource == 0)
            revert InvalidAuthority();
        if (!childRegistry.hasRootRoles(ROLE_REGISTRAR, address(this))) revert InvalidAuthority();
        return parent.expiry;
    }

    // The label is held as immutable calldata-independent text for pointer validation.
    string private _label;

    function _parentLabel() private view returns (string memory) {
        return _label;
    }

    function issue(string calldata label, address member, address resolver, uint64 expiry)
        external returns (uint256 tokenId)
    {
        uint64 parentExpiry = _requireHolder(msg.sender);
        if (member == address(0) || resolver == address(0) || expiry <= block.timestamp
            || expiry > parentExpiry || bytes(label).length == 0)
            revert InvalidIssuance();
        uint256 id = uint256(keccak256(bytes(label)));
        if (childRegistry.getState(id).status != 0) revert InvalidIssuance();
        tokenId = childRegistry.register(
            label, member, address(0), resolver,
            ROLE_SET_RESOLVER | ROLE_SET_SUBREGISTRY | ROLE_CAN_TRANSFER_ADMIN, expiry
        );
        _requireHolder(msg.sender); // Callback or external registry side effects cannot steal authority.
        IG2Ensv2Registry.State memory minted = childRegistry.getState(id);
        if (minted.status != 2 || minted.latestOwner != member || minted.expiry != expiry
            || minted.tokenId != tokenId) revert InvalidIssuance();
        emit NativeCandidate(tokenId, member);
    }
}
