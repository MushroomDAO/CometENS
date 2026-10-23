# G2 Sepolia ENSv2 runtime observation

The first public-chain experiment uses Ethereum **Sepolia (11155111)**, never mainnet. Before choosing a community parent name, use the **read-only** command below to sample deployed RootRegistry and ETHRegistry runtime bytes at one finalized block. Addresses are imported from `scripts/inspect-ensv2-risk.mjs`, which references the newer official Sepolia deployment, **not** the obsolete 2026-07-30 deployment in historical resolver tests.

```bash
COMETENS_SEPOLIA_RPC_URL=https://YOUR-SEPOLIA-RPC \
  node scripts/probe-g2-sepolia-ensv2-runtime.mjs
```

Do not commit RPC endpoints or place private keys in this command. Output contains addresses, runtime hashes, EIP-1967 implementation storage slot values and a finalized block reference, **but no transaction, signature, ENS authorization or `SOVEREIGN` certificate**. Independently compare output with verified official deployments and bytecode before making a trusted deployment manifest. One RPC is neither independent finality/consensus evidence nor an approval to broadcast.

This tool does **not** choose or register an ENS parent, validate the account that owns it, or clear the circular constructor dependency in the G2 relay/inbox stack. The strict deployment readiness gate remains `BLOCKED` until those properties have separately verified evidence. Do not use legacy `scripts/deploy-testnet.sh` for the G2 native issuance stack.
