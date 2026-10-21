# G2.9 — finalized ENSv1 resolver + record bundle observation

This independent **READ-ONLY** prototype observes a **single Ethereum Sepolia finalized block**. It does not install or freeze a resolver, write a record, sign, transact, certify ENSv2 migration, establish `SOVEREIGN` or certify `LOCKED_RECORD`. G2.9 remains **PENDING**.

```bash
export COMETENS_L1_SEPOLIA_RPC_URL=https://your-independent-sepolia-rpc
node scripts/observe-g2-legacy-resolver.mjs --profile ./legacy-observation.json
```

Example *shape*, not deployment identities (replace all addresses, runtime hashes, lock transaction and expected records with independently verified facts):

```json
{
  "chainId":11155111, "contract":"0x1111111111111111111111111111111111111111",
  "parentName":"community.eth", "childLabel":"alice",
  "expectedHolder":"0x2222222222222222222222222222222222222222",
  "expectedLockedBy":"0x3333333333333333333333333333333333333333",
  "lockTransactionHash":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "codehashes":{
    "store":"0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "registry":"0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "wrapper":"0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    "registrar":"0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
  },
  "records":{"addr":"0x4444444444444444444444444444444444444444",
    "contenthash":"0xe30102", "textKey":"name", "textValue":"Alice"}
}
```

At one RPC-reported finalized L1 block number the script verifies chain `11155111`, exact deployed code hashes for record-lock contract and canonical legacy Registry/NameWrapper/BaseRegistrar, `parentNode`/`node`/`parentLabelId`, the lock contract's embedded original pin hashes, and **`ENSRegistry.resolver(childNode)==contract`**. Parent and child Registry owners and registrar ERC-721 custody must be the NameWrapper; the **current** child `getData` holder and ERC-1155 `ownerOf` must equal `expectedHolder`, with parent CU and child CU|PCC, registrar/parent/child validity margin of >24h and child expiry within parent/registrar limits. This is a conservative validity policy, not proof that the name is unchangeable.

At the **same finalized height** the script verifies `locked=true`, exact `recordCommitment=keccak256(abi.encode(node,addr,contenthash,textKey,textValue))`, `lockedBy==expectedLockedBy`, and actual resolver `addr`, `text`, `contenthash` getters against expected bundle. It additionally verifies the pinned lock transaction succeeded, belonged to its historical block, that block and historical contract codehash match, and exactly one `MemberRecordsLocked(node,lockedBy,commitment)` event agrees. `lockedBy` is **historical provenance only**, distinct from today's NameWrapper holder; they can differ. Immutable data here means the reviewed runtime contains no setter following `locked`; it does **not** mean Registry's resolver pointer is immutable.

Every L1 read supplies the same `blockNumber` and verifies the finalized block hash again after observation. This is **single-provider RPC corroboration**, not an independently authenticated L1 consensus proof: a malicious RPC can fabricate internally consistent history, or equivocate between `eth_call` responses for one height. Proxy implementation/admin upgrades, inherited ERC-1155 approvals, existing Registrar/Wrapper operators, ENSv2 registry/EAC/migration, protocol updates, registrar grace and later expiry/re-registration or **resolver repointing** can change the effective name/resolution without changing this locked bundle. `nativeResolverPointerLockedVerified`, `ensV2AuthorityVerified`, `approvalInventoryExhaustive`, `independentlyVerifiedConsensus`, `lockedRecordVerified` and `sovereignReceipt` are permanently **false** in this observational result. Independent consensus/finality and all effective approval/admin paths require separate audited evidence before stronger acceptance.

Unit tests `test/unit/g2-legacy-resolver-observation.test.mjs` exercise finalized positive and mutation-sensitive chain/codehash/pointer/parent/child/holder/fuses/expiry/record/event/transaction/block drift failures, plus getter and async profile retargeting. No live RPC operation or public-chain write is performed by tests.
