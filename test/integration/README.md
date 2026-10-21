# Explicit opt-in for deployed Sepolia tests

The `deployed.test.ts` suite talks to **real Ethereum Sepolia and OP Sepolia**, not an Anvil fork. Some cases sign and broadcast transactions: `registerSubnode`, `setText` and `setAddr` (including a record for `aastar.eth`). They can change shared testnet records and spend testnet ETH.

**Default:** `pnpm vitest run` skips all nine live deployment tests, even when `.env.local` provides valid RPC URLs and private keys. Presence of credentials is never consent to write on-chain.

To deliberately enable only read-only tests on the deployed testnets, after checking contract and RPC addresses:

```sh
COMETENS_LIVE_READ_TESTS=1 pnpm vitest run test/integration/deployed.test.ts
```

To run the mutating tests, **after** verifying that the configured addresses, account, testnet balances, expected changes, and restoration procedure are acceptable:

```sh
COMETENS_LIVE_READ_TESTS=1 COMETENS_LIVE_WRITE_TESTS=1 pnpm vitest run test/integration/deployed.test.ts
```

Never set these opt-in variables in ordinary shell profiles, persistent CI variables or application `.env.local`. Run writes only with a dedicated, approved test account and in an isolated testnet namespace; the current suite still contains legacy test cases affecting `aastar.eth`. Read-only assertions may fail when deployed resolver pointers differ from historical expectations; investigate deployment state rather than changing chain ownership or gateway settings to make a stale test green.
