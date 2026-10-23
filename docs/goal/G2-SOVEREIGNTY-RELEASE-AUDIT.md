# G2 sovereignty release audit — evidence and blockers

This document is an **unaccepted** release checklist, not a certification or a change to the frozen [G2 acceptance matrix](G2-ACCEPTANCE.md). Each row requires a pinned source commit, local reproducible tests, independent formal review and, where a live-chain claim is made, independently verified finalized receipts. Missing evidence **fails closed**; GitHub CI is never a substitute for native ownership proof.

## Authority boundary — mandatory P0

1. The only operation that may assert an **ENS-native issuance** occurs on Ethereum L1 and checks the then-current ENS Registry/NameWrapper or ENSv2 EAC authority **inside the same atomic L1 transaction**. Test transfer/re-registration/expiry/role revocation immediately before execution, plus adversarial callback state changes during execution. If rights change, the operation must revert without issuing or sending a successful relay message.
2. An OP queue, OP ERC-721 mint, MANAGED lease, checkpoint, bridge delivery, prior Merkle/ZK proof, RPC block header or event is **never sufficient** to authorize fresh native issuance after L1 ownership changes. A previously valid proof remains historical after transfer; no asynchronous relay guarantees instantaneous native-title revocation. If any OP path claims native issuance independently, G2.4 is **BLOCKED**.
3. Prohibit global platform recovery owners, upgrade-admin seizure routes, arbitrary bridge signer overrides and member resolver edits. The verifier must inventory approval/operator, NameWrapper parent, registrar reclaim, expiry/renewal, ENSv2 EAC root-resource roles, proxies and migration paths. An unenumerated permission path prevents a `SOVEREIGN` result.

## Artifact-by-artifact release gates

| Gate | Evidence required to change PENDING | Failure that must be tested |
|---|---|---|
| G2.1–G2.3 | V4 per-parent controller isolation, quota/revoke/epoch transitions, non-seizable member ERC-721/record invariants; immutable runtime hashes | Other-parent grant, stale operator, member transfer/record overwrite by root or operator |
| G2.4 | L1 **current** ownership in same issuing transaction, plus independently pinned finalized authority and OP no-native-mint negative | L1 holder transfer/revoke/expiry between proof and L1 execution; OP replay after transfer |
| G2.5 | Actual SDK/CLI wallet grant/revoke/rotate and bounded indexed audit, with receipts and browser key isolation | Wrong parent/chain/code, historical events falsely reported as current status |
| G2.6 | Production Worker V4 integration with on-chain nonce execution and post-transfer invalidation; multi-relayer/restart test | Duplicate permit after Worker KV reset, parallel relayers, stale ERC-1271 callback |
| G2.7 | Native L1 member subname handoff, correct ENSv1 PCC/CU and registrar grace and expiry, plus separately modeled ENSv2 authority | OP NFT-only transfer labelled native, wrong/expired fuse and registrar reclaim |
| G2.8 | Complete admin/proxy/bridge role inventory, immutable runtime and reproducible **consensus-grounded finalized** native receipts | Malicious approval/admin/upgrade path omitted while receipt claims SOVEREIGN |
| G2.9 | Actual active ENS resolver pointer, member-only resolver control, optional irreversible record lock, expiry/recovery disclosures | Mutable resolver pointer or operator overwrite falsely called LOCKED_RECORD |

## Known limits after reviewed PR #160

- #150–#160 have supplied native-first design, ENSv1 local atomic issuance, bounded L1 monitors, provisional OP result inbox, request-bound relay, historical reconciliation and dual-RPC corroboration. These are **component evidence**, not a completed G2 acceptance run.
- The second RPC may corroborate a finalized block hash but does **not** independently prove two providers are independent or provide Ethereum consensus verification. A double-provider result cannot set `sovereignReceipt=true`.
- Current native proof targets local ENSv1 fixtures, not a verified live ENSv1/v2 deployment with all authority, upgrades and resolver controls. ENSv2 current EAC grant/ROOT privilege, migration and parent authority remain distinct tasks.
- The old managed OP issuer must never be reclassified as native. Even with a monitor, old OP actions may happen during cross-chain delivery; distinguish **OP application-only action** from **L1-native title** in all APIs, UI and receipts.
- No G2 public-chain write transaction or independently verified public-chain handoff receipt is established here. Public-chain writes are an explicit separate authorization gate; do not infer consent from configured keys.

## Required final sign-off bundle

Record: source commit and immutable deployment address/runtime codehash per network; reproducible Anvil adversarial suite; exact PR head independent approval and CI results; finality/consensus source and rollback handling; unprivileged verifier instructions with full raw receipt hashes; testnet transaction authorization and outcomes; member wallet demonstration with resolver and revoke controls; a truth table for `MANAGED`, `OBSERVED`, `LOCKED_RECORD`, and `SOVEREIGN`, each defaulting false when a requirement is unknown. Record remaining exceptions rather than silently weakening acceptance.

**Release status:** `G2 IN_PROGRESS`, all frozen G2.1–G2.9 `PENDING` until demonstrated and separately user-accepted. **G3 remains BLOCKED**; this checklist neither grants approval nor authorizes deployment.
