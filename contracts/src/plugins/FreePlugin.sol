// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import "../IRegistrarPlugin.sol";

/// @notice A no-op registrar plugin: anyone may register, fee is always 0.
contract FreePlugin is ERC165, IRegistrarPlugin {
    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) public view virtual override(ERC165, IERC165) returns (bool) {
        bytes4 ifaceId = type(IRegistrarPlugin).interfaceId;
        return interfaceId == ifaceId || super.supportsInterface(interfaceId);
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
    ) external pure override returns (uint256) {
        return 0;
    }
}
