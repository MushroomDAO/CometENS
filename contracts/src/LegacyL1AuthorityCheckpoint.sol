// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

interface ILegacyENSRegistry {
    function owner(bytes32 node) external view returns (address);
}

interface ILegacyNameWrapper {
    function ownerOf(uint256 id) external view returns (address);
    function getData(uint256 id) external view returns (address owner, uint32 fuses, uint64 expiry);
}

interface ILegacyBaseRegistrar {
    function ownerOf(uint256 labelId) external view returns (address);
    function nameExpires(uint256 labelId) external view returns (uint256);
}

/// @notice LEGACY ENSv1 .eth 2LD L1 checkpoint EVENT SOURCE ONLY.
/// @dev This contract never transmits a message or authorizes OP issuance.
///      Even a valid checkpoint has a nonzero L1-transfer-to-OP-delivery race.
contract LegacyL1AuthorityCheckpoint {
    uint256 public constant SOURCE_CHAIN_ID = 11155111;
    uint256 public constant DESTINATION_CHAIN_ID = 11155420;
    uint64 public constant MAX_LEASE = 2 hours;
    uint64 public constant EXPIRY_MARGIN = 24 hours;
    // Shape/version matches the separately reviewed OP inbox; NO relay is implemented here.
    bytes32 public constant AUTHORITY_VERSION = keccak256("COMETENS_G2_ROOT_CHECKPOINT_V1");
    bytes32 private constant ETH_NODE = 0x93cdeb708b7545dc668eb9280176169d4e3fc8d4018eea69e45fdc04d3da4a3d;

    address public constant ENS_REGISTRY = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address public constant NAME_WRAPPER = 0x0635513f179D50A207757E05759CbD106d7dFcE8;
    address public constant BASE_REGISTRAR = 0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85;

    struct RootCheckpoint {
        uint256 sourceChainId;
        uint256 destinationChainId;
        address sourceAdapter;
        address destinationInbox;
        bytes32 parentNode;
        address controller;
        uint64 sourceEpoch;
        uint64 sequence;
        uint64 leaseUntil;
        uint64 l1ValidUntil;
        bytes32 authorityVersion;
    }

    struct State {
        address nativeHolder;
        address controller;
        uint64 sourceEpoch;
        uint64 sequence;
        uint64 leaseUntil;
        uint64 l1ValidUntil;
    }

    error InvalidInput();
    error InvalidNativeAuthority();
    error Unauthorized();
    error InvalidLease();
    error ContractIdentityChanged();
    error WrongChain();
    error SequenceOverflow();

    event Checkpoint(RootCheckpoint checkpoint, bytes32 indexed reason);

    bytes32 public immutable parentNode;
    uint256 public immutable labelId;
    address public immutable destinationInbox;
    bytes32 public immutable registryRuntimeHash;
    bytes32 public immutable wrapperRuntimeHash;
    bytes32 public immutable registrarRuntimeHash;
    State public state;

    constructor(
        string memory parentLabel,
        address inbox,
        bytes32 expectedRegistryHash,
        bytes32 expectedWrapperHash,
        bytes32 expectedRegistrarHash
    ) {
        if (block.chainid != SOURCE_CHAIN_ID) revert WrongChain();
        if (
            inbox == address(0) || expectedRegistryHash == bytes32(0) || expectedWrapperHash == bytes32(0)
                || expectedRegistrarHash == bytes32(0)
        ) revert InvalidInput();
        bytes memory chars = bytes(parentLabel);
        if (chars.length == 0 || chars.length > 63 || chars[0] == "-" || chars[chars.length - 1] == "-") {
            revert InvalidInput();
        }
        for (uint256 i; i < chars.length; i++) {
            bytes1 c = chars[i];
            if (
                !((c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "-")
                    || (i == 2 && chars.length >= 4 && chars[2] == "-" && chars[3] == "-")
            ) {
                revert InvalidInput();
            }
        }
        labelId = uint256(keccak256(chars));
        parentNode = keccak256(abi.encodePacked(ETH_NODE, bytes32(labelId)));
        destinationInbox = inbox;
        registryRuntimeHash = expectedRegistryHash;
        wrapperRuntimeHash = expectedWrapperHash;
        registrarRuntimeHash = expectedRegistrarHash;
        _checkIdentity();
    }

    function _checkIdentity() internal view {
        if (block.chainid != SOURCE_CHAIN_ID) revert WrongChain();
        if (
            ENS_REGISTRY.codehash != registryRuntimeHash || NAME_WRAPPER.codehash != wrapperRuntimeHash
                || BASE_REGISTRAR.codehash != registrarRuntimeHash
        ) {
            revert ContractIdentityChanged();
        }
    }

    /// @notice Native wrapped holder and valid-until are re-read on L1 EXECUTION.
    /// @dev Wrapped custody is mandatory. The registrar's grace period is NEVER authority.
    function currentAuthority() public view returns (address holder, uint64 validUntil) {
        _checkIdentity();
        uint256 expiry = ILegacyBaseRegistrar(BASE_REGISTRAR).nameExpires(labelId);
        // Check registration expiry BEFORE ERC721 ownerOf, which can revert for
        // expired/burned tokens; public observeLoss must still be able to freeze.
        if (expiry <= block.timestamp + EXPIRY_MARGIN) return (address(0), 0);
        if (
            ILegacyENSRegistry(ENS_REGISTRY).owner(parentNode) != NAME_WRAPPER
                || ILegacyBaseRegistrar(BASE_REGISTRAR).ownerOf(labelId) != NAME_WRAPPER
        ) {
            return (address(0), 0);
        }
        (address dataOwner,, uint64 wrappedExpiry) = ILegacyNameWrapper(NAME_WRAPPER).getData(uint256(parentNode));
        holder = ILegacyNameWrapper(NAME_WRAPPER).ownerOf(uint256(parentNode));
        if (
            holder == address(0) || holder != dataOwner || expiry <= block.timestamp + EXPIRY_MARGIN
                || wrappedExpiry <= block.timestamp + EXPIRY_MARGIN
        ) {
            return (address(0), 0);
        }
        uint256 safeExpiry = expiry < wrappedExpiry ? expiry : wrappedExpiry;
        validUntil = uint64(safeExpiry - EXPIRY_MARGIN);
    }

    /// @dev Smart-account native holders can call directly. Approvals or relayer
    /// signatures are NOT accepted; this cannot become an offchain owner assertion.
    function bindOrRenew(address controller, uint64 requestedLease) external {
        (address holder, uint64 l1ValidUntil) = currentAuthority();
        if (holder == address(0)) revert InvalidNativeAuthority();
        if (holder != msg.sender) revert Unauthorized();
        if (controller == address(0)) revert InvalidInput();
        if (requestedLease == 0 || requestedLease > MAX_LEASE || block.timestamp + requestedLease > l1ValidUntil) {
            revert InvalidLease();
        }

        State memory previous = state;
        bool changed = previous.sourceEpoch == 0 || previous.nativeHolder != holder || previous.controller != controller
            || previous.controller == address(0);
        uint64 epoch = changed ? _next(previous.sourceEpoch) : previous.sourceEpoch;
        uint64 seq = _next(previous.sequence);
        uint64 until = uint64(block.timestamp + requestedLease);
        state = State(holder, controller, epoch, seq, until, l1ValidUntil);
        _emit(controller, epoch, seq, until, l1ValidUntil, keccak256("BIND_OR_RENEW"));
    }

    /// @notice Immediate L1 event-based cancellation by CURRENT native holder.
    /// @dev An OP lease is NOT automatically revoked by this event.
    function cancel() external {
        (address holder,) = currentAuthority();
        if (holder == address(0) || msg.sender != holder) revert Unauthorized();
        _freeze(keccak256("HOLDER_CANCEL"));
    }

    /// @notice Anyone may expose a known holder's loss/expiry on legacy L1.
    /// @dev A successful read when unchanged is a no-op: no sequence consumed.
    function observeLoss() external returns (bool frozen) {
        (address holder,) = currentAuthority();
        State memory prior = state;
        if (
            prior.controller != address(0) && prior.sourceEpoch != 0
                && (holder == address(0) || holder != prior.nativeHolder)
        ) {
            _freeze(keccak256("NATIVE_AUTHORITY_LOST"));
            return true;
        }
        return false;
    }

    function _freeze(bytes32 reason) internal {
        State memory prior = state;
        if (prior.controller == address(0)) revert InvalidInput();
        uint64 epoch = _next(prior.sourceEpoch);
        uint64 seq = _next(prior.sequence);
        // The original native holder is deliberately discarded.
        state = State(address(0), address(0), epoch, seq, 0, 0);
        _emit(address(0), epoch, seq, 0, 0, reason);
    }

    function _next(uint64 value) private pure returns (uint64) {
        if (value == type(uint64).max) revert SequenceOverflow();
        return value + 1;
    }

    function _emit(address controller, uint64 epoch, uint64 seq, uint64 until, uint64 validUntil, bytes32 reason)
        private
    {
        emit Checkpoint(
            RootCheckpoint(
                SOURCE_CHAIN_ID,
                DESTINATION_CHAIN_ID,
                address(this),
                destinationInbox,
                parentNode,
                controller,
                epoch,
                seq,
                until,
                validUntil,
                AUTHORITY_VERSION
            ),
            reason
        );
    }
}
