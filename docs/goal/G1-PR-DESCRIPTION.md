## G1 integration: standalone SDK adoption and acceptance evidence

This PR closes the reviewable **G1 release candidate** with an independent Vanilla TypeScript consumer, SDK integration/self-hosting documentation, an explicit acceptance evidence ledger and the durable Goal progress checkpoint. Its prerequisite code lives in smaller stacked PRs: API/CCIP safety #112, SDK profile and EIP-712 protocol #113, installable SDK runtime #114, and CI scope/Goal PR checks #115. It includes no new core contract deployment and does not publish npm packages.

### Merge and review order

G0 [#110](https://github.com/MushroomDAO/CometENS/pull/110) (user accepted, GitHub approved and merged) → API [#112](https://github.com/MushroomDAO/CometENS/pull/112) → typed SDK foundation [#113](https://github.com/MushroomDAO/CometENS/pull/113) → SDK runtime [#114](https://github.com/MushroomDAO/CometENS/pull/114) → CI scope [#115](https://github.com/MushroomDAO/CometENS/pull/115) → **G1 integration [#111](https://github.com/MushroomDAO/CometENS/pull/111)**. Independent worktrees and normal Git merges were used throughout, without rebase/force.

### Validation

- Node v22: `pnpm typecheck`, root Vite build, standalone SDK ESM/type build, independent demo `pnpm install`, `pnpm typecheck` and Vite production build — PASS.
- `pnpm vitest run`: **48 suites / 809 tests PASS**; 9 live deployment integration tests skipped by their required-RPC environment guard. `pnpm check:skipped` PASS. SDK foundation has four EIP-712 tests; Worker route safety has 13 tests.
- `pnpm check:typecheck-scope`: **Worker own TS 0 errors, wide scope 5 known errors/budget 5 PASS**; the budget and regression guard are in #115.
- Foundry `forge test -q` and root dist-secret scan — PASS. `git diff --check` — PASS.
- OP Sepolia read-only check confirmed expected chain ID and contract address. A comparison of direct L2 records to public L1 ENS resolution revealed a real discrepancy for `aastar.eth` (non-null OP record, null standard ENS address); this is disclosed and cannot be called full EIP-3668 parity.
- The SDK package has been independently packed/installed into a separate PNPM consumer with ESM/types imports; the Vanilla demo uses the public browser-safe entrypoint and displays only normalized error kinds.

### Limitations and gates

G1 preserves the old V3 managed trust boundary: the V3 global owner can override records and transfer OP NFTs, and Cloudflare KV nonce get/put is not atomic across PoPs. The G2 native ENS handoff and per-parent revocable operators, G3 ENSv2/proof continuity, G4 metered AAStar free tier and G5 full Sepolia end-to-end and security release gate are separately planned. No mainnet deployment is part of G1.

PR #115 extends GitHub's `test.yml` to PR bases `goal/**`, so the final stacked #111 can run the ordinary full CI workflow. The local full suite above is independent evidence; a successful GitHub test check may be claimed only after its actual status is verified. G1 still requires user acceptance before G2 may begin.

### Pre-PR review questions (1.4.1)

The independent PR-Daemon checker was run from a clean detached worktree: **version 1.4.1, commit 3105515ec11c, block 0**. Remaining review-level categories for this integration-only PR are SZ-1/SZ-2 (mostly Goal docs, README and demo assets), T1 (a standalone demo UI rather than a production subsystem), T2 (DOM missing-element guard), B1 (typed error display only), and C2 (`Promise.all` on two independent read-only record queries; no lock or shared mutable critical section).

The demo's TS build and independent install verify the public SDK contract, while the SDK's dedicated regression tests reside in the preceding #113/#114 PRs. DOM guard checks that `#lookup` and `#result` exist before attaching events; the HTML contains both, and the 375px/mobile and browser interaction tests remain G4 scope. The Demo displays only `SDKError.kind` and a generic fallback, never a raw RPC exception. The two asynchronous reads do not mutate permissions, and each SDK operation verifies the configured chain. This focused integration PR is a size exception for reviewable docs and demo (~50 executable TS lines), with all core API and SDK implementation extracted to preceding PRs.

### Addressed review findings on #111

- **Medium 1 — reproducible setup:** tracked `examples/sdk-vanilla/.env.example` by a precise `.gitignore` exception, documented all five `VITE_` variables and the `cp` setup step, and added an independent test verifying the fixture is Git-tracked.
- **Medium 2 — mainnet contract:** corrected both SDK integration and acceptance text: AAStar offers only a verified *testnet* preset today, while self-hosted users may explicitly configure Ethereum/OP mainnet with chain IDs 1/10; no mainnet service/deployment security assurance is implied. A focused test checks this API behavior.
- **Low — identity pins:** documented that deployed bytecode and ABI compatibility are verified, with optional caller-supplied `expectedCodeHash` rather than hardcoded version/codehash attestation.
- **Low — startup validation:** the Demo now constructs a validated self-host profile at page load and shows a configuration instruction and disables the submit control for invalid zero/missing addresses.
- The Demo uses direct OP record lookup across any ENS name; rootName scopes management operations, not global L1 ownership/Universal Resolver assertions.
