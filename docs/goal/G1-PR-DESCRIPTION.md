## Problem and outcome

The previous in-repo SDK was not independently installable, inferred networks from RPC URL names, reconstructed signed nonces and called retired management API paths. A community web app could not safely use it as the CometENS capability layer. G1 now delivers a standalone, installable Apache-2.0 ESM/TypeScript package with an explicit deployment profile, separate direct OP and ENS reads, a versioned EIP-712 write adapter for existing V3 workers and server-only API-key injection.

The current API Worker and CCIP Gateway also now fail closed on missing root/nonce/sender configuration and malformed calls, with bounded request payloads and safe error output. A vanilla TypeScript consumer, independent installation test, self-hosting documentation, security review and durable Goal evidence accompany the change.

## Validation

- Node v22: root TypeScript typecheck PASS; 41 Vitest unit suites / 766 tests PASS; main site Vite build PASS.
- Standalone SDK build/types PASS; independently installed ESM/types tarball PASS; vanilla demo fresh install, typecheck and Vite build PASS.
- Foundry contract tests PASS, production-bundle secret scan PASS, git diff --check PASS.
- Read-only OP Sepolia on-chain check PASS (chainId 11155420, both Worker configs aligned to the observed L2Records contract). Independent L1 ENS lookup versus direct L2 record read was tested and their results can differ; see G1-ACCEPTANCE.md.

## Safety and release notes

G1's V3 compatibility is an interim managed trust model: the old V3 global owner can still override records/transfer OP NFTs. Root-scoped revocable operators and sovereign L1 ENS handoff are G2 work; real ENSv2/continuous CCIP and production end-to-end are G3/G5. The existing Cloudflare KV nonce get/put is not atomic across PoPs, and the production gateway must configure ALLOWED_SENDERS before accepting requests. API-key billing/free-tier enforcement is G4, not shipped here. No npm publication, mainnet deployment, or irreversible user operation occurs in this PR.

This is stacked on accepted G0 PR #110. User G1 acceptance and GitHub review/CI are required before opening G2.
