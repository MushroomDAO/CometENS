# G2.6 partial: fail-closed V4 Worker issuance preflight (read-only)

`workers/api/src/v4-issuance-preflight.ts` exports
`preflightV4SignedIssuance(reader, pin, intent)`. It is an **inert, reusable**
boundary for a future V4 gateway: it neither changes the active V3 API Worker
routes nor enables `protocol: 'v4'`, and has no wallet, signing, secrets, write
capability, KV dependency or transaction broadcasting. Current `/register`,
`/set-addr`, `/set-text`, `/set-contenthash` and the remaining V3 write paths
still use their existing best-effort Cloudflare KV `consumeNonce` logic. That
KV `get`+`put` is eventually consistent across PoPs and is **not atomic**.

The future V4 caller must supply a trusted OP Sepolia RPC client, verified
`chainId=11155420`, the independently audited **deployed runtime codehash**,
contract address and expected per-community `parentNode`. The function rejects
incorrect identities and `l1OwnershipVerified != false`; that flag documents
the V4 application's lack of native L1 ENS title verification. It obtains one
OP latest-block number/hash and reads runtime bytecode, parent, controller,
controller epoch, `issuanceNonce`, `operatorRevision(operator)` and the operator
grant **at the same block number**. It checks a signed-only `CAP_ISSUE |
CAP_SIGNED_ISSUE` grant, initial-addr capability, quota, epoch, expiry and
deadline against that block's timestamp. Invalid, negative, or zero-hash RPC
headers are rejected before reading the contract state.

Next it uses `simulateContract`/`eth_call` for the **actual**
`issueBySig(label,member,initialAddr,nonce,deadline,signature)` on the pinned
V4 contract with `account` set to the **named operator** and `blockNumber` set
to the same snapshot. This checks EOA/ERC-1271 signature validity, current
nonce, grant revision, duplicate labels, ERC721 receiver hooks and any actual
onchain guards. A failed simulation rejects. It then rereads the latest block;
a different number or hash rejects even if the simulation succeeded. No KV
value or previously cached authorization is ever consulted; test coverage
includes KV incorrectly suggesting that a consumed nonce is available.

Success returns only `{scope:'op-application-only', preflightOnly:true,
atomicExecutionVerified:false, blockNumber, blockHash, issuanceNonce,
operatorRevision, controllerEpoch, ...identity}`. It returns **no grant of
authority and no transaction submission**. Provider errors are sanitized;
signature bytes, keys and RPC URLs are never copied into errors or logged.

## Critical remaining integration limits

- **Preflight cannot reserve a nonce.** Two concurrent workers can both pass
  at the same latest block, or the chain can change immediately after return.
  Only an **onchain transaction calling the real V4 method** can atomically
  consume the OP nonce and determine the winner. A caller must independently
  check the mined transaction receipt and finalized/canonical state, and must
  not turn this advisory result into an offchain approval or KV-authorized write.
- This code is **not wired to V3 Worker** and does not include a V4 writer,
  bounded relayer identity, wallet handling, queue/idempotency policy, receipts,
  OP finality monitoring or reorg recovery. A future integration must design
  the authenticated HTTP caller versus the actual transaction sender, never
  silently send with a global privileged key or treat the supplied operator as
  an authenticated HTTP identity. Future V4 record relays likewise require
  actual `nonces(holder)` and `recordEpoch(node)` onchain, rather than KV.
- The supplied RPC's chain data and bytecode are trusted inputs until
  independently verified. An upgradable proxy's shell codehash can remain
  unchanged while its implementation is replaced; this preflight requires an
  independently audited nonproxy deployment or implementation/admin pinning.
  This module does not prove Ethereum L1 ownership,
  ENSv2 migration, OP safe/finalized settlement or G2.4 immediate transfer
  revocation. An OP application name and even successful V4 execution cannot
  yield a native ENS `SOVEREIGN` receipt. **G2.6 remains partial**, the full
  G2.1–G2.9 acceptance matrix remains pending and G3 is blocked.

Run `pnpm vitest run test/unit/g2-v4-worker-preflight.test.ts` for local mocked
adversarial tests. They verify pinned same-block reads and eth_call, replay,
stale KV, signature/nonce races, changed head/hash, wrong chain/runtime/parent,
expired/revoked operator and no V4 public Worker endpoint. Tests do not require
RPC credentials or chain writes.
