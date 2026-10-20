# CometENS SDK integration — network and trust boundaries

> G1 API implementation and release candidate. See the independently installable demo in [examples/sdk-vanilla](../examples/sdk-vanilla/README.md). G0 safety model: [SECURITY-AND-SERVICE.md](goal/SECURITY-AND-SERVICE.md).

## Public configuration

A consumer selects an AAStar preset or creates a self-hosted deployment profile with explicit L1/L2 chain IDs and RPCs, resolver, L2 record contract, parent name, distinct management API URL and CCIP gateway URLs. The SDK verifies the chain IDs, nonempty deployed bytecode and V3 read interface, and optionally checks `expectedCodeHash` pins supplied by the deployer; without pins it does **not** attest a known code version. Wrong chains or missing contracts stop reads and writes. The AAStar preset is testnet-only because AAStar mainnet contracts have not been deployed or verified under G6. **Self-hosted Ethereum Mainnet / OP Mainnet configuration is allowed by the SDK** (chain IDs 1/10), but those deployments are independently operated and have not passed CometENS's G5/G6 security and mainnet acceptance gates.

Using AAStar hosting means accepting AAStar operations under the current V3 trust model. An AAStar-managed profile is an endpoint/configuration convenience; it is not a certificate of ENS NFT sovereignty. Self-hosters replace contract addresses, parent domain, endpoint URLs and signer infrastructure in their own profile, export and verify records, then arrange resolver changes with the real L1 name owner. A public profile must not contain a secret API key.

### Example: replace all infrastructure with your own profile

The package exposes a standalone client. Every address below is an illustrative placeholder; replace it with the verified deployment and use the matching chain IDs:

~~~typescript
import { createCometENSClient, createSelfHostedProfile } from '@cometens/sdk'

const profile = createSelfHostedProfile({
  id: 'community-sepolia',
  protocol: 'v3-readonly',
  rootName: 'community.eth',
  l1: {
    chainId: 11155111,
    rpcUrl: 'https://your-l1-sepolia-rpc.example',
    resolverAddress: '0x1111111111111111111111111111111111111111',
  },
  l2: {
    chainId: 11155420,
    rpcUrl: 'https://your-op-sepolia-rpc.example',
    recordsAddress: '0x2222222222222222222222222222222222222222',
  },
  apiBaseUrl: 'https://api.community.example',
  gatewayUrls: ['https://ccip.community.example/hybrid'],
})
const sdk = createCometENSClient(profile)
await sdk.verifyNetwork()
const l2Record = await sdk.getAddr('jason.community.eth')
const ensResult = await sdk.getEnsAddress('jason.community.eth')
~~~

The two reads intentionally have different meanings. The first queries OP records directly, while the second follows Ethereum ENS resolution, which may involve CCIP-Read. They may differ if a community has not set its L1 resolver or its L2 profile points elsewhere. A normal successful L2 record read does not prove that the ENS name has been issued as a real L1 ENS node.

For server-side metering integrations only, import createCometENSServerClient from the server subpath and supply getApiKey from a backend secret provider at runtime. That key is deliberately absent from the public profile. The current G1 deployment does **not** implement backend API-key billing or quota validation yet; those service features are scheduled for G4.

## Authentication

Browser clients can use a public project identifier as a metering label; it must not be relied upon as an authorization secret. A confidential API key belongs only in a server-side SDK client and may be used for quota and service access. It never authorizes a transfer, registrar permission or record update by itself. Each signed request must carry the exact signer, EIP-712 domain/chainId/verifying contract, original message, nonce and deadline; a relayer does not reconstruct them.

A registered domain can be Managed (operator retains control), Sovereign (L1 ENS original name and permission revocation independently proven), or Locked Record (an explicitly immutable record). **G1 does not deliver G2's Sovereign smart contracts.** V3's global owner remains able to override issuance permissions, records, and OP NFT transfers.

## Self-hosted migration

1. Export records, owner list, names and block numbers from the current OP contract. A V3 NFT does not transfer automatically to a newly deployed contract.
2. Deploy and source-verify the new OP contract and L1 resolver, create independent gateway/API deployments, and separate operator/signing keys.
3. Validate L1 and L2 chain IDs, bytecode versions, parent control, authorization and record parity before promoting the new profile.
4. With L1 name-owner approval, update the resolver pointer and test standard ENS resolution. Preserve old addresses/proofs for audit and rollback. For a purely offchain subname with no owned L1 node, a member cannot independently switch the resolver.
5. Check expiry/renewal and (in G2+) handoff fuses/roles separately before advertising native ENS name sovereignty.

## Operator configuration required by the hardened Worker

The G1 API Worker deliberately refuses write operations if ROOT_DOMAIN/ROOT_DOMAINS is blank or if neither REGISTRY nor RECORD_CACHE KV binding exists. The KV store supports best-effort nonce consumption; get-then-put is eventually consistent and **not atomic across PoPs**. Its protection is inadequate for the final irrevocable property model, which G2 must enforce on-chain. Bind the KV and configure the allowed parent names before enabling a testnet write flow.

The CCIP gateway also requires a non-empty ALLOWED_SENDERS list containing the exact deployed L1 resolver(s). A missing list returns an explicit configuration error and refuses signing/proofs. Some existing production example wrangler configurations have this field commented out: deployers must set and verify it against the resolver address before switching any ENS resolver pointer to the gateway. Never make a public all-senders fallback to restore availability; instead publish a reproducible configuration preflight.

These limits protect the current managed V3 compatibility path; they do not turn that contract into a final Sovereign implementation.

## Release and verification

The package must publish ESM/type exports and be installable into an independent consumer. G1 acceptance requires npm pack/install smoke, direct read test, typed write request parity, wrong chain/nonce/signature negatives, browser bundle secret scan and the full unit + Foundry suite. Live Sepolia end-to-end, ENSv2 migration hardening, and irreversible handoff remain gated by G2–G5; see [MILESTONES](goal/MILESTONES.md).
