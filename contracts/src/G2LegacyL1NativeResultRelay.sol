// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "./G2LegacyL1NativeIssuerProof.sol";
import "./G2NativeIssueResultInbox.sol";

interface IL1NativeResultMessenger {
    function sendMessage(address target, bytes calldata message, uint32 minGasLimit) external;
}

/// @notice Local L1 proof of atomic native ENSv1 issue + request-bound OP relay.
/// @dev The canonical L1 Messenger, real deployment and L1/OP finality are NOT
///      provided by this prototype. OP only records provisional OBSERVED.
contract G2LegacyL1NativeResultRelay is G2LegacyL1NativeIssuerProof {
    uint256 public constant L1_CHAIN_ID = 11155111;
    uint256 public constant OP_CHAIN_ID = 11155420;
    uint32 public constant MIN_GAS = 250_000;
    uint32 public constant MAX_GAS = 2_000_000;
    bytes32 public constant MESSAGE_VERSION = keccak256("COMETENS_G2_NATIVE_RESULT_V1");

    address public immutable l1Messenger;
    address public immutable destinationInbox;
    bytes32 public immutable messengerRuntimeHash;
    mapping(bytes32 => bool) public sentRequest;

    error InvalidRelayConfiguration();
    error InvalidRelayRequest();
    error RelayIdentityChanged();

    event NativeIssueResultSent(
        bytes32 indexed requestId, bytes32 indexed childNode, address indexed member,
        uint64 sourceBlockNumber
    );

    constructor(
        address source,
        bytes32 sourceHash,
        bytes32 parent,
        address messenger,
        bytes32 messengerHash,
        address destination
    ) G2LegacyL1NativeIssuerProof(source, sourceHash, parent) {
        if (
            block.chainid != L1_CHAIN_ID || messenger == address(0) || destination == address(0)
                || messengerHash == bytes32(0) || messenger.codehash != messengerHash
        ) revert InvalidRelayConfiguration();
        l1Messenger = messenger;
        messengerRuntimeHash = messengerHash;
        destinationInbox = destination;
    }

    /// @notice Native L1 holder alone authorizes the real issuance.
    /// Requester/nonce bind its result to one preexisting OP queued intent;
    /// providing an OP request ID is not proof of native holder consent.
    function issueAndRelay(
        string calldata label,
        address member,
        address resolver,
        uint64 expiry,
        address opRequester,
        uint256 requestNonce,
        uint32 minGasLimit
    ) external onlyCurrentLegacyNativeHolder returns (bytes32 requestId) {
        if (
            block.chainid != L1_CHAIN_ID || l1Messenger.codehash != messengerRuntimeHash
        ) revert RelayIdentityChanged();
        if (
            opRequester == address(0) || requestNonce == 0 || minGasLimit < MIN_GAS ||
                minGasLimit > MAX_GAS || block.number > type(uint64).max
        ) revert InvalidRelayRequest();

        bytes32 childNode = keccak256(abi.encodePacked(parentNode, keccak256(bytes(label))));
        requestId = keccak256(abi.encode(
            MESSAGE_VERSION, L1_CHAIN_ID, OP_CHAIN_ID, address(this), destinationInbox,
            parentNode, opRequester, childNode, member, expiry, requestNonce
        ));
        if (sentRequest[requestId]) revert InvalidRelayRequest();
        sentRequest[requestId] = true; // CEI before native callbacks or L1 messenger.

        if (_issueNative(label, member, resolver, expiry) != childNode) revert InvalidRelayRequest();
        G2NativeIssueResultInbox.NativeIssueResult memory result = G2NativeIssueResultInbox.NativeIssueResult({
            sourceChainId: L1_CHAIN_ID,
            destinationChainId: OP_CHAIN_ID,
            sourceEmitter: address(this),
            destinationInbox: destinationInbox,
            parentNode: parentNode,
            requestId: requestId,
            childNode: childNode,
            requester: opRequester,
            member: member,
            expiry: expiry,
            nonce: requestNonce,
            sourceBlockNumber: uint64(block.number),
            version: MESSAGE_VERSION
        });

        IL1NativeResultMessenger(l1Messenger).sendMessage(
            destinationInbox,
            abi.encodeCall(G2NativeIssueResultInbox.observeResult, (result)),
            minGasLimit
        );
        // Messenger callback/reentrancy must not transfer the parent mid-issue.
        _requireCurrentLegacyNativeHolder();
        emit NativeIssueResultSent(requestId, childNode, member, uint64(block.number));
    }
}
