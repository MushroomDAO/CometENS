#!/usr/bin/env bash
# ─── CometENS — Deploy to Testnet (OP Sepolia + Ethereum Sepolia) ──────────────
# Usage: bash scripts/deploy-testnet.sh
#
# Deploys:
#   1. L2RecordsV2       → OP Sepolia (11155420)
#   2. OffchainResolver  → Ethereum Sepolia (11155111)  [skipped if already deployed]
#   3. CF Worker         → cometens-gateway (testnet env)
#   4. CF Worker         → cometens-api (testnet env)
#
# Required env vars (in .env.local):
#   OP_SEPOLIA_RPC_URL, SEPOLIA_RPC_URL
#   PRIVATE_KEY (deployer, 0x-prefixed)
#   DEPLOYER_ADDRESS, SIGNER_ADDRESS

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load .env.local
if [[ -f "$ROOT/.env.local" ]]; then
  set -o allexport
  source <(grep -v '^#' "$ROOT/.env.local" | grep -v '^$')
  set +o allexport
fi

echo "═══════════════════════════════════════════════"
echo "  CometENS Testnet Deploy"
echo "  L1: Ethereum Sepolia (11155111)"
echo "  L2: Optimism Sepolia (11155420)"
echo "═══════════════════════════════════════════════"

# ── Step 1: Deploy L2RecordsV2 ──────────────────────────────────────────────────
echo ""
echo "▶ Step 1/3 — Deploy L2RecordsV2 (OP Sepolia)"
cd "$ROOT/contracts"
forge script script/DeployL2RecordsV2.s.sol \
  --rpc-url "$OP_SEPOLIA_RPC_URL" \
  --private-key "$PRIVATE_KEY_SUPPLIER" \
  --broadcast \
  --verify \
  2>&1 | tee /tmp/deploy-l2records.log

L2_ADDR=$(grep -oP '(?<=L2RecordsV2 deployed at: )0x[0-9a-fA-F]+' /tmp/deploy-l2records.log || \
          grep -oP '(?<=Contract Address: )0x[0-9a-fA-F]+' /tmp/deploy-l2records.log | tail -1)
echo "  L2RecordsV2 deployed: $L2_ADDR"

# ── Step 2: Deploy OffchainResolver ─────────────────────────────────────────────
echo ""
echo "▶ Step 2/4 — Deploy OffchainResolver (Ethereum Sepolia)"
echo "  Gateway URL: https://cometens-gateway.jhfnetboy.workers.dev"
GATEWAY_URL="https://cometens-gateway.jhfnetboy.workers.dev" \
forge script script/DeployOffchainResolver.s.sol \
  --rpc-url "$SEPOLIA_RPC_URL" \
  --private-key "$PRIVATE_KEY_SUPPLIER" \
  --broadcast \
  --verify \
  2>&1 | tee /tmp/deploy-resolver.log

RESOLVER_ADDR=$(grep -oP '(?<=Deployed OffchainResolver at: )0x[0-9a-fA-F]+' /tmp/deploy-resolver.log || \
               grep -oP '(?<=Contract Address: )0x[0-9a-fA-F]+' /tmp/deploy-resolver.log | tail -1)
echo "  OffchainResolver deployed: $RESOLVER_ADDR"

# ── Step 3: Deploy Gateway CF Worker (testnet) ──────────────────────────────────
echo ""
echo "▶ Step 3/4 — Deploy Gateway Cloudflare Worker (testnet)"
cd "$ROOT/workers/gateway"

# Update L2Records address in wrangler.toml if we got one
if [[ -n "${L2_ADDR:-}" ]]; then
  sed -i.bak "s|L2_RECORDS_ADDRESS = \"[^\"]*\"|L2_RECORDS_ADDRESS = \"$L2_ADDR\"|g" wrangler.toml
  rm -f wrangler.toml.bak
  echo "  Updated gateway wrangler.toml: L2_RECORDS_ADDRESS = $L2_ADDR"
fi

wrangler deploy --env testnet

# ── Step 4: Deploy API CF Worker (testnet) ───────────────────────────────────
echo ""
echo "▶ Step 4/4 — Deploy API Cloudflare Worker (testnet)"
cd "$ROOT/workers/api"

# Update L2Records address in wrangler.toml if we got one
if [[ -n "${L2_ADDR:-}" ]]; then
  sed -i.bak "s|L2_RECORDS_ADDRESS = \"[^\"]*\"|L2_RECORDS_ADDRESS = \"$L2_ADDR\"|g" wrangler.toml
  rm -f wrangler.toml.bak
  echo "  Updated API wrangler.toml: L2_RECORDS_ADDRESS = $L2_ADDR"
fi

# Secrets must be set via wrangler secret put — they are not in .env.local
# Run these manually once (or add to CI):
#   echo "$WORKER_EOA_PRIVATE_KEY" | wrangler secret put WORKER_EOA_PRIVATE_KEY --env testnet
#   echo "$UPSTREAM_ALLOWED_SIGNERS" | wrangler secret put UPSTREAM_ALLOWED_SIGNERS --env testnet
wrangler deploy --env testnet

echo ""
echo "═══════════════════════════════════════════════"
echo "  ✓ Testnet deploy complete"
echo ""
echo "  L2RecordsV2:      ${L2_ADDR:-see log}"
echo "  OffchainResolver: ${RESOLVER_ADDR:-see log}"
echo "  Gateway:          https://cometens-gateway.jhfnetboy.workers.dev"
echo "  API:              https://cometens-api.jhfnetboy.workers.dev"
echo ""
echo "  Next steps:"
echo "  1. Update .env.local: VITE_L2_RECORDS_ADDRESS=$L2_ADDR"
echo "  2. Set resolver on Sepolia ENS for your .eth name"
echo "═══════════════════════════════════════════════"
