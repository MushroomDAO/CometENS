// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title OffchainResolver
/// @notice EIP-3668 CCIP-Read resolver for ENS names.
///         When queried, reverts with OffchainLookup pointing to a gateway URL.
///         The gateway returns signed data; this contract verifies the signature,
///         binding it to the resolver address, expiry, original calldata, and result.
contract OffchainResolver {
    address public owner;
    address public signerAddress;
    string public gatewayUrl;

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

    event SignerUpdated(address indexed previous, address indexed next);
    event GatewayUrlUpdated(string previous, string next);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(address _owner, address _signer, string memory _gatewayUrl) {
        if (_owner == address(0) || _signer == address(0)) revert ZeroAddress();
        owner = _owner;
        signerAddress = _signer;
        gatewayUrl = _gatewayUrl;
        emit OwnershipTransferred(address(0), _owner);
        emit SignerUpdated(address(0), _signer);
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();
        emit SignerUpdated(signerAddress, newSigner);
        signerAddress = newSigner;
    }

    function setGatewayUrl(string calldata newUrl) external onlyOwner {
        emit GatewayUrlUpdated(gatewayUrl, newUrl);
        gatewayUrl = newUrl;
    }

    // ─── EIP-3668 resolution ──────────────────────────────────────────────────

    /// @notice Called by ENS clients. Reverts with OffchainLookup to trigger CCIP-Read.
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
    ///         Verifies the gateway signature, binding it to this resolver address,
    ///         expiry, the original calldata, and the result (EIP-3668 §4.1).
    /// @param response ABI-encoded (bytes result, uint64 expires, bytes signature)
    /// @param extraData ABI-encoded (bytes name, bytes callData) from the OffchainLookup
    function resolveWithProof(bytes calldata response, bytes calldata extraData)
        external
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
        if (recovered != signerAddress) revert InvalidSigner();

        return result;
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
            || interfaceId == 0x9061b923; // IExtendedResolver
    }
}
