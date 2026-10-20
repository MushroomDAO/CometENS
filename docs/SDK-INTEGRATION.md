# CometENS SDK integration — network and trust boundaries

> G1 API implementation and release candidate. See the independently installable demo in [examples/sdk-vanilla](../examples/sdk-vanilla/README.md). G0 safety model: [SECURITY-AND-SERVICE.md](goal/SECURITY-AND-SERVICE.md).

## Public configuration

A consumer selects an AAStar preset or creates a self-hosted deployment profile with explicit L1/L2 chain IDs and RPCs, resolver, L2 record contract, parent name, distinct management API URL and CCIP gateway URLs. All addresses are checked against their chain and known codehash/version, and an unknown or wrong chain stops write operations. Mainnet profiles are disabled until verified mainnet deployment; do not silently use testnet defaults in production.

Using AAStar hosting means accepting AAStar operations under the current V3 trust model. An AAStar-managed profile is an endpoint/configuration convenience; it is not a certificate of ENS NFT sovereignty. Self-hosters replace contract addresses, parent domain, endpoint URLs and signer infrastructure in their own profile, export and verify records, then arrange resolver changes with the real L1 name owner. A public profile must not contain a secret API key.

## Authentication

Browser clients can use a public project identifier as a metering label; it must not be relied upon as an authorization secret. A confidential API key belongs only in a server-side SDK client and may be used for quota and service access. It never authorizes a transfer, registrar permission or record update by itself. Each signed request must carry the exact signer, EIP-712 domain/chainId/verifying contract, original message, nonce and deadline; a relayer does not reconstruct them.

A registered domain can be Managed (operator retains control), Sovereign (L1 ENS original name and permission revocation independently proven), or Locked Record (an explicitly immutable record). **G1 does not deliver G2's Sovereign smart contracts.** V3's global owner remains able to override issuance permissions, records, and OP NFT transfers.

## Self-hosted migration

1. Export records, owner list, names and block numbers from the current OP contract. A V3 NFT does not transfer automatically to a newly deployed contract.
2. Deploy and source-verify the new OP contract and L1 resolver, create independent gateway/API deployments, and separate operator/signing keys.
3. Validate L1 and L2 chain IDs, bytecode versions, parent control, authorization and record parity before promoting the new profile.
4. With L1 name-owner approval, update the resolver pointer and test standard ENS resolution. Preserve old addresses/proofs for audit and rollback. For a purely offchain subname with no owned L1 node, a member cannot independently switch the resolver.
5. Check expiry/renewal and (in G2+) handoff fuses/roles separately before advertising native ENS name sovereignty.

## Release and verification

The package must publish ESM/type exports and be installable into an independent consumer. G1 acceptance requires npm pack/install smoke, direct read test, typed write request parity, wrong chain/nonce/signature negatives, browser bundle secret scan and the full unit + Foundry suite. Live Sepolia end-to-end, ENSv2 migration hardening, and irreversible handoff remain gated by G2–G5; see [MILESTONES](goal/MILESTONES.md).
