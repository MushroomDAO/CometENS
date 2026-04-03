// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../IRegistrarPlugin.sol";

/// @notice Registrar plugin that restricts registration to an owner-managed allowlist.
///         Fee is always 0.
contract WhitelistPlugin is IRegistrarPlugin {
    address public immutable pluginOwner;

    /// @notice address => allowed to register
    mapping(address => bool) public allowlist;

    error NotAllowed();
    error Unauthorized();

    constructor(address owner_) {
        require(owner_ != address(0), "zero owner");
        pluginOwner = owner_;
    }

    /// @notice Grant or revoke allowlist status for an address.
    function setAllowlist(address account, bool allowed) external {
        if (msg.sender != pluginOwner) revert Unauthorized();
        allowlist[account] = allowed;
    }

    /// @inheritdoc IRegistrarPlugin
    function canRegister(
        bytes32, /* parentNode */
        string calldata, /* label */
        address requester
    ) external view override returns (bool) {
        if (!allowlist[requester]) revert NotAllowed();
        return true;
    }

    /// @inheritdoc IRegistrarPlugin
    function registrationFee(
        bytes32, /* parentNode */
        string calldata, /* label */
        address /* requester */
    ) external pure override returns (uint256) {
        return 0;
    }
}
