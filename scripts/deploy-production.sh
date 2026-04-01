#!/usr/bin/env bash
# ─── CometENS — Deploy to Production (OP Mainnet + Ethereum Mainnet) ──────────
# Usage: bash scripts/deploy-production.sh
#
# Deploys:
#   1. L2RecordsV2       → Optimism Mainnet (10)
#   2. OffchainResolver  → Ethereum Mainnet (1)
#   3. CF Worker         → cometens-gateway-production
#   4. CF Worker         → cometens-api-production
#
# Required env vars (.env.production or exported):
#   OP_MAINNET_RPC_URL, MAINNET_RPC_URL
#   PRIVATE_KEY (deployer, 0x-prefixed)
#   DEPLOYER_ADDRESS, SIGNER_ADDRESS
#   GATEWAY_URL (production gateway — custom domain recommended)
#   WORKER_EOA_PRIVATE_KEY (API worker signing key — set via wrangler secret)
#
# IMPORTANT: This deploys to mainnet and costs real ETH. Verify all inputs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load .env.production (separate file, never commit to git)
if [[ -f "$ROOT/.env.production" ]]; then
  set -o allexport
  source <(grep -v '^#' "$ROOT/.env.production" | grep -v '^$')
  set +o allexport
fi

# Require confirmation for mainnet deploy
echo "═══════════════════════════════════════════════"
echo "  CometENS PRODUCTION Deploy"
echo "  L1: Ethereum Mainnet (1)"
echo "  L2: Optimism Mainnet (10)"
echo "═══════════════════════════════════════════════"
echo ""
echo "  ⚠️  This deploys to MAINNET and costs real ETH."
echo "  Deployer: ${DEPLOYER_ADDRESS:-NOT SET}"
echo "  Gateway:  ${GATEWAY_URL:-https://cometens-gateway-production.jhfnetboy.workers.dev}"
echo ""
read -rp "  Type 'yes' to continue: " CONFIRM
if [[ "$CONFIRM" != "yes" ]]; then
  echo "Aborted."
  exit 0
fi

GATEWAY_URL="${GATEWAY_URL:-https://cometens-gateway-production.jhfnetboy.workers.dev}"

# ── Step 1: Deploy L2RecordsV2 (OP Mainnet) ──────────────────────────────────
echo ""
echo "▶ Step 1/4 — Deploy L2RecordsV2 (OP Mainnet)"
cd "$ROOT/contracts"
forge script script/DeployL2RecordsV2.s.sol \
  --rpc-url "$OP_MAINNET_RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --broadcast \
  --verify \
  2>&1 | tee /tmp/deploy-l2records-prod.log

L2_ADDR=$(grep -oP '(?<=L2RecordsV2 deployed at: )0x[0-9a-fA-F]+' /tmp/deploy-l2records-prod.log || \
          grep -oP '(?<=Contract Address: )0x[0-9a-fA-F]+' /tmp/deploy-l2records-prod.log | tail -1)
echo "  L2RecordsV2 deployed: $L2_ADDR"

# ── Step 2: Deploy OffchainResolver (Mainnet) ────────────────────────────────
echo ""
echo "▶ Step 2/4 — Deploy OffchainResolver (Ethereum Mainnet)"
echo "  Gateway URL: $GATEWAY_URL"
GATEWAY_URL="$GATEWAY_URL" \
forge script script/DeployOffchainResolver.s.sol \
  --rpc-url "$MAINNET_RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --broadcast \
  --verify \
  2>&1 | tee /tmp/deploy-resolver-prod.log

RESOLVER_ADDR=$(grep -oP '(?<=Deployed OffchainResolver at: )0x[0-9a-fA-F]+' /tmp/deploy-resolver-prod.log || \
               grep -oP '(?<=Contract Address: )0x[0-9a-fA-F]+' /tmp/deploy-resolver-prod.log | tail -1)
echo "  OffchainResolver deployed: $RESOLVER_ADDR"

# ── Step 3: Deploy Gateway CF Worker (production) ────────────────────────────
echo ""
echo "▶ Step 3/4 — Deploy Gateway Cloudflare Worker (production)"
cd "$ROOT/workers/gateway"

# Update production L2Records address in wrangler.toml
if [[ -n "${L2_ADDR:-}" ]]; then
  sed -i.bak "s|L2_RECORDS_ADDRESS = \"[^\"]*\"|L2_RECORDS_ADDRESS = \"$L2_ADDR\"|g" wrangler.toml
  echo "  Updated wrangler.toml production L2_RECORDS_ADDRESS = $L2_ADDR"
fi

# Set production secrets
echo ""
echo "  Setting Gateway Worker secrets..."
echo "${OP_MAINNET_RPC_URL}" | wrangler secret put OP_RPC_URL --env production
echo "${PRIVATE_KEY_SUPPLIER:-$PRIVATE_KEY}" | wrangler secret put PRIVATE_KEY_SUPPLIER --env production

wrangler deploy --env production

# ── Step 4: Deploy API CF Worker (production) ────────────────────────────────
echo ""
echo "▶ Step 4/4 — Deploy API Cloudflare Worker (production)"
cd "$ROOT/workers/api"

# Update production L2Records address in wrangler.toml
if [[ -n "${L2_ADDR:-}" ]]; then
  sed -i.bak "s|L2_RECORDS_ADDRESS = \"[^\"]*\"|L2_RECORDS_ADDRESS = \"$L2_ADDR\"|g" wrangler.toml
  echo "  Updated API wrangler.toml production L2_RECORDS_ADDRESS = $L2_ADDR"
fi

# Set production secrets
echo ""
echo "  Setting API Worker secrets..."
echo "${OP_MAINNET_RPC_URL}" | wrangler secret put OP_RPC_URL --env production
echo "${WORKER_EOA_PRIVATE_KEY:-$PRIVATE_KEY}" | wrangler secret put WORKER_EOA_PRIVATE_KEY --env production
echo "${UPSTREAM_ALLOWED_SIGNERS:-$DEPLOYER_ADDRESS}" | wrangler secret put UPSTREAM_ALLOWED_SIGNERS --env production

wrangler deploy --env production

echo ""
echo "═══════════════════════════════════════════════"
echo "  ✓ Production deploy complete"
echo ""
echo "  L2RecordsV2:      ${L2_ADDR:-see log}"
echo "  OffchainResolver: ${RESOLVER_ADDR:-see log}"
echo "  Gateway:          $GATEWAY_URL"
echo "  API:              https://cometens-api-production.jhfnetboy.workers.dev"
echo ""
echo "  Next steps:"
echo "  1. Update .env.production: VITE_L2_RECORDS_ADDRESS=$L2_ADDR"
echo "  2. Set resolver on Mainnet ENS for your .eth name"
echo "  3. (Optional) Assign custom domains in CF dashboard"
echo "     Uncomment [[env.production.routes]] in both wrangler.toml files"
echo "═══════════════════════════════════════════════"
