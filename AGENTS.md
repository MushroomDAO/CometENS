# CometENS (ens-tool) — Agent Guide

This document provides essential information for AI coding agents working on the CometENS project.

## Project Overview

**CometENS** is an L2 subdomain distribution system for ENS. It allows users to register subdomains under a root `.eth` name on Optimism, which can be resolved globally via CCIP-Read (EIP-3668).

**Architecture Flow:**
```
User/DApp → L1 ENS → OffchainResolver → [OffchainLookup] → Gateway
                                                              ↓
                                                        L2Records (OP)
                                                              ↓
                                                       Signed Response
                                                              ↓
                                        OffchainResolver.resolveWithProof()
```

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla TypeScript (no React/Vue), Vite |
| Backend Gateway | Vite dev server middleware + Cloudflare Workers |
| Smart Contracts | Solidity ^0.8.20, Foundry |
| Ethereum Library | viem ^2.37.13 |
| Testing | Vitest ^4.1.2 |
| Package Manager | pnpm |

## Directory Structure

```
├── src/                    # Frontend TypeScript entry points
│   ├── config.ts           # Runtime configuration from env vars
│   ├── main.ts             # .box domain manager (Optimism Mainnet)
│   ├── admin.ts            # Admin interface for querying/setting records
│   └── register.ts         # User-facing subdomain registration
├── server/                 # Backend gateway logic
│   └── gateway/
│       ├── index.ts        # CCIP-Read request handlers
│       ├── manage/
│       │   └── schemas.ts  # EIP-712 type definitions
│       ├── readers/
│       │   └── L2RecordsReader.ts
│       ├── writer/
│       │   └── L2RecordsWriter.ts
│       └── v1/
│           └── register.ts # Upstream API handler
├── sdk/                    # Public SDK for third-party integration
│   ├── CometENS.ts         # Main SDK class
│   ├── types.ts            # TypeScript type definitions
│   └── index.ts            # SDK exports
├── contracts/              # Solidity smart contracts (Foundry)
│   ├── src/
│   │   ├── L2Records.sol   # L2 record storage contract
│   │   └── OffchainResolver.sol  # L1 CCIP-Read resolver
│   ├── script/             # Deployment scripts
│   └── test/               # Solidity unit tests
├── test/                   # TypeScript test suite
│   ├── unit/               # Unit tests (fast, no network)
│   ├── e2e/                # E2E tests (requires Anvil)
│   └── integration/        # Integration tests (requires real RPC)
├── workers/gateway/        # Cloudflare Worker deployment
├── *.html                  # Static HTML pages (vanilla JS/TS)
└── vite.config.ts          # Vite config with embedded gateway middleware
```

## Build and Development Commands

```bash
# Install dependencies
pnpm install

# Development server (includes gateway middleware on port 4173)
pnpm dev

# Production build
pnpm build

# TypeScript validation (no emit)
pnpm typecheck

# Run tests
pnpm test                    # All tests
pnpm test:watch             # Watch mode
pnpm test:coverage          # With coverage report

# Run specific test suites
pnpm vitest run test/unit/      # Unit tests only
pnpm vitest run test/e2e/       # E2E tests (requires Anvil)
pnpm vitest run test/integration/  # Integration tests (requires .env.local)

# Solidity tests
cd contracts && forge test
```

## Environment Configuration

Copy `.env.op-sepolia` to `.env.local` and fill in values:

```bash
cp .env.op-sepolia .env.local
```

**Critical Environment Variables:**

| Variable | Purpose | Scope |
|----------|---------|-------|
| `VITE_ROOT_DOMAIN` | Root ENS domain (e.g., `aastar.eth`) | Client |
| `VITE_L2_RECORDS_ADDRESS` | L2Records contract on OP Sepolia | Client |
| `VITE_L1_OFFCHAIN_RESOLVER_ADDRESS` | OffchainResolver on Sepolia | Client |
| `VITE_GATEWAY_URL` | CCIP gateway URL | Client |
| `VITE_L2_RPC_URL` | Optimism RPC endpoint | Client |
| `VITE_L1_SEPOLIA_RPC_URL` | Ethereum Sepolia RPC | Client |
| `OP_SEPOLIA_RPC_URL` | Server-side L2 RPC | Server |
| `PRIVATE_KEY_SUPPLIER` | Signs CCIP-Read responses | Server |
| `WORKER_EOA_PRIVATE_KEY` | Executes L2 transactions | Server |
| `UPSTREAM_ALLOWED_SIGNERS` | Comma-separated addresses for /api/v1 | Server |

> **Naming Convention:** Variables with `VITE_` prefix are exposed to the browser bundle. Variables without the prefix are server/build-time only.

## Code Style Guidelines

1. **Language:** TypeScript with strict mode enabled
2. **Module System:** ES Modules (`"type": "module"` in package.json)
3. **Ethereum Library:** Use `viem` exclusively (no ethers.js)
4. **DOM Manipulation:** Imperative vanilla TypeScript (no framework)
5. **Comments:** Mixed Chinese and English (follow existing convention)
6. **Type Imports:** Use `import type { ... }` for type-only imports
7. **Hex Types:** Use `` `0x${string}` `` for Ethereum addresses and hex data

### ABI Constants Pattern

ABIs are defined as const assertions for type safety:

```typescript
const MY_ABI = [
  {
    type: 'function',
    name: 'myFunction',
    stateMutability: 'view',
    inputs: [{ name: 'arg', type: 'bytes32' }],
    outputs: [{ name: '', type: 'address' }],
  },
] as const
```

## Testing Strategy

| Test Type | Location | Requirements | Purpose |
|-----------|----------|--------------|---------|
| Unit | `test/unit/` | None (mocked) | Test logic in isolation |
| E2E | `test/e2e/` | Anvil (`brew install foundry`) | Test full flows locally |
| Integration | `test/integration/` | `.env.local` with real RPCs | Test against live contracts |
| Solidity | `contracts/test/` | Foundry | Test contract logic |

### Running Tests

```bash
# Start dev server first for E2E tests
pnpm dev

# In another terminal:
pnpm vitest run test/unit/     # Fast feedback
pnpm vitest run test/e2e/      # Local chain tests
pnpm vitest run test/integration/  # Live network tests
```

## Security Considerations

1. **Private Keys:** Never commit private keys. Use environment variables only.
2. **Server-side Keys:** `PRIVATE_KEY_SUPPLIER` and `WORKER_EOA_PRIVATE_KEY` must never have `VITE_` prefix.
3. **EIP-712 Signing:** All state-changing operations require EIP-712 typed data signatures.
4. **Deadline Checking:** All signed operations include a deadline (600 seconds from signing).
5. **Signature Verification:** Gateway verifies all signatures before executing L2 transactions.
6. **CCIP-Read Security:** Gateway responses are signed and verified by OffchainResolver contract.

## Key Files Reference

| File | Purpose |
|------|---------|
| `src/config.ts` | Centralized configuration from env vars |
| `server/gateway/index.ts` | CCIP-Read request handling logic |
| `server/gateway/manage/schemas.ts` | EIP-712 domain and type definitions |
| `server/gateway/writer/L2RecordsWriter.ts` | L2 transaction execution |
| `sdk/CometENS.ts` | Public SDK implementation |
| `contracts/src/L2Records.sol` | L2 storage contract |
| `contracts/src/OffchainResolver.sol` | L1 resolver with CCIP-Read |
| `vite.config.ts` | Vite config with gateway middleware |

## Deployment Architecture

1. **L2 Contract (L2Records):** Deployed on Optimism Sepolia/Mainnet. Stores subdomain records.
2. **L1 Contract (OffchainResolver):** Deployed on Ethereum Sepolia/Mainnet. Registered as resolver for root domain.
3. **Gateway:** Cloudflare Worker that reads L2 data and returns signed responses.
4. **Frontend:** Static HTML/TS files served by Vite or any static host.

## CCIP-Read Flow

1. Client calls `OffchainResolver.resolve(name, data)` on L1
2. Contract reverts with `OffchainLookup` error containing gateway URL
3. Client fetches from gateway: `POST /api/ccip` with `calldata` and `sender`
4. Gateway reads from L2Records, signs response
5. Client calls `OffchainResolver.resolveWithProof(response, extraData)`
6. Contract verifies signature, returns result

## Common Tasks

### Adding a New API Endpoint

Add to `vite.config.ts` in the `configureServer` plugin:

```typescript
server.middlewares.use('/api/my-endpoint', async (req, res) => {
  // Handle request
})
```

### Adding a New EIP-712 Type

Add to `server/gateway/manage/schemas.ts`:

```typescript
export const MyTypes = {
  MyMessage: [
    { name: 'field1', type: 'bytes32' },
    { name: 'field2', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const
```

### Deploying Gateway Worker

```bash
cd workers/gateway
pnpm install
wrangler deploy
wrangler secret put OP_SEPOLIA_RPC_URL
wrangler secret put PRIVATE_KEY_SUPPLIER
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `window.ethereum` undefined | MetaMask not installed or not enabled |
| Chain ID mismatch | Call `switchToRequiredChain()` before wallet operations |
| CCIP-Read fails | Check gateway URL is accessible, signature is valid |
| L2 transaction timeout | OP Sepolia RPC can be slow; increase timeout in L2RecordsWriter |
| Type errors in tests | Ensure `test/` is included in vitest.config.ts |

## External References

- [ENS Documentation](https://docs.ens.domains/)
- [EIP-3668: CCIP-Read](https://eips.ethereum.org/EIPS/eip-3668)
- [viem Documentation](https://viem.sh/)
- [Foundry Book](https://book.getfoundry.sh/)
