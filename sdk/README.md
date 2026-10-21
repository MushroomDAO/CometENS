# @cometens/sdk

### G2.5 partial: read-only OP controller CLI

The source-tree `pnpm controller:v4 -- status --profile ./v4-profile.json --operator 0x...` checks the actual OP Sepolia chain ID, pinned runtime bytecode hash, immutable parent node and `l1OwnershipVerified=false` before querying the controller, pending controller, controller epoch, and an optional operator's granted permissions, remaining quota, expiry, grant epoch and effective issuing rights. The JSON profile contains only `parentName`, `chainId:11155420`, `contract` and `expectedCodeHash`. Supply a trusted OP Sepolia RPC through the `COMETENS_OP_RPC_URL` environment variable; no RPC URL or secret is printed. The `receipt --hash 0x...` command checks that the mined transaction's destination matches this pinned OP contract, then returns block, status and sender. A successful receipt alone does **not** confirm desired permissions: run `status` again.

`prepare-grant`, `prepare-revoke`, `prepare-rotate`, `prepare-propose` and `prepare-accept` prepare unsigned calldata only. Run `pnpm controller:v4 -- --help` for required options. There is no signing, wallet, broadcasting, automatic transaction, L1 authority proof or sovereign exit. Multiple latest-block RPC reads may span blocks. G2.5 here is **partial** and limited to the experimental OP application contract; L1 ENS/NameWrapper binding and G2 acceptance gates remain separate.

For a pending controller nomination, `prepare-cancel-handoff --from 0xCURRENT_CONTROLLER` returns unsigned `proposeController(address(0))` calldata after verifying the caller is the current controller and a pending nominee exists. After sending it with an external wallet, `status` should report the zero pending address.

The `expectedCodeHash` must be computed from the **deployed runtime code of the post-PR #123 V4 contract**, not a #122-era deployment or creation bytecode. Derive an independently trusted hash with `cast code <contract> --rpc-url <OP_SEPOLIA_RPC> | cast keccak`, confirm the chain is OP Sepolia (11155420), and cross-check verified deployment source. No default hash is guessed. Mismatch intentionally fails closed.

### Experimental G2 OP application controller adapter (not a native ENS release)

The **separate** `@cometens/sdk/v4` entrypoint exposes `V4ControllerAdapter` and the ABI of the independently deployed `L2CommunityRecordsV4` proof-of-concept. It **does not** enable the existing G1 `createCometENSClient({protocol: 'v4'})` path: that remains rejected until G2's entire L1 authority and NameWrapper acceptance is complete. The adapter is restricted to OP Sepolia (`chainId: 11155420`), requires the caller to pin an independently checked deployed runtime bytecode hash, and verifies the immutable community parent and current controller before preparing transaction calldata. It never accepts a private key or sends a transaction.

`prepareGrant`, `prepareRevoke`, `prepareRotate`, and `prepareControllerHandoff` return explicit `{from,to,chainId,data,value,ownershipScope:'op-application-only'}`. For a two-step handoff, the **current controller** submits `prepareControllerHandoff(old, new)` and the **proposed new controller** subsequently submits `prepareAcceptController(new)`; only then do old-epoch grants become inactive. The controlling wallet must review, sign and broadcast separately, then independently verify chain receipt and updated `getOperator()` status. Prior permissions/quota are historical if `canIssue` reports false. No adapter response is a `SOVEREIGN` receipt. The OP contract reports `l1OwnershipVerified=false` because this implementation does **not** validate L1 ENS Registry / NameWrapper owner, PCC/CU fuse state, expiry, resolution or bridge/finality proofs. An integrator-supplied codehash, even when it matches, does not alone prove trusted deployment provenance or protect a mutable proxy implementation. Keep G2.4–G2.9 gates in [G2-ACCEPTANCE](../docs/goal/G2-ACCEPTANCE.md).

**Signed issuance status caveat (G2.6 partial):** Contract `operatorActive(operator, CAP_ISSUE)` and SDK `getOperator().canIssue` mean an active operator **grant** exists. On a V4 deployment with `CAP_SIGNED_ISSUE = 4`, these may report `true` even though unsigned `issue()` must revert; the controller's EIP-712 signature is required for `issueBySig()`. `canInitialAddr` likewise checks a grant, not whether an unsigned mint is permitted. The current SDK grant/rotate preparation deliberately rejects unknown permission bits including `4` and does not implement signed issuance; interpret `canIssue` together with raw `permissions`, never as `canIssueUnsigned`. See [V4 signed issuance boundaries](../docs/V4-SIGNED-ISSUANCE.md).

Standalone TypeScript ESM package for Ethereum ENS subdomains whose records live on Optimism. Package exports are `@cometens/sdk` (browser-safe), `@cometens/sdk/server` (server-only optional API key), and `@cometens/sdk/profiles`. Requires Node 20+ or a modern browser. The repository root remains a private application.

The AAStar preset is **testnet only**, pointing at the reference Sepolia deployment. It is not a mainnet or availability guarantee. Verify deployment state before relying on its addresses. The SDK checks both RPC chain IDs, deployed contract bytecode, and the V3 record read interface before all calls. Optionally pin `l1.expectedCodeHash` and `l2.expectedCodeHash` to the keccak256 of each *deployed runtime bytecode*: any mismatch then fails closed. Without pins, verification only establishes bytecode presence and ABI compatibility, which is weaker than contract identity attestation; proxy implementation changes require additional monitoring. `getAddr`, `getText`, `getContenthash` and `resolve` read L2 records directly; `getEnsAddress` traverses standard Ethereum L1 ENS resolution (including CCIP-Read when supported by the resolver).

`verifyNetwork` checks that the configured L1 resolver address has code; it does not assert the current L1 ENS Registry resolver pointer for `rootName` is that address. That pointer can be changed by the ENS name owner. `getEnsAddress` follows the live L1 ENS path; compare its result to direct L2 records when investigating a resolver cutover or service inconsistency.

**Observed reference-network divergence (2026-10-20):** for `aastar.eth` the AAStar testnet preset's direct OP record read returned an address while the standard Ethereum Sepolia ENS lookup returned `null`. This SDK does not silently substitute the L2 value into an ENS result; a direct OP record is a different trust/availability statement from globally resolved ENS data. G3 will address continuous resolution and finality/compatibility monitoring.

```ts
import {
  createCometENSClient, createSelfHostedProfile,
  typedDataForRegister,
} from '@cometens/sdk'

const profile = createSelfHostedProfile({
  id: 'my-community-sepolia',
  protocol: 'v3',                 // current signed Worker write protocol
  rootName: 'community.eth',
  l1: {
    chainId: 11155111,           // Ethereum Sepolia
    rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    resolverAddress: '0xYOUR_L1_RESOLVER_ADDRESS',
  },
  l2: {
    chainId: 11155420,           // OP Sepolia
    rpcUrl: 'https://sepolia.optimism.io',
    recordsAddress: '0xYOUR_L2_RECORDS_ADDRESS',
  },
  apiBaseUrl: 'https://api.yourdomain.example',
  gatewayUrls: ['https://gateway.yourdomain.example/hybrid'],
})

const sdk = createCometENSClient(profile)
await sdk.verifyNetwork()
const addr = await sdk.getAddr('alice.community.eth')
const data = await sdk.resolve('alice.community.eth', { textKeys: ['com.twitter', 'url'] })

// A wallet or backend signer must sign these EXACT values first.
// nonce and deadline are supplied by the caller, never silently replaced by the SDK.
const message = {
  parent: profile.rootName,
  label: 'alice',
  owner: '0x1111111111111111111111111111111111111111' as const,
  nonce: 123n,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
}
const typed = typedDataForRegister(profile, message)
// signature = await wallet.signTypedData({ account: signerAddress, ...typed })
// await sdk.register({ from: signerAddress, signature, message })
```

Use `typedDataForSetAddr`, `typedDataForSetText`, and `typedDataForSetContenthash` with `client.setAddr`, `client.setText`, and `client.setContenthash`. Each signed message must carry the signer address `from`, an exact `nonce` and `deadline` in Unix seconds; signer, typed data, and request message must match. `SetAddr.addr` is a 20-byte EVM address (`0x` + 40 hex characters), regardless of coinType, matching the current V3 API Worker's address restriction. Use the zero address to clear. All writes require a configured, independently hosted `apiBaseUrl`; no API origin is inferred from gateway URLs. A successful request must return an actual L2 `txHash`.

The `protocol: 'v3-readonly'` mode supports existing records but refuses write calls; `protocol: 'v3'` supports current EIP-712 API Worker writes. Neither provides community-scoped revocable owner/operator grants. `protocol: 'v4'` is intentionally rejected until the G2 contracts and adapters are complete. `getCapabilities()` reports the available feature set.

For compatibility with the current V3 contract-owner workflow, `typedDataForAddRegistrar` / `typedDataForRemoveRegistrar` and `addRegistrar` / `removeRegistrar` mirror the Worker's owner-only `/add-registrar` and `/remove-registrar` endpoints. The signed `parentNode` must equal `namehash(profile.rootName)`, with explicit signer, nonce, deadline, and, when adding, `quota` and `expiry`. **V3's global contract owner bypasses registrar restrictions**: removing a registrar does not revoke or constrain the global owner, nor grant a community parent owner sovereignty. The per-parent root controller and genuinely revocable operator API require G2.

### Server-only API keys

This is an **optional future managed gateway integration**. The present Worker authenticates signed writes and does not implement API key metering. API keys alone never grant ownership or authorize a mint or record change.

```ts
import { createCometENSServerClient } from '@cometens/sdk/server'

const serverSdk = createCometENSServerClient(profile, {
  getApiKey: () => process.env.COMETENS_API_KEY ?? '',
})
```

Only import `@cometens/sdk/server` from trusted Node/backend code. It refuses construction with `window` present. Never place API keys, private keys, secret RPC URLs, or a token-bearing endpoint in `NetworkProfile`, public `VITE_` variables, query parameters, frontend bundles, or logs. The SDK rejects URL queries, unexpected secret-shaped profile fields and obvious long provider token paths (such as `/v2/<token>`), but cannot reliably identify every credential string embedded in arbitrary URL paths: only supply public endpoints in a browser profile. Browser usage requires wallet EIP-712 signatures; a publishable project identifier (if introduced by the managed service) must grant no write authority.

Write failures throw `SDKError` with safe `kind` values such as `unauthorized` (401/403), `conflict` (409), `rate-limited` (429), `service-unavailable` (503), and `api-error` for others. `status` and allowlisted `code` fields are exposed without copying untrusted raw backend error text or RPC URLs.

### Self-hosting and migration

The self-host factory accepts only supplied addresses and endpoints; there is no implicit AAStar fallback. Moving from managed to self-hosted requires independently checking the old L2 NFT owners and records, deploying your own L2 contract and API/gateway/resolver, reconstructing/reissuing names with appropriate holder authorizations, verifying L2 reads and independent ENS resolution, and then switching the **L1 ENS node you actually control** to the new resolver. Old L2 NFTs stay in the old contract. A pure offchain subdomain without an owned L1 node cannot independently redirect resolver. See the repository's `docs/SELF-HOSTING.md` and `docs/DELEGATED-HOSTING.md` for current deployment and trust boundaries.

### Build and smoke test

From the repository root: `pnpm --dir sdk install`, `pnpm --dir sdk build`, `pnpm --dir sdk pack`. Install the tarball into an empty external consumer and verify both import paths and generated type declarations. This only builds a package; it does not publish to npm.
