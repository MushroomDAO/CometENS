// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.23;

/// @title OPResolver — Bedrock Storage Proof Resolver (C3)
/// @notice EIP-3668 CCIP-Read resolver that verifies ENS records stored in
///         L2RecordsV3 on Optimism via Bedrock storage proofs on L1.
///         Uses unruggable-gateways v1.3.5 OPFaultVerifier for trustless
///         L2→L1 state verification — no gateway signing key required.
///
/// @dev Architecture:
///   1. ENS Universal Resolver calls resolve(name, data)
///   2. We build a GatewayFetcher request describing which L2RecordsV3 storage
///      slots to prove and revert with OffchainLookup
///   3. The CCIP-Read gateway fetches eth_getProof from OP node and returns proof
///   4. fetchCallback() runs: OPFaultVerifier verifies proof against L1 rootClaim
///   5. Callback decodes verified values and returns the ENS record
///
/// @dev L2RecordsV3 storage layout (relevant slots):
///   slot 7: _addrs        mapping(bytes32 node => mapping(uint256 coinType => bytes))
///   slot 8: _texts        mapping(bytes32 node => mapping(string key => string))
///   slot 9: _contenthashes mapping(bytes32 node => bytes)
///
/// @dev Upgradeability: _verifier is mutable (setVerifier, onlyOwner).
///   When OP Stack upgrades (e.g., OP Succinct ZK proofs), redeploy
///   OPFaultVerifier + OPFaultGameFinder and call setVerifier().
///   The resolver itself does not need to be redeployed.

import {GatewayFetcher} from "@unruggable/contracts/GatewayFetcher.sol";
import {GatewayFetchTarget, IGatewayVerifier} from "@unruggable/contracts/GatewayFetchTarget.sol";
import {GatewayRequest} from "@unruggable/contracts/GatewayRequest.sol";

contract OPResolver is GatewayFetchTarget {
    using GatewayFetcher for GatewayRequest;

    // ─── Constants ────────────────────────────────────────────────────────────

    /// @dev L2RecordsV3 storage slot for _addrs mapping
    uint256 constant SLOT_ADDRS = 7;
    /// @dev L2RecordsV3 storage slot for _texts mapping
    uint256 constant SLOT_TEXTS = 8;
    /// @dev L2RecordsV3 storage slot for _contenthashes mapping
    uint256 constant SLOT_CONTENTHASH = 9;

    /// @dev IAddrResolver.addr(bytes32) selector
    bytes4 constant SEL_ADDR   = 0x3b3b57de;
    /// @dev IAddressResolver.addr(bytes32,uint256) selector
    bytes4 constant SEL_ADDR2  = 0xf1cb7e06;
    /// @dev ITextResolver.text(bytes32,string) selector
    bytes4 constant SEL_TEXT   = 0x59d1d43c;
    /// @dev IContentHashResolver.contenthash(bytes32) selector
    bytes4 constant SEL_CHASH  = 0xbc1c58d1;

    // ─── State ────────────────────────────────────────────────────────────────

    address public owner;

    /// @notice L2RecordsV3 contract address on Optimism
    address public l2RecordsAddress;

    /// @notice OPFaultVerifier — mutable to support future OP Stack upgrades
    IGatewayVerifier public verifier;

    // ─── Events ───────────────────────────────────────────────────────────────

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event VerifierUpdated(address indexed previousVerifier, address indexed newVerifier);
    event L2RecordsUpdated(address indexed previousAddr, address indexed newAddr);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error Unauthorized();
    error ZeroAddress();
    error UnsupportedSelector(bytes4 selector);

    // ─── Modifier ────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor(
        address _owner,
        IGatewayVerifier _verifier,
        address _l2RecordsAddress
    ) {
        if (_owner == address(0)) revert ZeroAddress();
        if (address(_verifier) == address(0)) revert ZeroAddress();
        if (_l2RecordsAddress == address(0)) revert ZeroAddress();
        owner = _owner;
        verifier = _verifier;
        l2RecordsAddress = _l2RecordsAddress;
        emit OwnershipTransferred(address(0), _owner);
    }

    // ─── Ownership & Admin ────────────────────────────────────────────────────

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Update the verifier contract.
    ///         Call this when OP Stack upgrades (e.g., new fault proof system).
    function setVerifier(IGatewayVerifier _verifier) external onlyOwner {
        if (address(_verifier) == address(0)) revert ZeroAddress();
        emit VerifierUpdated(address(verifier), address(_verifier));
        verifier = _verifier;
    }

    /// @notice Update the L2RecordsV3 address (e.g., after mainnet migration).
    function setL2RecordsAddress(address _addr) external onlyOwner {
        if (_addr == address(0)) revert ZeroAddress();
        emit L2RecordsUpdated(l2RecordsAddress, _addr);
        l2RecordsAddress = _addr;
    }

    // ─── ERC-165 ──────────────────────────────────────────────────────────────

    function supportsInterface(bytes4 x) external pure returns (bool) {
        return
            x == 0x01ffc9a7 || // IERC165
            x == 0x9061b923 || // IExtendedResolver (ENSIP-10)
            x == 0x3b3b57de || // IAddrResolver.addr(bytes32)
            x == 0xf1cb7e06 || // IAddressResolver.addr(bytes32,uint256)
            x == 0x59d1d43c || // ITextResolver.text(bytes32,string)
            x == 0xbc1c58d1;   // IContentHashResolver.contenthash(bytes32)
    }

    // ─── IExtendedResolver.resolve ────────────────────────────────────────────

    /// @notice Entry point for ENS resolution. Builds storage proof request for
    ///         the requested record type and reverts with OffchainLookup.
    /// @param  name DNS-encoded ENS name (not used directly — node from data)
    /// @param  data ABI-encoded call: addr(node), text(node,key), etc.
    function resolve(
        bytes calldata name,
        bytes calldata data
    ) external view returns (bytes memory) {
        if (data.length < 4) revert UnsupportedSelector(bytes4(0));
        bytes4 sel = bytes4(data[:4]);

        if (sel == SEL_ADDR) {
            // addr(bytes32 node) → ETH address (coinType 60)
            bytes32 node = abi.decode(data[4:], (bytes32));
            _fetchAddr(node, 60, data);
        } else if (sel == SEL_ADDR2) {
            // addr(bytes32 node, uint256 coinType)
            (bytes32 node, uint256 coinType) = abi.decode(data[4:], (bytes32, uint256));
            _fetchAddr(node, coinType, data);
        } else if (sel == SEL_TEXT) {
            // text(bytes32 node, string key)
            (bytes32 node, string memory key) = abi.decode(data[4:], (bytes32, string));
            _fetchText(node, key, data);
        } else if (sel == SEL_CHASH) {
            // contenthash(bytes32 node)
            bytes32 node = abi.decode(data[4:], (bytes32));
            _fetchContenthash(node, data);
        } else {
            revert UnsupportedSelector(sel);
        }

        // unreachable: _fetch* always reverts via OffchainLookup
        return "";
    }

    // ─── Fetch helpers ────────────────────────────────────────────────────────

    /// @dev Read _addrs[node][coinType] from L2RecordsV3 (slot 7)
    function _fetchAddr(bytes32 node, uint256 coinType, bytes calldata carry) private view {
        GatewayRequest memory r = GatewayFetcher
            .newRequest(1)
            .setTarget(l2RecordsAddress)
            .setSlot(SLOT_ADDRS)
            .push(node)
            .follow()
            .push(coinType)
            .follow()
            .readBytes()
            .setOutput(0);

        fetch(verifier, r, this.addrCallback.selector, carry, new string[](0));
    }

    /// @dev Read _texts[node][key] from L2RecordsV3 (slot 8).
    ///      GatewayVM's FOLLOW op computes keccak256(abi.encodePacked(key_bytes, slot)),
    ///      which matches Solidity's mapping(string => ...) slot derivation.
    ///      We must push the raw string bytes — NOT a pre-hashed value.
    function _fetchText(bytes32 node, string memory key, bytes calldata carry) private view {
        GatewayRequest memory r = GatewayFetcher
            .newRequest(1)
            .setTarget(l2RecordsAddress)
            .setSlot(SLOT_TEXTS)
            .push(node)
            .follow()
            .push(bytes(key))
            .follow()
            .readBytes()
            .setOutput(0);

        fetch(verifier, r, this.textCallback.selector, carry, new string[](0));
    }

    /// @dev Read _contenthashes[node] from L2RecordsV3 (slot 9)
    function _fetchContenthash(bytes32 node, bytes calldata carry) private view {
        GatewayRequest memory r = GatewayFetcher
            .newRequest(1)
            .setTarget(l2RecordsAddress)
            .setSlot(SLOT_CONTENTHASH)
            .push(node)
            .follow()
            .readBytes()
            .setOutput(0);

        fetch(verifier, r, this.contenthashCallback.selector, carry, new string[](0));
    }

    // ─── Callbacks ────────────────────────────────────────────────────────────

    /// @notice Called by fetchCallback after proof verification for addr()
    /// @param  values  Verified storage values: values[0] = raw bytes for the address
    /// @param  exitCode 0 = success
    /// @param  carry   Original resolve() calldata (to determine return ABI)
    function addrCallback(
        bytes[] calldata values,
        uint8 exitCode,
        bytes calldata carry
    ) external pure returns (bytes memory) {
        bytes4 sel = bytes4(carry[:4]);
        if (exitCode != 0 || values.length == 0 || values[0].length == 0) {
            // Record not found — return zero address / empty bytes
            if (sel == SEL_ADDR2) return abi.encode(bytes(""));
            return abi.encode(address(0));
        }

        if (sel == SEL_ADDR2) {
            // addr(bytes32, uint256) → bytes (raw address bytes for the coin type)
            return abi.encode(values[0]);
        } else {
            // addr(bytes32) → address (ETH, coinType=60, 20 bytes stored left-aligned)
            // values[0] is 20 bytes of address data:
            //   mem layout: [length_word_32B][addr_20B][zero_pad...]
            //   mload(ptr+32) = [addr_20B][zero_12B] (left-aligned in 256-bit word)
            //   shr(96) removes the 12-byte right-pad → address in low 20 bytes
            bytes memory raw = values[0];
            address result;
            if (raw.length >= 20) {
                assembly {
                    result := shr(96, mload(add(raw, 32)))
                }
            }
            return abi.encode(result);
        }
    }

    /// @notice Called by fetchCallback after proof verification for text()
    function textCallback(
        bytes[] calldata values,
        uint8 exitCode,
        bytes calldata /* carry */
    ) external pure returns (bytes memory) {
        if (exitCode != 0 || values.length == 0 || values[0].length == 0) {
            return abi.encode("");
        }
        return abi.encode(string(values[0]));
    }

    /// @notice Called by fetchCallback after proof verification for contenthash()
    function contenthashCallback(
        bytes[] calldata values,
        uint8 exitCode,
        bytes calldata /* carry */
    ) external pure returns (bytes memory) {
        if (exitCode != 0 || values.length == 0 || values[0].length == 0) {
            return abi.encode(bytes(""));
        }
        return abi.encode(values[0]);
    }
}
