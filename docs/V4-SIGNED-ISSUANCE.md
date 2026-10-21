# V4 per-parent signed issuance (G2.6 partial)

`L2CommunityRecordsV4` remains an **OP application-layer** ERC-721/record
contract. A controller signature here does **not** prove that the controller owns
the L1 ENS parent and does **not** transfer native ENS/NameWrapper ownership.
Nothing in this change updates the V3 Worker/KV or exposes a new SDK mint flow.

## Delegation and opt-in enforcement

- Each V4 deployment has one immutable `parentNode` and a mutable
  `rootController`. Its existing direct `issue()` route remains available to the
  controller and to operators granted `CAP_ISSUE` without `CAP_SIGNED_ISSUE`.
- A controller who requires **per-mint signed consent** grants the operator
  `CAP_ISSUE | CAP_SIGNED_ISSUE` (and, only if needed, `CAP_INITIAL_ADDR`). Such
  an operator **cannot** call unsigned `issue()`; it may use `issueBySig()` only
  with a valid signature of the current controller. Other operator grants still
  permit unsigned issuance by design: this is an opt-in policy per operator.
- The **actual transaction sender** is the nominated operator, which must have
  an active, non-expired grant in the current `controllerEpoch` with quota left.
  `CAP_INITIAL_ADDR` is required if `initialAddr != address(0)`; it cannot edit
  records after the NFT is minted. Existing `_safeMint` receiver callback and
  NFT-holder-only record/transfer permissions are unchanged.
- `operatorRevision(operator)` increments for grants, revocations and rotations.
  A previously signed request cannot survive a revoke/re-grant under the same
  controller. Controller transfer bumps `controllerEpoch` and invalidates every
  old grant/signature, including after a grant to the same operator.

## Typed permit and on-chain replay policy

EIP-712 domain: name `CometENS Community V4`, version `1`, target **OP chain ID**,
and the exact deployed V4 **verifying contract address**. The struct is:

```solidity
Issue(
  string label,
  address member,
  address initialAddr,
  address operator,
  uint64 controllerEpoch,
  uint256 operatorRevision,
  uint256 nonce,
  uint256 deadline
)
```

The contract hashes the string label as EIP-712 `string`, checks the **current**
epoch/revision itself, and requires `nonce == issuanceNonce` (one shared on-chain
sequence for this V4 instance). Only the current controller's EOA signature or
ERC-1271 approval counts. Any operator can read the nonce, but only one permit
for a given nonce can succeed. A successful permit atomically increments nonce,
decrements the operator's quota, and mints; reverts undo *all* these effects.
`invalidateIssuanceNonce(nextNonce)` lets only the controller cancel existing
permits by increasing the nonce, subject to a bounded skip and ceiling.

The contract checks `block.timestamp <= deadline <= block.timestamp + 1 day`
when submitted (execution cutoff, not evidence of when it was signed).
Operators must request a new signature after grant revision, controller epoch,
nonce, or deadline changes. The EIP-712 domain prevents cross-chain and
cross-contract replay. Validation consumes nonce/quota before an external
ERC-1271 **staticcall**; the callback cannot mutate on-chain state.

## Limits and deployment notes

- A malicious but currently authorized **unsigned** `CAP_ISSUE` operator can
  still issue within its scoped grant, as existing V4 behavior expressly allows.
  Signed enforcement must be selected when granting that operator.
- Once a valid permit is signed, the designated operator may execute it before
  revocation, expiry or cancellation, subject to OP transaction order. The
  controller may cancel the current sequence; this does not revert prior mints.
- The single issuance nonce serializes signed mints for this parent. Clients
  should read `issuanceNonce`, `controllerEpoch`, and `operatorRevision` afresh
  before presenting signatures; this is a simple safe first increment, not a
  high-throughput issuance queue. Future nonce permits may become executable
  later if the issuer does not skip beyond them.
- For possible future deployment, compile with an optimizer: the local
  `forge build --sizes --optimize` measurement is below EIP-170's 24,576-byte
  runtime ceiling. No new deployment or testnet write is authorized here.

The Foundry suite covers EOA/ERC-1271 signatures, on-chain replay, operator
revocation/re-grant, expiry/quota, controller epoch transfer, other chain and
contract, and holder record invalidation on ERC-721 transfer. G2.6 and the
overall G2 acceptance matrix remain **PENDING** until integration, review,
and independent acceptance.
