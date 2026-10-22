# G2 authority boundary: native ENS ownership vs. OP managed leases

> Design contract, 2026-10-21. **Not implemented, deployed, independently audited, or accepted.** G1 is ACCEPTED; G2 remains IN_PROGRESS and all G2-ACCEPTANCE rows remain PENDING. This file is not a cross-chain proof or a `SOVEREIGN` receipt.

**2026-10-22 architectural update:** the native issuance direction is [L2 request → current-authorization L1 native transaction → authenticated OP result mirror](G2-ZK-MERKLE-L1-AUTHORITY-DECISION.md), with an event-triggered and periodic L1 Monitor for subsequent state convergence. The `MANAGED` lease below remains a documented bounded prototype, **not** a replacement for native issuance or a passing G2.4 transfer-time safety proof.

## Security decision

An authenticated Ethereum L1→Optimism message proves that a particular L1 authority statement *was submitted* on L1. It does **not** prove that the original L1 owner remains the owner *now*. ENS parent ownership can transfer, expire or migrate before the message reaches OP. OP cannot synchronously read an arbitrary newly finalized Ethereum state without an independently verified state proof. Thus a message-only OP authority is **MANAGED with a finite lease**, never continuous native ENS sovereignty.

Do **not** silently rewrite this limitation as “instant on L1 transfer” or “100% revocable.” The only acceptable expiry/transfer exposure is explicitly bounded and observable. `SOVEREIGN` is name-specific **L1 native handoff** and passes an independent current, finalized owner/role/resolver verifier. A verified OP NFT never qualifies by itself.

The stronger alternative—escrowing native parent ownership and requiring OP freeze acknowledgement before parent transfer—would materially constrain the community's independent ownership and cannot be enabled without a separate user design decision. G2 defaults to *no escrow*.

**Acceptance reconciliation:** the frozen [G2.4 requirement](../goal/G2-ACCEPTANCE.md) that an L1 transfer cannot expand stale OP privileges is **NOT met by the managed-lease design**. We will not weaken that requirement to make a test pass. In particular, a real transfer during a two-hour lease can leave the former root controller with residual OP write authority until a freeze is delivered or the lease expires. Package A–D can only be marked *implemented as a bounded MANAGED prototype*, **not G2.4 ACCEPTED**. Before closing G2.4, require a genuinely race-excluding design (for example a user-approved L1 custody/freeze-before-transfer protocol) or remove the stale OP controller's privileged issuance path by making native L1 issuance the only authoritative issuance; independently prove which assurance applies. This stronger restriction is a separate product/security decision, not implied user approval of escrow.

## G2.4 proposed protocol, `MANAGED` only

1. **L1 native authority adapter (immutable, pinned):** determine the live authority of `parentNode` on the selected chain at the time of the binding transaction, rather than trusting a constructor argument, Worker signature or hot EOA. ENSv1 Registry owner and NameWrapper wrapped holder/fuses/expiry are distinct; for `.eth`, registrar expiry and grace matter too. ENSv2 uses its actual hierarchical registry and EAC permissions, **not** ENSv1 namehash ownership/fuse shortcuts. Pin chainId, native contract addresses and runtime implementation identity. An L1 smart-account/multisig controller must be supported.
2. **Explicit owner-authorized bind/renew/rotate:** the native L1 owner signs an actual L1 operation, or calls directly from its smart account. The adapter emits a monotonically sequenced checkpoint containing source/version, parent identity, controller, epoch, L1 validity horizon, short OP lease horizon, block context and destination. Third parties may permissionlessly *request a read/refresh*; the adapter only emits a state-changing freeze checkpoint after independently detecting lost/expired native authority. A harmless read does not increment `sequence`, consume sequence slots, or grant authority. Gas for the requested L1 refresh and message belongs to the submitting caller; no keeper can extend authority by assertion alone.
3. **Canonical messenger only:** fix and verify L1 sender adapter and L2 inbox. The inbox requires `msg.sender == pinned L2CrossDomainMessenger` *and* `xDomainMessageSender() == pinned L1 adapter`, along with exact source/destination chain IDs, contract identity, parent identity, version, sequence and epoch. Never accept an arbitrary relayer's JSON/signature as equivalent proof. The OP messenger itself is an upgradeable dependency; disclose that systemic trust rather than hiding it.
4. **OP isolation/lease enforcement:** use **one new V4 successor per parent** (not a shared multi-root storage map), each with separate `sourceVersion`, L1 `sourceEpoch`, L1 global-per-parent `sequence`, OP `controllerEpoch`, `rootController`, `leaseUntil` and L1 validity limit. `sourceEpoch` changes for native L1 owner/controller authority events (including migration); it never resets the monotone `sequence`. OP `controllerEpoch` must increment on *every accepted increase in sourceEpoch*, even when the controller address stays identical, invalidating old operators, pending handoff, grants and controller-signed authorizations. Member-only `recordEpoch` remains reserved for each NFT transfer, **not** L1 checkpoint rotation. Reject any `sequence <= storedSequence`, any `sourceEpoch < storedSourceEpoch`, and a controller change without a sourceEpoch increase. An expired/unknown/undelivered lease prevents **new privilege expansions**, even if Worker KV or gateways report success. It must never block actions that only *reduce* OP privilege. A current lease is still only a snapshot: expiry bounds staleness; it does not prevent pre-expiry L1 transfers.
5. **No member clawback:** freezing a parent or rotating its controller cannot transfer existing issued member NFTs or overwrite member-owned records. Do not reuse V3 global-owner semantics. Native L1 expiry and re-registration may independently end ownership of the name; report that explicitly.

**Lease bounds (OP Sepolia prototype):** `MAX_LEASE = 2 hours` is a hard onchain ceiling; `leaseUntil > block.timestamp`, `leaseUntil <= block.timestamp + MAX_LEASE`, and `leaseUntil <= l1ValidUntil`, where the L1 adapter sets `l1ValidUntil` at or before actual parent `.eth` registration expiry **minus a 24-hour safety margin** (not inside registrar grace). Only the L1-native holder/authorized smart account at L1 execution can request a positive new controller or renewal; the fixed authenticated L1 adapter is the only source of these messages. An operator or Worker cannot choose the lease horizon. Operational renewal attempts should start at least 15 minutes before lease end, but there is **no fallback privilege if they are late**; do not mistake scheduling for an onchain safety guarantee. These short bounds are risk containment, **not** satisfaction of G2.4 transfer-time safety.

| Action after OP lease expiry | Decision | Reason |
| --- | --- | --- |
| Direct controller / delegated `issue`; signed `issue` | **Reject** | Expands issuance privileges |
| `grantOperator`; `rotateOperator` (grants next) | **Reject** | Creates new privilege even if old operator is removed |
| `proposeController(nonzero)` / `acceptController` | **Reject** | New controller authority must come from fresh L1 proof |
| `revokeOperator`; `proposeController(address(0))` | **Allow** | Can only reduce existing/pending OP rights |
| Member's own records, token transfer, signed-record nonce invalidation | **Allow** | Must remain member-controlled; cannot enlarge root authority |

**Finality classification:** canonical L1 deposits may first be executed on an unsafe OP head and before the source L1 transaction is finalized. This is not a proof of finality. A provisional inbox checkpoint may enforce only a *MANAGED* lease. The independent receipt verifier must observe the originating L1 checkpoint in a finalized Ethereum block **and** the corresponding OP execution in a finalized OP block before reporting verified delivery; reorged, unsafe or unproven inclusions must never count toward G2.4 acceptance. A messenger without a verified finalized-source guarantee cannot be elevated by merely waiting an arbitrary number of minutes.

Suggested versioned message shape (ABI to be frozen and tested before implementation):

```solidity
struct RootCheckpoint {
    uint256 sourceChainId;
    uint256 destinationChainId;
    address sourceAdapter;
    address destinationInbox;
    bytes32 parentNode;
    address controller;
    uint64 sourceEpoch;
    uint64 sequence;
    uint64 leaseUntil;
    uint64 l1ValidUntil;
    bytes32 authorityVersion;
}
```

**Fail-closed tests:** spoof `xDomainMessageSender`; generic relayer call; wrong chain, inbox, parent, epoch or source version; duplicate/out-of-order checkpoint; failed relay; lease expires before next checkpoint; old controller directly issues; rotation leaves operator/pending owner active; L1 transfer during unexpired lease; ENSv1→ENSv2 migration while old v1 message is delayed; `.eth` expiration, grace and re-registration; OP reorg/unsafe inclusion. The **L1 transfer during lease must demonstrate the limitation honestly**, not be marked protected by tests that only inspect OP.

Required concrete checkpoint examples (OP Sepolia messenger `0x4200000000000000000000000000000000000007`, L1 source chainId `11155111`, OP destination `11155420`, same pinned adapter/inbox/root/version throughout):

| Stored `(sourceEpoch,sequence,controller)` | Incoming | Expected |
| --- | --- | --- |
| `(0,0,zero)` | `(1,1,A)` with `leaseUntil=now+3600`, `l1ValidUntil=now+7200` | Accept `MANAGED` (not G2.4 acceptance) |
| `(1,1,A)` | `(1,1,A)` | Reject duplicate |
| `(1,1,A)` | `(1,2,B)` | Reject controller change without epoch increase |
| `(1,1,A)` | `(2,2,B)` | Accept and increment OP controllerEpoch, revoke old A grants |
| `(2,2,B)` | `(1,3,A)` | Reject stale L1 epoch even with higher sequence |
| `(2,2,B)` | `(3,3,zero)` freeze | Accept; no new issues; member records intact |
| `(3,3,zero)` | `(4,4,B)` `leaseUntil=now+7201` | Reject over MAX_LEASE |
| `(3,3,zero)` | `(4,4,B)` `leaseUntil > l1ValidUntil` | Reject beyond native parent validity |

Test both post-expiry `revokeOperator` and `proposeController(0)` **succeed**, while `issue`, grant, nonzero propose and accept all fail. This does not change the frozen G2.4 requirement for immediate transfer safety.

## Native G2.7–G2.9 acceptance is separate

**ENSv1 legacy path:** member's actual L1 subname must be registered under the native Registry/NameWrapper, held by the member in the canonical NameWrapper and, as appropriate, have parent `CANNOT_UNWRAP` plus child `CANNOT_UNWRAP | PARENT_CANNOT_CONTROL`. Check holder approvals (`getApproved` / `isApprovedForAll`), current unexpired parent/child, `.eth` registrar lifecycle, renewal limits, resolver control and upgrade/admin paths. PCC/CU is not perpetual ownership: expiry and ENS protocol governance remain external risks. Default to **member-changeable resolver**; irreversible resolver lock is an explicit optional decision with recovery consequences.

**ENSv2 current Sepolia path:** independently pin official v2 deployment and implementation, hierarchical parent/subregistry pointers, name lifecycle and EAC versions (token IDs change when roles or registration versions change). Inspect `ROOT_RESOURCE` regular **and admin** rights, `ROLE_SET_PARENT`, registry `ROLE_UPGRADE`, relevant per-name and per-record write roles and inherited ERC-1155 `setApprovalForAll`. A plain role revoke is not irreversible if an admin/root holder can regrant it. Migrated v1 names require a fresh v2 proof; a v1 `RESERVED` fallback is not a v2 owner. Neither EAC nor v1 fuses alone certify immutable record content.

**Receipt/verifier:** `SOVEREIGN` is *never inferred from OP bridge/lease alone*. A reproducible receipt must state name/holder, L1 chain, exact finalized block number/hash, audited contract/implementation identity, native holder/fuses or EAC rights, parent expiry/migration, member resolver control and all remaining approval/admin paths. If resolution or record immutability is claimed, include its independent finality/permission evidence. OP delivery requires a separate finalized OP receipt; an L1 finalized tx is not the same as finalized OP execution. Missing/stale/unsafe evidence yields `MANAGED`, `HANDOFF_PENDING`, `NEEDS_REPAIR` or `AT_RISK`, **never optimistic `SOVEREIGN`**. Public RPC readings alone are not cryptographically independent finality proofs.

## Small, independently reviewable implementation sequence

| Package | Scoped work | G2 |
| --- | --- | --- |
| A | Pinned live L1 authority readers and expiry/grace negative tests | 2.4 |
| B | L1 smart-account-capable onchain checkpoint producer | 2.4 |
| C | Versioned canonical messenger and authenticated OP inbox | 2.4 |
| D | Fresh lease-gated OP V4 successor; prove rotation cannot move member NFT/records and controller direct-issue gate | 2.1, 2.2, 2.3, 2.4 |
| E | SDK/CLI status, grant/revoke receipt and relayer nonce tests | 2.5, 2.6 |
| F | ENSv1 native subname calldata and L1 member-handoff verifier | 2.7, 2.8 |
| G | Pinned ENSv2 EAC inspector and migration invalidation | 2.4, 2.7, 2.8 |
| H | Resolver autonomy, optional immutable records, third-party receipt verification | 2.8, 2.9 |

All require review/CI/Foundry fuzz or local Anvil E2E where appropriate. Real Sepolia writes require a separately authorized acceptance workflow; the presence of RPC/keys does not grant permission. No mainnet writes, SDK publication or G3 until G2 passes the full matrix and the user explicitly accepts it.

## Reference specifications (not proofs of a deployed CometENS instance)

- [ENSv2 Enhanced Access Control](https://docs.ens.domains/ensv2/enhanced-access-control/)
- [ENSv2 Permissioned Registry](https://docs.ens.domains/ensv2/permissioned-registry/)
- [ENSv2 migration](https://docs.ens.domains/ensv2/migration/)
- [OP Stack cross-domain messenger specification](https://specs.optimism.io/protocol/messengers.html)
- [G2 acceptance matrix](../goal/G2-ACCEPTANCE.md)
