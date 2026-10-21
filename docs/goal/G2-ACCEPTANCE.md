# G2 — Per-community control, revocable operators, and real ENS handoff

> **IN_PROGRESS, not accepted.** G1 was explicitly accepted by the user on 2026-10-21. This is G2's release gate, not proof that G2 capabilities already exist. G3 remains blocked until independent G2 user acceptance.

The [L1-to-OP authority design boundary](../reference/G2-L1-TO-OP-AUTHORITY.md) records why an asynchronously delivered L1 ownership checkpoint can authorize only a bounded `MANAGED` lease, not native ENS `SOVEREIGN` handoff. It is an unimplemented design contract, not new acceptance evidence.

## Non-negotiable distinctions

- A V3 OP NFT is an **application-layer token**, never evidence that its holder owns an Ethereum L1 ENS Registry / NameWrapper node.
- A parent-controller binding on OP is **not independently verified L1 ownership** merely because someone supplied a namehash, address or an EOA signature. Real ENS owner/wrapped-owner, expiry, chain ID, proof/finality and migration checks must be performed at G2.4/G2.7 before calling it native or sovereign.
- No platform-wide owner, proxy admin, privileged gateway signer or emergency hook may confiscate a member-owned NFT, rewrite a member's records, or silently reassign a registered parent controller. Prefer independent per-community deployments; any shared implementation must satisfy the same isolation proof.
- AAStar hot EOAs hold only explicitly granted, scoped, expiring and revocable rights. OP on-chain state, **not Cloudflare KV**, must reject revoked/stale/replayed transaction authorizations.
- Consent to authorize a testnet or mainnet chain write is not implied by having RPC URLs/private keys configured. Do not use a live-network test as an ordinary `pnpm vitest run`; see `test/integration/README.md`.

## Frozen acceptance matrix

| ID | Required artifact | Acceptance negatives (fail closed) | State |
|---|---|---|---|
| G2.1 | V4 Core per-`parentNode` controller and explicit rights/quota/expiry/epoch | Cross-parent grant, issue, wrong parent hash and unauthorized root binding fail | PENDING |
| G2.2 | Owner grant / restrict / revoke / rotate with transaction receipt and indexed events | Old/expired/exhausted operator fails immediately after OP finality; grant cannot outlive controller epoch | PENDING |
| G2.3 | Member-controlled NFT/records/transfer; no global-owner backdoor | Operator/root controller cannot transfer a member token or change a member-private addr/text/contenthash; member can | PENDING |
| G2.4 | Independently verifiable L1 ENS root ownership binding and expiry/transfer/rotation freeze | Unproven owner, stale L1 state, transfer, expiry, wrong network and invalid proof cannot expand privileges | PENDING |
| G2.5 | SDK + CLI grant/status/revoke and independent owner audit query | Browser has no API key/private key; invalid chain/code/version, wrong parent or contract stops action | PENDING |
| G2.6 | Atomic signature nonce consumption and transfer-aware record behavior | Same signed request cannot succeed twice, including KV loss/multiple relayers; post-transfer old owner/record cannot remain authoritative silently | PENDING |
| G2.7 | Native ENSv1 NameWrapper subname handoff with PCC/CU and bounded expiry, separated from OP NFT | Merely transferring OP ERC721 never yields a native ENS `SOVEREIGN` claim; wrong fuse, locked parent or expired node fails | PENDING |
| G2.8 | No deploy/admin upgrade bypass; reproducible independent handoff receipt | Mutable proxy, privileged service signer, bridge emergency role, omitted checks or absent chain evidence cannot produce a SOVEREIGN receipt | PENDING |
| G2.9 | Member-controlled resolver and optional irreversible record locks | Parent/platform cannot rewrite locked data; member resolver change/expiry/safety tradeoff explicit | PENDING |

## Landing order and implementation boundaries

1. **Core ACL / state tests**: first deliver a new, separately deployed and source-verifiable V4 implementation. Start with narrow per-parent rights and immutable member authority; don't alter V3 state or enable the current SDK's `protocol:'v4'` prematurely. Auditable errors/events and malicious cross-parent/operator tests are mandatory. This covers only a **subset** of G2.1–G2.3; no standalone OP binding is automatically sovereign.
2. **Client and replay path**: publish a separate SDK/CLI adapter for explicitly selected V4 chain/address and owner-wallet transactions, plus on-chain signer nonce/epoch binding and negative replay tests. The existing Worker V3/KV security contract remains legacy and must not be advertised as upgraded by merely using an SDK type.
3. **L1 authority & native ENS**: use independently verifiable L1 ENS Registry/NameWrapper authority, finalized/correct-chain proof, lifecycle expiry/transfer monitoring, and real L1 NameWrapper handoff. A trusted attestation/bridge, if temporarily necessary for the PoC, must be marked `MANAGED` and must fail closed for `SOVEREIGN` classification.
4. **Full acceptance**: validate all nine G2 rows, run Foundry fuzz/invariants, local Anvil E2E and independently approved testnet live flows with explicit consent; independent PR review/CI and contract hash receipts; ask the user for a **separate explicit G2 ACCEPTED** before beginning G3.

## G1 acceptance and carry-forward limitations

On 2026-10-21 the assistant started the local read-only browser demo at `http://127.0.0.1:5188/` and provided test steps; the user then explicitly accepted, without claiming which browser interactions they personally performed: **「啊，验收通过了，你继续开发吧。」** This authorizes G2 implementation, **not** mainnet migration, SDK npm publication or waiver of existing security findings. Historical direct OP Sepolia `aastar.eth` reads and Ethereum L1 ENS resolution are observably different. [Issue #118](https://github.com/MushroomDAO/CometENS/issues/118) tracks this discrepancy; live testnet reads/writes require explicit flags after merged PRs [#117](https://github.com/MushroomDAO/CometENS/pull/117) and [#119](https://github.com/MushroomDAO/CometENS/pull/119).
