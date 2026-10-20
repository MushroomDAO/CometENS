# @cometens/sdk changelog

## 0.1.0 — 2026-10-20 (G1 release candidate)

- First independently installable Apache-2.0 ESM/TypeScript package and public subpath exports.
- Explicit Ethereum and Optimism deployment profiles, chain ID verification, optional runtime bytecode hash checks, and self-host configuration without an AAStar fallback.
- Direct OP record reads separated from canonical L1 ENS resolution.
- Typed EIP-712 messages and legacy V3 Worker operations for issuance, record writes and registrar management; caller-provided nonce, deadline and signer are preserved.
- A server-only API-key injection extension, stable error classes and fail-closed validation.

V3 is still a **managed trust model** whose global owner can override records and transfer OP NFTs. This version does not provide G2's native L1 ENS ownership handoff, per-parent revocation guarantees, or production AAStar mainnet preset. This is a candidate for user G1 acceptance, not an npm publication announcement.
