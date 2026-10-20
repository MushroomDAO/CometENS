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
| G1.7 | AAStar managed testnet preset and full self-host profile + server key separation | API URL distinct from gateway; mainnet unavailable until deployed; no API key in browser import or compiled bundle |

G1 release-candidate scope is complete, but acceptance is explicitly gated on user review and GitHub checks. G1 must clearly state the residual risks: V3 global owner can override registered records and transfer OP ERC721s; current KV-backed nonce store is not an atomic blockchain authority. Native L1 ENS subdomain transfer, per-parent operator grant/revoke, final unseizable ownership and irreversible records belong to G2–G5. No G1 package shall claim that old V3 already meets these.

## Test and PR evidence

| Check | Result / command / context |
|---|---|
| G1 branch base | G0 accepted head 8652eb8; three isolated worktrees and branch names recorded in PROGRESS |
| Integration worktree initial typecheck | PASS with Node v22.22.2 |
| Integration worktree initial unit suite | PASS: 38 files / 727 tests, Foundry on PATH |
| Integration worktree initial Vite site build | PASS: pnpm build |
| SDK unit and npm pack consumer | SDK branch final c580f1f, tarball ESM + d.ts external PNPM install/import PASS; final sdk TypeScript build PASS, independent demo install + typecheck + build PASS |
| Worker/API negative security suite | PASS: worker branch 9f6ba66, merged as 078c995; 13 new route safety tests; typecheck, unit suite 39 files/743 tests PASS |
| SDK vanilla demo typecheck/build | PASS: independent examples/sdk-vanilla pnpm install, pnpm typecheck, pnpm build after SDK package build |
| Final full CI, Foundry and diff-check | Final merged integration 4c59c20: Node22 root typecheck PASS, 41 files / 766 unit tests PASS, Vite build PASS, standalone SDK build PASS, Foundry forge test -q PASS, dist-secret scan PASS, git diff --check PASS; GitHub PR CI pending |
| PR URL/head/review/checks | [G1 PR #111](https://github.com/MushroomDAO/CometENS/pull/111) OPEN, branch goal/g1-integration stacked on G0 #110; review/CI required before merging; latest head tracked in PROGRESS |
| User G1 acceptance | PENDING — G2 blocked |

## Live testnet read-only evidence, 2026-10-20

- With explicitly public OP Sepolia RPC, pnpm check:chain --env testnet --json returned ok:true, chainId 11155420, L2Records 0xbA692CdfDA33916BbE8d2a1f23E80218db8ebFDc, owner 0xb5600060e6de5E11D3636731964218E53caadf0E. Both Worker wrangler files agree on contract address.
- Running packed/compiled SDK @aastarTestnetProfile against Ethereum Sepolia + OP Sepolia, verifyNetwork() succeeded. For alice.aastar.eth, getAddr (OP) and getEnsAddress (Ethereum ENS) both null; this is only a negative lookup, not a positive parity proof.
- For aastar.eth, direct OP getAddr returned 0xb5600060e6de5E11D3636731964218E53caadf0E, while public L1 ENS getEnsAddress returned null. **These are different namespaces/paths**; SDK must expose source and never silently claim direct L2 data is the globally resolved ENS result. An independently verifiable positive offchain CCIP result still needs a suitable configured L1 resolver and named test case; retain this as an outstanding testnet evidence item for G1 review and G3/G5 hardening.

## Testnet runtime versus offline verification

CI tests using mocks and local Foundry are not independent confirmation of an actual Sepolia deployment. If G1 final delivery lacks funded/testnet RPC access, write this as a blocker of the real network portion and keep any such check pending. G5 includes the mandatory comprehensive Sepolia deployment, signer/CCIP and permission exit end-to-end proof. Runtime errors must never be translated into successful read fallback.

## Audit and dependencies

G1 pull request is based on the accepted G0 branch until G0 is merged to main. G1's pending implementation must not bypass GitHub review requirements. G2 may start only after this document records confirmed G1 acceptance by the user.
