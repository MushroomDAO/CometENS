# G2 authority boundary: native ENS ownership vs. OP managed leases

> Design contract, 2026-10-21. **Not implemented, deployed, independently audited, or accepted.** G1 is ACCEPTED; G2 remains IN_PROGRESS and all G2-ACCEPTANCE rows remain PENDING. This file is not a cross-chain proof or a `SOVEREIGN` receipt.

## Security decision

An authenticated Ethereum L1→Optimism message proves that a particular L1 authority statement *was submitted* on L1. It does **not** prove that the original L1 owner remains the owner *now*. ENS parent ownership can transfer, expire or migrate before the message reaches OP. OP cannot synchronously read an arbitrary newly finalized Ethereum state without an independently verified state proof. Thus a message-only OP authority is **MANAGED with a finite lease**, never continuous native ENS sovereignty.

Do **not** silently rewrite this limitation as “instant on L1 transfer” or “100% revocable.” The only acceptable expiry/transfer exposure is explicitly bounded and observable. `SOVEREIGN` is name-specific **L1 native handoff** and passes an independent current, finalized owner/role/resolver verifier. A verified OP NFT never qualifies by itself.

The stronger alternative—escrowing native parent ownership and requiring OP freeze acknowledgement before parent transfer—would materially constrain the community's independent ownership and cannot be enabled without a separate user design decision. G2 defaults to *no escrow*.

## G2.4 proposed protocol, `MANAGED` only

1. **L1 native authority adapter (immutable, pinned):** determine the live authority of `parentNode` on the selected chain at the time of the binding transaction, rather than trusting a constructor argument, Worker signature or hot EOA. ENSv1 Registry owner and NameWrapper wrapped holder/fuses/expiry are distinct; for `.eth`, registrar expiry and grace matter too. ENSv2 uses its actual hierarchical registry and EAC permissions, **not** ENSv1 namehash ownership/fuse shortcuts. Pin chainId, native contract addresses and runtime implementation identity. An L1 smart-account/multisig controller must be supported.
2. **Explicit owner-authorized bind/renew/rotate:** the native L1 owner signs an actual L1 operation, or calls directly from its smart account. The adapter emits a monotonically sequenced checkpoint containing source/version, parent identity, controller, epoch, L1 validity horizon, short OP lease horizon, block context and destination. Third parties may permissionlessly trigger safe expiry/freeze refreshes; no keeper can extend authority by assertion alone.
3. **Canonical messenger only:** fix and verify L1 sender adapter and L2 inbox. The inbox requires `msg.sender == pinned L2CrossDomainMessenger` *and* `xDomainMessageSender() == pinned L1 adapter`, along with exact source/destination chain IDs, contract identity, parent identity, version, sequence and epoch. Never accept an arbitrary relayer's JSON/signature as equivalent proof. The OP messenger itself is an upgradeable dependency; disclose that systemic trust rather than hiding it.
4. **OP isolation/lease enforcement:** store per-parent `sourceVersion`, `epoch`, `sequence`, `rootController`, `leaseUntil` and validity limit onchain. Reject stale/out-of-order, duplicate, future-version and wrong-parent messages. On new epoch, invalidate old operators, pending handoff, grants and signed authorizations. **Every** privileged operation—including direct controller `issue`, grant, rotate, controller proposal/acceptance and delegated issue—must check live OP lease. An expired/unknown/undelivered checkpoint freezes new privilege expansions, even if Worker KV or gateways report success. A current lease is still only a snapshot: expiry bounds staleness; it does not prevent pre-expiry L1 transfers.
5. **No member clawback:** freezing a parent or rotating its controller cannot transfer existing issued member NFTs or overwrite member-owned records. Do not reuse V3 global-owner semantics. Native L1 expiry and re-registration may independently end ownership of the name; report that explicitly.

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
| D | Fresh lease-gated OP V4 successor, including controller bypass negatives | 2.1, 2.2, 2.4 |
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
