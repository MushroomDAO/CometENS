#!/usr/bin/env bash
# Explicitly OFFLINE G2 local harness. This script never invokes `forge script`.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$#" -ne 1 || ! -f "$1" ]]; then
  echo 'Usage: bash scripts/g2-native-testnet-dry-run.sh /path/to/local-readiness.json' >&2
  exit 1
fi
MANIFEST="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
export COMETENS_LIVE_WRITE_TESTS=0
# Unset common secrets without printing, deriving or sending their values.
unset PRIVATE_KEY PRIVATE_KEY_SUPPLIER WORKER_EOA_PRIVATE_KEY DEPLOYER_PRIVATE_KEY
cd "$ROOT"
forge build --root contracts
forge test --root contracts --no-cache
# The CLI always exits nonzero: BLOCKED means never permission to broadcast.
node scripts/check-g2-native-testnet-readiness.mjs --manifest "$MANIFEST"
