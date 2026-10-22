// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

interface INativeResultOPMessenger {
    function xDomainMessageSender() external view returns (address);
}

/// @notice OP request queue and authenticated L1-result observation for ONE parent.
/// @dev Results are PROVISIONAL: this never mints, grants, resolves, or proves
///      finalized L1 ownership. The future L1 emitter must be independently audited.
contract G2NativeIssueResultInbox {
    uint256 public constant OP_CHAIN_ID = 11155420;
    uint256 public constant L1_CHAIN_ID = 11155111;
    address public constant OP_MESSENGER = 0x4200000000000000000000000000000000000007;
    bytes32 public constant VERSION = keccak256("COMETENS_G2_NATIVE_RESULT_V1");
    bool public constant sovereignReceipt = false;
    bool public constant currentL1AuthorityVerified = false;
    bool public constant finalizedL1IssuanceVerified = false;

    bytes32 public immutable parentNode;
    address public immutable l1ResultEmitter;

    enum Status { NONE, PENDING, CANCELLED, OBSERVED }

    struct Request {
        address requester;
        bytes32 childNode;
        address member;
        uint64 expiry;
        uint256 nonce;
        Status status;
        uint64 observedSourceBlock;
    }

    struct NativeIssueResult {
        uint256 sourceChainId;
        uint256 destinationChainId;
        address sourceEmitter;
        address destinationInbox;
        bytes32 parentNode;
        bytes32 requestId;
        bytes32 childNode;
        address requester;
        address member;
        uint64 expiry;
        uint256 nonce;
        uint64 sourceBlockNumber;
        bytes32 version;
    }

    mapping(address => uint256) public nextNonce;
    mapping(bytes32 => Request) public requests;

    error InvalidConfiguration();
    error InvalidRequest();
    error UnauthorizedMessenger();
    error InvalidResult();

    event IssueRequested(
        bytes32 indexed requestId, address indexed requester, bytes32 indexed childNode,
        address member, uint64 expiry, uint256 nonce
    );
    event IssueCancelled(bytes32 indexed requestId);
    event NativeResultObserved(bytes32 indexed requestId, bytes32 indexed childNode, uint64 sourceBlockNumber);

    constructor(bytes32 parent, address emitter) {
        if (block.chainid != OP_CHAIN_ID || parent == bytes32(0) || emitter == address(0)) {
            revert InvalidConfiguration();
        }
        parentNode = parent;
        l1ResultEmitter = emitter;
    }

    /// @notice Application intent only. Does not establish L1 holder consent.
    function queueIssue(string calldata childLabel, address member, uint64 expiry)
        external returns (bytes32 requestId)
    {
        bytes memory chars = bytes(childLabel);
        if (
            block.chainid != OP_CHAIN_ID || member == address(0) || expiry <= block.timestamp
                || chars.length == 0 || chars.length > 63
        ) revert InvalidRequest();
        if (chars.length >= 4 && chars[2] == "-" && chars[3] == "-") revert InvalidRequest();
        for (uint256 i; i < chars.length; ++i) {
            bytes1 c = chars[i];
            if (!((c >= "a" && c <= "z") || (c >= "0" && c <= "9") ||
                (c == "-" && i > 0 && i + 1 < chars.length))) revert InvalidRequest();
        }
        bytes32 childNode = keccak256(abi.encodePacked(parentNode, keccak256(chars)));

        uint256 nonce = ++nextNonce[msg.sender];
        requestId = _id(msg.sender, childNode, member, expiry, nonce);
        requests[requestId] = Request({
            requester: msg.sender, childNode: childNode, member: member, expiry: expiry,
            nonce: nonce, status: Status.PENDING, observedSourceBlock: 0
        });
        emit IssueRequested(requestId, msg.sender, childNode, member, expiry, nonce);
    }

    function cancelIssue(bytes32 requestId) external {
        Request storage r = requests[requestId];
        if (block.chainid != OP_CHAIN_ID || r.requester != msg.sender || r.status != Status.PENDING) {
            revert InvalidRequest();
        }
        r.status = Status.CANCELLED;
        emit IssueCancelled(requestId);
    }

    /// @notice Canonical messenger source identity, not source finality.
    ///         A valid L1 result might arrive on OP before L1 finalization.
    function observeResult(NativeIssueResult calldata result) external {
        if (
            msg.sender != OP_MESSENGER
                || INativeResultOPMessenger(OP_MESSENGER).xDomainMessageSender() != l1ResultEmitter
        ) revert UnauthorizedMessenger();

        Request storage r = requests[result.requestId];
        if (
            block.chainid != OP_CHAIN_ID || result.version != VERSION
                || result.sourceChainId != L1_CHAIN_ID || result.destinationChainId != OP_CHAIN_ID
                || result.sourceEmitter != l1ResultEmitter || result.destinationInbox != address(this)
                || result.parentNode != parentNode || result.sourceBlockNumber == 0
                || r.status != Status.PENDING || r.requester != result.requester
                || r.childNode != result.childNode || r.member != result.member
                || r.expiry != result.expiry || r.nonce != result.nonce
                || result.requestId != _id(r.requester, r.childNode, r.member, r.expiry, r.nonce)
        ) revert InvalidResult();

        // No native rights are granted, even when the source message authenticates.
        r.status = Status.OBSERVED;
        r.observedSourceBlock = result.sourceBlockNumber;
        emit NativeResultObserved(result.requestId, r.childNode, result.sourceBlockNumber);
    }

    function _id(address requester, bytes32 childNode, address member, uint64 expiry, uint256 nonce)
        private view returns (bytes32)
    {
        return keccak256(abi.encode(
            VERSION, L1_CHAIN_ID, OP_CHAIN_ID, l1ResultEmitter, address(this),
            parentNode, requester, childNode, member, expiry, nonce
        ));
    }
}
