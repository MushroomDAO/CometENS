# G3 Sepolia resolver bytecode shapes

Read-only inventory of runtime bytecode. It is not acceptance, not a resolver-pointer reconciliation, and not a CCIP `resolveWithProof` check. **G3 stays BLOCKED.** `test/integration/deployed.test.ts`, `docs/goal/G2-ACCEPTANCE.md`, and `docs/goal/STATUS.md` are unchanged.

`scripts/check-sepolia-resolver-drift.mjs` classifies bytecode by whether these selectors occur as hex substrings:

| Category | `gatewayUrl()` `8bf165d9` | `verifier()` `2b7ac3f3` | `resolveWithProof(bytes,bytes)` `f4d4d2f8` |
| --- | --- | --- | --- |
| `HybridResolver` | yes | yes | no |
| `OPResolver` | no | yes | no |
| `OffchainResolver` | yes | no | yes |
| `unknown` | any other combination, including empty code | | |

`entry.healthy === true` means only that the three-selector pattern matched one of those shapes. Empty, invalid, partial, and superset bytecode is `unknown` with `healthy: false`. A substring hit is not a compiler identity or a codehash pin. The report always sets `g3Unblocked: false`, `acceptance: false`, and `deploymentHealthy: false`.

Default input is a JSON fixture (`--fixture`). The script does not read environment files. `--live --address 0x…` is the only network path. It calls `https://ethereum-sepolia-rpc.publicnode.com` (chain `11155111`) or, with `--chain op-sepolia`, `https://sepolia.optimism.io` (chain `11155420`), at one `finalized` block. It does not look up ENS names.

Unit tests in `test/unit/g3-sepolia-resolver-drift.test.mjs` cover the three shapes, empty and unrecognized bytecode, and the fixture CLI. Live reconciliation is still unrun.
