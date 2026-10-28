# G2.1–G2.9 frozen acceptance evidence inventory — 2026-10-28

Baseline: `1fc838872598bfed7868feb6854b3bea65183662`. Evidence inventory only; **not release acceptance**. The frozen `docs/goal/G2-ACCEPTANCE.md` still marks every row PENDING; G3 BLOCKED until explicit user acceptance.

| Gate | Local test witness on main | Missing acceptance evidence | Status |
|---|---|---|---|
| G2.1 | `L2CommunityRecordsV4.t.sol` | Parent/controller deploy and finalized authority | PENDING |
| G2.2 | `G2ManagedLeaseIssuer.t.sol` | Finalized revoke/rotation receipts | PENDING |
| G2.3 | `L2CommunityRecordsV4NonceGuard.t.sol` | Complete production privileged-path proof | PENDING |
| G2.4 | `G2StrictTransferGap.t.sol` | Instant transfer-time L1-to-OP revocation; stale MANAGED lease counterexample | PENDING |
| G2.5 | `g2-controller-cli.test.ts` | Live owner SDK CLI chain and deployment identity | PENDING |
| G2.6 | `L2CommunityRecordsV4Issuance.t.sol` | Worker signed issuance and replay/finality on production path | PENDING |
| G2.7 | `G2Ensv2AtomicSubnameProof.t.sol` | Finalized native L1 ENS member handoff | PENDING |
| G2.8 | `g2-native-dual-rpc-corroboration.test.mjs` | Exhaustive proxy/admin/messenger audit and SOVEREIGN evidence | PENDING |
| G2.9 | `G2LegacyMemberRecordLock.t.sol` | Actual native resolver pointer lock and member autonomy | PENDING |

`gh issue view 138` currently reports CLOSED. Closure is not a replacement for the strict G2.4 negative of no old OP issuance after L1 owner transfer. Read-only probes, MANAGED leases, local Foundry tests, PR approvals and CI cannot alone prove sovereign, finalized member handoff. Do not promote any row without independent chain evidence and separate user acceptance.
