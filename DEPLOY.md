# CometENS Deployment Guide

## Prerequisites
- Node.js >= 20
- Foundry (`curl -L https://foundry.paradigm.xyz | bash`)
- A wallet with testnet ETH (Sepolia + OP Sepolia)

## 1. Install Dependencies
```bash
pnpm install
git submodule update --init
cd contracts && forge install
```

## 2. Deploy Contracts

### 2a. Deploy L2Records (OP Sepolia)
```bash
cd contracts
export DEPLOYER_ADDRESS=0x...
export PRIVATE_KEY=0x...
forge script script/DeployL2Records.s.sol \
  --rpc-url $OP_SEPOLIA_RPC_URL \
  --broadcast --verify
```
Note the deployed address → set as OP_L2_RECORDS_ADDRESS

### 2b. Deploy OffchainResolver (Ethereum Sepolia)
```bash
export SIGNER_ADDRESS=0x...
export GATEWAY_URL=https://cometens-gateway.jhfnetboy.workers.dev
forge script script/DeployOffchainResolver.s.sol \
  --rpc-url $SEPOLIA_RPC_URL \
  --broadcast --verify
```
Note the deployed address → set as L1_OFFCHAIN_RESOLVER_ADDRESS

## 3. Configure Environment

```bash
cp .env.op-sepolia .env.local
# Fill in all values (see comments in .env.op-sepolia)
```

Required vars:
- VITE_ROOT_DOMAIN=aastar.eth
- VITE_L2_RECORDS_ADDRESS=0x...
- VITE_L1_OFFCHAIN_RESOLVER_ADDRESS=0x...
- VITE_GATEWAY_URL=https://cometens-gateway.jhfnetboy.workers.dev
- VITE_L2_RPC_URL=...
- VITE_L1_SEPOLIA_RPC_URL=...
- OP_SEPOLIA_RPC_URL=...
- SEPOLIA_RPC_URL=...
- PRIVATE_KEY_SUPPLIER=0x...
- WORKER_EOA_PRIVATE_KEY=0x...

## 4. Set ENS Resolver on Sepolia
1. Go to https://sepolia.app.ens.domains
2. Register your .eth name (needs Sepolia ETH)
3. Set resolver to: L1_OFFCHAIN_RESOLVER_ADDRESS

## 5. Start Development Server
```bash
pnpm dev
```
Opens on http://localhost:4173

## 6. Run Tests

```bash
# Unit tests (fast, no network)
pnpm vitest run test/unit/

# E2E tests (requires Anvil: brew install foundry)
pnpm vitest run test/e2e/

# Integration tests (requires .env.local with real RPCs)
pnpm vitest run test/integration/
```

## 7. Deploy CCIP Gateway to Cloudflare Workers

The CCIP-Read gateway must be publicly accessible for third-party tools (viem, ethers, ENS app) to resolve subdomains. It is deployed as a Cloudflare Worker.

```bash
cd workers/gateway
pnpm install
wrangler deploy

# Set secrets (never committed to git)
wrangler secret put OP_SEPOLIA_RPC_URL
wrangler secret put PRIVATE_KEY_SUPPLIER
```

**Currently deployed:** `https://cometens-gateway.jhfnetboy.workers.dev`

To add a custom domain, add a route in `workers/gateway/wrangler.toml` and configure DNS in the Cloudflare dashboard. After changing the gateway URL, redeploy the OffchainResolver with the new URL (or call `setGatewayUrl()` if the contract supports it).

## 8. Deployed Contracts (Testnet)

| Contract | Deployed by | Network | Address |
|---|---|---|---|
| L2Records | CometENS | OP Sepolia (11155420) | [`0xf8df7ffd1cefd1226bf0f302120cafd8f6119115`](https://sepolia-optimism.etherscan.io/address/0xf8df7ffd1cefd1226bf0f302120cafd8f6119115) |
| OffchainResolver | CometENS | Ethereum Sepolia (11155111) | [`0x87d97a2e3B334a4b62e1269d02bf4e2b168EbB45`](https://sepolia.etherscan.io/address/0x87d97a2e3B334a4b62e1269d02bf4e2b168EbB45) |
| ENS Registry | ENS Official | Ethereum Sepolia | [`0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e`](https://sepolia.etherscan.io/address/0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e) |
| ENS Universal Resolver | ENS Official | Ethereum Sepolia | [`0x21B000Fd62a880b2125A61e36a284BB757b76025`](https://sepolia.etherscan.io/address/0x21B000Fd62a880b2125A61e36a284BB757b76025) |
| Root Domain | — | Sepolia ENS | `aastar.eth` |

---

## Testing Third-Party Resolution

Once a subdomain is registered (e.g. `alice.aastar.eth`), any ENS-compatible tool can resolve it via CCIP-Read. The gateway **must be publicly reachable** (use the Cloudflare Worker URL, not localhost).

### Method 1 — viem script (recommended)

The script at `scripts/resolve-testnet.ts` runs a full CCIP-Read resolution against Sepolia:

```bash
# Ensure .env.local has VITE_L1_SEPOLIA_RPC_URL set
npx tsx scripts/resolve-testnet.ts alice
# or with full name:
npx tsx scripts/resolve-testnet.ts alice.aastar.eth
```

Expected output:
```
Resolving: alice.aastar.eth
  L1 RPC:  https://eth-sepolia.../v2/***
  Gateway: https://cometens-gateway.jhfnetboy.workers.dev

addr(60/ETH):     0xb5600060e6de5E11D3636731964218E53caadf0E

✓ Resolution complete
```

### Method 2 — ethers.js

```ts
import { ethers } from 'ethers'
const provider = new ethers.JsonRpcProvider('https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY')
const addr = await provider.resolveName('alice.aastar.eth')
console.log(addr) // → 0xb560...
```

### Method 3 — ENS App (browser)

Open in browser (supports CCIP-Read for testnet):
```
https://app.ens.domains/alice.aastar.eth?chain=sepolia
```

### Method 4 — curl (raw gateway call)

Manually invoke the gateway with encoded calldata. First compute the ENS node:

```bash
NODE=$(cast namehash alice.aastar.eth | cut -c3-)  # strip 0x
CALLDATA="0x3b3b57de${NODE}"                         # addr(bytes32) selector

curl -s -X POST https://cometens-gateway.jhfnetboy.workers.dev \
  -H "Content-Type: application/json" \
  -d "{\"calldata\":\"$CALLDATA\",\"sender\":\"0x87d97a2e3B334a4b62e1269d02bf4e2b168EbB45\"}"
```

Returns `{"data":"0x..."}` — ABI-encoded `(bytes result, uint64 expires, bytes sig)`.

> Note: `cast resolve-name` does not support CCIP-Read (EIP-3668) — use the viem script or ethers.js instead.
