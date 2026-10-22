# G2.5 experimental V4 indexed operator history (read-only)

This component audits an **independently pinned, per-community OP Sepolia V4 application**. It never signs, broadcasts, uses private keys/Worker KV, infers native L1 ENS ownership or generates `SOVEREIGN`. G2.5 and G2.4 remain **PENDING**.

```bash
export COMETENS_OP_RPC_URL=https://your-independently-selected-op-sepolia-rpc
node scripts/audit-v4-operator-events.mjs --profile ./v4-profile.json \
  --from-block 123400 --to-block 123431 \
  --operator 0x2222222222222222222222222222222222222222
```

Profile uses the exact existing controller CLI fields (values **illustrative**, not deployed identities):

```json
{"parentName":"community.eth","chainId":11155420,"contract":"0x1111111111111111111111111111111111111111","expectedCodeHash":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
```

Pin V4 contract address, expected **runtime** bytecode hash and parent independently from deployment evidence; never derive them from unsigned JSON or gateway KV. Each scanned block checks OP chain ID `11155420`, `keccak256(getCode) == expectedCodeHash` and `parentNode() == namehash(parentName)`. Four plain profile fields are copied before any network await; getter-based retargeting is rejected. A proxy shell codehash cannot establish implementation identity.

Only **1–64 blocks** per request, starting >=1, with `toBlock` at/below the RPC-reported **finalized** height. At most 512 transactions, 512 V4 contract logs per block and 4096 receipt logs per request; any excess aborts. Explicitly query disjoint sequential windows for wider history. Each block's full `eth_getBlockReceipts` set must exactly match its transaction hashes; V4 receipts' logs must exactly match `eth_getLogs` by address, topics/data, tx hash/index, log index, block number/hash, and success. Missing methods, truncated pages, conflicting logs, injected receipts or malformed ABI are errors. No silent fallback or pagination claiming completeness.

The CLI uses viem's standard `client.request({method:'eth_getBlockReceipts'})` and formats RPC receipts, because an ordinary viem public client has no `getBlockReceipts` action. RPC providers lacking this method fail closed without a logs-only fallback.

RPC responses are **single-provider corroboration**, not independent consensus/finality evidence: one malicious RPC can fabricate mutually consistent block, receipts and logs. Compare with independently operated providers/verified consensus evidence before elevating historical provenance claims. No proof of absent post-range events or a full contract history is made.

The actual Solidity V4 events decoded are `OperatorGranted(operator,permissions,quota,expiresAt,epoch)`, `OperatorRevoked(operator,epoch)`, `ControllerAccepted(previous,current,epoch)`, `SubnodeIssued(parent,node,holder,issuer)` and `IssuanceNonceConsumed(operator,nonce,node)`. The optional operator filter applies to both **grant and revoke** (including `rotateOperator`'s separate events), signed issuance's indexed `operator` and the subnode event's non-indexed `issuer`. All `ControllerAccepted` events remain visible even under a filter to expose epoch rotation, and each `SubnodeIssued.parent` must match the pinned community. Output includes block/hash, transaction/hash/index, logIndex and original decoded arguments.

**Crucial distinction:** event history is **not CURRENT authorization**. A former grant may be expired, quota exhausted, revoked, invalidated by `controllerEpoch`, superseded by a later grant, or belong to an unobserved block. Query pinned current OP `operators`, `operatorRevision`, `controllerEpoch`, and `operatorActive` separately at a verified block for present-tense permissions. Historical logs neither prove L1 NameWrapper/ENSv2 ownership nor certify native member names.

`test/unit/g2-v4-operator-audit.test.mjs` exercises real ABI encoding for grant/revoke/rotation and both issuance events, correct filtering, and negative mutation-sensitive scenarios for wrong chain/hash/parent, unfinalized ranges, injected/truncated logs, receipts, tx/block mismatch, removed flags, spoofed topics, and profile changes during asynchronous execution. This tool is kept separate from #144 controller SDK and Worker V4 preflight writes.
