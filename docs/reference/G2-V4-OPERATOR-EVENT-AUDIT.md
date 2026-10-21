# G2.5 experimental V4 operator history: read-only indexed log audit

Run against an **independently pinned, already deployed** per-community OP Sepolia
V4 application contract. The script never signs, broadcasts, loads a wallet,
consults Worker KV or infers L1 native ENS ownership. G2.5 and G2.4 remain
`PENDING`. This component does **not** issue a `SOVEREIGN` receipt.

```bash
export COMETENS_OP_RPC_URL=https://your-independently-selected-op-sepolia-rpc
node scripts/audit-v4-operator-events.mjs \
  --profile ./v4-profile.json --from-block 123400 --to-block 123431 \
  --operator 0x2222222222222222222222222222222222222222
```

Profile (same keys as existing V4 controller CLI):

```json
{
  "parentName": "community.eth",
  "chainId": 11155420,
  "contract": "0x1111111111111111111111111111111111111111",
  "expectedCodeHash": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

The addresses/hash/block numbers above are **illustrative**, not deployments.
Determine V4 address, parent and expected **runtime** bytecode hash by an
independent deployment inventory, not from an unsigned website or gateway.
The command checks `namehash(parentName) == parentNode()` and runtime codehash
at **every queried block**, requires RPC chain ID `11155420`, and rejects
absent/replaced code. The program snapshots the four allowed plain profile
fields before any network await; programmatic getter-based and mid-request
mutable input substitution cannot redirect an in-flight scan. A proxy's shell codehash alone cannot certify its
implementation and this is not a general upgradeable-runtime verifier.

The query window is at most **64 blocks**, beginning at block >=1, with its
upper endpoint at/below the RPC's reported `finalized` head. Each block must
have at most 512 transactions and 512 contract logs, and the entire request at
most 4,096 receipt logs; otherwise it fails closed. This is a bounded window,
not an all-history inventory. To cover more history, explicitly request
successive disjoint windows and independently ensure no gap. The RPC must
support complete `eth_getBlockReceipts` and `eth_getLogs`; a missing method is
an error, not permission to silently skip provenance checks. Per-block receipts
must match the block transaction hash inventory and query logs exactly in
address, topic/data, transaction/hash/index, block hash/height and event shape.
This detects injected entries, omitted logs and partial pages when the two RPC
responses disagree. Both responses can still be fabricated by the **same RPC**;
these checks are corroboration, **not independently verified Ethereum/OP
consensus or finalized receipts**. Compare against a second independently
operated node or consensus proof before escalating assurance.

Events decoded from the contract's actual Solidity ABI:

| Event | Operator filtering / significance |
| --- | --- |
| `OperatorGranted(operator, permissions, quota, expiresAt, epoch)` | Indexed **operator**; `rotateOperator` grants the next operator |
| `OperatorRevoked(operator, epoch)` | Indexed **operator**; `rotateOperator` revokes the old operator |
| `ControllerAccepted(previous, current, epoch)` | Always shown, including with operator filter; controller epoch invalidates old grants |
| `SubnodeIssued(parent, node, holder, issuer)` | Filter by **issuer**, non-indexed field; issuer may be controller or operator |
| `IssuanceNonceConsumed(operator, nonce, node)` | Filter by indexed **operator**, evidences signed issuance consumption |

The indexed-topic filters are implemented by decoding the **complete** bounded
V4 receipt and log set then matching each operator, so revoke/rotation cannot
be missed by querying only `OperatorGranted`. `ControllerAccepted` is always
included for the relevant parent because epoch rotation invalidates older
grants. `SubnodeIssued` also checks its indexed `parent` matches the pinned
community. The report includes block number/hash, transaction hash/index and
log index, plus scanned range, contract/runtime pin and parent. It is an
**event audit trail only**. Historical grant/revoke/mint events do **not** prove
today's `operators`, `operatorRevision`, `controllerEpoch`, `operatorActive`,
current quota, live expiration or whether a transaction was reverted after a
reorg. Read those present-tense values independently with a **pinned V4 status
read at a specific verified OP block**. No public status or `SOVEREIGN` flag
can derive from logs alone.

Tests in `test/unit/g2-v4-operator-audit.test.mjs` construct ABI-encoded V4
grant/revoke/controller/signed-issuance/subnode events and exercise the operator
filter. Mutation-sensitive negatives cover wrong chain, bytecode hash, parent,
unfinalized range, malformed profile, injected or truncated log page, changed
block hash, wrong transaction hash, removed flag, wrong event parent and
missing block receipts. This tool remains separate from SDK/CLI write-prep
changes and Worker preflight integration, and uses read RPC methods only.
The tests also mutate supplied profile fields during pending RPC calls and
reject alternating getter input, protecting the single immutable scan target.
