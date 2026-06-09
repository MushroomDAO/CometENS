# CLAUDE.md

## Mycelium Protocol 生态上下文
> 本 repo 属于 mycelium 组织，参与 Mycelium Protocol 生态建设。
> 上下文来源: github.com/AAStarCommunity/Brood — 更新时自动同步

@/Users/jason/Dev/Brood/protocol/MISSION.md
@/Users/jason/Dev/Brood/protocol/PGL/CONTEXT.md
@/Users/jason/Dev/Brood/orgs/mycelium/PROFILE.md
@/Users/jason/Dev/Brood/orgs/mycelium/INTERFACES.md

---

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev             # Start frontend dev server on port 4173
pnpm build           # Production build
pnpm typecheck       # TypeScript validation (no emit)
pnpm test            # Run all tests (unit + e2e + integration)
pnpm vitest run test/unit/        # Unit tests only (fast, no network)
pnpm vitest run test/e2e/         # E2E tests (requires Anvil)
pnpm vitest run test/integration/ # Integration tests (requires .env.local)
pnpm abi:sync        # Sync ABI from contracts/out/ into contracts/abi/

# Solidity contracts (Foundry)
cd contracts && forge test        # Run Solidity unit tests
cd contracts && forge build       # Compile contracts

# Cloudflare Workers deployment
cd workers/gateway && wrangler deploy --env testnet
cd workers/api && wrangler deploy --env testnet
```

## Architecture

**CometENS** is an L2 subdomain distribution system for ENS. Users register subdomains under a root `.eth` name on Optimism; global resolution works via CCIP-Read (EIP-3668).

```
User/DApp → L1 ENS → OffchainResolver → [OffchainLookup] → Gateway Worker
                                                                    ↓
                                                            L2Records (OP)
                                                                    ↓
                                                           Signed Response
                                                                    ↓
                                             OffchainResolver.resolveWithProof()
```

This is a **Vite + TypeScript** app with no framework (no React/Vue). DOM manipulation is done imperatively in plain TS.

### Pages and Entry Points

| HTML file | TS entry | Purpose |
|-----------|----------|---------|
| `index.html` | — | Landing/console page |
| `box.html` | `src/main.ts` | `.box` domain manager (Optimism Mainnet) |
| `register.html` | `src/register.ts` | User-facing subdomain registration |
| `admin.html` | `src/admin.ts` | Admin interface for querying/setting records |
| `api-docs.html` | — | API documentation |

### Backend: Cloudflare Workers (Phase 3)

`vite.config.ts` is now a **pure frontend build config** — all API logic has moved to Cloudflare Workers:

- **`workers/gateway/`** (`cometens-gateway` worker) — CCIP-Read resolution. Reads L2Records, returns signed responses. Configured via `wrangler.toml` env `testnet`/`production`. Supports two modes:
  - **Signature mode** (default): signs responses with `PRIVATE_KEY_SUPPLIER`
  - **Proof mode** (`PROOF_MODE=true`): Bedrock storage proof (trustless, no signing key needed)

- **`workers/api/`** (`cometens-api` worker) — Write operations + lookup. Handles `/register`, `/set-addr`, `/lookup`. Uses KV namespaces:
  - `REGISTRY` — address→label registry
  - `RECORD_CACHE` — ENS record cache (shared namespace ID with gateway worker)

The legacy `server/gateway/` code remains as a reference implementation used only by tests and local tooling.

### Smart Contracts (`contracts/`)

Three versions of the L2 storage contract:
- **`L2Records.sol`** (V1) — basic record storage
- **`L2RecordsV2.sol`** — adds registrar plugin architecture (`IRegistrarPlugin`) with quota/expiry
- **`L2RecordsV3.sol`** — extends V2 with ERC-721 subdomain ownership (tokenId = `uint256(node)`)

On-chain resolver contracts:
- **`OffchainResolver.sol`** — L1 resolver that triggers CCIP-Read lookup to the gateway
- **`OPResolver.sol`** — L1 resolver using Optimism Bedrock storage proofs (trustless, no gateway key)

Contracts use Foundry; libraries are git submodules under `contracts/lib/`.

### SDK (`sdk/`)

`sdk/CometENS.ts` — public SDK for third-party integration. Reads records directly from L2Records (no gateway needed); writes go through the API worker's `/api/manage` endpoints. Testnet/mainnet is auto-detected from the RPC URL.

### Key Library

**viem** is the only runtime dependency. Used for everything: contract reads/writes, wallet client, EIP-712 signing, ENS utilities, ABI encoding/decoding.

## Environment Setup

Copy `.env.op-sepolia` to `.env.local` and fill in values:

```
# Client-side (VITE_ prefix = bundled into browser)
VITE_NETWORK=op-sepolia
VITE_ROOT_DOMAIN=aastar.eth
VITE_L2_RECORDS_ADDRESS=        # L2RecordsV3 contract on OP Sepolia
VITE_L1_OFFCHAIN_RESOLVER_ADDRESS=
VITE_GATEWAY_URL=               # defaults to deployed testnet worker
VITE_API_URL=                   # defaults to deployed testnet worker
VITE_L2_RPC_URL=
VITE_L1_SEPOLIA_RPC_URL=

# Server-side (no VITE_ prefix — never exposed to browser)
PRIVATE_KEY_SUPPLIER=           # Signs CCIP-Read gateway responses
WORKER_EOA_PRIVATE_KEY=         # Executes L2 write transactions
UPSTREAM_ALLOWED_SIGNERS=       # Comma-separated addresses for /api/v1 whitelist
```

For local dev, `VITE_API_URL` and `VITE_GATEWAY_URL` default to the deployed testnet workers (`src/config.ts`), so `.env.local` only needs RPC URLs.

## Testing

| Test type | Location | Requirements |
|-----------|----------|--------------|
| Unit | `test/unit/` | None (mocked) |
| E2E | `test/e2e/` | Anvil (`brew install foundry`) + `pnpm dev` running |
| Integration | `test/integration/` | `.env.local` with real RPCs |
| Solidity | `contracts/test/` | Foundry |

## Vendor Submodule

`vendor/unruggable-gateways/` is a git submodule with CCIP-Read gateway reference implementations. Run `git submodule update --init` if it's empty. The same library is also a Foundry submodule at `contracts/lib/unruggable-gateways/`.
