# G2 L1 finalized-event trigger and backfill — no native authority

**Status:** read-only L1 Sepolia event discovery prototype. It observes **only explicitly pinned** ENS contract addresses and topics, within bounded finalized-RPC block ranges. The scanner sends no transactions or cross-domain messages, never grants ENS/OP rights, never proves `SOVEREIGN`, and **does not complete G2.4**. It is the event-driven trigger for the separate ENSv1/ENSv2 finalized state readers; events and a checkpoint by themselves cannot prove current ownership or unchanged authority.

Prepare a local public manifest (with independently verified addresses, runtime bytecode hashes and event topic0 selectors for the exact chosen deployment):

```json
{
  "chainId": 11155111,
  "startBlock": "12345678",
  "sources": [
    {
      "address": "0x1111111111111111111111111111111111111111",
      "codeHash": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "topics": ["0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]
    }
  ]
}
```

The values above are **placeholders**, not verified ENS deployments. Pick `startBlock` at or after all specified monitored contracts' actual deployed code. To run with a verified manifest:

```sh
export COMETENS_PUBLIC_SEPOLIA_RPC=https://ethereum-sepolia-rpc.publicnode.com
node scripts/scan-g2-finalized-l1-events.mjs --manifest ./ens-l1-event-manifest.json > result.json
jq .cursor result.json > event-cursor.json
# After safely consuming result.json, run the next contiguous range:
node scripts/scan-g2-finalized-l1-events.mjs \
  --manifest ./ens-l1-event-manifest.json --previous event-cursor.json > next.json
```

Each invocation checks the RPC's `finalized` block, bounds one scan to 128 blocks, verifies every source's expected runtime code hash at the range endpoints, fetches logs with address/topic filters using **explicit `eth_getLogs` JSON-RPC** (the installed viem `getLogs` helper derives topics from ABI events and ignores a direct `topics` argument), verifies each log's block hash against a numbered block read, and rechecks finality. It refuses wrong chain, source code, missing/mismatched prior hash, reversed height, duplicate log, mismatched source/topics, reverted log, corrupted cursor and RPC failure; errors are sanitized. The caller persists `cursor` **only after** downstream processing and then scans the next range, replaying from the previous cursor on crash. An empty log result does not mean permission is unchanged: every result sets `mustReconcileNativeState: true` to require periodic ENS owner/expiry/EAC and resolver reads. A progress cursor after a bounded range is not a native ENS authorization certificate.

| Result | Interpretation |
| --- | --- |
| `EVENTS_OBSERVED` | At least one source/selector-matched log was confirmed within the sampled RPC's finalized blocks; re-read affected ENS state |
| `NO_EVENTS` | No sampled matching log; still perform a periodic native state read for expiry, migration or unknown event signatures |
| `UNCHANGED` | Cursor already reached this finalized head; no new log range requested, but state freshness must still be checked |
| Error | No new cursor. Investigate provider/chain/manifest state, then retry without skipping blocks |

**Cursor portability:** The `manifestHash` includes JSON key order and source/topic array order. Reformatting or reordering fields can invalidate the previous cursor even when its meaning is unchanged; preserve the exact manifest across runs. Historical catch-up may require an archive-capable RPC to retrieve contract bytecode at old heights.

**Limitations:** EIP-1186/Merkle consensus verification and complete protocol-specific role enumeration are not implemented. All finality and block hashes are **one RPC provider's claims**, not independently verified Ethereum consensus. Endpoint codehash pins do not rule out a transient proxy implementation change or intermediate code mutation, and event allowlists can omit relevant changes. A→B→A between samples may have logs when the watched contracts emit matching events, but never assume they do. L1 expiry may occur without an event. Operators should compare independent providers, implement a durable database cursor/atomic downstream state update, canonical reorg recovery, explicit deployment manifests and routine full native state reconciliation before production. Even a perfectly synchronized Monitor cannot instantly revoke stale OP privileges on a concurrent L1 transfer; native issuance must be authorized on L1 at execution time.
