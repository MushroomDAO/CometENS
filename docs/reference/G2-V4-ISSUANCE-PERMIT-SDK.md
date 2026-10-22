# G2.6: V4 controller-signed issuance SDK payload (application only)

The separate `@cometens/sdk/v4` entrypoint exposes `createV4IssueTypedData`
and `prepareV4IssueBySig`. These are **pure encoding helpers**: they never
read chain state, sign messages, broadcast transactions, consume an onchain
nonce or turn V4 OP application tokens into L1 native ENS ownership.

1. Independently verify the pinned OP V4 deployed runtime, its parent namehash,
   current root controller and `CAP_ISSUE | CAP_SIGNED_ISSUE` operator grant.
   Read `controllerEpoch`, `operatorRevision(operator)` and `issuanceNonce`
   directly from the target V4 contract, not from Worker KV or a local counter.
2. Construct `{chainId:11155420, verifyingContract}` and the exact
   `{label, member, initialAddr, operator, controllerEpoch, operatorRevision,
   nonce, deadline}`. `label` must obey the V4 ASCII LDH subset, including the
   third/fourth-hyphen rule. Keep `deadline` near the intended transaction; the
   contract checks `now <= deadline <= now + 1 day` **at execution**. The helper
   validates integer ranges but makes **no current-time execution claim**.
3. `createV4IssueTypedData(profile, permit)` returns the EIP-712 domain
   `CometENS Community V4`/`1`, Issue struct and message for the actual root
   controller's external wallet to sign (EOA or ERC-1271).
4. `prepareV4IssueBySig(profile, permit, controllerSignature)` returns the
   unsigned **operator-sent** transaction `{from,to,chainId,data,value}`.
   The controller signature is embedded in calldata, but the transaction is
   **not signed or sent**; only the named active operator may submit it.
5. At the **actual transaction**, V4 checks the live grant, quota, epoch,
   signature and onchain nonce atomically. Any competing issue, controller
   rotation, operator regrant/revoke or expiry can invalidate the previously
   prepared calldata. Read the finalized receipt and resulting ownership
   independently; no successful preflight reserves a nonce.

Signature bindings include target OP chain and verifying contract through the
EIP-712 domain; the 8 Issue fields bind member, label, initial record address,
operator, controller epoch, operator revision, nonce and deadline. The tests
compare the resulting EIP-712 digest with a separately ABI-encoded domain/struct
hash (independent of `hashTypedData` and the contract's `ISSUE_TYPEHASH`).

The helpers deliberately accept only explicit OP Sepolia profiles for this G2
stage. They do **not** replace Worker V3 APIs or implement a new V4 Worker
route, chain runtime authentication, nonce reservation, L1-native issuance,
ENSv2 EAC/migration audit, `SOVEREIGN` receipt or public-chain deployment.
They do not authorize wallet signing without the controller's separate
approval. The [G2 acceptance matrix](../goal/G2-ACCEPTANCE.md) remains PENDING.
