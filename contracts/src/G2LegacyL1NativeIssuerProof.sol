// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "./G2LegacyL1NativeActionGuard.sol";

interface INativeENSRegistryProof {
    function owner(bytes32 node) external view returns (address);
}

interface INativeNameWrapperProof {
    function getData(uint256 id) external view returns (address owner, uint32 fuses, uint64 expiry);
    function ownerOf(uint256 id) external view returns (address);
    function setSubnodeRecord(
        bytes32 parentNode,
        string calldata label,
        address owner,
        address resolver,
        uint64 ttl,
        uint32 fuses,
        uint64 expiry
    ) external returns (bytes32);
}

/// @notice L1-only *local proof* of atomic native ENSv1 issuance authority.
/// @dev Requires parent-holder authorization of this contract on NameWrapper.
///      NOT deployed, audited, ENSv2-compatible, or an OP issuance gateway.
contract G2LegacyL1NativeIssuerProof is G2LegacyL1NativeActionGuard {
    address public constant ENS_REGISTRY = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address public constant NAME_WRAPPER = 0x0635513f179D50A207757E05759CbD106d7dFcE8;
    uint32 public constant CANNOT_UNWRAP = 1;
    uint32 public constant PARENT_CANNOT_CONTROL = 1 << 16;

    error InvalidNativeIssue();
    error ParentNotLocked();
    error NativeIssueMismatch();

    event NativeChildIssued(bytes32 indexed node, address indexed member, uint64 expiry);

    constructor(address source, bytes32 expectedSourceHash, bytes32 expectedParent)
        G2LegacyL1NativeActionGuard(source, expectedSourceHash, expectedParent)
    {}

    /// @dev Authorization and native write happen in ONE L1 transaction.
    ///      The post-write recheck also rejects a parent transfer during an
    ///      external NameWrapper/recipient callback, reverting the entire write.
    function issueNative(string calldata label, address member, address resolver, uint64 expiry)
        external
        onlyCurrentLegacyNativeHolder
        returns (bytes32 node)
    {
        _validateLabel(label, member);
        (, uint64 validUntil) = nativeSource.currentAuthority();
        if (expiry <= block.timestamp || expiry > validUntil) revert InvalidNativeIssue();
        node = keccak256(abi.encodePacked(parentNode, keccak256(bytes(label))));
        _validateVacancy(node, expiry);

        if (
            INativeNameWrapperProof(NAME_WRAPPER)
                    .setSubnodeRecord(
                        parentNode, label, member, resolver, 0, CANNOT_UNWRAP | PARENT_CANNOT_CONTROL, expiry
                    ) != node
        ) revert NativeIssueMismatch();

        _requireCurrentLegacyNativeHolder();
        _validateIssuedChild(node, member, expiry);
        emit NativeChildIssued(node, member, expiry);
    }

    function _validateLabel(string calldata label, address member) private pure {
        bytes memory chars = bytes(label);
        if (member == address(0) || chars.length == 0 || chars.length > 63) revert InvalidNativeIssue();
        if (chars.length >= 4 && chars[2] == "-" && chars[3] == "-") revert InvalidNativeIssue();
        for (uint256 i; i < chars.length; ++i) {
            bytes1 c = chars[i];
            if (!((c >= "a" && c <= "z") || (c >= "0" && c <= "9") || (c == "-" && i > 0 && i + 1 < chars.length))) {
                revert InvalidNativeIssue();
            }
        }
    }

    function _validateVacancy(bytes32 node, uint64 expiry) private view {
        INativeNameWrapperProof wrapper = INativeNameWrapperProof(NAME_WRAPPER);
        (, uint32 parentFuses,) = wrapper.getData(uint256(parentNode));
        if ((parentFuses & CANNOT_UNWRAP) == 0) revert ParentNotLocked();
        (address existing,, uint64 residualExpiry) = wrapper.getData(uint256(node));
        if (
            existing != address(0) || residualExpiry > expiry
                || INativeENSRegistryProof(ENS_REGISTRY).owner(node) != address(0)
        ) {
            revert InvalidNativeIssue();
        }
    }

    function _validateIssuedChild(bytes32 node, address member, uint64 expiry) private view {
        INativeNameWrapperProof wrapper = INativeNameWrapperProof(NAME_WRAPPER);
        (address finalOwner, uint32 finalFuses, uint64 finalExpiry) = wrapper.getData(uint256(node));
        if (
            finalOwner != member || wrapper.ownerOf(uint256(node)) != member || finalExpiry != expiry
                || (finalFuses & (CANNOT_UNWRAP | PARENT_CANNOT_CONTROL)) != (CANNOT_UNWRAP | PARENT_CANNOT_CONTROL)
                || INativeENSRegistryProof(ENS_REGISTRY).owner(node) != NAME_WRAPPER
        ) revert NativeIssueMismatch();
    }
}
