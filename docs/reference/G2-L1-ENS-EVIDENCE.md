# G2 L1 ENS authority evidence — legacy ENSv1 Sepolia ONLY

## Status and source (2026-10-21)

**Read-only observation; not a cross-chain ownership or `SOVEREIGN` receipt.** The official [ENS deployment list](https://docs.ens.domains/learn/deployments/) states that **Sepolia now uses ENSv2** for the app and Universal Resolver. ENSv1 Registry `0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e` and NameWrapper `0x0635513f179D50A207757E05759CbD106d7dFcE8` are **legacy** contracts on that testnet. Their old owner/fuse state is not automatically an observation of today's active ENSv2 EAC permissions, resolution, or migration.

ENS's official [NameWrapper fuse documentation](https://docs.ens.domains/wrapper/fuses/) defines parent `CANNOT_UNWRAP` (CU) and child `PARENT_CANNOT_CONTROL` (PCC), plus child CU, as relevant constraints for legacy ENSv1 subname delegation. The [expiry documentation](https://docs.ens.domains/wrapper/expiry/) explains that fuses/ownership expire and that subname expiry cannot exceed its parent expiry. None of these alone establish an OP per-community controller binding or eliminate ENS protocol-level governance/upgrade risks.

## `scripts/audit-legacy-ensv1-authority.mjs`

The script accepts an **explicit legacy mode** (`--mode legacy-ensv1-sepolia`), one direct parent/child name pair and **independently pinned** 32-byte runtime codehashes for the two official ENSv1 contracts. It reads only Ethereum Sepolia via a PUBLIC HTTPS RPC root URL supplied in `COMETENS_PUBLIC_SEPOLIA_RPC`; no private key, relayer, L2 wallet, transaction broadcast or automatic deployment exists. Do not place RPC tokens in the URL, command line or public outputs.

Example (replace both placeholders with **independently verified on-chain runtime-bytecode hashes**, not arbitrary guesses):

```sh
export COMETENS_PUBLIC_SEPOLIA_RPC=https://ethereum-sepolia-rpc.publicnode.com
node scripts/audit-legacy-ensv1-authority.mjs \
  --mode legacy-ensv1-sepolia \
  --parent community.eth \
  --child alice.community.eth \
  --registry-codehash 0xYOUR_VERIFIED_32_BYTE_HASH \
  --wrapper-codehash 0xYOUR_VERIFIED_32_BYTE_HASH
```

Without real pins, the tool **rejects** rather than guessing current code hashes. With valid pins, it checks RPC chainId=11155111, gets one finalized L1 block (no fallback to `latest`), fails if the block is stale, pins both bytecode hashes, queries parent and child Registry owner at the same block, then reads NameWrapper `getData` at the same block only when the Registry owner is the official legacy wrapper. It checks nonzero owner, parent CU, child PCC+CU and bounded future expiry against both finalized and current time. Invalid or inconsistent state does **not** produce an optimistic success fallback. Raw provider exceptions and credential-bearing URLs are never copied into output.

**Trust limits:** the single RPC supplies the `finalized` tag and block data; this tool does **not** independently validate Ethereum consensus, inclusion proofs, or the RPC's honesty. Reproduce observations through separately operated RPCs before relying on them for a security decision. Names are intentionally restricted to lowercase ASCII-LDH labels; this is **not** general ENSIP-15 normalization or ENSv2 EAC name validation. A matching runtime codehash identifies the sampled legacy implementation, not the active ENSv2 resolver or its permissions.

Returned fields always include `mode: LEGACY_ENSV1_SEPOLIA_OBSERVATION_ONLY`, `sovereignReceipt: false`, `ensV2AuthorityVerified: false`, `opControllerAuthorityVerified: false`, and the finalized block number. `observedLegacyFuseConditions: true` means *only* that sampled ENSv1 NameWrapper fuse constraints were seen, not that the current ENSv2 name or OP controller is authorized.

## Explicitly unresolved G2 controls

1. **G2.4**: an independently verified, freshness-bounded, cross-chain L1 owner-to-OP `rootController` binding with transfer, expiry, re-registration, cancellation and messenger replay handling. Offchain JSON or a signature from the old L1 owner does not satisfy this.
2. **G2.7**: actual ENSv1 NameWrapper native child creation/handoff, where applicable, and separate ENSv2 EAC native ownership and migration mapping. Do not burn fuses on user names to make a test green.
3. **G2.8–G2.9**: absence of bypass through admin/upgrade/proxy/bridge and independent receipt after actual member resolver/record control. Must be demonstrated against the deployed code and owner rights, not inferred from this read-only script.

These requirements remain `PENDING` in [G2 acceptance](../goal/G2-ACCEPTANCE.md). **No G2 `SOVEREIGN` classification may be derived from this artifact.**
