# G2.4 #138: strict transfer-time revocation, proof obligation and L1-only support

**Status: BLOCKED / G2.4 `PENDING`.** This analysis and its Foundry fixture do
not provide an ENS-native name, a consensus/state proof, a deployed cross-chain
protocol, an independently finalized L1/OP receipt or a `SOVEREIGN` status.
They explicitly falsify the tempting claim that a bounded OP lease gives
transfer-time revocation. No escrow, platform superowner or G3 work is proposed.

## The safety property and why the current OP path cannot prove it

Frozen #138 requirement: after the actual native L1 parent ownership/authority
change, **no former OP root controller, delegate, or previously signed
authorization may expand OP or claimed native issuance privileges**, regardless of undelivered,
reordered or delayed bridge messages, and without member-token clawback.

Let `C` be a canonical authenticated OP checkpoint with `(controller=A,
sourceEpoch=1, leaseUntil=t+3600)`. At `t+1`, an actual L1 transaction transfers
native parent control from A to B. Consider two possible histories at `t+2`:

| History | L1 native state at `t+2` | OP inbox/V4/issuer state at `t+2` |
| --- | --- | --- |
| H0 | A still owns parent | Last delivered `C`; live lease for A; old delegates |
| H1 | B now owns parent | **Identical** last delivered `C`; live lease for A; old delegates |

Before a fresh message or independently verified authoritative state proof is
present *and enforced at the actual OP transaction*, any OP-only deterministic
guard receives identical inputs in H0 and H1. Therefore it must make the same
authorization decision in both histories. If it permits an OP mint for A in H0,
it necessarily permits that mint in H1. A shorter lease only shortens the race;
it cannot eliminate the interval. A relayer, watcher, `observeLoss()` call,
OP `sourceEpoch` advance **after delivery**, optimistic bridge confirmation,
gateway cache or L1 event emitted after the transfer cannot change this proof.
A proof about a *historical finalized L1 state* likewise cannot certify a later
L1 transfer has not occurred. Native L1 and OP cannot share an atomic write
boundary while the parent is freely transferable on L1.

`contracts/test/G2StrictTransferGap.t.sol` contains the executable *failure*
case. Using local fixture code for the pinned legacy Registry, NameWrapper and
BaseRegistrar, it builds the actual V4 + OP inbox + managed lease issuer, accepts
one canonical-messenger-mocked positive checkpoint, and grants a delegate. The
fixture then changes the L1 native holder from A to B **without delivering a new
OP checkpoint**; A and the old delegate each successfully mint real V4 tokens
through the existing issuer. A subsequently delivered zero-controller freeze
blocks further mints. These two successes are evidence of the **unfixed bug
against the strict G2.4 requirement**, not a passing transfer-safety proof.
Foundry's `vm.chainId` switching is a controlled two-domain simulation, not
two independent finalized chains or a real cross-chain proof.

## Minimal supporting L1-only component delivered in this package

`contracts/src/G2LegacyL1NativeActionGuard.sol` is a small abstract guard for
**future L1 native action executors**. It is intentionally **not** wired into the
existing OP V4 issuance path and cannot make OP leases strict. An inheriting L1
executor may attach `onlyCurrentLegacyNativeHolder` to an L1 entrypoint:

- Verify execution is on L1 Sepolia, and pin the source contract's runtime
  hash, intended `parentNode`, and explicit L1 source-domain identifier.
- On **each L1 execution**, call the legacy source's `currentAuthority()`,
  which checks current ENSv1 Registry and BaseRegistrar custody of `.eth`,
  NameWrapper holder/data consistency and registrar/wrapper expiry outside
  the 24-hour margin. Require nonzero current native holder equal to the
  **actual transaction caller**. Smart-account native holders can call directly;
  relayers, old holders and cached checkpoint controllers cannot impersonate it.
- Fail closed on identity/chain/custody/expiry mismatch. The onchain test harness
  demonstrates A permitted before a legacy wrapped-owner transfer, immediately
  denied after it and B permitted in the new state. The demonstration action
  only increments a local test counter; **no native ENS issuance is performed**.

The guard is an internal execution-time building block: a separate reviewed
native NameWrapper/ENSv2 issuance implementation would have to enforce it in
the **same L1 transaction**, atomically with all other actual right-expanding
operations. A frontend preflight or an OP RPC call to this L1 contract cannot
provide that guarantee. Native registrar/wrapper approvals and external
callbacks require separate auditing: an unrelated granted operator or an
L1 transfer performed *inside* a downstream callback can bypass a naive
"checked earlier" call pattern. No platform admin/escrow/owner is installed.

## Actual ENSv1 and ENSv2 authority surfaces

**ENSv1 `.eth` wrapped name**: check current Registry owner (the wrapper),
BaseRegistrar ERC-721 custody and registration expiry (the 90-day grace period
is *not* mint authority), NameWrapper `ownerOf`/`getData` agreement, fuses,
subname expiry, ERC-721 `getApproved`/`isApprovedForAll`, NameWrapper ERC-1155
`isApprovedForAll` and any authorized subname manager. NameWrapper
`CANNOT_UNWRAP` and child `PARENT_CANNOT_CONTROL` can constrain parent actions
only until their effective expiry; resolver administration remains separate.
Refs: [NameWrapper fuses](https://docs.ens.domains/wrapper/fuses/),
[expiry](https://docs.ens.domains/wrapper/expiry/),
[contracts](https://docs.ens.domains/wrapper/contracts/).

**ENSv2**: ENSv1 `namehash`/NameWrapper custody is **not** a complete ENSv2
owner proof. ENSv2 uses hierarchical registries, EAC role/resource scopes,
regular **and admin** `ROOT_RESOURCE` roles, `ROLE_SET_PARENT`,
`ROLE_SET_SUBREGISTRY`, `ROLE_UPGRADE`, record/resolver roles and inherited
ERC-1155 `setApprovalForAll` authority. Token IDs are mutable when permissions
or registration versions change; a stale token ID or a `RESERVED` name is not
current native ownership. Migration may choose a *different* v2 holder and
resolver and may route old v1 NFTs to migration controllers/Graveyard. An
unmigrated v1-looking state cannot establish that ENSv2 migration has not
already superseded it. All deployed ENSv2 registry/proxy/implementation/
subregistry paths, EAC and migration proofs must be independently pinned and
audited **before** any native issuance gate supports ENSv2. This package has
**no ENSv2 authorization path**, refuses any claim of ENSv2 readiness and must
not be enabled as production G2.4 authorization across migration.
Refs: [ENSv2 permissioned registry](https://docs.ens.domains/ensv2/permissioned-registry/),
[EAC](https://docs.ens.domains/ensv2/enhanced-access-control/),
[migration](https://docs.ens.domains/ensv2/migration/).

## Product/security decision still required

| Option | Enforceable boundary | Required decision / limitation |
| --- | --- | --- |
| A. Native L1 issuance only | Authorize and perform **irreversible native issuance on L1**, inside the same transaction as current native authority verification; OP mirror cannot confer independent issue rights | Community explicitly agrees to disable or permanently downgrade the old OP V4 issuer as authoritative; native executor, ENSv1/v2 migration/approvals, callbacks and member handoff require a separate reviewed implementation. Current adapter cannot be retroactively frozen at L1 transfer time. |
| B. L1 custody / transfer pre-freeze handshake | No native transfer until authoritative OP freeze is proven and ordering/finality guaranteed | **High-impact custody and transfer UX choice** requires explicit user/community approval, violates the current no-custodian direction without a new model. Not implemented. |
| C. L1 state proof on OP | Verify a particular L1 owner state root at a particular finalized block | Historical proof alone cannot rule out a more recent native transfer. Needs additional synchronization or a transfer restriction; not equivalent to A/B. Not implemented. |
| D. Keep OP bounded MANAGED | Time-bound the stale issuance risk; later freeze eventually stops it | Existing behavior, **cannot pass #138/G2.4**. |

**Conservative recommendation**: retain current public OP V4 as an explicitly
`MANAGED` application NFT system with an unresolved strict release blocker. Do
not publish any receipt claiming native ownership or transfer-time revocation.
Before implementing Option A as authoritative, obtain the explicit high-level
decision to move irreversible issuance to L1 and determine how to neutralize
the preexisting OP mint pathway, plus separately verify ENSv2/migration state.
No unilateral irreversible code change or L1 custody handoff is authorized.

Acceptance of #138 requires independent tests across actual finalized L1/OP
states, a native issuance transaction whose authorization rechecks every
applicable ENSv1/v2 and approval authority at execution, parent transfer /
expiry / re-registration / migration / upgrade / callback negative tests,
demonstrated removal of all stale OP privilege-expansion paths and independent
security review. **All G2 acceptance rows remain PENDING.**
