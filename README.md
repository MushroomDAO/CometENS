# ENS-tool (CometENS)

L2 subdomain distribution system: register subdomains under a root `.eth` name on Optimism, resolved globally via CCIP-Read (EIP-3668).

## Quick Start

```bash
cp .env.op-sepolia .env.local   # fill in values
pnpm dev                        # gateway + frontend on :4173
```

## Commands

```bash
pnpm dev              # start dev server (gateway middleware included)
pnpm build            # production build
pnpm typecheck        # TypeScript validation
pnpm test             # vitest unit + E2E tests
pnpm test:coverage    # coverage report
cd contracts && forge test   # Solidity unit tests
```

## Running Tests

```bash
# 1. Start dev server (required for E2E tests that hit /api/*)
pnpm dev

# 2. Unit tests — no external dependencies
pnpm vitest run test/unit/

# 3. Anvil E2E tests — spins up local chain automatically (requires foundry)
pnpm vitest run test/e2e/

# 4. On-chain integration tests — requires .env.local with OP Sepolia RPC + keys
pnpm vitest run test/integration/

# 5. Solidity contract tests
cd contracts && forge test
```

## Architecture

```
User/DApp → L1 ENS → OffchainResolver → [OffchainLookup] → Gateway
                                                              ↓
                                                        L2Records (OP)
                                                              ↓
                                                       signed response
                                                              ↓
                                        OffchainResolver.resolveWithProof()
```

See `CLAUDE.md` for full architecture details.

## Deployed Contracts

| Contract | Network | Address |
|----------|---------|---------|
| L2Records | OP Sepolia (11155420) | `0x9Ed5d10101656b69B5bf50Ef15fd3cc33F55058b` |
| OffchainResolver | Ethereum Sepolia (11155111) | `0x87d97a2e3B334a4b62e1269d02bf4e2b168EbB45` |

## Environment Variables

See `.env.op-sepolia` for template. Required:
- `OP_SEPOLIA_RPC_URL` — Optimism Sepolia RPC
- `OP_L2_RECORDS_ADDRESS` / `VITE_L2_RECORDS_ADDRESS` — deployed L2Records
- `VITE_EIP712_VERIFYING_CONTRACT` — EIP-712 domain contract
- `PRIVATE_KEY_SUPPLIER` — gateway response signer
- `WORKER_EOA_PRIVATE_KEY` — L2 transaction executor

---

## ENS V2 Readiness

Reference: [docs.ens.domains/web/ensv2-readiness](https://docs.ens.domains/web/ensv2-readiness)

### Compatibility Matrix

| Requirement | Status |
|-------------|--------|
| viem ≥ 2.35.0 | ⚠️ currently ^2.24.1 — bump needed |
| Universal Resolver as entry point | ✅ resolution starts on L1 ENS |
| CCIP-Read / EIP-3668 | ✅ core architecture, correct signing scheme |
| Multichain client (L1 + L2) | ✅ L1 for resolution, L2 for storage |
| DNS name detection (not just `.eth`) | ⚠️ low priority for MVP |

### Impact on This Project

**Good news — we are structurally V2-aligned:**

1. **CCIP-Read is the V2 standard path.** Our entire stack (OffchainResolver → Gateway → L2Records) already implements EIP-3668 correctly, including the calldata-binding signature scheme required for replay protection.

2. **Per-name Registry (V2 core change).** ENS V2 moves from a global registry to one registry per `.eth` name. For us this means in the future we can set our resolver directly on the per-name registry with no code changes — V2 is backward compatible with existing resolvers.

3. **Universal Resolver upgrade.** ENS V2 makes the Universal Resolver the DAO-owned canonical entry point. Our `OffchainResolver` registers as the resolver for the root domain — this routing is unchanged. viem ≥2.35.0 uses the new Universal Resolver automatically.

4. **Action needed:** Bump viem to ≥2.35.0 before mainnet deployment.

### ENS V2 Verification Tests

```ts
// Universal Resolver working:
// getAddress("ur.integration-tests.eth") → 0x2222222222222222222222222222222222222222

// CCIP-Read working end-to-end:
// getAddress("test.offchaindemo.eth") → 0x779981590E7Ccc0CFAe8040Ce7151324747cDb97
```

---

## Building with AI

Reference: [docs.ens.domains/building-with-ai](https://docs.ens.domains/building-with-ai/)

ENS provides machine-readable documentation for AI-assisted development:
- `https://docs.ens.domains/llms.txt` — concise overview with links
- `https://docs.ens.domains/llms-full.txt` — complete docs in plain text

Usage with Claude Code:
```
Please read https://docs.ens.domains/llms-full.txt then help me with ENS integration
```

**Context7 MCP** (live ENS docs in IDE):
```bash
claude mcp add context7 -- npx -y @upstash/context7-mcp
```
