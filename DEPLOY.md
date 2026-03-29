# CometENS Deployment Guide

## Prerequisites
- Node.js >= 20
- Foundry (`curl -L https://foundry.paradigm.xyz | bash`)
- A wallet with testnet ETH (Sepolia + OP Sepolia)

## 1. Install Dependencies
```bash
npm install
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
export GATEWAY_URL=http://localhost:4173/api/ccip
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
- VITE_GATEWAY_URL=http://localhost:4173/api/ccip
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
npm run dev
```
Opens on http://localhost:4173

## 6. Run Tests

```bash
# Unit tests (fast, no network)
npm test -- test/unit/

# E2E tests (requires Anvil: brew install foundry)
npm test -- test/e2e/

# Integration tests (requires .env.local with real RPCs)
npm test -- test/integration/
```

## 7. Deployed Contracts (Testnet)
| Contract | Network | Address |
|---|---|---|
| L2Records | OP Sepolia | 0x9Ed5d10101656b69B5bf50Ef15fd3cc33F55058b |
| OffchainResolver | Ethereum Sepolia | 0x87d97a2e3B334a4b62e1269d02bf4e2b168EbB45 |
| Root Domain | Sepolia ENS | aastar.eth |
