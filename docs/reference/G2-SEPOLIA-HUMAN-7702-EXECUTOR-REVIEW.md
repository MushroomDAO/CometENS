# G2 Sepolia EIP-7702 human executor: review and preflight

**Status: execution NOT approved.** PR #187 was approved for **merge only** and merged as `90b1a4f64feafde2cb3b821090d748fff36368b5`. This merge does not authorize a real-wallet signature or broadcast. A separate independent security reviewer must explicitly approve **EXECUTE for the exact runtime SHA and current order**, and the wallet owner must separately authorize execution and confirm control of the specified key out of band. Until both decisions are recorded, use read-only `check` only.

## Evidence and its limits

The repository's `test/e2e/g2-7702-local-anvil.test.mjs` exercises a disposable randomly generated wallet against locally started Anvil, Prague hardfork, with chain ID **11155111**. It creates delegated code, runs the exported `executeVerified` and `inspectHash` functions with the test-only wallet constant substituted through Vitest's module mock, mines a real locally signed EIP-7702 transaction, polls `inspectHash` after mining and logs measured `gasUsed`. The first `executeVerified` status must be pending or awaiting finality. `recheck`, `guard`, `persist` and `checkRemote` are replaced in the test, and both RPC slots use the **same Anvil client**. Neither the actual CLI entry points (`main()` and `recover()`), filesystem permissions and persistence, two independent RPCs, nor production `verify` are tested here. No production wallet private key is used. This is **plain local Anvil, not a Sepolia fork**; chain ID matching alone does not reproduce Sepolia state, fees, RPC behavior or wallet custody. Run `pnpm vitest run test/e2e/g2-7702-local-anvil.test.mjs` with Foundry Anvil installed to reproduce. A previous reviewer reported an independent manual local Anvil run; that result is not Sepolia-fork or real-wallet evidence.

## Read-only preflight for an operator

From the repository root, use the local `gh` CLI to identify the reviewed commit:

```sh
gh api repos/MushroomDAO/CometENS/commits/main --jq '.sha'
gh api repos/MushroomDAO/CometENS/pulls/187 --jq '{merged_at,merge_commit_sha}'
gh api repos/MushroomDAO/CometENS/pulls/187/reviews --jq '[.[]|{state,commit_id,body}]'
```

Compare the actual local `scripts/g2-sepolia-human-7702-revoke.mjs` and `scripts/check-g2-sepolia-7702-revocation.mjs` against the blobs fetched at the specifically reviewed commit using `gh api`; inspect any later changes individually. An approved merge SHA **does not automatically approve later runtime changes**. A new explicit execution security review must cover the current SHA, journal semantics, expiry check placement, signer, two RPCs, and pending/reorg recovery.

Before preparing any order, inspect the script and its `validate()` schema. A typical **intent only** (never interpreted as an execution approval) has the following shape; replace wallet and expiration only with values verified directly from the script and current chain:

```json
{
  "version": 1,
  "action": "clear-7702",
  "chainId": 11155111,
  "wallet": "WALLET_FROM_VERIFIED_RUNTIME",
  "expiresAt": "FUTURE_UTC_WITHIN_ONE_HOUR",
  "maxGas": "60000",
  "maxFeePerGasWei": "2000000000",
  "maxPriorityFeePerGasWei": "1000000000"
}
```

This is a **template, not a valid order**. Calculate fee caps anew from both trusted RPCs. Only the wallet owner may prepare a private 0700 directory and 0600 order file using the runtime's private-path requirements. When approved for **read-only preflight**, the supported CLI form is:

```sh
node scripts/g2-sepolia-human-7702-revoke.mjs check "$ORDER_FILE"
```

Do not run `execute` at this stage. The `check` mode returns an unsigned snapshot only, after checking the current delegation and fee caps. The order may expire at any time. The merged #189 runtime rechecks after authorization, revalidates expiry before signing and again before broadcast. These checks still require independent execution-security approval of the exact runtime SHA.

## Recovery gates before any human execution

- An observed `PENDING_NO_RETRY` means **do not resubmit**. Immediately after a send, a missing receipt or a lagging RPC can leave that normal pending state; command exit status is not evidence of transaction failure.
- The journal `.hash` is written before `.attempt` and before a single broadcast. A `.hash` without `.attempt` can indicate interrupted preparation; `recover` returns `MISSING_ATTEMPT_JOURNAL_NO_RETRY` when `.attempt` is absent. Preserve the artifacts for investigation, never reconstruct or retry automatically.
- If a transaction was dropped, superseded or replaced, inspect both RPCs for the recorded hash, the account's pending/latest nonce, canonical receipts, current delegation and any replacement hash. A consumed nonce with a missing original hash is **not success**. The merged runtime returns `NONCE_CONSUMED_OR_TX_REPLACED_NO_RETRY` when it observes a consumed nonce; this does not identify the replacement transaction or prove successful clearing.
- The merged #189 runtime creates an exclusive wallet-and-nonce `.lock` after human confirmation and a fresh verification, before reading the signing key. Locks intentionally remain after uncertain outcomes; a stranded lock must be investigated manually using both RPCs and the preserved journals. Never delete a lock merely to retry.
- The merged runtime repeats canonical receipt-block and receipt identity checks after finality reads. Independent RPC disagreement and deeper reorganization remain review considerations.
- A returned `DELEGATION_CLEARED_FINALIZED` reports receipt-block code after finality; inspect the **latest** current code too, because later redelegation can occur. Verify both RPCs agree.

For read-only recovery with the existing journal basename (do not append `.hash` or `.attempt`):

```sh
node scripts/g2-sepolia-human-7702-revoke.mjs recover "$JOURNAL_BASE"
```

A nonfinal or inconclusive recovery result can exit with status 2 and must never be interpreted as permission to resend. Never provide private-key bytes to an agent or authorize AI-driven `execute`. **Approval to merge this PR is not approval to EXECUTE.**

Record the independent security reviewer, exact reviewed SHA, review timestamp, intended account, order expiration, and the wallet owner's affirmative authorization before reconsidering `execute`. Merge approval alone is insufficient.
