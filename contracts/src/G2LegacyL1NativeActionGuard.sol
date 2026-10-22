// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "./LegacyL1AuthorityCheckpoint.sol";

/// @notice Reusable *L1-only* guard for a future native ENSv1 action executor.
/// @dev NOT an OP issuance gate, migration oracle, native mint, or G2.4 proof.
///      A consumer must apply this at the actual L1 action entrypoint.
abstract contract G2LegacyL1NativeActionGuard {
    uint256 public constant LEGACY_L1_CHAIN_ID = 11155111;

    LegacyL1AuthorityCheckpoint public immutable nativeSource;
    bytes32 public immutable sourceRuntimeHash;
    bytes32 public immutable parentNode;

    error WrongChain();
    error InvalidNativeSource();
    error NotCurrentNativeHolder();

    constructor(address source, bytes32 expectedSourceHash, bytes32 expectedParent) {
        if (source == address(0) || expectedSourceHash == bytes32(0) || expectedParent == bytes32(0)) {
            revert InvalidNativeSource();
        }
        nativeSource = LegacyL1AuthorityCheckpoint(source);
        sourceRuntimeHash = expectedSourceHash;
        parentNode = expectedParent;
        // The same _verifySource check also guards every executed native action.
        _verifySource();
    }

    modifier onlyCurrentLegacyNativeHolder() {
        _requireCurrentLegacyNativeHolder();
        _;
    }

    /// @dev Must be called inside the L1 executor transaction by its owner,
    /// not offchain beforehand or on OP using a cached source checkpoint.
    function _requireCurrentLegacyNativeHolder() internal view {
        _verifySource();
        (address holder, uint64 validUntil) = nativeSource.currentAuthority();
        if (holder == address(0) || holder != msg.sender || validUntil <= block.timestamp) {
            revert NotCurrentNativeHolder();
        }
    }

    function _verifySource() private view {
        if (block.chainid != LEGACY_L1_CHAIN_ID) revert WrongChain();
        if (
            address(nativeSource).codehash != sourceRuntimeHash || nativeSource.parentNode() != parentNode
                || nativeSource.SOURCE_CHAIN_ID() != LEGACY_L1_CHAIN_ID
        ) revert InvalidNativeSource();
    }
}
