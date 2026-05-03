# CometENS — ENS App Resolution Test Cases

Created: 2026-04-04 23:30 CST

## Test Environment

| Item | Value |
|------|-------|
| L2RecordsV3 (OP Sepolia) | `0x8836E89D654141a858f680e995CA86f6644A29a5` |
| OPResolver (ETH Sepolia) | `0x9070d42C9C12333053565e7ee8c4BdDE9Ca73083` |
| OffchainResolver (ETH Sepolia) | `0xe138Ec90E6a793F69455a45cF78494c7baFd1A1b` |
| Gateway Worker | `https://cometens-gateway.jhfnetboy.workers.dev` |
| Deployer/Signer | `0xb5600060e6de5E11D3636731964218E53caadf0E` |

---

## Test Case 1: Signature Mode (immediate resolution)

| Field | Value |
|-------|-------|
| **Name** | `sig1.forest.aastar.eth` |
| **Mode** | Signature (OffchainResolver + PROOF_MODE=false) |
| **L2 Tx** | `0xbbb615e8ed6c2d0c077316ce597cf80c617660522c7d60fb0cd1ab0bae21a81a` |
| **L2 Block** | 41,755,989 |
| **Registered** | 2026-04-04 22:55 CST |
| **Resolved addr** | `0xb5600060e6de5E11D3636731964218E53caadf0E` |
| **L1 CCIP-Read** | resolveWithProof on OffchainResolver — **PASS** (immediate) |
| **ENS App** | https://sepolia.app.ens.domains/sig1.forest.aastar.eth — **PASS** (user confirmed) |
| **Expected delay** | 0 (signature mode = instant) |

**Verification steps:**
1. ENS Registry: `forest.aastar.eth` resolver → OffchainResolver (`0xe138...`)
2. Gateway: PROOF_MODE=false, POST `/` returns signed response
3. L1: `resolveWithProof()` verifies ECDSA signature → returns addr
4. ENS App loads the name and shows the address

---

## Test Case 2: Proof Mode — new registration (waiting for finalization)

| Field | Value |
|-------|-------|
| **Name** | `proof1.forest.aastar.eth` |
| **Mode** | Proof (OPResolver + PROOF_MODE=true) |
| **L2 Tx** | `0x4ffea667650b3343a1dc74329af25fbb11adcbc7107e054ff442b486541b1940` |
| **L2 Block** | 41,756,799 |
| **Registered** | 2026-04-04 23:20 CST |
| **Resolved addr** | `0xb5600060e6de5E11D3636731964218E53caadf0E` (on L2 directly) |
| **L1 CCIP-Read** | `fetchCallback` returns correct addr — **PASS** (2026-05-03) |
| **ENS App** | https://sepolia.app.ens.domains/proof1.forest.aastar.eth |
| **ASR anchor at test time** | L2 block 41,604,994 (151,939 blocks behind) |
| **ASR anchor at verification** | L2 block 42,689,800 (> registration block ✓) |
| **Verified** | 2026-05-03 — `scripts/check-proof-resolution.mjs` **ALL PASS** |

**Verification steps (to run after estimated time):**
```bash
# 1. Check ASR anchor has advanced past 41756799
cast call 0xa1Cec548926eb5d69aa3B7B57d371EdBdD03e64b "anchors(uint32)(bytes32,uint256)" 1 --rpc-url $SEPOLIA_RPC_URL

# 2. Check gateway returns proof (not 503)
curl -s "https://cometens-gateway.jhfnetboy.workers.dev/0x9070d42C9C12333053565e7ee8c4BdDE9Ca73083/$(cast calldata 'addr(bytes32)' $(cast namehash 'proof1.forest.aastar.eth'))"

# 3. Check ENS App
open https://sepolia.app.ens.domains/proof1.forest.aastar.eth
```

---

## Test Case 3: Proof Mode — re-registered name (waiting for finalization)

| Field | Value |
|-------|-------|
| **Name** | `2.forest.aastar.eth` |
| **Mode** | Proof (OPResolver + PROOF_MODE=true) |
| **L2 Tx (V3 re-register)** | `0x49b04f37a0a7c44d16cc573c83f8ce2a173e11750cdd5dab66a6b214449721b8` |
| **L2 Block** | 41,756,901 |
| **Registered** | 2026-04-04 23:25 CST (re-registered on V3; originally on V2) |
| **Resolved addr** | `0x935f8694855FA9f1D1520E43689219ED4fFF8c97` (on L2 directly) |
| **L1 CCIP-Read** | `fetchCallback` returns correct addr — **PASS** (2026-05-03) |
| **ENS App** | https://sepolia.app.ens.domains/2.forest.aastar.eth |
| **ASR anchor at test time** | L2 block 41,604,994 |
| **ASR anchor at verification** | L2 block 42,689,800 (> registration block ✓) |
| **Verified** | 2026-05-03 — `scripts/check-proof-resolution.mjs` **ALL PASS** |

**Note:** This name was originally registered on L2RecordsV2 (now obsolete). It had to be re-registered on V3 because OPResolver reads from V3 storage slots (7/8/9).

**Verification steps:** Same as Test Case 2, substituting `2.forest.aastar.eth`.

---

## Summary

| Test Case | Mode | Name | Status | Verified |
|-----------|------|------|--------|---------|
| 1 | Signature | sig1.forest.aastar.eth | **PASS** | 2026-04-04 (immediate) |
| 2 | Proof | proof1.forest.aastar.eth | **PASS** | 2026-05-03 |
| 3 | Proof | 2.forest.aastar.eth | **PASS** | 2026-05-03 |

## Key Findings

1. **Signature mode works immediately** — no delay, ENS App resolves as soon as L2 registration confirms.

2. **Proof mode works after dispute game finalization** — once the ASR anchor advances past the L2 registration block, `OPFaultVerifier.getStorageValues()` returns the verified address.

3. **OP Sepolia dispute game cadence is ~1 per challenge period** (~151,200 blocks = 3.5 days). The anchor is always ~1 challenge period behind current head. This is expected testnet behavior (few validators).

4. **503 guard threshold was fixed** — raised from 1800 blocks to 230,000 blocks for `op-sepolia` in `ANCHOR_STALE_THRESHOLD`. Mainnet threshold (1800) unchanged.

5. **viem `getEnsAddress()` + new Universal Resolver incompatibility** — the 2026-05 version of the ENS Universal Resolver (`0xeeeeeeee...`) on Sepolia uses `resolveWithGateways()` which doesn't properly handle our `@unruggable/gateways` CCIP-Read callback. Use the manual CCIP-Read flow (see `scripts/check-proof-resolution.mjs`) for testing.

6. **forest.aastar.eth now uses OPResolver** — all subdomains resolve via proof mode.

## How to Re-verify

```bash
# Full end-to-end proof mode test (manual CCIP-Read flow, bypasses viem UR incompatibility)
node scripts/check-proof-resolution.mjs
```

The script:
1. Calls `OPResolver.resolve()` via raw `eth_call` to get the `OffchainLookup`
2. Fetches the storage proof from the gateway via `curl` (proxy-aware)
3. Calls `OPResolver.fetchCallback(proof, carry)` to verify on L1
4. Checks the returned address matches expected

Note: Node.js native `fetch` doesn't use the system proxy (`127.0.0.1:7890`). The script uses `curl` (which respects `https_proxy`) for the gateway call.
