# G2.4 / G2.7 / G2.8 — ENSv2 Sepolia authority risk inspector

**Status:** experimental, read-only, **always `NEEDS_REVIEW`**. It cannot produce a
`SOVEREIGN` receipt. This is a bounded sample of one finalized Ethereum Sepolia
block, not proof of Ethereum consensus, of all permission holders, or of native
ENS handoff to OP. It never signs, broadcasts, upgrades or mutates contracts.

## Verified upstream and deployment version

* Authoritative current [ENS deployments](https://docs.ens.domains/learn/deployments/)
  (checked 2026-10-21): **RootRegistry**
  `0xb458d6a3a77919449d03e7a6903c26827c1ec43f`,
  **ETHRegistry** `0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4`,
  chain ID `11155111`. The old checked-in
  `docs/reference/ensv2-deployments-sepolia.md` is from **2026-07-30**
  and must not be used as the current address list.
* Official [contracts-v2 Sepolia 2026-09-15 release](https://github.com/ensdomains/contracts-v2/releases/tag/sepolia-deployment-2026-09-15)
  is source tag `f2f0a05e6c1711134b73204a1e37f8e6c1aea6ab`.
  Its addresses (**RootRegistry** `0x9703dbd26dab89504490994138cf2c575251a9ce`,
  **ETHRegistry** `0x657ea849311d3d5823348dded7c2aaafb3ede09e`)
  differ from the current ENS deployment page. **Do not mix deployment generations.**
  Source interfaces in that tag establish the checked method ABI:
  `IRegistry.getSubregistry/getParent`,
  `IPermissionedRegistry.getState/getResource/isEmancipated`,
  `IEnhancedAccessControl.roles/roleCount`,
  `PermissionedRegistry.isApprovedForAll`.
  Current ENS [Registry](https://docs.ens.domains/ensv2/permissioned-registry/),
  [Hierarchy](https://docs.ens.domains/ensv2/registry-hierarchy/) and
  [EAC](https://docs.ens.domains/ensv2/enhanced-access-control/) docs confirm
  root/namespaced roles, ERC1155 approval inheritance and UUPS upgrade powers.
* **Live finalized-block cross-check** (single public RPC, 2026-10-21):
  block **11961002**, hash
  `0x10cd8caf419842777854b21d1e7ee89587d3b219870833e5e114e9dd82cf0889`.
  Both listed registry addresses had runtime keccak256
  `0xddb7698fc2857f7a9e726491025fead241791f113a19714149db8cbf87688e98`;
  `RootRegistry.getSubregistry("eth")` returned the listed ETHRegistry and
  `ETHRegistry.getParent()` returned the listed RootRegistry and label `eth`.
  ERC1967 implementation slots were zero on these two sampled contracts;
  child UserRegistry instances may instead be UUPS proxies. These hashes are
  **observations at one block**, not everlasting defaults or audit certificates.

## Run without exposing credentials

Create a public manifest outside git (addresses/hashes must be independently
confirmed after deployments and upgrades):

```json
{
  "chainId": 11155111,
  "name": "alice.eth",
  "rootRegistry": "0xb458d6a3a77919449d03e7a6903c26827c1ec43f",
  "ethRegistry": "0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4",
  "pins": [
    {"address":"0xb458d6a3a77919449d03e7a6903c26827c1ec43f","codeHash":"0xddb7698fc2857f7a9e726491025fead241791f113a19714149db8cbf87688e98"},
    {"address":"0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4","codeHash":"0xddb7698fc2857f7a9e726491025fead241791f113a19714149db8cbf87688e98"}
  ],
  "operators": []
}
```

```bash
export COMETENS_SEPOLIA_RPC_URL='https://ethereum-sepolia-rpc.publicnode.com'
pnpm inspect:ensv2 -- ./sepolia-public-manifest.json
# Query bytecode of *this* deployment at a finalized block, then independently verify:
cast code <registry> --block finalized --rpc-url "$COMETENS_SEPOLIA_RPC_URL" | cast keccak
```

At a **single finalized block**, the inspector checks chain ID, runtime hashes,
ERC1967 implementation address and implementation bytecode hash when present,
ERC1967 admin/beacon slots, the forward AND backward canonical registry links,
each visited label's status/expiry/current EAC resource, root and scoped regular
AND admin assignee-count bitmaps (`ROLE_SET_PARENT`, dangerous roles, `ROLE_UPGRADE`
and other published registry roles), `isEmancipated()`, and known third-party
delegated roles and `isApprovedForAll()` for supplied operator addresses.
For dynamically discovered child registries, add a separate runtime pin; when
ERC1967 implementation storage is nonzero, add
`{"implementation":{"address":"0x...","codeHash":"0x..."}}` to that pin.
Without the required pin, the walk stops with a specific finding.

## Why the verdict stays NEEDS_REVIEW

The protocol does **not** expose a complete enumerable list of EAC role holders
or ERC1155 `setApprovalForAll` operators. Sampling known addresses cannot
prove no unknown delegate exists. `ROOT_RESOURCE` admin holders can regrant
roles, `ROLE_SET_PARENT` can remount child registries even when
`isEmancipated()` reports true, `ROLE_UPGRADE`/proxy admin/beacon/governance
can change logic, and parent `ROLE_SET_SUBREGISTRY` can replace a child's
registry. Name expiry and migrations can invalidate an otherwise matching
snapshot. Current Sepolia L1 EAC checks do not verify OP binding, L1→OP bridge
finality, resolver immutability or post-check state. Missing lineage, unpinned
code, invalid ABI/RPC, incomplete approvals, or potentially dangerous roles
therefore remain **NEEDS_REVIEW**, never `SOVEREIGN`.

Only normalized lowercase ASCII-LDH `.eth` names are accepted; this is not a
full ENSIP-15 normalizer. The RPC URL is provided in an environment variable
and is never printed in errors/results. Public RPC block finality is still a
provider assertion: cross-check independently operated Ethereum RPCs and
verified implementation source before making high-stakes permission decisions.
