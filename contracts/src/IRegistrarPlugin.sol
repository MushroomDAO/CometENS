// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Called by L2RecordsV3 before minting a subdomain.
/// @dev Implementations may enforce pricing, whitelists, token gating, etc.
interface IRegistrarPlugin {
    /// @notice Returns true if `requester` is allowed to register `label` under `parentNode`.
    ///         Reverts with a descriptive reason to block registration.
    /// @param parentNode The namehash of the parent domain.
    /// @param label      The plain-text label being registered.
    /// @param requester  The address requesting the registration.
    function canRegister(
        bytes32 parentNode,
        string calldata label,
        address requester
    ) external view returns (bool);

    /// @notice Returns the ETH fee required for this registration (may be 0).
    function registrationFee(
        bytes32 parentNode,
        string calldata label,
        address requester
    ) external view returns (uint256);
}
