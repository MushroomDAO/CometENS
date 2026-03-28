# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start dev server on port 4173 (includes gateway middleware)
npm run build        # Build for production
npm run typecheck    # TypeScript validation (no emit)
```

No test suite exists. Use `typecheck` to validate changes.

## Architecture

This is a **Vite + TypeScript** app with no framework (no React/Vue). DOM manipulation is done imperatively in plain TS files.

### Pages and Entry Points

| HTML file | TS entry | Purpose |
|-----------|----------|---------|
| `index.html` | — | Landing/console page |
| `box.html` | `src/main.ts` | `.box` domain manager (Optimism Mainnet) |
| `eth.html` | `src/eth.ts` | `.eth` domain manager (L1/L2 dual mode) |

### Two Domain Systems

**`.box` system (`src/main.ts`)**
- Operates on Optimism Mainnet (chainId=10)
- Uses ThreeDNS contract (`0xBB7B805B257d7C76CA9435B3ffe780355E4C4B17`)
- Users allocate subdomains via `setSubnodeOwner(parentNode, labelHash, targetAddress)`
- Pre-checks: confirms caller is owner/approved operator before executing

**`.eth` system (`src/eth.ts`)**
- Dual query mode: L1 (Mainnet/Sepolia ENS) or L2 (Optimism Sepolia L2Records contract)
- L2Records stores domain records; OffchainResolver on L1 fetches them via CCIP-Read
- Supports querying `addr`, `text`, `contenthash` records
- EIP-712 signing for `SetAddr` typed data (payload-only, no broadcast)

### Backend Gateway (dev server middleware in `vite.config.ts`)

Two API routes injected into the Vite dev server:

- **POST `/api/ccip`** — CCIP-Read handler: decodes calldata, reads from L2RecordsReader, optionally signs response with `PRIVATE_KEY_SUPPLIER`
- **POST `/api/manage`** — EIP-712 signature verifier for `/set-addr` and `/register` operations

Server-side logic lives in `server/gateway/`:
- `index.ts` — main gateway handler
- `manage/schemas.ts` — EIP-712 domain and message type definitions
- `readers/L2RecordsReader.ts` — reads from L2 contract via viem

### Key Library

**viem** is the only runtime dependency. Used for everything: contract reads/writes, wallet client, EIP-712 signing, ENS utilities, ABI encoding/decoding.

## Environment Setup

Copy `.env.op-sepolia` and fill in values. Required variables:

```
OP_SEPOLIA_RPC_URL=             # Optimism Sepolia RPC
OP_L2_RECORDS_ADDRESS=          # L2Records contract (server-side)
VITE_L2_RECORDS_ADDRESS=        # L2Records contract (client-side)
VITE_EIP712_VERIFYING_CONTRACT= # EIP-712 domain contract
PRIVATE_KEY_SUPPLIER=           # Signs gateway CCIP responses
```

`VITE_` prefix = exposed to browser bundle. Non-prefixed vars are server/build-time only.

## Vendor Submodule

`vendor/unruggable-gateways/` is a git submodule containing CCIP-Read gateway reference implementations. Run `git submodule update --init` if it's empty.
