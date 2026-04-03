// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../IRegistrarPlugin.sol";

/// @notice A no-op registrar plugin: anyone may register, fee is always 0.
contract FreePlugin is IRegistrarPlugin {
    /// @inheritdoc IRegistrarPlugin
    function canRegister(
        bytes32, /* parentNode */
        string calldata, /* label */
        address /* requester */
    ) external pure override returns (bool) {
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
