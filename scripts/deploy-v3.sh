#!/usr/bin/env bash
# ─── CometENS — Migrate to L2RecordsV3 (Fix OPResolver storage slot mismatch) ─
#
# Root cause: OPResolver was designed for L2RecordsV3 (slots 7/8/9) but testnet
# was running L2RecordsV2 (slots 1/2/3). Proof generation returned wrong slots.
#
# This script:
#   1. Deploys L2RecordsV3 to OP Sepolia
#   2. Adds Worker EOA as registrar on V3 (for forest.aastar.eth + aastar.eth)
#   3. Calls OPResolver.setL2RecordsAddress(v3) on ETH Sepolia (no redeploy)
#   4. Updates workers/*/wrangler.toml
#   5. Deploys gateway + api CF workers
#
# Required env vars (in .env.local or exported):
#   OP_SEPOLIA_RPC_URL       — Optimism Sepolia RPC
#   SEPOLIA_RPC_URL          — Ethereum Sepolia RPC
#   PRIVATE_KEY_SUPPLIER     — Deployer key (owns OPResolver + will own V3)
#   DEPLOYER_ADDRESS         — Deployer address
#   WORKER_EOA_ADDRESS       — Worker EOA address (registrar on V3)
#
# Deployed addresses:
#   OPResolver (Eth Sepolia): 0x9070d42C9C12333053565e7ee8c4BdDE9Ca73083

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load .env.local
if [[ -f "$ROOT/.env.local" ]]; then
  set -o allexport
  # shellcheck disable=SC1091
  source "$ROOT/.env.local"
  set +o allexport
fi

# ── Validate env vars ─────────────────────────────────────────────────────────
: "${OP_SEPOLIA_RPC_URL:?OP_SEPOLIA_RPC_URL not set}"
: "${SEPOLIA_RPC_URL:?SEPOLIA_RPC_URL not set}"
: "${PRIVATE_KEY_SUPPLIER:?PRIVATE_KEY_SUPPLIER not set}"
: "${DEPLOYER_ADDRESS:?DEPLOYER_ADDRESS not set}"
# Worker EOA defaults to DEPLOYER_ADDRESS (same key on testnet)
WORKER_EOA_ADDRESS="${WORKER_EOA_ADDRESS:-$DEPLOYER_ADDRESS}"

OP_RESOLVER="0x9070d42C9C12333053565e7ee8c4BdDE9Ca73083"

echo "═══════════════════════════════════════════════"
echo "  CometENS — Migrate to L2RecordsV3"
echo "  Fix: OPResolver storage slot mismatch"
echo "  Deployer: $DEPLOYER_ADDRESS"
echo "  Worker EOA: $WORKER_EOA_ADDRESS"
echo "  OPResolver: $OP_RESOLVER"
echo "═══════════════════════════════════════════════"

# ── Step 1: Deploy L2RecordsV3 to OP Sepolia ─────────────────────────────────
echo ""
echo "▶ Step 1/5 — Deploy L2RecordsV3 (OP Sepolia)"
cd "$ROOT/contracts"

DEPLOYER_ADDRESS="$DEPLOYER_ADDRESS" \
  forge script script/DeployL2RecordsV3.s.sol \
  --rpc-url "$OP_SEPOLIA_RPC_URL" \
  --private-key "$PRIVATE_KEY_SUPPLIER" \
  --broadcast \
  --slow \
  2>&1 | tee /tmp/deploy-v3.log

V3_ADDR=$(grep -oP '(?<=L2RecordsV3 deployed at: )0x[0-9a-fA-F]+' /tmp/deploy-v3.log | tail -1)
if [[ -z "$V3_ADDR" ]]; then
  echo "ERROR: Could not parse L2RecordsV3 address from forge output."
  echo "Check /tmp/deploy-v3.log"
  exit 1
fi
echo "  L2RecordsV3: $V3_ADDR"

# ── Step 2: Compute forest.aastar.eth and aastar.eth namehashes ───────────────
echo ""
echo "▶ Step 2/5 — Add Worker EOA as registrar on L2RecordsV3 (OP Sepolia)"

# Compute namehashes using cast
ETH_NODE=$(cast keccak $(cast concat-hex \
  0x0000000000000000000000000000000000000000000000000000000000000000 \
  $(cast keccak "eth")) 2>/dev/null || \
  cast from-utf8 "eth" | xargs cast keccak)

# Use viem-compatible namehash (cast ens-namehash)
AASTAR_NODE=$(cast ens-namehash "aastar.eth" 2>/dev/null || \
  python3 -c "
import hashlib
def keccak(b): import subprocess; r=subprocess.run(['cast','keccak','0x'+b.hex()],capture_output=True,text=True); return bytes.fromhex(r.stdout.strip()[2:])
zero=b'\x00'*32
eth_hash=keccak(b'eth')
aastar_hash=keccak(b'aastar')
step1=keccak(zero+eth_hash)
step2=keccak(step1+aastar_hash)
print('0x'+step2.hex())
")

FOREST_NODE=$(cast ens-namehash "forest.aastar.eth" 2>/dev/null || \
  python3 -c "
import subprocess
def keccak(data): r=subprocess.run(['cast','keccak','0x'+data.hex()],capture_output=True,text=True); return bytes.fromhex(r.stdout.strip()[2:])
zero=b'\x00'*32
step1=keccak(zero+keccak(b'eth'))
step2=keccak(step1+keccak(b'aastar'))
step3=keccak(step2+keccak(b'forest'))
print('0x'+step3.hex())
")

echo "  aastar.eth node: $AASTAR_NODE"
echo "  forest.aastar.eth node: $FOREST_NODE"

# Add Worker EOA as registrar for forest.aastar.eth (unlimited quota, no expiry)
echo "  addRegistrar: Worker EOA for forest.aastar.eth..."
cast send "$V3_ADDR" \
  "addRegistrar(bytes32,address,uint256,uint256)" \
  "$FOREST_NODE" "$WORKER_EOA_ADDRESS" 0 0 \
  --rpc-url "$OP_SEPOLIA_RPC_URL" \
  --private-key "$PRIVATE_KEY_SUPPLIER"

# Add Worker EOA as registrar for aastar.eth (unlimited quota, no expiry)
echo "  addRegistrar: Worker EOA for aastar.eth..."
cast send "$V3_ADDR" \
  "addRegistrar(bytes32,address,uint256,uint256)" \
  "$AASTAR_NODE" "$WORKER_EOA_ADDRESS" 0 0 \
  --rpc-url "$OP_SEPOLIA_RPC_URL" \
  --private-key "$PRIVATE_KEY_SUPPLIER"

echo "  ✓ Registrars added"

# ── Step 3: Update OPResolver.l2RecordsAddress (ETH Sepolia) ─────────────────
echo ""
echo "▶ Step 3/5 — Update OPResolver.setL2RecordsAddress (Ethereum Sepolia)"
cast send "$OP_RESOLVER" \
  "setL2RecordsAddress(address)" "$V3_ADDR" \
  --rpc-url "$SEPOLIA_RPC_URL" \
  --private-key "$PRIVATE_KEY_SUPPLIER"

# Verify
STORED=$(cast call "$OP_RESOLVER" "l2RecordsAddress()" --rpc-url "$SEPOLIA_RPC_URL" | \
  sed 's/0x000000000000000000000000/0x/')
echo "  ✓ OPResolver.l2RecordsAddress → $STORED"

# ── Step 4: Update wrangler.toml in both workers ─────────────────────────────
echo ""
echo "▶ Step 4/5 — Update wrangler.toml (both workers)"

sed -i.bak "s|L2_RECORDS_ADDRESS = \"[^\"]*\"|L2_RECORDS_ADDRESS = \"$V3_ADDR\"|g" \
  "$ROOT/workers/gateway/wrangler.toml"
rm -f "$ROOT/workers/gateway/wrangler.toml.bak"
echo "  ✓ workers/gateway/wrangler.toml updated"

sed -i.bak "s|L2_RECORDS_ADDRESS = \"[^\"]*\"|L2_RECORDS_ADDRESS = \"$V3_ADDR\"|g" \
  "$ROOT/workers/api/wrangler.toml"
rm -f "$ROOT/workers/api/wrangler.toml.bak"
echo "  ✓ workers/api/wrangler.toml updated"

# ── Step 5: Deploy CF Workers ─────────────────────────────────────────────────
echo ""
echo "▶ Step 5/5 — Deploy Cloudflare Workers (testnet)"

cd "$ROOT/workers/gateway"
wrangler deploy --env testnet
echo "  ✓ Gateway worker deployed"

cd "$ROOT/workers/api"
wrangler deploy --env testnet
echo "  ✓ API worker deployed"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════"
echo "  ✓ Migration to L2RecordsV3 complete"
echo ""
echo "  L2RecordsV3 (OP Sepolia): $V3_ADDR"
echo "  OPResolver (Eth Sepolia): $OP_RESOLVER"
echo "    l2RecordsAddress → $V3_ADDR"
echo ""
echo "  Next steps:"
echo "  1. Re-register test subdomains (jason.forest.aastar.eth, etc.)"
echo "     via https://cometens.pages.dev/register.html"
echo "  2. Verify ENS App resolution: https://sepolia.app.ens.domains/2.forest.aastar.eth"
echo "     (may take a few minutes for OP Sepolia fault game finalization)"
echo "═══════════════════════════════════════════════"
