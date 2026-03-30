#!/usr/bin/env bash
# ─── CometENS — Deploy to Production (OP Mainnet + Ethereum Mainnet) ──────────
# Usage: bash scripts/deploy-production.sh
#
# Deploys:
#   1. L2Records         → Optimism Mainnet (10)
#   2. OffchainResolver  → Ethereum Mainnet (1)
#   3. CF Worker         → cometens-gateway-production
#
# Required env vars (.env.production or exported):
#   OP_MAINNET_RPC_URL, MAINNET_RPC_URL
#   PRIVATE_KEY (deployer, 0x-prefixed)
#   DEPLOYER_ADDRESS, SIGNER_ADDRESS
#   GATEWAY_URL (production gateway — custom domain recommended)
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

# ── Step 1: Deploy L2Records (OP Mainnet) ────────────────────────────────────
echo ""
echo "▶ Step 1/3 — Deploy L2Records (OP Mainnet)"
cd "$ROOT/contracts"
forge script script/DeployL2Records.s.sol \
  --rpc-url "$OP_MAINNET_RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --broadcast \
  --verify \
  2>&1 | tee /tmp/deploy-l2records-prod.log

L2_ADDR=$(grep -oP '(?<=Deployed L2Records at: )0x[0-9a-fA-F]+' /tmp/deploy-l2records-prod.log || \
          grep -oP '(?<=Contract Address: )0x[0-9a-fA-F]+' /tmp/deploy-l2records-prod.log | tail -1)
echo "  L2Records deployed: $L2_ADDR"

# ── Step 2: Deploy OffchainResolver (Mainnet) ────────────────────────────────
echo ""
echo "▶ Step 2/3 — Deploy OffchainResolver (Ethereum Mainnet)"
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

# ── Step 3: Deploy CF Worker (production) ────────────────────────────────────
echo ""
echo "▶ Step 3/3 — Deploy Cloudflare Worker (production)"
cd "$ROOT/workers/gateway"

# Update production L2Records address in wrangler.toml
if [[ -n "${L2_ADDR:-}" ]]; then
  # Update the production section specifically
  python3 - <<PYEOF
import re, pathlib
p = pathlib.Path('wrangler.toml')
content = p.read_text()
# Replace L2_RECORDS_ADDRESS in the [env.production] section
content = re.sub(
  r'(\[env\.production\].*?L2_RECORDS_ADDRESS = ")[^"]+(")',
  rf'\g<1>{os.environ["L2_ADDR"]}\g<2>',
  content, flags=re.DOTALL
)
p.write_text(content)
PYEOF
  echo "  Updated wrangler.toml production L2_RECORDS_ADDRESS = $L2_ADDR"
fi

# Set production secrets
echo ""
echo "  Setting production Worker secrets..."
echo "$OP_MAINNET_RPC_URL" | wrangler secret put OP_RPC_URL --env production
echo "$PRIVATE_KEY_SUPPLIER" | wrangler secret put PRIVATE_KEY_SUPPLIER --env production

wrangler deploy --env production

echo ""
echo "═══════════════════════════════════════════════"
echo "  ✓ Production deploy complete"
echo ""
echo "  L2Records:        ${L2_ADDR:-see log}"
echo "  OffchainResolver: ${RESOLVER_ADDR:-see log}"
echo "  Gateway:          $GATEWAY_URL"
echo ""
echo "  Next steps:"
echo "  1. Update .env.production: VITE_L2_RECORDS_ADDRESS=$L2_ADDR"
echo "  2. Set resolver on Mainnet ENS for your .eth name"
echo "  3. (Optional) Assign a custom domain in CF dashboard, then:"
echo "     Uncomment [[env.production.routes]] in workers/gateway/wrangler.toml"
echo "     and run: wrangler deploy --env production"
echo "═══════════════════════════════════════════════"
