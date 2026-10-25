# Sepolia EIP-7702 local human revoke candidate — DRAFT, not approved for execution

Only test wallet `0xF7Bf79AcB7F3702b9DbD397d8140ac9DE6Ce642C`, Sepolia `11155111`, current pinned delegate `0x5804b6119d12ad403a430fd3cff12a8ff6e4064b`. The intended authorization uses `contractAddress: zeroAddress`, `executor:'self'` and nonce transaction nonce + 1. The CLI has explicit `check`, `execute`, and `recover` modes. `execute` requires a real TTY, exact phrase, POSIX mode 0600 test-key file and a unique journal pathname that does not already exist; it never logs key bytes. All fee/nonce/delegate checks are refreshed after consent and again after signing. An offline-signed Type-4 transaction hash (never raw transaction bytes or private keys) is written and fsynced in an exclusive .hash journal before the first network broadcast. A separate .attempt journal is fsynced before the single sendRawTransaction call. No retry is automatic; ambiguous outcomes must be investigated using the durable hash. Unknown RPC outcome MUST NOT trigger retry. A successful receipt still needs independent read-only cross-RPC finality verification.

Example order JSON keys: `version:1`, `action:'clear-7702'`, `chainId:11155111`, fixed `wallet`, `maxGas:'60000'`, `maxFeePerGasWei:'100000000'`, `maxPriorityFeePerGasWei:'2000000'`, `expiresAt:'<UTC ISO within 1 hour>'`. The suggested limits are illustrative, not live fee guidance.

**Execution review blockers**: No full Anvil Sepolia fork execution test for the actual delegated wallet and revocation, and the second RPC may be stale/hostile. No code claims atomic nonce reservation. A trusted human must approve these gaps resolved before using execute. Do not ask AI agents to run execute or read key files. Clearing delegation breaks smart-account sessions and leaves prior storage intact.


## Security review update

The executor signs a Type-4 transaction offline, derives its hash with keccak256(serialized), persists the hash before transmission, and uses exactly one raw-transaction submission. An RPC timeout leaves the .hash journal for manual chain inspection. The key is opened with O_NOFOLLOW and checked by descriptor fstat before reading. Network calls have explicit timeout and zero retries.

A success receipt alone is insufficient: both providers must return the expected Type-4 transaction with the fixed sender, destination, nonce, and zero-address self-authorization at nonce + 1. The receipt must be included in finalized history reported by both providers, and code at the receipt block must be empty from both providers. Until that evidence is available, execution reports a blocked/pending result instead of declaring completion. Disposable local Anvil validation and external formal review are still required.

## Read-only recovery and reverted outer execution

Run: node scripts/g2-sepolia-human-7702-revoke.mjs recover /absolute/path/to/journal

Recovery reads the protected journal.hash and journal.attempt files and queries both RPCs. No signing key, signing, or broadcasting occurs. Repeat it after two confirmations until finality. PENDING_NO_RETRY and AWAITING_FINALITY are not success states, and no automatic retry is allowed.

EIP-7702 authorization changes are applied before outer execution and persist if outer execution reverts. Recovery validates Type-4 transaction fields and authorization, independent of receipt.status, then checks wallet code at the finalized receipt block on both providers. The outerExecution field records success or reverted separately. Conflicting RPC results and delegated code remain non-success statuses.

Recovery requires both protected journal.hash and journal.attempt records to agree on hash, nonce and Sepolia chain ID; a signed-but-never-attempted transaction cannot be described as submitted. Missing receipts or transactions yield PENDING_NO_RETRY. Each provider must agree on the receipt's mined block hash and its canonical block at that height. Both independently reported finalized heights must include that mined block, but need not be equal. EIP-7702 code is checked at that receipt block regardless of outer transaction status.

Local signed EIP-7702 Type-4 Anvil test has passed using a disposable test key and local chain. This is not a Sepolia fork test, not an approval for live execution, and does not establish behavior on the target Sepolia wallet.

For every exclusive journal creation, both the file contents and the parent directory entry are fsynced before continuing. Failure to sync either is fatal; the executor must not broadcast on a journal durability error. This includes the prebroadcast .hash and .attempt files.

## Mac Terminal runbook — REVIEW ONLY, NOT APPROVED FOR EXECUTION

These commands apply **only after this PR is merged** and run from the real repository root containing `scripts/g2-sepolia-human-7702-revoke.mjs`. They are documentation for independent human security review, **not authorization to execute**. Before any human execution: verify the **exact current PR head has formal independent APPROVED review and green CI**, all required security findings have been resolved, and the existing private key actually controls the fixed **Sepolia test wallet**. A local signed Anvil test passed, but neither a Sepolia fork nor an approved live revoke was completed.

```sh
cd /Users/jason/Dev/mycelium/CometENS
umask 077
mkdir -p -m 700 "$HOME/.config/cometens-g2-sepolia"
PRIVATE_DIR="$HOME/.config/cometens-g2-sepolia"
ORDER="$PRIVATE_DIR/7702-review-order.json"
EXPIRES_AT="$(date -u -v+15M '+%Y-%m-%dT%H:%M:%S.000Z')"
test ! -e "$ORDER" || { echo 'Order already exists: review before replacing'; exit 1; }
( umask 077; cat > "$ORDER" <<EOF
{
  "version": 1,
  "action": "clear-7702",
  "wallet": "0xF7Bf79AcB7F3702b9DbD397d8140ac9DE6Ce642C",
  "chainId": 11155111,
  "maxGas": "60000",
  "maxFeePerGasWei": "100000000",
  "maxPriorityFeePerGasWei": "2000000",
  "expiresAt": "$EXPIRES_AT"
}
EOF
)
chmod 600 "$ORDER"
node scripts/g2-sepolia-human-7702-revoke.mjs check "$ORDER"
```

The fee and gas ceilings are **illustrative limits** and can cause the check to fail; they do not represent live fee advice. Do not raise caps without independent review. `check` is read-only and never loads a signing key. Mac BSD `date -v+15M` sets a 15-minute UTC expiry. The directory itself must be owned by the current user and mode 0700; protected files must be owned by that user and mode 0600.

The next block is a **manual execution template only**. It must **not be run** until the approval and exact wallet-key prerequisites above are met. `KEY` must refer to an **already existing** 0600 file containing the matching test wallet key. **Never paste, send, upload, or share private key bytes with any AI assistant, chat, issue, or review comment.** Never create a key from an AI transcript.

```sh
KEY="$PRIVATE_DIR/existing-matching-test-wallet.key"
test -f "$KEY" && test ! -L "$KEY" || { echo 'Missing or linked key file'; exit 1; }
JOURNAL="$PRIVATE_DIR/7702-$(date -u +%Y%m%dT%H%M%SZ)-$$"
test ! -e "$JOURNAL" && test ! -e "$JOURNAL.hash" && test ! -e "$JOURNAL.attempt" || { echo 'Journal path already in use'; exit 1; }
# HUMAN OPERATOR ONLY, after exact-head approval and green CI:
node scripts/g2-sepolia-human-7702-revoke.mjs execute "$ORDER" "$KEY" "$JOURNAL"
```

Execution requires a real interactive Terminal and typed confirmation. The journal **base pathname must not exist** before execute; the executor reserves it atomically. Once `JOURNAL`, `JOURNAL.hash`, or `JOURNAL.attempt` exists, **never retry execute**, including after timeout or a reverted outer transaction. Preserve the files securely and inspect the recorded transaction hash. Creation of each journal file synchronizes **both its contents and parent directory entry** before any broadcast.

For post-submission read-only recovery, use the **same journal base pathname**, without the `.hash` suffix:

```sh
node scripts/g2-sepolia-human-7702-revoke.mjs recover "$JOURNAL"
```

`recover` reads neither the signing key nor the order, constructs no wallet, never signs, and never sends. Repeat this **read-only query** after initial confirmations and while waiting for finality; `AWAITING_FINALITY` and `PENDING_NO_RETRY` are not permission to resubmit. Only matched transaction, canonical receipt block, finalized inclusion on both RPCs, and empty code at the mined block qualify for `DELEGATION_CLEARED_FINALIZED`. Outer execution may revert even when EIP-7702 revocation is effective, so inspect `outerExecution` separately.

CLI exit status is fail-closed: `check` may exit 0 for a successful unsigned read-only preflight; `execute` and `recover` print their JSON result, and return exit code 0 **only** for `DELEGATION_CLEARED_FINALIZED`. Pending, missing, or inconsistent finality returns nonzero (2); a nonzero result is never a reason to retry execute.
