#!/usr/bin/env bash
# E2E test: register subdomains under multiple root domains via the API Worker.
# Requires: cast (foundry), .env.local with PRIVATE_KEY_SUPPLIER + OP_SEPOLIA_RPC_URL
set -euo pipefail

source .env.local 2>/dev/null || source .env.op-sepolia 2>/dev/null

API="https://cometens-api.jhfnetboy.workers.dev"
V3="0x8836E89D654141a858f680e995CA86f6644A29a5"
CHAIN_ID=11155420  # OP Sepolia
SIGNER_KEY="$PRIVATE_KEY_SUPPLIER"
SIGNER_ADDR=$(cast wallet address "$SIGNER_KEY")

echo "=== D6 Multi-Root Domain E2E Test ==="
echo "API: $API"
echo "Signer: $SIGNER_ADDR"
echo ""

# ── Step 1: Verify /root-domains returns both roots ──────────────────────────
echo "--- Step 1: GET /root-domains ---"
DOMAINS=$(curl -sf "$API/root-domains")
echo "$DOMAINS" | python3 -m json.tool
echo ""

# Check that both domains are present
echo "$DOMAINS" | python3 -c "
import sys, json
d = json.load(sys.stdin)['domains']
assert 'forest.aastar.eth' in d, 'forest.aastar.eth missing'
assert 'game.aastar.eth' in d, 'game.aastar.eth missing'
print('✓ Both root domains present')
"
echo ""

# ── Step 2: Register under game.aastar.eth ──────────────────────────────────
LABEL="d6test$(date +%s | tail -c 5)"
PARENT="game.aastar.eth"
FULL_NAME="${LABEL}.${PARENT}"
NOW=$(date +%s)
NONCE=$((NOW * 1000))
DEADLINE=$((NOW + 600))

echo "--- Step 2: Register ${FULL_NAME} ---"

# Check availability
echo "Checking availability..."
AVAIL=$(curl -sf "$API/check-label?label=${LABEL}&parent=${PARENT}")
echo "$AVAIL" | python3 -m json.tool

# Build EIP-712 typed data JSON and sign via temp file
TMPJSON=$(mktemp /tmp/eip712-XXXXXX.json)
trap "rm -f $TMPJSON" EXIT

sign_register() {
  local parent=$1 label=$2 nonce=$3 deadline=$4
  cat > "$TMPJSON" <<EOFJ
{
  "types": {
    "EIP712Domain": [
      {"name":"name","type":"string"},
      {"name":"version","type":"string"},
      {"name":"chainId","type":"uint256"},
      {"name":"verifyingContract","type":"address"}
    ],
    "Register": [
      {"name":"parent","type":"string"},
      {"name":"label","type":"string"},
      {"name":"owner","type":"address"},
      {"name":"nonce","type":"uint256"},
      {"name":"deadline","type":"uint256"}
    ]
  },
  "primaryType": "Register",
  "domain": {
    "name": "CometENS",
    "version": "1",
    "chainId": ${CHAIN_ID},
    "verifyingContract": "${V3}"
  },
  "message": {
    "parent": "${parent}",
    "label": "${label}",
    "owner": "${SIGNER_ADDR}",
    "nonce": "${nonce}",
    "deadline": "${deadline}"
  }
}
EOFJ
  cast wallet sign --data --from-file --private-key "$SIGNER_KEY" "$TMPJSON"
}

# EIP-712 sign
echo "Signing EIP-712 Register message..."
SIG=$(sign_register "$PARENT" "$LABEL" "$NONCE" "$DEADLINE")
echo "Signature: ${SIG:0:20}..."

# Submit registration
echo "Submitting to /register..."
REG_RESULT=$(curl -sf -X POST "$API/register" \
  -H "content-type: application/json" \
  -d "{
    \"from\": \"${SIGNER_ADDR}\",
    \"signature\": \"${SIG}\",
    \"domain\": { \"verifyingContract\": \"${V3}\" },
    \"message\": {
      \"parent\": \"${PARENT}\",
      \"label\": \"${LABEL}\",
      \"owner\": \"${SIGNER_ADDR}\",
      \"nonce\": \"${NONCE}\",
      \"deadline\": \"${DEADLINE}\"
    }
  }")
echo "$REG_RESULT" | python3 -m json.tool
echo ""

# Extract txHash
TX_HASH=$(echo "$REG_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('txHash',''))")
echo "Tx: $TX_HASH"

# ── Step 3: Verify on L2 ─────────────────────────────────────────────────────
echo ""
echo "--- Step 3: Verify on L2 ---"
sleep 3  # Wait for block confirmation

NODE=$(cast namehash "$FULL_NAME")
echo "Node: $NODE"

RESOLVED_ADDR=$(cast call "$V3" "addr(bytes32)(address)" "$NODE" --rpc-url "$OP_SEPOLIA_RPC_URL")
echo "Resolved addr: $RESOLVED_ADDR"

if [[ "$(echo "$RESOLVED_ADDR" | tr '[:upper:]' '[:lower:]')" == "$(echo "$SIGNER_ADDR" | tr '[:upper:]' '[:lower:]')" ]]; then
  echo "✓ L2 addr matches signer"
else
  echo "✗ L2 addr mismatch! Expected $SIGNER_ADDR, got $RESOLVED_ADDR"
  exit 1
fi

OWNER=$(cast call "$V3" "subnodeOwner(bytes32)(address)" "$NODE" --rpc-url "$OP_SEPOLIA_RPC_URL")
echo "Subnode owner: $OWNER"

# ── Step 4: Verify /lookup returns this name ─────────────────────────────────
echo ""
echo "--- Step 4: Verify /lookup ---"
LOOKUP=$(curl -sf "$API/lookup?address=${SIGNER_ADDR}")
echo "$LOOKUP" | python3 -m json.tool

echo "$LOOKUP" | python3 -c "
import sys, json
data = json.load(sys.stdin)
names = data.get('names', [])
assert '${FULL_NAME}' in names, '${FULL_NAME} not found in lookup names: ' + str(names)
print('✓ ${FULL_NAME} found in lookup')
"

# ── Step 5: Also register under forest.aastar.eth for comparison ─────────────
echo ""
echo "--- Step 5: Register ${LABEL}.forest.aastar.eth ---"
PARENT2="forest.aastar.eth"
FULL_NAME2="${LABEL}.${PARENT2}"
NONCE2=$((NONCE + 1))

SIG2=$(sign_register "$PARENT2" "$LABEL" "$NONCE2" "$DEADLINE")

REG_RESULT2=$(curl -sf -X POST "$API/register" \
  -H "content-type: application/json" \
  -d "{
    \"from\": \"${SIGNER_ADDR}\",
    \"signature\": \"${SIG2}\",
    \"domain\": { \"verifyingContract\": \"${V3}\" },
    \"message\": {
      \"parent\": \"${PARENT2}\",
      \"label\": \"${LABEL}\",
      \"owner\": \"${SIGNER_ADDR}\",
      \"nonce\": \"${NONCE2}\",
      \"deadline\": \"${DEADLINE}\"
    }
  }")
echo "$REG_RESULT2" | python3 -m json.tool

# ── Step 6: Verify both names in /lookup ──────────────────────────────────────
echo ""
echo "--- Step 6: Verify both names in /lookup ---"
sleep 2
LOOKUP2=$(curl -sf "$API/lookup?address=${SIGNER_ADDR}")
echo "$LOOKUP2" | python3 -m json.tool

echo "$LOOKUP2" | python3 -c "
import sys, json
data = json.load(sys.stdin)
names = data.get('names', [])
assert '${FULL_NAME}' in names, '${FULL_NAME} not in names'
assert '${FULL_NAME2}' in names, '${FULL_NAME2} not in names'
print('✓ Both names found: ${FULL_NAME} and ${FULL_NAME2}')
"

echo ""
echo "=== D6 Multi-Root E2E Test PASSED ==="
