# CometENS SDK — independent vanilla TypeScript consumer

This application deliberately lives outside the SDK package and has its own dependency manifest. It demonstrates resolving an address and text record through the public SDK with an explicit self-hosted network profile.

## Run on OP Sepolia + Ethereum Sepolia

Build the local SDK first from repository root:

~~~sh
cd sdk
pnpm install
pnpm build
cd ../examples/sdk-vanilla
cp .env.example .env.local
~~~

Edit `.env.local`, replacing both zero contract addresses with your own verified Sepolia deployments; replace the parent name and RPCs as necessary. The expected public variables are `VITE_PARENT_NAME`, `VITE_L1_RPC_URL`, `VITE_L2_RPC_URL`, `VITE_L1_RESOLVER_ADDRESS`, and `VITE_L2_RECORDS_ADDRESS`. **Do not place API keys or private keys in `VITE_` variables.** Run:

~~~sh
pnpm install
pnpm typecheck
pnpm dev
~~~

The URL origin of the RPC does not imply network identity. The SDK must query the chain IDs and reject unexpected networks or missing bytecode. Name reads here use direct L2Records; they do **not** represent an ENS Universal Resolver or ENSv2 migration correctness check.

This read-only example has no API key, wallet, private key, or permission to mint. Browser environment variables prefixed VITE_ are public. G1 typed EIP-712 write APIs require exact signed from/message/nonce/deadline and a configured independent API Worker; G2 will add revocable per-parent smart contract authorization. Never claim existing V3-managed names are immutable or non-revocable.

The page validates its public profile at startup and disables lookup until the contract addresses have been configured. Direct OP record lookup accepts any ENS name; it does not prove ownership of the name under the configured parent or that the L1 ENS Registry resolves to the configured gateway.
