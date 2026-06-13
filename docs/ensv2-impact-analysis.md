# ENS V2 Architectural Pivot: Impact Analysis for CometENS

*April 2026 — Technical Roadmap Note*

---

## 1. The ENS V2 Pivot: What Changed

In February 2026, ENS Labs cancelled Namechain — the dedicated L2 rollup that had been ENS V2's centerpiece — citing a 99% reduction in L1 gas costs driven by Ethereum's gas limit increases (30M → 60M) and Dencun/blob fee reductions. ENS V2 is now a **pure L1 registry rewrite**: a hierarchical "per-name subregistry" architecture replacing the single flat ENS V1 registry, deployed exclusively on Ethereum Mainnet. Audits are ongoing as of Q1 2026; a testnet alpha is live on Sepolia. No production launch date has been announced.

The V2 design gives each `.eth` name its own registry contract for managing subnames, replacing the old NameWrapper fuse system with granular role-based permissions (resolver-level, name-level, record-level). Crucially, **resolver interfaces are unchanged**: `IExtendedResolver`, `CCIP-Read (ERC-3668)`, and the `resolve(bytes,bytes)` callback pattern all carry forward from V1 into V2.

---

## 2. Impact on the CCIP-Read / L2 Subdomain Stack

**Not affected.** CCIP-Read (ERC-3668) is a first-class primitive in ENS V2. The Universal Resolver on L1 continues to orchestrate CCIP-Read lookups identically to V1 — it detects `OffchainLookup` reverts from resolvers and sends the client to fetch from the gateway. The ENS V2 docs explicitly confirm that the resolver interface (`IExtendedResolver`, `resolve(bytes,bytes)`) is **unchanged**, and all existing CCIP-Read names (e.g., `cb.id`, `uni.eth`) will continue resolving without modification.

CometENS's `OffchainResolver.sol` (which implements `IExtendedResolver` and emits `OffchainLookup`) and `OPResolver.sol` (which uses `GatewayFetchTarget` from `unruggable-gateways`) are forward-compatible. No ABI or interface changes are required.

---

## 3. Per-Name Subregistry vs. L2Records Approach

ENS V2's "per-name subregistry" means `aastar.eth` could optionally point its L1 subregistry to a custom contract. This **complements rather than conflicts** with CometENS's L2Records approach: CometENS stores subdomain records on OP (Sepolia/Mainnet) and resolves them via CCIP-Read. ENS V2 changes how the L1 registry *finds* the resolver for `aastar.eth`, but once the resolver is found, the existing CCIP-Read flow is identical.

When `aastar.eth` eventually migrates to V2, its owner would configure the V2 subregistry to point subname lookups at the existing `OffchainResolver` — the same step as updating a resolver pointer today. Nothing downstream changes.

---

## 4. Unruggable Gateways: Still Relevant

ENS Labs and Unruggable are **actively co-developing** the V2 L2-interoperability layer. ENS V2's roadmap explicitly requires CCIP-Read + gateway servers with storage proofs for cross-chain primary name resolution. The `unruggable-gateways` library (Bedrock Merkle proofs, `GatewayFetcher`, `GatewayFetchTarget`) is not made obsolete — it is the **intended path** for trustless L2 resolution under both V1 and V2.

CometENS's current trusted-signing gateway is a stepping stone. Migrating `OPResolver.sol` to use `IGatewayVerifier` (already scaffolded in the codebase) eliminates the trusted EOA assumption and aligns with ENS V2's long-term cross-chain resolution model.

---

## 5. Timeline and Upgrade Path

ENS V2 is on Sepolia testnet; audits are incomplete. A mainnet launch before Q3 2026 appears unlikely based on current signals. When V2 does launch, **migration for `aastar.eth` is voluntary** — V1 names continue resolving via an "ENSv1 Fallback Resolver" that the V2 registry queries automatically. There is no forced cutover.

Upgrade path when ready: (1) optionally migrate `aastar.eth` to a V2 subregistry contract; (2) configure that subregistry to delegate subname resolution to the existing `OffchainResolver` — no contract redeployment required.

---

## Impact Summary

### (a) What changes when ENS V2 launches

- The L1 registry structure changes from flat to hierarchical per-name subregistries.
- `.eth` owners gain optional control over their own subregistry contracts.
- Gas costs for L1 registration remain low (already reduced ~99%).
- V1 names continue resolving without interruption via the V1 fallback resolver.

### (b) What we need to update

- **Nothing immediately.** Existing deployments keep working.
- **When migrating `aastar.eth` to V2 (optional, future):** configure the V2 subregistry to point at the existing `OffchainResolver`. One transaction.
- **Recommended (independent of V2):** complete the `OPResolver.sol` migration from trusted-signing to `IGatewayVerifier` (storage proofs). This is good practice now and aligns with ENS V2's cross-chain model.

### (c) What is unaffected

- `OffchainResolver.sol` — interface unchanged, no redeployment needed.
- `OPResolver.sol` — `IExtendedResolver` + `GatewayFetchTarget` are forward-compatible.
- The CCIP-Read gateway server (`server/gateway/`) — protocol unchanged.
- `L2Records` contract on OP Sepolia/Mainnet — no changes required.
- `unruggable-gateways` submodule — remains the canonical path for trustless L2 resolution.
