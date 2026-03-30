# Durin Integration Analysis

**Submodule**: `eval/durin` → `https://github.com/namestonehq/durin`
**Author**: NameStone
**License**: MIT
**Last updated**: Jan 2025 (repo still active as of Mar 2026)

---

## What Durin Is

Durin is the ENS-recommended toolkit for issuing L2 subnames under any `.eth` name. It ships a complete four-piece system:

1. **L1Resolver** (`src/L1Resolver.sol`) — an ENSIP-10 `IExtendedResolver` deployed on Ethereum mainnet/Sepolia. Stores a `(chainId, registryAddress)` mapping per parent node and emits a `stuffedResolveCall` CCIP-Read revert that passes chain + registry info directly to the gateway, eliminating any per-name gateway lookup.
2. **L2Registry** (`src/L2Registry.sol`) — an ERC-721 contract where each subname NFT token ID equals `namehash(label.parent.eth)`. Inherits `L2Resolver` and supports `createSubnode()` with inline multicall data for atomic record-setting at registration time.
3. **L2RegistryFactory** (`src/L2RegistryFactory.sol`) — a minimal proxy (Clones) factory so new parent-name registries are cheap to deploy. Deployed on all supported L2s; the `durin.dev` frontend calls it.
4. **Gateway** (`gateway/`) — a Hono HTTP server deployable to Cloudflare Workers. Decodes the `stuffedResolveCall` arguments, dispatches a `resolve(name, data)` call to the L2Registry on the specified chain (via dRPC multi-chain RPC), signs the response with EIP-191 / the `SignatureVerifier` hash scheme, and returns `(result, expires, sig)`.

Supported L2s in gateway: Arbitrum, Base, Celo, Linea, Optimism, Polygon, Scroll, Worldchain (mainnet + testnet each).

---

## Architecture Comparison

### L1 Resolver

| Aspect | Durin `L1Resolver.sol` | CometENS `OffchainResolver.sol` |
|---|---|---|
| Standard | ENSIP-10 `IExtendedResolver` | ENSIP-10 `IExtendedResolver` |
| CCIP-Read revert type | `OffchainLookup` with `stuffedResolveCall` selector | `OffchainLookup` with `resolveWithProof` selector |
| Chain/registry routing | Stored on-chain per parent node via `setL2Registry()` | Hardcoded via env vars |
| Name wrapper support | Yes — handles wrapped names via `INameWrapper.ownerOf()` | No |
| Wildcard subdomain support | Yes — strips to 2LD+TLD to find parent node | No |
| Signer management | Single signer via `setSigner()` (owner-only) | Multi-signer mapping (addSigner/removeSigner) ✅ |

Durin's "stuffed" calldata pattern is a clever optimization: `targetChainId` and `targetRegistryAddress` are embedded in the CCIP-Read calldata itself, so the gateway does not need any state lookups to route the request — the revert payload contains everything.

### L2 Storage Contract

| Aspect | Durin `L2Registry.sol` | CometENS `L2Records.sol` |
|---|---|---|
| Record types | `addr` (multi-coin, ENSIP-11), `text`, `contenthash`, `ABI` | `addr` (ETH-only), `text`, `contenthash` |
| Access control | ERC-721 ownership + approved registrar list | None (open write) |
| Registration | `createSubnode(parentNode, label, owner, data[])` with inline multicall | External: `setAddr`, `setText`, `setContenthash` called separately |
| Ownership model | Each subname is an ERC-721 NFT | No ownership tracking |
| Signature-based writes | `setAddrWithSignature`, `setTextWithSignature`, etc. (ERC-6492 aware) | Not present |
| Multi-coin addressing | Yes — coinType parameter (ENSIP-11) | No — single ETH address per node |

### Gateway / CCIP-Read Server

| Aspect | Durin gateway | CometENS gateway |
|---|---|---|
| Runtime | Hono on Cloudflare Workers (or local Bun) | Vite dev-server middleware (Node) |
| Transport | GET `/v1/:sender/:data` | POST `/api/ccip` |
| Signature scheme | EIP-191 `(result, expires, sig)` | Same scheme ✅ |
| Multi-chain dispatch | Yes — `supportedChains` array, dRPC provider | No — hardcoded OP Sepolia |
| Chain/registry source | Decoded from calldata (`stuffedResolveCall` args 2+3) | Environment variables |

### Auth / Registration Pattern

Durin does not use EIP-712. It uses an ERC-6492-aware raw `keccak256` signature over `(contractAddress, node, ...fields, expiration)`. CometENS uses EIP-712 with `nonce` and `deadline` — more expressive for off-chain registrations and gives better MetaMask display. This is a genuine advantage CometENS has over Durin.

---

## Key Patterns Worth Borrowing

### 1. "Stuffed" CCIP-Read calldata

Encode `(name, data, chainId, registryAddress)` into the CCIP-Read calldata. The gateway reads chain ID and registry address directly from the request — no server-side state, no env vars per chain. Makes the gateway stateless and trivially multi-chain.

Reference: `eval/durin/src/L1Resolver.sol` L225–249, `eval/durin/gateway/src/handlers/getCcipRead.ts` L39–50.

**Integration path**: When expanding to multi-chain (Milestone B/C), adopt this pattern in `OffchainResolver.sol`.

### 2. `setL2Registry()` on-chain pattern

Let the ENS name owner register their L2 registry on-chain (with NameWrapper support). CometENS currently stores this in env vars; putting it on-chain enables permissionless deployment without gateway reconfiguration.

Reference: `eval/durin/src/L1Resolver.sol` L123–139.

### 3. ERC-721 subname ownership

Using `namehash(label.parent.eth)` as the ERC-721 token ID ties ownership directly to the ENS namehash. `createSubnode(node, label, owner, data[])` atomically mints + sets records in one transaction.

Reference: `eval/durin/src/L2Registry.sol` L138–160.

**Integration path**: Milestone B (Name Wrapper + NFT subdomains).

### 4. Registrar allowlist pattern

`addRegistrar(address)` / `removeRegistrar(address)` authorizes multiple "registrar" contracts that call `createSubnode()`. Hook for pricing, allow-lists, token-gating without modifying core registry.

Reference: `eval/durin/src/L2Registry.sol` L220–234, `eval/durin/src/examples/L2Registrar.sol`.

### 5. Multi-chain gateway routing

`supportedChains` array + multi-chain provider means one gateway binary serves any registered L2. Add a chain, redeploy, done.

Reference: `eval/durin/gateway/src/ccip-read/query.ts` L26–88.

### 6. ENSIP-11 multi-coin addressing in registrar

Derives `coinType = (0x80000000 | chainId)` at construction and sets both chain-native address and ETH (coinType 60) on registration. Required for cross-chain reverse resolution.

Reference: `eval/durin/src/examples/L2Registrar.sol` L33–52.

---

## What CometENS Does Better

1. **EIP-712 signed registrations** — `Register`/`SetAddr`/`SetText` typed data with nonce+deadline is more robust than Durin's raw keccak256 scheme. Better MetaMask display, replay protection per contract.
2. **Multi-signer gateway keys** — `mapping(address => bool) signers` with `addSigner`/`removeSigner` enables zero-downtime key rotation. Durin uses a single `signer` address.
3. **Integrated dev server** — Full stack in one `npm run dev`. Durin requires separate gateway + frontend processes.
4. **POST body calldata** — More appropriate for large calldata, no URL-length limits.

---

## What NOT to Copy

- **Hono + Cloudflare Workers runtime** — Keep Node primary; Cloudflare deployment is additive, not a rewrite.
- **`arachnid/string-utils` for label splitting** — Heavy Solidity dependency for a task viem handles client-side.
- **dRPC hardcode** — CometENS env vars are more flexible; keep provider URLs configurable.
- **ERC-6492 validator hardcoded address** — Use constructor parameter if adopting signature-based writes.
- **L2RegistryFactory** — Only needed for a hosted multi-tenant service (durin.dev). For a single registry, deploy directly.
