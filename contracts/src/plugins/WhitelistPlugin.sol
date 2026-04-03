// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import "../IRegistrarPlugin.sol";

/// @notice Registrar plugin that restricts registration to an owner-managed allowlist.
///         Fee is always 0.
contract WhitelistPlugin is ERC165, IRegistrarPlugin {
    address public immutable pluginOwner;

    /// @notice address => allowed to register
    mapping(address => bool) public allowlist;

    error NotAllowed();
    error Unauthorized();

    constructor(address owner_) {
        require(owner_ != address(0), "zero owner");
        pluginOwner = owner_;
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) public view virtual override(ERC165, IERC165) returns (bool) {
        bytes4 ifaceId = IRegistrarPlugin.canRegister.selector ^ IRegistrarPlugin.registrationFee.selector;
        return interfaceId == ifaceId || super.supportsInterface(interfaceId);
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
