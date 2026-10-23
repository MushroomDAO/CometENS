# G2 native L1 → OP testnet deployment readiness — BLOCKED dry-run

**Only a local/offline preparation artifact.** It never signs, broadcasts, loads `.env.local`, derives a wallet from private keys, deploys, upgrades, or grants ENS-native rights. Every `checkG2NativeReadiness` result has `status: BLOCKED`, `readyToBroadcast: false`, `nativeAuthorityVerified: false`, `ensV2AuthorityVerified: false`, and `sovereignReceipt: false`. G2.4–G2.9 remain `PENDING`, G3 blocked.
## Reproducible no-signer dry-run
Create an **uncommitted local manifest**, with *independently verified public* address + codehash pins replacing all placeholders (these deliberately fail validation); never include any key, RPC URL, signer or credential. The manifest is an audit input, **not deployment permission**:
```json
{
  "version":1,"networks":{"l1ChainId":11155111,"opChainId":11155420},
  "community":{"parentName":"REPLACE.eth","expectedHolder":"REPLACE_PUBLIC_HOLDER"},
  "deployPlan":{"targetDomainReviewed":false,"contractsApproved":false,"addressPredictionReviewed":false},
  "contracts":{
    "source":{"address":"REPLACE","expectedRuntimeHash":"REPLACE"},"relay":{"address":"REPLACE","expectedRuntimeHash":"REPLACE"},
    "inbox":{"address":"REPLACE","expectedRuntimeHash":"REPLACE"},"l1Messenger":{"address":"REPLACE","expectedRuntimeHash":"REPLACE"},
    "opMessenger":{"address":"0x4200000000000000000000000000000000000007","expectedRuntimeHash":"REPLACE"},
    "registry":{"address":"0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e","expectedRuntimeHash":"REPLACE"},"wrapper":{"address":"0x0635513f179D50A207757E05759CbD106d7dFcE8","expectedRuntimeHash":"REPLACE"},
    "registrar":{"address":"0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85","expectedRuntimeHash":"REPLACE"}
  }
}
```
```bash
bash scripts/g2-native-testnet-dry-run.sh /absolute/path/to/uncommitted-g2-readiness.json
```
Runs `forge build --root contracts`, local `forge test --root contracts --no-cache`, then **offline-only** `node scripts/check-g2-native-testnet-readiness.mjs --manifest ...`. No RPC requests from shell, no `forge script`, no `--private-key` or `--broadcast`; final exit **1** is deliberate because readiness is BLOCKED. Locally compiled Foundry constructor ABI must exactly match `LegacyL1AuthorityCheckpoint(string,address,bytes32,bytes32,bytes32)`, `G2LegacyL1NativeResultRelay(address,bytes32,bytes32,address,bytes32,address)`, `G2NativeIssueResultInbox(bytes32,address)`. Creation bytecode is not deployed immutable-runtime evidence.
## Immutable wiring and HARD blockers

1. **Native community unresolved:** a specific lower-case ASCII `.eth` parent and independently proved native holder, wrapped Registry/Registrar/NameWrapper expiry, fuses, `ownerOf`/`getData` consistency, approval/upgrade scope and active ENSv2 migration status are required. The native holder must separately authorize the L1 executor for `setSubnodeRecord`; a broad `NameWrapper.setApprovalForAll` grant needs a separate scoped-risk/revocation review. A historic `currentAuthority()` read is not write-time consent.
2. **Address-construction cycle unresolved:** Sepolia L1 `LegacyL1AuthorityCheckpoint` constructor contains the OP inbox address; L1 `G2LegacyL1NativeResultRelay` contains source address/hash, parent namehash, canonical L1 Messenger/hash **and OP inbox**; OP Sepolia `G2NativeIssueResultInbox` contains parent namehash and **future L1 relay**. Ordinary independent `CREATE2` hashes form a circular immutable constructor dependency. Require separately audited deterministic CREATE-nonce reservation or reviewed address-independent CREATE3 factory (real factory runtime/hash/nonce or salt/preimage evidence, reorg control) and exact immutable bytecode/address reproduction. `addressPredictionReviewed: true` is **self-attestation only**, not independent proof. Never invent an address.
3. **Wrong old deploy script:** `scripts/deploy-testnet.sh` deploys **L2RecordsV2** / old OffchainResolver via `--private-key --broadcast`, edits wrangler configuration and deploys Workers. `contracts/script/DeployL2RecordsV2.s.sol` also targets old V2. Neither is a G2 native issuer/OP result inbox deployment path. **Never run them for G2**; no legacy V2 fallback.
4. **Signer/Messenger/authority unresolved:** no verified public deployer and key-custody signoff, no audited live G2 source/relay/inbox runtime/deployer plan, no verified L1+OP canonical Messenger proxy **implementation/admin** inventory, reorg/proof rules, gas/receipt plan, or exact head independent review of immutable versions. Do not read or print keys. OP canonical messenger is `0x4200000000000000000000000000000000000007` on OP Sepolia **11155420**; L1 source/relay chain is Sepolia **11155111**. All approvals and testnet go/no-go remain outstanding.
5. **#163 separation:** worker5 #163 is **Mainnet chain ID 1 ENSv2 EAC read-only** work. Current Mainnet ENSv1 registration/resolution and deployed ENSv2 contracts have distinct active roles; do not confuse Mainnet ENSv2 `ROLE_REGISTRAR` on child `ROOT_RESOURCE` with Sepolia legacy NameWrapper ownership or assume ENSv2 migration automatically grants ENSv1 native issuance. See <https://docs.ens.domains/learn/deployments/> and <https://docs.ens.domains/ensv2/enhanced-access-control/>. A new ENSv2 execution-time issuer requires a separate approved design and testnet deployment.

**Optional independent read-only API** after actual contracts exist: `checkG2NativeReadiness(manifest,{artifacts,l1Client,opClient})` compares both chain IDs, eight pinned runtime hashes and source/relay/inbox immutable references at sampled finalized blocks, plus `currentAuthority` holder/expiry and chain/block hashes re-read for drift. `historicalLegacyPinsMatched:true` is only matching RPC data: **not current execution authority**, two-independent-consensus proof or an allow-to-broadcast switch. With missing RPC/artifacts/manifest the tool reports an explicit BLOCKED reason; provider errors are redacted. Unit test: `pnpm vitest run test/unit/g2-testnet-deployment-readiness.test.mjs` checks 25 fail-closed scenarios, including malicious key fields and getter mutation. G2.4 and user acceptance status are never changed by this document or script.
