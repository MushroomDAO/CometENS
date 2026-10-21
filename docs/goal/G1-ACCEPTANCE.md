# G1 — SDK independent consumer acceptance

> Status: READY_FOR_ACCEPTANCE, **not yet user accepted**. G0 was accepted 2026-10-20. This is a reproducible evidence ledger for G1 scope and the basis for the user's G1 review.

## Scope and compatibility contract

| Item | Target | Evidence before G1 acceptance |
|---|---|---|
| G1.1 | Independent ESM + TypeScript package with subpath exports and semantic version | Versioned package tarball, install in a separate directory, independent TypeScript/Vite build |
| G1.2 | Explicit OP + Ethereum chain IDs; contract address/code validation | Wrong RPC chainId and empty/wrong bytecode negative tests; self-host URL strings not used as chain detection |
| G1.3 | Read-only L2 and standard ENS resolution clearly separated | getAddr, getText, getContenthash and resolved source, including ENS Universal Resolver; direct OP and ENS results independently cross-checked |
| G1.4 | Exact EIP-712 write operations and signed message envelope | Register, SetAddr, SetText, SetContenthash: from, typed message, nonce, deadline, domain/verifyingContract, signature; no Date.now reconstruction; invalid signer/chain/nonce fail |
| G1.5 | Stable exports, errors/events, README and minimal independent demo | public error kinds and package import; examples/sdk-vanilla build and read demo; AAStar SDK composition boundary |
| G1.6 | API Worker and CCIP Gateway reject unauthorized/malformed requests | Empty root allowlist fails closed; size, sender/calldata and error-redaction tests; no unsafe success fallback |
| G1.7 | AAStar managed testnet preset and full self-host profile + server key separation | API URL distinct from gateway; **AAStar mainnet preset not offered until verified G6 deployment**, but explicit third-party self-hosted mainnet profiles are supported; no API key in browser import or compiled bundle |

G1 release-candidate scope is complete, but acceptance is explicitly gated on user review and GitHub checks. G1 must clearly state the residual risks: V3 global owner can override registered records and transfer OP ERC721s; current KV-backed nonce store is not an atomic blockchain authority. Native L1 ENS subdomain transfer, per-parent operator grant/revoke, final unseizable ownership and irreversible records belong to G2–G5. No G1 package shall claim that old V3 already meets these.

## Test and PR evidence

| Check | Result / command / context |
|---|---|
| G1 branch base | G0 #110 用户验收并合并为 `813f1e2`；G1 栈经逐级 base 更新、普通 merge、最新 head review/CI，最终合并至 main `3390adf` |
| Integration worktree initial typecheck | PASS with Node v22.22.2 |
| Integration worktree initial unit suite | PASS: 38 files / 727 tests, Foundry on PATH |
| Integration worktree initial Vite site build | PASS: pnpm build |
| SDK unit and npm pack consumer | SDK branch final c580f1f, tarball ESM + d.ts external PNPM install/import PASS; final sdk TypeScript build PASS, independent demo install + typecheck + build PASS |
| Worker/API negative security suite | PASS: worker branch 9f6ba66, merged as 078c995; 13 new route safety tests; typecheck, unit suite 39 files/743 tests PASS |
| SDK vanilla demo typecheck/build | PASS: independent examples/sdk-vanilla pnpm install, pnpm typecheck, pnpm build after SDK package build |
| Final local CI-equivalent checks | G1 updated Demo `afd13ca`: Node22 root typecheck PASS; complete Vitest **49 files / 811 tests PASS**, 9 live integration tests intentionally skipped; `pnpm check:skipped` PASS in prior head; SDK build, Vite build, demo typecheck/build, Foundry PASS; prior browser dist-secret scan PASS; diff-check PASS. Worker own TypeScript errors 0, wide scope 5 known errors with tightened budget 5 (`pnpm check:typecheck-scope` PASS) |
| PR URL/head/review/checks | Stacked G0 [#110](https://github.com/MushroomDAO/CometENS/pull/110) → API [#112](https://github.com/MushroomDAO/CometENS/pull/112) → SDK Foundation [#113](https://github.com/MushroomDAO/CometENS/pull/113) → SDK runtime [#114](https://github.com/MushroomDAO/CometENS/pull/114) → CI [#115](https://github.com/MushroomDAO/CometENS/pull/115) → Demo/acceptance [#111](https://github.com/MushroomDAO/CometENS/pull/111). #115 enables full GitHub workflow for `goal/**` PR bases; GitHub results remain separately required. User G1 acceptance remains pending |
| GitHub full CI evidence | [PR #115](https://github.com/MushroomDAO/CometENS/pull/115) `test` + `cla-check` SUCCESS; [PR #111](https://github.com/MushroomDAO/CometENS/pull/111) `test` + `cla-check` SUCCESS at head `9306f21` ([Actions run 39413890122](https://github.com/MushroomDAO/CometENS/actions/runs/39413890122)). Later doc-only head revisions need their own fresh GitHub check before acceptance or merge |
| Latest reviewer-fix evidence | #111 head `afd13ca` fixes tracked `.env.example`, demo startup validation, and self-host/mainnet documentation; `test` and `cla-check` SUCCESS ([run 39458665006](https://github.com/MushroomDAO/CometENS/actions/runs/39458665006)). #110 merged to main as `813f1e2`, #112 merged to main as `2734474`; #113 updated to new `main` as `4416b10`, full CI SUCCESS, fresh review requested |
| GitHub completed landing, 2026-10-21 | G0 [#110](https://github.com/MushroomDAO/CometENS/pull/110) `813f1e2`; API [#112](https://github.com/MushroomDAO/CometENS/pull/112) `2734474`; EIP-712 [#113](https://github.com/MushroomDAO/CometENS/pull/113) `40ee340`; SDK package [#114](https://github.com/MushroomDAO/CometENS/pull/114) `d5fc687`; CI [#115](https://github.com/MushroomDAO/CometENS/pull/115) `b434750`; Demo/acceptance [#111](https://github.com/MushroomDAO/CometENS/pull/111) `3390adf`. All PRs APPROVED and CI green at their final reviewed heads before merge. [Final #111 test run 39535343002](https://github.com/MushroomDAO/CometENS/actions/runs/39535343002) SUCCESS at head `848b71c` |
| User G1 acceptance | PENDING — G2 blocked |

## Live testnet read-only evidence, 2026-10-20

- With explicitly public OP Sepolia RPC, pnpm check:chain --env testnet --json returned ok:true, chainId 11155420, L2Records 0xbA692CdfDA33916BbE8d2a1f23E80218db8ebFDc, owner 0xb5600060e6de5E11D3636731964218E53caadf0E. Both Worker wrangler files agree on contract address.
- Running packed/compiled SDK @aastarTestnetProfile against Ethereum Sepolia + OP Sepolia, verifyNetwork() succeeded. For alice.aastar.eth, getAddr (OP) and getEnsAddress (Ethereum ENS) both null; this is only a negative lookup, not a positive parity proof.
- For aastar.eth, direct OP getAddr returned 0xb5600060e6de5E11D3636731964218E53caadf0E, while public L1 ENS getEnsAddress returned null. **These are different namespaces/paths**; SDK must expose source and never silently claim direct L2 data is the globally resolved ENS result. An independently verifiable positive offchain CCIP result still needs a suitable configured L1 resolver and named test case; retain this as an outstanding testnet evidence item for G1 review and G3/G5 hardening.

## Testnet runtime versus offline verification

CI tests using mocks and local Foundry are not independent confirmation of an actual Sepolia deployment. If G1 final delivery lacks funded/testnet RPC access, write this as a blocker of the real network portion and keep any such check pending. G5 includes the mandatory comprehensive Sepolia deployment, signer/CCIP and permission exit end-to-end proof. Runtime errors must never be translated into successful read fallback.

## Audit and dependencies

G0 and all G1 implementation PRs have merged into main with GitHub approval and tests. **This is technical delivery, not a user acceptance event.** G1 remains `READY_FOR_ACCEPTANCE`; G2 may start only after this document records confirmed G1 acceptance by the user.
