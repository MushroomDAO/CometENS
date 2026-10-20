## G1 integration: standalone SDK adoption and acceptance evidence

This PR closes the reviewable **G1 release candidate** with an independent Vanilla TypeScript consumer, SDK integration/self-hosting documentation, an explicit acceptance evidence ledger and the durable Goal progress checkpoint. Its prerequisite code lives in smaller stacked PRs: API/CCIP safety #112, SDK profile and EIP-712 protocol #113, installable SDK runtime #114. It includes no new core contract deployment and does not publish npm packages.

### Merge and review order

G0 [#110](https://github.com/MushroomDAO/CometENS/pull/110) (user accepted, awaiting fresh GitHub review) → API [#112](https://github.com/MushroomDAO/CometENS/pull/112) → typed SDK foundation [#113](https://github.com/MushroomDAO/CometENS/pull/113) → SDK runtime [#114](https://github.com/MushroomDAO/CometENS/pull/114) → **G1 integration [#111](https://github.com/MushroomDAO/CometENS/pull/111)**. Independent worktrees and normal Git merges were used throughout, without rebase/force.

### Validation

- Node v22: `pnpm typecheck`, root Vite build, standalone SDK ESM/type build, independent demo `pnpm install`, `pnpm typecheck` and Vite production build — PASS.
- `pnpm vitest run test/unit/`: **42 suites / 770 tests PASS** (includes four new EIP-712 foundation tests and 13 route-level Worker safety tests).
- Foundry `forge test -q` and root dist-secret scan — PASS. `git diff --check` — PASS.
- OP Sepolia read-only check confirmed expected chain ID and contract address. A comparison of direct L2 records to public L1 ENS resolution revealed a real discrepancy for `aastar.eth` (non-null OP record, null standard ENS address); this is disclosed and cannot be called full EIP-3668 parity.
- The SDK package has been independently packed/installed into a separate PNPM consumer with ESM/types imports; the Vanilla demo uses the public browser-safe entrypoint and displays only normalized error kinds.

### Limitations and gates

G1 preserves the old V3 managed trust boundary: the V3 global owner can override records and transfer OP NFTs, and Cloudflare KV nonce get/put is not atomic across PoPs. The G2 native ENS handoff and per-parent revocable operators, G3 ENSv2/proof continuity, G4 metered AAStar free tier and G5 full Sepolia end-to-end and security release gate are separately planned. No mainnet deployment is part of G1.

GitHub's current `test.yml` triggers for PR bases `main`/`preview` only; this stacked goal PR receives CLA checks but no automatic full test workflow until its base is retargeted after prerequisites merge. The local full suite above is evidence, **not an invented green GitHub test check**. G1 still requires user acceptance before G2 may begin.

### Pre-PR review questions (1.4.1)

The independent PR-Daemon checker was run from a clean detached worktree: **version 1.4.1, commit 3105515ec11c, block 0**. Remaining review-level categories for this integration-only PR are SZ-1/SZ-2 (mostly Goal docs, README and demo assets), T1 (a standalone demo UI rather than a production subsystem), T2 (DOM missing-element guard), B1 (typed error display only), and C2 (`Promise.all` on two independent read-only record queries; no lock or shared mutable critical section).

The demo's TS build and independent install verify the public SDK contract, while the SDK's dedicated regression tests reside in the preceding #113/#114 PRs. DOM guard checks that `#lookup` and `#result` exist before attaching events; the HTML contains both, and the 375px/mobile and browser interaction tests remain G4 scope. The Demo displays only `SDKError.kind` and a generic fallback, never a raw RPC exception. The two asynchronous reads do not mutate permissions, and each SDK operation verifies the configured chain. This focused integration PR is a size exception for reviewable docs and demo (~50 executable TS lines), with all core API and SDK implementation extracted to preceding PRs.
