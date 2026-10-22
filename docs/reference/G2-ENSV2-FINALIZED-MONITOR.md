# G2.4 ENSv2 Sepolia finalized-state monitor — read-only

**Scope:** version-pinned ENSv2 Sepolia finalized-RPC polling, always `NEEDS_REVIEW`; no L1 transaction, OP issuance/relay, custody, privilege grant or SOVEREIGN receipt. This is a separate protocol from the [legacy ENSv1 monitor (PR #153)](https://github.com/MushroomDAO/CometENS/pull/153). [G2.4](../goal/G2-ACCEPTANCE.md) remains `PENDING`.

The command `scripts/monitor-g2-ensv2-l1.mjs` reuses the [current ENSv2 risk inspector](G2-ENSV2-RISK-INSPECTOR.md) to observe a specified ENS name through its actual RootRegistry → ETHRegistry → child-registry hierarchy. It pins every visited runtime code hash and discovered proxy implementation, checks dynamic EAC role/resource state and `ROOT_RESOURCE` administrator counts, known operator approvals, expiry and registry pointers, then validates that the captured numbered block still matches the RPC's finalized block. The monitor accepts a previous cursor bound to the exact manifest and compares each name component's holder, status, expiry, resource, EAC role summaries, approvals, emancipation and newly discovered risk findings.

Run with a locally stored, independently pinned manifest in the format described in [ENSv2 risk inspector](G2-ENSV2-RISK-INSPECTOR.md). On this path the command **only** accepts a public HTTPS RPC root with no credentials or URL query string:

```sh
export COMETENS_SEPOLIA_RPC_URL='https://ethereum-sepolia-rpc.publicnode.com'
node scripts/monitor-g2-ensv2-l1.mjs --manifest ./my-ensv2-manifest.json > observed.json
jq .cursor observed.json > previous-cursor.json
# For the next poll:
node scripts/monitor-g2-ensv2-l1.mjs \
  --manifest ./my-ensv2-manifest.json --previous previous-cursor.json > observed-next.json
```

`BASELINE` is the first sample; `UNCHANGED` has the same observed state, `CHANGED` records changed paths such as `visited[1].owner` or `visited[1].rootRoles`. `AT_RISK` means nonbaseline inspector findings occurred (expired name, root/admin role, third-party delegation, proxy admin or another risk), not a newly discovered security exploit. Each result remains `NEEDS_REVIEW`, including otherwise unchanged names, because owner/delegate enumeration and Ethereum consensus are not independently proved. Missing runtime pin, wrong chain, incomplete ancestry, untrusted previous cursor, source rollback/reorg or mismatched block hash returns an error, not a new positive snapshot.

Expiration may trigger `AT_RISK` solely from wall-clock passage, with no L1 event or newer block. A genuine same-block modification of native holder, roles, registry or approvals fails closed; only the `NAME_NOT_ACTIVE` finding may change when an expiry time crosses. The CLI has no background scheduler: persist the returned `cursor` *after* downstream processing, and poll at a service-defined interval. In an eventual production monitor add a finalized L1 event indexer/backfill with reorg protection, periodically re-read expiry even without events, and perform authenticated OP mirroring separately.

**Security boundary:** The RPC's `finalized` label is provider-supplied; codehash and readContract consistency are **not** a consensus/state proof. Scanning only listed operators does not rule out unknown EAC roles or `setApprovalForAll` approvals. A→B→A transfers between polls can go undetected. New native issuance must still check live L1 authorization and execute in its own L1 transaction; an OP lease, historical result or watcher alert cannot revoke instantly or authorize native issuance. No real ENS ownership or record-writer sovereignty can be inferred from this monitor.
