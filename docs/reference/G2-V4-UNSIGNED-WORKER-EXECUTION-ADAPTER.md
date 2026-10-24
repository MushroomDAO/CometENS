# G2.6 — disabled-by-default V4 unsigned execution handoff and receipt observer

**STATUS: NOT A LIVE WORKER WRITE ROUTE. No key, signature, transaction send or broadcast. G2.6 PENDING.**

`workers/api/src/v4-execution-adapter.ts` builds on the existing [read-only V4
preflight](G2-V4-WORKER-ISSUANCE-PREFLIGHT.md) and SDK typed-intent encoder. It
has **no import or call from `workers/api/src/index.ts`**. All V3 routes remain
unchanged. V3 `REGISTRY`/nonce KV is expressly **not** an eligible V4 replay,
rate-limit or admission store: its get/put is not globally atomic.

## Two audited call boundaries

`prepareV4UnsignedExecution({enabled,credential,admission,reader,pin,intent,
expectedOperator})` fails closed unless a server-only explicit feature flag is
`true`. It does not accept a JSON-supplied `enabled` flag or trust a user-supplied
`expectedOperator`; callers MUST originate those from a reviewed deployment
configuration. The required `admission` interface is **NOT IMPLEMENTED** in
production and MUST be an independently authenticated and audited service:

- `authenticate(credential, operator, V4 contract)` must verify the real caller,
  bind them to the correct community/operator and return an opaque principal,
  without logging raw tokens. Comparing credential strings is insufficient.
- `throttle(principal, chain/contract/operator namespace)` must be **atomic,
  globally effective and bounded**; a per-isolate `Map`, the old V3 KV, or a
  client-supplied counter does not qualify.
- `reserve(chain/contract/issuanceNonce, deadline)` must be an **atomic durable
  claim** with independently reviewed expiry, idempotency, crash/reorg recovery,
  and a single global linearization point. A successful `eth_call` does not
  reserve any onchain nonce. Invalid signatures/changed grants fail *before*
  reservation to prevent poisoning live nonce slots.

With all checks present, adapter uses the existing `preflightV4SignedIssuance`
on an explicitly `ccipRead:false` OP Sepolia public client. That pins runtime
codehash, `parentNode`, `l1OwnershipVerified=false`, current controller, epoch,
operator grant/revision/quota/expiry, **the actual OP `issuanceNonce`**, and
does an exact `issueBySig` signature/receiver-hook simulation at the same OP
block. The V4 contract executes `issuanceNonce = nonce+1`, operator quota
consumption, signature verification and `_issue` in **one EVM transaction**,
reverting together on failure. No offchain admission can replace this atomic
EVM check. Runtime hash pin requires independently verified *actual deployed*
code and a separately audited no-proxy/upgrades assumption.

Only then does it create `UNSIGNED_HANDOFF_ONLY`: chain 11155420, V4 contract,
expected runtime codehash, parent, exact operator/member/label/nonce/deadline,
same-block proof and unsigned `issueBySig` calldata. The calldata **contains
the controller's externally supplied EIP-712 signature**, and therefore may be
exposed only to a separately authenticated, isolated operator-sender custody
service — **never a public HTTP response, logs, analytics, V3 KV or browser**.
`signed=false` means the OP *transaction* has not been signed. The controller's
permit may already carry a signature. The adapter has no wallet/signer method,
external writer injection, `sendRawTransaction`, `writeContract` or chain state
mutation. No signer keys or signer material are read.

`verifyV4ExternalReceipt(reader,handoff,txHash)` separately inspects only an
**external** transaction hash. It verifies chain 11155420, external transaction
`from`/`to`/input/value/hash, successful receipt/block identity, a finalized
height covering the receipt, canonical block hash on re-read, pinned V4 runtime
hash at receipt height, the exact V4 `IssuanceNonceConsumed` and `SubnodeIssued`
logs with operator/nonce/parent/node/holder bound to the handoff, and the
onchain issuance nonce progressed after execution. It never reads an operator
private key or sends a transaction; output is
`EXTERNAL_OP_TX_OBSERVED_ONLY`, **not** an L1 ENS native sovereignty receipt.

## Tests and unresolved production blockers

`pnpm exec vitest run test/unit/g2-v4-execution-adapter.test.ts` exercises:
disabled flag causing no RPC/auth/claims; bad principal, operator, rate limit;
invalid controller signature and stale actual OP nonce before claiming; exact
same-block positive simulator; two simultaneous callers with a shared *atomic*
test reservation (one winner), sequential replay rejection, later onchain nonce
change; provider-error sanitization; and external receipt negatives for wrong
sender/contract/tx calldata, mismatch/missing events and nonce, wrong chain,
unfinalized/reorged receipt, changed runtime and malicious provider. The mock
reservation is only a *test fixture*, not a Cloudflare Durable Object service.

**Why no live route:** There is no proven globally atomic, rate-limited V4
admission and identity implementation; no verified signer-custody-separated
operator sender/broadcast policy; no live deployed V4 runtime address/hash,
per-community controller + EIP-712 permit intake, transaction fee/nonce/gas
budget, external tx submission or cross-RPC finalized receipt corroboration.
Connecting a write route without these is an unsafe privilege escalation. Do
not enable it with a Worker env variable alone. No `SOVEREIGN` claim is made:
V4 is OP **application-only**; G2.4 L1-native ownership/transfer-time safety,
ENSv2 migration and finalized L1 issuance remain independent blockers.
