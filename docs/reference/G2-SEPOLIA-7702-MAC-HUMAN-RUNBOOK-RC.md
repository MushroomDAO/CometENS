# Sepolia EIP-7702 — Mac Terminal human-only release candidate

**NOT AUTHORIZED TO EXECUTE.** This is a candidate operator procedure, not permission to sign or broadcast. Require (1) independent security clearance explicitly stating **EXECUTE** for the exact two runtime scripts and SHA, and (2) the wallet owner's separate affirmative authorization and confirmation that their existing private key controls the pinned wallet. A merge approval, passing CI, and `check` success grant neither permission. Never give private-key bytes to an AI, terminal transcript, reviewer, or automation. A human must type the execute command and its exact terminal confirmation personally. G3 remains blocked.

## 1. Verify and materialize pinned code (read-only GitHub requests)

The reviewed candidate is **main commit `d28ab52166f9ecc28c22668f6eafbb6e1914bc5f`**, comprising merged #187/#189. If an independent EXECUTE reviewer approves a different runtime commit, **stop and replace this entire candidate only after renewed review**, including digest and dependency checking. On the operator Mac, start at the actual repository root with installed project dependencies (`node_modules/viem`). Do **not** run the pre-existing local `scripts/g2-sepolia-human-7702-revoke.mjs`: its observed SHA256 `cbb747fb...` differs from merged code `ecebd459...`. Do not overwrite the old file.

```sh
# HUMAN: inspect current directory; stop if this is not the CometENS repository root.
pwd
test -d node_modules/viem || { echo 'STOP: missing local viem dependency'; exit 2; }
set -euo pipefail
PIN=d28ab52166f9ecc28c22668f6eafbb6e1914bc5f
RUNNER="$PWD/.g2-7702-human-runner-$PIN"
# Directory must be absent: avoid inheriting untrusted or previously edited files.
test ! -e "$RUNNER" || { echo 'STOP: runner already exists'; exit 2; }
( umask 077; mkdir -m 700 "$RUNNER"; mkdir -m 700 "$RUNNER/scripts" )
for NAME in g2-sepolia-human-7702-revoke.mjs check-g2-sepolia-7702-revocation.mjs; do
  gh api --method GET "repos/MushroomDAO/CometENS/contents/scripts/$NAME" -f "ref=$PIN" --jq .content | base64 -D > "$RUNNER/scripts/$NAME"
  chmod 600 "$RUNNER/scripts/$NAME"
done
EXPECTED_EXEC=ecebd4592955f69b9a487bf47eab2217ff02608b3f9a777187777825656b8c7b
EXPECTED_CHECK=3ac1227ac1895f403b81868158e61e2fdceeefc9b88c2c3f0d71a5ad4ddd643d
ACTUAL_EXEC=$(shasum -a 256 "$RUNNER/scripts/g2-sepolia-human-7702-revoke.mjs" | awk '{print $1}')
ACTUAL_CHECK=$(shasum -a 256 "$RUNNER/scripts/check-g2-sepolia-7702-revocation.mjs" | awk '{print $1}')
test "$ACTUAL_EXEC" = "$EXPECTED_EXEC" || { echo 'STOP: executor SHA256 mismatch'; exit 2; }
test "$ACTUAL_CHECK" = "$EXPECTED_CHECK" || { echo 'STOP: checker SHA256 mismatch'; exit 2; }
# No symlink/redirect to the outdated source files; imported checker stays alongside executor.
test ! -L "$RUNNER/scripts/g2-sepolia-human-7702-revoke.mjs"
test ! -L "$RUNNER/scripts/check-g2-sepolia-7702-revocation.mjs"
node --check "$RUNNER/scripts/g2-sepolia-human-7702-revoke.mjs"
node --check "$RUNNER/scripts/check-g2-sepolia-7702-revocation.mjs"
printf 'PINNED verified: %s\n' "$PIN"
```

The runner is a direct child of the repository, so the ESM import `viem` resolves upward to the repository's `node_modules`; both local imports resolve within the isolated `scripts` folder. GitHub fetch failure, changed bytes, missing dependencies, or an existing runner directory are hard stops. These checks verify code identity, not security approval. Treat the runner directory as sensitive and do not upload it. Run the commands individually in a human-owned interactive Mac Terminal; avoid copying commands from a modified document.

## 2. Owner-controlled private files and expiring order

The exact runtime accepts only direct-child paths inside `$HOME/.config/cometens-g2-sepolia`, which must be owned by the current macOS user, non-symlink, and mode **0700**. Order, existing key, journals and locks must be regular files mode **0600**. Do not print or `cat` the private key; the human wallet owner must already possess the matching Sepolia key in the required directory. The process must never import or copy a key from an AI workspace. Stop if the wallet, network or key ownership cannot be confirmed out of band.

```sh
umask 077
PRIVATE="$HOME/.config/cometens-g2-sepolia"
mkdir -p -m 700 "$HOME/.config" "$PRIVATE"
chmod 700 "$PRIVATE"
test ! -L "$PRIVATE" || { echo 'STOP: symlink private dir'; exit 2; }
# OWNER MUST PLACE AN EXISTING MATCHING 0600 KEY HERE OUT OF BAND; do not create/generate/read it here.
KEY="$PRIVATE/owner-existing-sepolia-key"
[ -f "$KEY" ] && [ ! -L "$KEY" ] && [ "$(stat -f %Lp "$KEY")" = 600 ] || { echo 'STOP: key path/permissions'; exit 2; }
# Confirm pinned WALLET manually from the checker and wallet owner, not from a guessed address.
rg '^export const WALLET' "$RUNNER/scripts/check-g2-sepolia-7702-revocation.mjs"
# Manually enter the EXACT pinned wallet address into a shell variable; no key material.
printf 'Pinned wallet address (0x...): '
read -r TARGET_WALLET
# Create a fresh, unique, non-preexisting order file. Expiry is dynamic, 10 minutes from now (<=15 minutes).
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
ORDER="$PRIVATE/order-$STAMP.json"
JOURNAL="$PRIVATE/journal-$STAMP"
test ! -e "$ORDER" && test ! -e "$JOURNAL" && test ! -e "$JOURNAL.hash" && test ! -e "$JOURNAL.attempt" || { echo 'STOP: collision'; exit 2; }
EXPIRY=$(date -u -v+10M +%Y-%m-%dT%H:%M:%SZ)
# Fees are strict caps, NOT recommended current fees. Both RPCs must pass the runtime's live fee checks.
ORDER="$ORDER" TARGET_WALLET="$TARGET_WALLET" EXPIRY="$EXPIRY" node -e 'const fs=require("fs"); const o={version:1,action:"clear-7702",chainId:11155111,wallet:process.env.TARGET_WALLET,expiresAt:process.env.EXPIRY,maxGas:"60000",maxFeePerGasWei:"2000000000",maxPriorityFeePerGasWei:"1000000000"};fs.writeFileSync(process.env.ORDER,JSON.stringify(o,null,2)+"\n",{flag:"wx",mode:0o600})'
test "$(stat -f %Lp "$ORDER")" = 600 || { echo 'STOP: insecure order'; exit 2; }
```

The pinned script validates `chainId=11155111`, the specific wallet address and expiry. The 2 gwei / 1 gwei fee caps can fail at either RPC; do not bypass them or blindly raise caps. If the deadline expires, stop and create a separately reviewed fresh order and journal, never reuse an uncertain attempt. Existing `nonce-<wallet>-<nonce>.lock` files signal prior reservations: investigate before doing anything else.

## 3. Read-only preflight and separate approval boundary

```sh
node "$RUNNER/scripts/g2-sepolia-human-7702-revoke.mjs" check "$ORDER"
```

Review `UNSIGNED_ONLY`, pinned wallet, observed transaction nonce, delegation, code hashes, common canonical block, and fee caps from **both distinct configured public RPCs**. Investigate any error, difference, stale result or code change; stop on failure. The `check` command neither signs nor broadcasts. Record the independent reviewer's name, UTC decision, the **exact pinned SHA and both SHA256 values**, wallet, order expiration, and an explicit written approval **for EXECUTE**, plus the wallet owner's separate recorded authorization. Do not proceed without both. Approval must evaluate the actual source, two-RPC checks, nonce reservation, journal durability, exit statuses, and recovery; approval of this documentation PR is only for merging documentation.

## 4. ONE human execute, only AFTER both external approvals

**NOT AUTHORIZED BY THIS DOCUMENT.** The following is a withheld release-candidate command. The owner must personally open a live TTY after all approvals, recheck SHA256 and order freshness, and type it once. Never run it through an agent, CI, remote job, copied background shell, pipeline, or retry loop.

```sh
# HUMAN-ONLY, CONDITIONAL ON EXPLICIT EXECUTE CLEARANCE AND OWNER APPROVAL:
# node "$RUNNER/scripts/g2-sepolia-human-7702-revoke.mjs" execute "$ORDER" "$KEY" "$JOURNAL"
```

The runtime requires a real input/output TTY and the operator to type exactly `CLEAR SEPOLIA DELEGATION`. It verifies remote state again, creates an exclusive wallet-and-nonce lock and a new journal before reading the key, signs a single authorization and type-4 transaction, persists `.hash` then `.attempt`, and broadcasts once. A wrong confirmation, hash mismatch, unexpected exit or error is a stop; **never automatically resend**. Expiry and nonce races may invalidate the attempt. Preserve journal and lock artifacts; do not delete them to force another send.

## 5. Human read-only recovery and postcondition

After any nonzero or status **exit 2** (including `PENDING_NO_RETRY`, `AWAITING_FINALITY`, unknown receipt or process interruption), preserve the order and journal and inspect the two configured RPCs. Only when a real `.hash` journal exists use:

```sh
node "$RUNNER/scripts/g2-sepolia-human-7702-revoke.mjs" recover "$JOURNAL"
```

`recover` is read-only; it may itself exit 2 without implying that re-execution is safe. A `.hash` without `.attempt` returns `MISSING_ATTEMPT_JOURNAL_NO_RETRY`; absent `.hash`, changed nonce, replaced/dropped transaction, RPC disagreement, reorg, or restored delegation require independent investigation, **not a repeat broadcast**. Never run the `execute` line a second time. Require independent finalized receipts, canonical block identity and cleared delegation at both finalized and latest observations on both RPCs before recording `DELEGATION_CLEARED_FINALIZED`. Keep the order, transaction hash, runtime digests, observations, and operator/reviewer approval record without ever exposing the key. Until a human security reviewer separately authorizes EXECUTE and the wallet owner authorizes their signature, the release status stays **NOT AUTHORIZED**.
