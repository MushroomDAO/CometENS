// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.23;

/// @title HybridResolver — auto-routes signature (fresh) ↔ finalized proof (aged)
/// @notice One ENS resolver that resolves a record via EITHER a gateway signature
///         (for records not yet finalized on L2 — instant) OR a Bedrock storage
///         proof verified by OPFaultVerifier (for finalized, unchanged records —
///         trustless). The gateway picks the mode per record; this contract
///         verifies whichever was returned.
///
///         Optimistic proofs (un-finalized state, MIN_AGE_SEC>0) are NOT used:
///         the proof path is finalized-only (trustless & fast), and anything
///         newer than the finalized state is served by signature.
///
/// @dev See docs/HYBRID-RESOLVER-DESIGN.md for the full wire format & security notes.
///      Request-building and value-decoding mirror OPResolver; signature
///      verification mirrors OffchainResolver (EIP-3668 §4.1).

import {GatewayFetcher} from "@unruggable/contracts/GatewayFetcher.sol";
import {GatewayRequest} from "@unruggable/contracts/GatewayRequest.sol";
import {IGatewayVerifier} from "@unruggable/contracts/IGatewayVerifier.sol";

contract HybridResolver {
    using GatewayFetcher for GatewayRequest;

    // ─── L2RecordsV3 storage slots ──────────────────────────────────────────────
    uint256 constant SLOT_ADDRS = 7;
    uint256 constant SLOT_TEXTS = 8;
    uint256 constant SLOT_CONTENTHASH = 9;

    // ─── Resolver record selectors ──────────────────────────────────────────────
    bytes4 constant SEL_ADDR  = 0x3b3b57de; // addr(bytes32)
    bytes4 constant SEL_ADDR2 = 0xf1cb7e06; // addr(bytes32,uint256)
    bytes4 constant SEL_TEXT  = 0x59d1d43c; // text(bytes32,string)
    bytes4 constant SEL_CHASH = 0xbc1c58d1; // contenthash(bytes32)

    // ─── Gateway response discriminator ──────────────────────────────────────────
    uint8 constant MODE_SIG = 0;
    uint8 constant MODE_PROOF = 1;

    // ─── State ────────────────────────────────────────────────────────────────
    address public owner;
    address public l2RecordsAddress;
    IGatewayVerifier public verifier;        // mutable — OP Stack upgrades
    mapping(address => bool) public signers; // authorized gateway signers (SIG mode)
    string public gatewayUrl;

    // ─── Events ─────────────────────────────────────────────────────────────────
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event VerifierUpdated(address indexed previousVerifier, address indexed newVerifier);
    event L2RecordsUpdated(address indexed previousAddr, address indexed newAddr);
    event SignerAdded(address indexed signer);
    event SignerRemoved(address indexed signer);
    event GatewayUrlUpdated(string previous, string next);

    // ─── Errors ───────────────────────────────────────────────────────────────
    error OffchainLookup(address from, string[] urls, bytes request, bytes4 callback, bytes carry);
    error Unauthorized();
    error ZeroAddress();
    error UnsupportedSelector(bytes4 selector);
    error UnknownMode(uint8 mode);
    error SignatureExpired();
    error InvalidSigner();
    error InvalidSignatureLength();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(
        address _owner,
        IGatewayVerifier _verifier,
        address _l2RecordsAddress,
        address[] memory _signers,
        string memory _gatewayUrl
    ) {
        if (_owner == address(0)) revert ZeroAddress();
        if (address(_verifier) == address(0)) revert ZeroAddress();
        if (_l2RecordsAddress == address(0)) revert ZeroAddress();
        owner = _owner;
        verifier = _verifier;
        l2RecordsAddress = _l2RecordsAddress;
        gatewayUrl = _gatewayUrl;
        for (uint256 i = 0; i < _signers.length; i++) {
            if (_signers[i] == address(0)) revert ZeroAddress();
            signers[_signers[i]] = true;
            emit SignerAdded(_signers[i]);
        }
        emit OwnershipTransferred(address(0), _owner);
    }

    // ─── Admin ──────────────────────────────────────────────────────────────────
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setVerifier(IGatewayVerifier _verifier) external onlyOwner {
        if (address(_verifier) == address(0)) revert ZeroAddress();
        emit VerifierUpdated(address(verifier), address(_verifier));
        verifier = _verifier;
    }

    function setL2RecordsAddress(address _addr) external onlyOwner {
        if (_addr == address(0)) revert ZeroAddress();
        emit L2RecordsUpdated(l2RecordsAddress, _addr);
        l2RecordsAddress = _addr;
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

    // ─── ERC-165 ──────────────────────────────────────────────────────────────
    function supportsInterface(bytes4 x) external pure returns (bool) {
        return
            x == 0x01ffc9a7 || // IERC165
            x == 0x9061b923 || // IExtendedResolver (ENSIP-10)
            x == 0x3b3b57de || // IAddrResolver
            x == 0xf1cb7e06 || // IAddressResolver
            x == 0x59d1d43c || // ITextResolver
            x == 0xbc1c58d1;   // IContentHashResolver
    }

    // ─── IExtendedResolver.resolve ────────────────────────────────────────────
    /// @notice Builds the proof request for the record, then reverts with a custom
    ///         OffchainLookup. The gateway replies with (mode, payload); the callback
    ///         verifies the signature (mode 0) or the proof (mode 1).
    function resolve(bytes calldata /* name */, bytes calldata data) external view returns (bytes memory) {
        GatewayRequest memory req = _buildRequest(data);
        bytes memory context = verifier.getLatestContext();
        // carry == request: both sides need (context, req, data); the gateway parses
        // it to decide mode, the callback uses it to verify.
        bytes memory blob = abi.encode(context, req, data);
        string[] memory urls = new string[](1);
        urls[0] = gatewayUrl;
        revert OffchainLookup(address(this), urls, blob, this.hybridCallback.selector, blob);
    }

    /// @notice CCIP-Read callback. Verifies whichever proof type the gateway returned.
    /// @param response abi.encode(uint8 mode, bytes payload)
    /// @param carry    abi.encode(bytes context, GatewayRequest req, bytes data)
    function hybridCallback(bytes calldata response, bytes calldata carry)
        external
        view
        returns (bytes memory)
    {
        (bytes memory context, GatewayRequest memory req, bytes memory data) =
            abi.decode(carry, (bytes, GatewayRequest, bytes));
        (uint8 mode, bytes memory payload) = abi.decode(response, (uint8, bytes));

        if (mode == MODE_SIG) {
            return _verifySignature(payload, data);
        } else if (mode == MODE_PROOF) {
            (bytes[] memory values, uint8 exitCode) =
                verifier.getStorageValues(context, req, payload);
            return _decodeValues(values, exitCode, data);
        }
        revert UnknownMode(mode);
    }

    // ─── SIG path (mirrors OffchainResolver) ────────────────────────────────────
    /// @dev payload = abi.encode(bytes result, uint64 expires, bytes sig).
    ///      Binds to address(this), expires, keccak(data), keccak(result) — EIP-3668.
    function _verifySignature(bytes memory payload, bytes memory data)
        private
        view
        returns (bytes memory)
    {
        (bytes memory result, uint64 expires, bytes memory sig) =
            abi.decode(payload, (bytes, uint64, bytes));
        if (block.timestamp > expires) revert SignatureExpired();

        bytes32 messageHash = keccak256(
            abi.encodePacked(hex"1900", address(this), expires, keccak256(data), keccak256(result))
        );
        bytes32 ethHash =
            keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));

        address recovered = _recover(ethHash, sig);
        if (recovered == address(0) || !signers[recovered]) revert InvalidSigner();
        return result;
    }

    function _recover(bytes32 hash, bytes memory sig) private pure returns (address) {
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

    // ─── PROOF path (mirrors OPResolver decoding) ───────────────────────────────
    function _decodeValues(bytes[] memory values, uint8 exitCode, bytes memory data)
        private
        pure
        returns (bytes memory)
    {
        bytes4 sel = bytes4(data);
        bool empty = exitCode != 0 || values.length == 0 || values[0].length == 0;

        if (sel == SEL_ADDR) {
            if (empty) return abi.encode(address(0));
            bytes memory raw = values[0];
            address result;
            if (raw.length >= 20) {
                assembly {
                    result := shr(96, mload(add(raw, 32)))
                }
            }
            return abi.encode(result);
        } else if (sel == SEL_ADDR2) {
            if (empty) return abi.encode(bytes(""));
            return abi.encode(values[0]);
        } else if (sel == SEL_TEXT) {
            if (empty) return abi.encode("");
            return abi.encode(string(values[0]));
        } else if (sel == SEL_CHASH) {
            if (empty) return abi.encode(bytes(""));
            return abi.encode(values[0]);
        }
        revert UnsupportedSelector(sel);
    }

    // ─── Request builder (mirrors OPResolver) ───────────────────────────────────
    function _buildRequest(bytes calldata data) private view returns (GatewayRequest memory) {
        if (data.length < 4) revert UnsupportedSelector(bytes4(0));
        bytes4 sel = bytes4(data[:4]);

        if (sel == SEL_ADDR) {
            bytes32 node = abi.decode(data[4:], (bytes32));
            return _addrRequest(node, 60);
        } else if (sel == SEL_ADDR2) {
            (bytes32 node, uint256 coinType) = abi.decode(data[4:], (bytes32, uint256));
            return _addrRequest(node, coinType);
        } else if (sel == SEL_TEXT) {
            (bytes32 node, string memory key) = abi.decode(data[4:], (bytes32, string));
            return GatewayFetcher.newRequest(1).setTarget(l2RecordsAddress).setSlot(SLOT_TEXTS)
                .push(node).follow().push(bytes(key)).follow().readBytes().setOutput(0);
        } else if (sel == SEL_CHASH) {
            bytes32 node = abi.decode(data[4:], (bytes32));
            return GatewayFetcher.newRequest(1).setTarget(l2RecordsAddress).setSlot(SLOT_CONTENTHASH)
                .push(node).follow().readBytes().setOutput(0);
        }
        revert UnsupportedSelector(sel);
    }

    function _addrRequest(bytes32 node, uint256 coinType) private view returns (GatewayRequest memory) {
        return GatewayFetcher.newRequest(1).setTarget(l2RecordsAddress).setSlot(SLOT_ADDRS)
            .push(node).follow().push(coinType).follow().readBytes().setOutput(0);
    }
}
