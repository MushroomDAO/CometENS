# G2.4 — Ethereum MAINNET ENSv2 current EAC observation

**Status: READ-ONLY SNAPSHOT; G2.4 `PENDING`. Not an issuance permit,
deployed L1 executor, native handoff, cross-chain finality proof, or
`SOVEREIGN` receipt.** The historical ENSv1 NameWrapper proof is [separate](G2-L1-NATIVE-ATOMIC-ISSUE-PROOF.md).

`scripts/verify-g2-ensv2-eac-l1.mjs` is narrowly scoped to one ASCII-LDH
second-level `parentName` (e.g. `community.eth`) and its direct child registry
on **Ethereum L1 chain ID 1**. It is separate from the Sepolia ENSv2 risk
inspector and refuses all ENSv1 NameWrapper assumptions. [Official deployments](https://docs.ens.domains/learn/deployments/)
listed on **2026-10-23**: `RootRegistry` `0x2553c09be6447beffdb86fa622ad41fb8f77a91e`
and `ETHRegistry` `0xf60aba43e1f7f3dab1186ff03b561401c9df85e2`.
**ENSv2 is deployed ahead of the Mainnet launch; ENSv1 still serves Mainnet
registration and resolution until activation.** These pinned addresses do not
themselves establish that ENSv2 is authoritative for a given name.

## Input and observations

The caller supplies a known native holder/actor and three independently
verified runtime code hashes (root, ETH, **dynamically discovered** child
registry); where a registry is a proxy, the current implementation address
and runtime hash must also be pinned. No example hash should be treated as
authoritative. The script refuses unexpected manifest keys and does not
obtain/accept private keys or wallet signing rights.

```json
{
  "parentName": "community.eth",
  "holder": "0x<40 hex characters>",
  "actor": "0x<same current holder>",
  "pins": [
    { "address": "0x2553c09be6447beffdb86fa622ad41fb8f77a91e", "codeHash": "0x<64 hex characters>" },
    { "address": "0xf60aba43e1f7f3dab1186ff03b561401c9df85e2", "codeHash": "0x<64 hex characters>" },
    { "address": "0x<discovered child registry>", "codeHash": "0x<64 hex characters>",
      "implementation": { "address": "0x<impl address>", "codeHash": "0x<64 hex characters>" } }
  ]
}
```

`implementation` is needed **only** for a nonzero EIP-1967 implementation
slot. A zero implementation slot must have no implementation pin. Nonzero
EIP-1967 admin or beacon slots fail closed; unknown upgrade mechanisms are
outside this proof.

```bash
COMETENS_MAINNET_RPC_URL=https://YOUR_READ_ONLY_MAINNET_RPC \
  node scripts/verify-g2-ensv2-eac-l1.mjs ./local-mainnet-manifest.json
```

The script checks `getChainId() === 1`, reads a fresh `latest` block number,
hash and timestamp, pins every contract read/bytecode/storage check to that
number, and rechecks the block hash at the end to detect a changed head.
It requires the root → `.eth` registry link and reverse parent; the parent
name's `getState(keccak256(label))` must be `REGISTERED` (status 2), have
at least 24 hours validity, current EAC resource equal to `getResource`,
current token's `ownerOf(tokenId)` equal to `latestOwner` **and** the expected
holder. `RESERVED`, expired, re-registered/stale IDs or changed holder fail.
It discovers the parent's subregistry via `getSubregistry(label)` and checks
its reverse `getParent` link and code/implementation identity.

On that **child registry** it checks `hasRootRoles(ROLE_REGISTRAR, actor)`
and `roles(ROOT_RESOURCE, actor) & ROLE_REGISTRAR`; **name-scoped roles and
`ROLE_SET_SUBREGISTRY` on the parent registry do not authorize child mint**.
It also observes the parent's `ROLE_SET_SUBREGISTRY` with `hasRoles(resource,
ROLE_SET_SUBREGISTRY, actor)` and `isApprovedForAll`, explicitly as distinct
capabilities. It refuses unknown extra ROOT registrars and any observed
ROOT registrar admin, `ROLE_REGISTER_RESERVED` migration, `ROLE_SET_PARENT`,
`ROLE_UNREGISTER`, `ROLE_SET_SUBREGISTRY`, `ROLE_SET_RESOLVER`, or `ROLE_UPGRADE`
regular/admin assignee count on visited registries. Parent name-scoped
`ROLE_SET_SUBREGISTRY` regular/admin assignees must be unique to the observed
holder; any other scoped `ROLE_UNREGISTER` assignee denies the observation.
A role admin can otherwise regrant a role after a regular-role revocation. The exact ordinary/admin bit
layout comes from [ENS EAC](https://docs.ens.domains/ensv2/enhanced-access-control/)
and [Permissioned Registry](https://docs.ens.domains/ensv2/permissioned-registry/).

## Decisions and limits

Any unmet precondition returns `DENY`. An entirely consistent snapshot may
return `OBSERVED_EAC_ONLY`, with `authorizedAtSnapshot=true` **but always**
`canExecuteNativeIssue=false`, `sovereignReceipt=false` and
`verifiedLiveTransaction=false`. This function performs **no** mint, bridge,
cross-chain write or native L1 transaction. The data can become stale between
the read and an actual L1 transaction, so an L1-native executor must enforce
the relevant **current** EAC state inside the same transaction as the native
write, with the approved ENSv2 implementation and additional registry/migration
semantics. Latest RPC responses are not independently verified consensus or
finalized receipts, nor proof against reorgs beyond the sampled numbered head.

Root-admin enumeration is not complete from a snapshot of role counts. Even
with zero suspicious EAC assignees, contract/proxy governance, upgrade/factory
authorization, unenumerated operator approvals, resolver record writers,
ancestral transfers, ETH registrar renewal/re-registration, migration from
ENSv1 (`RESERVED` is **not** an ENSv2 owner) and activation/finality evidence
still need independent review. Existing OP V4 managed issuance remains
non-authoritative and can act on stale bridge checkpoints. No `SOVEREIGN`
claim or strict G2.4 transfer-time acceptance is established here.

Reproduce synthetic negative tests (no external chain writes):

```bash
pnpm exec vitest run test/unit/g2-ensv2-eac-l1.test.mjs
```
