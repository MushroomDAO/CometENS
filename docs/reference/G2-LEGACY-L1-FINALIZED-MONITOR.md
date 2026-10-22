# G2.4 prototype: legacy ENSv1 Sepolia finalized-state polling

**Scope:** read-only, non-authoritative legacy ENSv1 Sepolia observation. The current ENSv2 Sepolia EAC/Permissioned Registry is **not** monitored by this command. It does not grant, revoke, freeze or mirror OP controller rights; it never publishes a SOVEREIGN receipt. The [native-first/OP mirror design](G2-ZK-MERKLE-L1-AUTHORITY-DECISION.md) and frozen [G2.4](../goal/G2-ACCEPTANCE.md) remain separate work.

The command `scripts/monitor-g2-legacy-l1.mjs` reuses the exact-block registry/NameWrapper runtime-codehash checks from `audit-legacy-ensv1-authority.mjs`, plus an independently repeated read of the finalized block's hash and timestamp. It compares the new sample with an explicitly provided prior cursor and emits `BASELINE`, `UNCHANGED`, `CHANGED` or `AT_RISK`. Parent and child registry owner, wrapped holder, wrapper expiry and observed legacy CU/PCC fuse conditions form the difference set. An expired fuse can make `AT_RISK` appear **without any transfer event or new block**. Missing pins, wrong network, provider errors, inconsistent finalized block or a changed stored block hash all fail closed, with no optimistic output.

For example, after independently obtaining the **actual** pinned runtime bytecode hashes of the two legacy ENSv1 Sepolia contracts:

```sh
export COMETENS_PUBLIC_SEPOLIA_RPC=https://ethereum-sepolia-rpc.publicnode.com
node scripts/monitor-g2-legacy-l1.mjs \
  --mode legacy-ensv1-sepolia \
  --parent community.eth --child alice.community.eth \
  --registry-codehash 0xYOUR_INDEPENDENTLY_VERIFIED_32_BYTE_HASH \
  --wrapper-codehash 0xYOUR_INDEPENDENTLY_VERIFIED_32_BYTE_HASH > result.json
jq .cursor result.json > previous-cursor.json
```

Use the same command on the next poll with `--previous previous-cursor.json`. The first poll omits the flag and produces `BASELINE`; once the flag is supplied, a missing value, missing/empty file, invalid JSON or JSON `null` **fails closed** rather than silently restarting a baseline. Save the **new** cursor only after the result has been durably consumed. This CLI itself writes no cursor and sends no transaction. Keep prior cursor files out of the repo. Operators can schedule the command or invoke its pure `monitorLegacyL1({client, ..., previous})` API; there is no resident watcher service in this phase.

| Status | Meaning | Authority consequence |
| --- | --- | --- |
| `BASELINE` | First finalized RPC sample | None; only an observation |
| `UNCHANGED` | Sampled identity/fields equal previous | Does not prove uninterrupted ownership between polls |
| `CHANGED` | One or more sampled ENSv1 fields differ | Inspect the `changedFields` and pinned block; cannot directly freeze OP |
| `AT_RISK` | Legacy parent/child CU/PCC observation invalid or has expired at current time | May have `changedFields: []`; safe to highlight as stale/unsafe in UX |
| Command error | Wrong codehash, stale finalized source, untrusted previous cursor or RPC failure | Do not replace a working cursor or claim current native ownership |

**Trust and risk limits:** `finalized` is a claim of the chosen RPC, not an independent Ethereum consensus proof. When the cursor advances to a new finalized block, the reader also re-reads the previous block number and checks its recorded hash/timestamp, failing closed if the RPC disagrees; this is **single-RPC ancestor consistency**, not verification of complete Ethereum consensus, all intermediate events or continuous L1 ownership. Resample across separately operated providers to investigate disagreement, and never present the results as ENSv2 roles or native member sovereignty. This legacy probe does **not** check BaseRegistrar registration expiry, wrapper operator approvals, resolver writers, active ENSv2 EAC versions or full authorization closure, and therefore cannot decide whether minting is permitted. An A→B→A transfer entirely between polls may leave identical samples. Changes after the finalized block, and L1→OP delivery delay, are not known to this program. No monitor alone solves G2.4 strict transfer-time revocation.

**Next independent work packages:** (1) version-pinned **ENSv2** finalized ancestry/EAC/upgrade observation, not an ENSv1 fallback; (2) event-triggered indexer plus durable finalized cursor/backfill/reorg testing; (3) authenticated L1-native issuance outcome messages and OP mirror state with replay/expiry handling. Any OP record writes that affect actual ENS resolution need separate current-authority enforcement, even when a monitor exists.
