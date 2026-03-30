#!/usr/bin/env bash
# ─── CometENS — Testnet resolution test (curl + cast) ─────────────────────────
# Tests the full CCIP-Read pipeline end-to-end using curl and cast.
# Works through http_proxy / https_proxy automatically (curl respects env vars).
#
# Usage:
#   bash scripts/resolve-testnet.sh alice
#   bash scripts/resolve-testnet.sh alice.aastar.eth
#   bash scripts/resolve-testnet.sh          # defaults to alice.aastar.eth

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ─── Load .env.local ──────────────────────────────────────────────────────────
load_env_var() {
  local key="$1" file="$ROOT/.env.local"
  [[ -f "$file" ]] || return
  grep -m1 "^${key}=" "$file" | sed "s/^${key}=//;s/^['\"]//;s/['\"]$//"
}

L1_RPC=$(load_env_var VITE_L1_SEPOLIA_RPC_URL)
RESOLVER=$(load_env_var VITE_L1_OFFCHAIN_RESOLVER_ADDRESS)
ROOT_DOMAIN=$(load_env_var VITE_ROOT_DOMAIN)
ROOT_DOMAIN="${ROOT_DOMAIN:-aastar.eth}"

[[ -z "$L1_RPC" ]] && { echo "Error: VITE_L1_SEPOLIA_RPC_URL not set in .env.local"; exit 1; }
[[ -z "$RESOLVER" ]] && { echo "Error: VITE_L1_OFFCHAIN_RESOLVER_ADDRESS not set in .env.local"; exit 1; }

# ─── Parse name ───────────────────────────────────────────────────────────────
ARG="${1:-alice}"
if [[ "$ARG" == *.* ]]; then
  NAME="$ARG"
else
  NAME="${ARG}.${ROOT_DOMAIN}"
fi

# ─── Helpers ──────────────────────────────────────────────────────────────────

rpc_call() {
  # $1 = to address, $2 = calldata
  local result
  result=$(curl -s --max-time 15 -X POST "$L1_RPC" \
    -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"to\":\"$1\",\"data\":\"$2\"},\"latest\"]}")
  if [[ $? -ne 0 || -z "$result" ]]; then
    echo '{"error":{"message":"RPC request failed or timed out"}}'
    return 0
  fi
  echo "$result"
}

# ─── Step 0: Read gateway URL from chain ──────────────────────────────────────

GW_SELECTOR="0x8bf165d9"  # keccak4("gatewayUrl()")
GW_RESPONSE=$(rpc_call "$RESOLVER" "$GW_SELECTOR")
GW_URL=$(echo "$GW_RESPONSE" | python3 -c "
import sys, json
hex = json.load(sys.stdin).get('result','')[2:]
if not hex: print('(unknown)'); exit()
off = int(hex[0:64], 16)
ln = int(hex[off*2:off*2+64], 16)
data = hex[off*2+64:off*2+64+ln*2]
print(bytes.fromhex(data).decode())
" 2>/dev/null || echo "(unknown)")

echo ""
echo "Resolving: $NAME"
echo "  L1 RPC:   ${L1_RPC/\/v2\/*/\/v2\/***}"
echo "  Resolver: $RESOLVER"
echo "  Gateway:  $GW_URL"
echo ""

# ─── Step 1: Compute namehash and dns-encode ───────────────────────────────────

NODE=$(cast namehash "$NAME")
echo "  Node:     $NODE"
echo ""

# DNS-encode the name
DNS_NAME=$(python3 -c "
name = '$NAME'
parts = name.split('.')
out = ''
for p in parts:
    b = p.encode()
    out += format(len(b), '02x') + b.hex()
out += '00'
print('0x' + out)
")

# ─── Step 2: Encode addr(bytes32) calldata ────────────────────────────────────

ADDR_SELECTOR="3b3b57de"
NODE_HEX="${NODE#0x}"
ADDR_CALLDATA="0x${ADDR_SELECTOR}${NODE_HEX}"

# Encode resolve(bytes name, bytes calldata) call
# resolve(bytes,bytes) selector = keccak4("resolve(bytes,bytes)")
RESOLVE_SELECTOR="9061b923"

encode_resolve() {
  local name_hex="${1#0x}"
  local data_hex="${2#0x}"
  local name_len=${#name_hex}
  local data_len=${#data_hex}
  local name_bytes=$((name_len / 2))
  local data_bytes=$((data_len / 2))
  # ABI encoding: offset_name(32) + offset_data(32) + len_name(32) + name_padded + len_data(32) + data_padded
  local name_padded_len=$(( (name_bytes + 31) / 32 * 32 ))
  local data_padded_len=$(( (data_bytes + 31) / 32 * 32 ))
  local offset_name="0000000000000000000000000000000000000000000000000000000000000040"  # 64
  local offset_data
  offset_data=$(printf '%064x' $((64 + 32 + name_padded_len)))
  local len_name
  len_name=$(printf '%064x' "$name_bytes")
  local name_padded
  name_padded=$(printf "%-$((name_padded_len * 2))s" "$name_hex" | tr ' ' '0')
  local len_data
  len_data=$(printf '%064x' "$data_bytes")
  local data_padded
  data_padded=$(printf "%-$((data_padded_len * 2))s" "$data_hex" | tr ' ' '0')
  echo "0x${RESOLVE_SELECTOR}${offset_name}${offset_data}${len_name}${name_padded}${len_data}${data_padded}"
}

RESOLVE_CALLDATA=$(encode_resolve "$DNS_NAME" "$ADDR_CALLDATA")

# ─── Step 3: Call OffchainResolver.resolve() — expect OffchainLookup ──────────

STEP1=$(rpc_call "$RESOLVER" "$RESOLVE_CALLDATA")

# Check for OffchainLookup error (selector 0x556f1830)
REVERT_DATA=$(echo "$STEP1" | python3 -c "
import sys, json
j = json.load(sys.stdin)
if 'error' in j and 'data' in j['error']:
    print(j['error']['data'])
else:
    print('')
" 2>/dev/null)

if [[ -z "$REVERT_DATA" ]]; then
  # Check if the RPC returned a result instead of a revert (name not registered)
  RESULT_DATA=$(echo "$STEP1" | python3 -c "import sys,json; print(json.load(sys.stdin).get('result',''))" 2>/dev/null)
  if [[ -n "$RESULT_DATA" && "$RESULT_DATA" != "null" ]]; then
    echo "addr(ETH): ERROR — resolve() did not revert (check resolver config)"
  else
    echo "addr(ETH): ERROR — RPC call failed or no OffchainLookup revert"
  fi
  echo ""; echo "✓ Done"; exit 0
fi

REVERT_SELECTOR="${REVERT_DATA:0:10}"
if [[ "$REVERT_SELECTOR" != "0x556f1830" ]]; then
  echo "addr(ETH): ERROR — unexpected revert selector $REVERT_SELECTOR"
  echo ""; echo "✓ Done"; exit 0
fi

# ─── Step 4: Decode OffchainLookup and call gateway ───────────────────────────

GW_RESULT=$(python3 - "$REVERT_DATA" "$GW_URL" <<'PYEOF'
import sys, json

revert_hex = sys.argv[1][10:]  # strip 0x556f1830

def slot(i):
    return revert_hex[i*64:(i+1)*64]

def read_bytes(offset_slots):
    ln = int(slot(offset_slots), 16)
    data = revert_hex[(offset_slots+1)*64:(offset_slots+1)*64 + ln*2]
    return '0x' + data

def read_string(offset_slots):
    ln = int(slot(offset_slots), 16)
    data = revert_hex[(offset_slots+1)*64:(offset_slots+1)*64 + ln*2]
    return bytes.fromhex(data).decode()

# Layout: sender(32), urls_offset(32), calldata_offset(32), callback(32), extradata_offset(32)
sender = '0x' + slot(0)[24:]          # last 20 bytes of 32-byte slot
urls_offset = int(slot(1), 16) // 32  # in slots
calldata_offset = int(slot(2), 16) // 32
# slot(3) = callbackFunction (bytes4)
extradata_offset = int(slot(4), 16) // 32

# Parse urls array
url_count = int(slot(urls_offset), 16)
first_url = ''
if url_count > 0:
    str_offset = int(slot(urls_offset + 1), 16) // 32
    first_url = read_string(urls_offset + str_offset + 1)

calldata_bytes = read_bytes(calldata_offset)
extradata_bytes = read_bytes(extradata_offset)

print(json.dumps({
    'sender': sender,
    'url': first_url,
    'callData': calldata_bytes,
    'extraData': extradata_bytes
}))
PYEOF
)

if [[ -z "$GW_RESULT" ]]; then
  echo "addr(ETH): ERROR — failed to decode OffchainLookup data"
  echo ""; echo "✓ Done"; exit 0
fi

CALL_DATA=$(echo "$GW_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['callData'])" 2>/dev/null)
SENDER=$(echo "$GW_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['sender'])" 2>/dev/null)
EXTRA_DATA=$(echo "$GW_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['extraData'])" 2>/dev/null)
GATEWAY_URL_USED=$(echo "$GW_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['url'])" 2>/dev/null)

# ─── Step 5: POST to gateway ──────────────────────────────────────────────────

GW_RESPONSE=$(curl -s --max-time 15 -X POST "$GATEWAY_URL_USED" \
  -H "Content-Type: application/json" \
  -d "{\"data\":\"$CALL_DATA\",\"sender\":\"$SENDER\"}")
if [[ $? -ne 0 || -z "$GW_RESPONSE" ]]; then
  echo "addr(ETH): ERROR — gateway request failed"
  echo ""; echo "✓ Done"; exit 0
fi

GW_DATA=$(echo "$GW_RESPONSE" | python3 -c "
import sys, json
try:
    j = json.load(sys.stdin)
    if 'error' in j:
        print('ERR:' + str(j['error']))
    else:
        print(j['data'])
except Exception as e:
    print('ERR:' + str(e))
" 2>/dev/null)
if [[ -z "$GW_DATA" || "$GW_DATA" == ERR:* ]]; then
  echo "addr(ETH): ERROR — gateway error: ${GW_DATA#ERR:}"
  echo ""; echo "✓ Done"; exit 0
fi

# ─── Step 6: resolveWithProof ─────────────────────────────────────────────────

# resolveWithProof(bytes,bytes) selector = keccak4("resolveWithProof(bytes,bytes)")
PROOF_SELECTOR="f4d4d2f8"

encode_two_bytes() {
  local a_hex="${1#0x}"
  local b_hex="${2#0x}"
  local a_bytes=$(( ${#a_hex} / 2 ))
  local b_bytes=$(( ${#b_hex} / 2 ))
  local a_padded_len=$(( (a_bytes + 31) / 32 * 32 ))
  local b_padded_len=$(( (b_bytes + 31) / 32 * 32 ))
  local off_a="0000000000000000000000000000000000000000000000000000000000000040"
  local off_b
  off_b=$(printf '%064x' $((64 + 32 + a_padded_len)))
  local len_a
  len_a=$(printf '%064x' "$a_bytes")
  local a_padded
  a_padded=$(printf "%-$((a_padded_len * 2))s" "$a_hex" | tr ' ' '0')
  local len_b
  len_b=$(printf '%064x' "$b_bytes")
  local b_padded
  b_padded=$(printf "%-$((b_padded_len * 2))s" "$b_hex" | tr ' ' '0')
  echo "0x${PROOF_SELECTOR}${off_a}${off_b}${len_a}${a_padded}${len_b}${b_padded}"
}

PROOF_CALLDATA=$(encode_two_bytes "$GW_DATA" "$EXTRA_DATA")
PROOF_RESULT=$(rpc_call "$RESOLVER" "$PROOF_CALLDATA")

# ─── Step 7: Decode result ────────────────────────────────────────────────────

python3 - "$PROOF_RESULT" "$NAME" <<'PYEOF'
import sys, json

j = json.loads(sys.argv[1])
name = sys.argv[2]

if 'error' in j:
    print(f"addr(ETH): ERROR — resolveWithProof reverted: {j['error'].get('message','')}")
    sys.exit(0)

raw = j.get('result', '')[2:]  # strip 0x
if not raw or raw == '0' * len(raw):
    print("addr(ETH): (not set)")
    sys.exit(0)

# Outer bytes wrapper: offset(32) + length(32) + data
outer_offset = int(raw[0:64], 16)
inner_len = int(raw[outer_offset*2:outer_offset*2+64], 16)
inner = raw[outer_offset*2+64:outer_offset*2+64+inner_len*2]

# Inner is ABI-encoded address: 12 bytes padding + 20 bytes
if len(inner) >= 64:
    addr = '0x' + inner[24:64]
    if addr == '0x' + '0'*40:
        print("addr(ETH): (not set)")
    else:
        # Convert to checksum address via cast
        import subprocess
        try:
            cs = subprocess.check_output(['cast', 'to-check-sum-address', addr], text=True).strip()
            print(f"addr(ETH): {cs}")
        except Exception:
            print(f"addr(ETH): {addr}")
else:
    print(f"addr(ETH): (not set)")
PYEOF

echo ""
echo "✓ Done"
