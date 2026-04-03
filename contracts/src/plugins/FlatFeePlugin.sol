// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../IRegistrarPlugin.sol";

/// @notice Registrar plugin that charges a fixed ETH fee per registration.
///         Any address may register; the required fee is fixed at deploy time.
contract FlatFeePlugin is IRegistrarPlugin {
    uint256 public immutable fee;

    constructor(uint256 fee_) {
        fee = fee_;
    }

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
    ) external view override returns (uint256) {
        return fee;
    }
}
