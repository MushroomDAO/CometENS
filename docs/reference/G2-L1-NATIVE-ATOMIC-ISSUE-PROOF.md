# G2.4 — local ENSv1 native atomic issue proof (not an acceptance receipt)

**Status: LOCAL PROOF ONLY; G2.4 `PENDING`.**

The historical `G2StrictTransferGap.t.sol` test remains a counterexample: after
an L1 owner A transfers their wrapped parent to B, an undelivered OP freeze leaves
the old OP V4 controller/delegate able to issue OP application-layer tokens.
There is no synchronous read of current Ethereum L1 ENS ownership from OP.

`contracts/src/G2LegacyL1NativeIssuerProof.sol` is a separate, deliberately
unconnected **legacy ENSv1 L1-only** candidate. It extends the existing pinned
`G2LegacyL1NativeActionGuard`, enforcing the real `msg.sender == current L1
NameWrapper holder` at execution. Within that same **L1 transaction**, it:

1. Rechecks the pinned L1 Registry, BaseRegistrar and NameWrapper custody,
   native holder and registration/wrapper expiry with a 24-hour safety margin.
   Checks the parent's `CANNOT_UNWRAP` fuse and a vacant child node. Accepts only
   ASCII lowercase LDH labels, nonzero member, and child expiry no later than
   the current native authority's safe expiry.
2. Calls legacy `NameWrapper.setSubnodeRecord(parentNode,label,member,resolver,
   0,CANNOT_UNWRAP|PARENT_CANNOT_CONTROL,expiry)`. The **current parent holder**
   must separately grant this executor `setApprovalForAll` on the wrapper for
   NameWrapper's own `onlyTokenOwner(parentNode)` gate. No parent NFT is
   transferred into custody; this contract has no owner or admin key.
3. Rechecks L1 parent authority after the external call and asserts the actual
   native child Registry ownership, wrapped member ownership, fuse bits and
   requested expiry. A transfer in a recipient callback reverts the **whole
   transaction**, including the tentative child write.

The result is a narrow atomic rule for **issuance through this L1 entrypoint**:
after a completed L1 parent transfer, the old holder's later transactions fail,
even if the OP mirror has not received any transfer event. A new L1 parent
holder can separately approve and use the executor. Existing member-owned
wrapped children are not moved by this executor.

## Reproduce locally (no Sepolia/mainnet transaction)

The fixture installs behavior-simulating Registry, BaseRegistrar and NameWrapper
bytecode at the **legacy ENSv1 address constants** using Foundry `vm.etch`.
It issues a native child via the exact `setSubnodeRecord` ABI and verifies the
Registry/NameWrapper effects. It is **not** the full real deployed NameWrapper
implementation, a live network fork, an ENSv2 EAC proof or an independently
finalized L1 receipt.

```bash
cd contracts
forge test --offline --match-contract G2LegacyL1NativeIssuerProofTest

# Optional: separate terminal, local Anvil only:
anvil --chain-id 11155111 --port 18643 --silent
forge test --offline --fork-url http://127.0.0.1:18643 \
  --match-contract G2LegacyL1NativeIssuerProofTest
```

Negative tests cover completed parent transfer without updating OP, recipient
ERC-1155 callback transfer with whole-transaction rollback, lack of wrapper
operator approval, unlocked parent, wrong chain, registrar expiry, invalid
child expiry/name, duplicate child, missing fuse, and fraudulent wrapper output.

## Non-authoritative OP boundary and production blockers

The OP inbox, V4 token and managed lease issuer **remain unchanged**. OP
checkpoints can be a lagging *mirror* of native L1 events and are `MANAGED`
only. No OP token issued before/after this proof is upgraded to a native ENS
membership, and any old OP mint route remains a strict G2.4 blocker while it
can expand privileges despite L1 transfer. This source file is not connected
to production, SDK, or live deployments; it must not be advertised as a
security upgrade to the existing issuer.

Before a native production path: independently pin/audit deployed ENSv1
Registry/Registrar/Wrapper implementation and migration state; validate
NameWrapper approval/operator and upgrade surfaces, registrar `reclaim`, ENSv2
subregistries and EAC rights; review smart wallet callbacks, real NameWrapper
runtime behavior, permission grants, user-controlled resolver/recovery,
expiry extension and member handoff; validate finalized transaction receipts;
and remove/downgrade all stale right-expanding OP paths. A pinned historic
ENSv1 holder alone is insufficient to authorize ENSv2 after migration.

Official references: [ENS NameWrapper operations](https://docs.ens.domains/wrapper/contracts/),
[fuses](https://docs.ens.domains/wrapper/fuses/),
[expiry](https://docs.ens.domains/wrapper/expiry/),
and the existing [strict-transfer counterexample](./G2-STRICT-TRANSFER-TIME-PROOF.md).
