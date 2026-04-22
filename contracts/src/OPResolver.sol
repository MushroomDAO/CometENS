// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title OPResolver
/// @notice EIP-3668 CCIP-Read resolver for ENS names backed by Optimism Bedrock
///         storage proofs (Milestone C1 scaffold).
///
///         When `verifyProofs` is false (default), the resolver behaves identically
///         to OffchainResolver — it verifies a gateway signature (EIP-3668 §4.1).
///
///         When `verifyProofs` is true, `resolveWithProof` decodes a
///         `(bytes result, bytes proof)` response and will verify the proof
///         against the OP state root committed on L1 (TODO: C2 implementation).
///
///         This toggle lets C1 be deployed and exercised without breaking any
///         existing flows; C2 will complete the proof-verification path.
contract OPResolver {
    address public owner;
    mapping(address => bool) public signers;
    string public gatewayUrl;

    /// @notice When true, resolveWithProof expects a storage proof instead of
    ///         a gateway signature.  Set to false at construction time so that
    ///         the contract is fully functional from day one.
    bool public verifyProofs;

    // ─── Errors ───────────────────────────────────────────────────────────────

    error OffchainLookup(
        address sender,
        string[] urls,
        bytes callData,
        bytes4 callbackFunction,
        bytes extraData
    );
    error Unauthorized();
    error InvalidSigner();
    error InvalidSignatureLength();
    error SignatureExpired();
    error ZeroAddress();
    /// @notice Raised when proof mode is enabled but proof verification is not
    ///         yet implemented (C2 milestone).
    error ProofVerificationNotImplemented();

    // ─── Events ───────────────────────────────────────────────────────────────

    event SignerAdded(address indexed signer);
    event SignerRemoved(address indexed signer);
    event GatewayUrlUpdated(string previous, string next);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event VerifyProofsToggled(bool enabled);

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────────────

    /// @param _owner         Contract owner address
    /// @param _signers       Initial set of authorized gateway signers (used in
    ///                       signature mode)
    /// @param _gatewayUrl    CCIP-Read gateway URL template
    /// @param _verifyProofs  Start in proof-verification mode (use false for C1)
    constructor(
        address _owner,
        address[] memory _signers,
        string memory _gatewayUrl,
        bool _verifyProofs
    ) {
        if (_owner == address(0)) revert ZeroAddress();
        owner = _owner;
        gatewayUrl = _gatewayUrl;
        verifyProofs = _verifyProofs;
        emit OwnershipTransferred(address(0), _owner);
        for (uint256 i = 0; i < _signers.length; i++) {
            if (_signers[i] == address(0)) revert ZeroAddress();
            signers[_signers[i]] = true;
            emit SignerAdded(_signers[i]);
        }
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addSigner(address signer) external onlyOwner {
        if (signer == address(0)) revert ZeroAddress();
        signers[signer] = true;
        emit SignerAdded(signer);
    }

    function removeSigner(address signer) external onlyOwner {
        signers[signer] = false;
        emit SignerRemoved(signer);
    }

    function setGatewayUrl(string calldata newUrl) external onlyOwner {
        emit GatewayUrlUpdated(gatewayUrl, newUrl);
        gatewayUrl = newUrl;
    }

    /// @notice Toggle between signature-based and proof-based verification.
    /// @param enabled If true, resolveWithProof will expect a storage proof
    ///                (proof mode is a stub until C2).
    function setVerifyProofs(bool enabled) external onlyOwner {
        verifyProofs = enabled;
        emit VerifyProofsToggled(enabled);
    }

    // ─── EIP-3668 resolution ──────────────────────────────────────────────────

    /// @notice Called by ENS clients. Always reverts with OffchainLookup to
    ///         trigger the CCIP-Read flow.
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory) {
        string[] memory urls = new string[](1);
        urls[0] = gatewayUrl;

        revert OffchainLookup(
            address(this),
            urls,
            data,
            this.resolveWithProof.selector,
            abi.encode(name, data)
        );
    }

    /// @notice Callback after the client receives the gateway response.
    ///
    ///         Signature mode (verifyProofs == false):
    ///           `response` is ABI-encoded (bytes result, uint64 expires, bytes signature).
    ///           Verifies the EIP-3668 gateway signature exactly as OffchainResolver does.
    ///
    ///         Proof mode (verifyProofs == true):
    ///           `response` is ABI-encoded (bytes result, bytes proof) where
    ///           `proof` is ABI-encoded (bytes32 stateRoot, bytes[] storageProof).
    ///           Placeholder types — exact format to be finalised in C2.
    ///           Currently reverts with ProofVerificationNotImplemented().
    ///
    /// @param response   Gateway response (format depends on verifyProofs flag)
    /// @param extraData  ABI-encoded (bytes name, bytes callData) from OffchainLookup
    function resolveWithProof(bytes calldata response, bytes calldata extraData)
        external
        view
        returns (bytes memory)
    {
        if (verifyProofs) {
            return _resolveWithStorageProof(response, extraData);
        } else {
            return _resolveWithSignature(response, extraData);
        }
    }

    // ─── Internal: signature path (C1 / OffchainResolver-compatible) ──────────

    function _resolveWithSignature(bytes calldata response, bytes calldata extraData)
        internal
        view
        returns (bytes memory)
    {
        (bytes memory result, uint64 expires, bytes memory sig) =
            abi.decode(response, (bytes, uint64, bytes));

        if (block.timestamp > expires) revert SignatureExpired();

        // Recover original callData to bind the signature to the specific request.
        (, bytes memory callData) = abi.decode(extraData, (bytes, bytes));

        // EIP-3668 signing scheme:
        // keccak256(hex"1900" ++ address(this) ++ expires ++ keccak256(callData) ++ keccak256(result))
        bytes32 messageHash = keccak256(
            abi.encodePacked(
                hex"1900",
                address(this),
                expires,
                keccak256(callData),
                keccak256(result)
            )
        );
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));

        address recovered = _recover(ethHash, sig);
        if (recovered == address(0)) revert InvalidSigner();
        if (!signers[recovered]) revert InvalidSigner();

        return result;
    }

    // ─── Internal: proof path (C2 TODO) ──────────────────────────────────────

    /// @dev Proof format (placeholder — to be finalised in C2):
    ///   response = abi.encode(bytes result, bytes proof)
    ///   proof    = abi.encode(bytes32 stateRoot, bytes[] storageProof)
    ///
    ///   C2 will:
    ///   1. Retrieve the OP L2OutputOracle contract on L1.
    ///   2. Verify that stateRoot matches the committed output at a recent L2 block.
    ///   3. Walk the MPT storage proof to confirm the slot value equals keccak256(result).
    function _resolveWithStorageProof(bytes calldata response, bytes calldata /*extraData*/)
        internal
        pure
        returns (bytes memory)
    {
        // Decode to validate structure (will panic on malformed input even in stub).
        (bytes memory result, bytes memory proof) = abi.decode(response, (bytes, bytes));

        // Decode proof shape to validate encoding (values unused until C2).
        // solhint-disable-next-line no-unused-vars
        (bytes32 stateRoot, bytes[] memory storageProof) = abi.decode(proof, (bytes32, bytes[]));

        // Silence unused-variable warnings at the Solidity level.
        (result, stateRoot, storageProof); // referenced but verification not yet done

        // TODO(C2): verify stateRoot against L2OutputOracle on L1, then verify
        //           storageProof against stateRoot using the Optimism Bedrock
        //           MPT proof library.
        revert ProofVerificationNotImplemented();
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    function _recover(bytes32 hash, bytes memory sig) internal pure returns (address) {
        if (sig.length != 65) revert InvalidSignatureLength();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        if (v < 27) v += 27;
        return ecrecover(hash, v, r, s);
    }

    /// @notice EIP-165 supportsInterface
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 // EIP-165
            || interfaceId == 0x9061b923 // IExtendedResolver
            || interfaceId == 0x582de3e7; // IERC7996
    }

    /// @notice IERC7996 feature detection stub.
    function supportsFeature(bytes4 /*featureId*/) external pure returns (bool) {
        return false;
    }
}
