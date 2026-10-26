# G2 ENSv2 Sepolia first-name registration: local commit/reveal drafts

**Status: OFFLINE-SAFE PREPARATION ONLY. No registration was made.**

The expected wallet/owner is exactly `0xF7Bf79AcB7F3702b9DbD397d8140ac9DE6Ce642C`.
The preparation script neither reads private keys nor creates any wallet client, signature, approval, commitment transaction, registrar transaction or chain broadcast. Every return is `BLOCKED` (even after successful `eth_call` simulation), with `broadcasts=false`, `signatures=false`, `registrationCompleted=false`, `nativeAuthorityVerified=false`, `sovereignReceipt=false`.

## Verified Sepolia addresses and ABI

Read on 2026-10-24 from [ENS official deployments](https://docs.ens.domains/learn/deployments/), pointing to [the deployed Sepolia ETHRegistrar artifact at upstream commit `07e55a056f5b6a9c90119f501bdd05714e67dddd`](https://github.com/ensdomains/contracts-v2/blob/07e55a056f5b6a9c90119f501bdd05714e67dddd/contracts/deployments/sepolia/ETHRegistrar.json) and [its Solidity source](https://github.com/ensdomains/contracts-v2/blob/07e55a056f5b6a9c90119f501bdd05714e67dddd/contracts/src/registrar/ETHRegistrar.sol):

| Deployment / ABI fact | Verified value |
| --- | --- |
| Ethereum Sepolia chain | `11155111` |
| ENSv2 `ETHRegistrar` | `0xf633e7fc17e2bbe0d0965d18ec1821dcb754a3d3` |
| ENSv2 `ETHRegistry` | `0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4` |
| Test fee token `MockUSDC` | `0x240b0316df57887dbbe58b586508b19e633a14aa` |
| `makeCommitment` | `(string,address,bytes32,address,address,uint64,bytes32) → bytes32` |
| `commit` | `(bytes32)`, selector `0xf14fcbc8` |
| `register` | `(string,address,bytes32,address,address,uint64,address,bytes32) → uint256`, selector `0xcff3e7c2` |
| `getRegisterPrice` | `(string,uint64,address) → (uint256,uint256)` |
| Commitment state | `commitmentAt(bytes32) → uint64`, `MIN_COMMITMENT_AGE`, `MAX_COMMITMENT_AGE` |
| Registrar **observed finalized runtime hash** | `0xb025a7edb8e81862c2d28857211a7a91c1fb2b17c5bcf28b983987067f083c2a` |
| MockUSDC **observed finalized runtime hash** | `0xa9a4749f886f5035336f6e16dce5ca6f339ae73f76e94ad4b8f46a447dc335f3` |

**Independent runtime verification, 2026-10-24:** Two different public read-only Sepolia JSON-RPC providers (`https://ethereum-sepolia-rpc.publicnode.com` and `https://sepolia.drpc.org`) returned byte-for-byte identical `eth_getCode(address, "finalized")` results for both contracts. The deployed runtime lengths are respectively **8,037** and **4,309** bytes. Independently downloaded the deployment JSON from the pinned upstream ENS repository commit above. Its `deployedBytecode.object` has those exact lengths; after excluding **only the compiler-declared `immutableReferences` ranges** (768 bytes for Registrar, 224 for MockUSDC), the on-chain runtime and official artifact are byte-for-byte equal, with **zero unexplained byte differences**. Raw artifact-hash and on-chain runtime-hash differ because immutables are substituted at deployment; using the former as `expectedRuntimeHash` would be incorrect. These observations do **not** establish consensus finality independent of the RPCs or eliminate the need to verify the pinned code again before use.

The commitment is `keccak256(abi.encode(label, owner, secret, subregistry, resolver, duration, referrer))` from upstream Solidity; **payment token is included only in reveal, not in the commitment**. Registrar `register` debits the actual transaction sender via ERC20 `transferFrom` for `base + premium`. The live values, not documentation defaults, determine `MIN_COMMITMENT_AGE`, `MAX_COMMITMENT_AGE`, `MIN_REGISTER_DURATION`, token acceptance and price.

## Create local manifest and private salt directory

Copy this JSON to an **untracked file**. The two listed runtime pins have been independently checked against official artifacts and two public RPCs (method above); repeat the read-only hash checks before using them. Registration defaults to a bare name (`subregistry=0`, `resolver=0`, `referrer=0`), with full future member/community configuration left to a separate user-controlled transaction and review.

```json
{
  "wallet": "0xF7Bf79AcB7F3702b9DbD397d8140ac9DE6Ce642C",
  "label": "my-test-community",
  "durationSeconds": "31536000",
  "maxTotalCost": "100000000",
  "expectedRegistrarCodeHash": "0xb025a7edb8e81862c2d28857211a7a91c1fb2b17c5bcf28b983987067f083c2a",
  "expectedTokenCodeHash": "0xa9a4749f886f5035336f6e16dce5ca6f339ae73f76e94ad4b8f46a447dc335f3"
}
```

`maxTotalCost` is the **user's local intended spending ceiling**, in **MockUSDC base units** (six decimals, `100000000` = 100 MockUSDC). ENSv2 Registrar `register` has **no max-cost parameter**, so this is **not an atomic limit enforced by the registrar**. A single local salt file must be stored in an existing directory owned by you with mode `0700`, **outside the repository**. Only the explicit path is opened. The script creates a new file atomically (`O_EXCL|O_NOFOLLOW`, mode `0600`), generates 32 random bytes with the OS CSPRNG, writes and fsyncs salt/commitment bound to exact label, wallet and duration. Re-running commit safely reuses the identical salt and commitment. It refuses a symlink, incorrect permissions, tampered commitment or changed label/duration, and never prints the salt during commit preparation. Back up this local file securely before any actual on-chain commit; losing it makes your prior commitment unrevealable.

```bash
mkdir -m 700 "$HOME/.cometens-sepolia-private"
node scripts/prepare-g2-sepolia-ensv2-registration.mjs \
  --manifest /absolute/path/to/local-public-manifest.json \
  --salt-file "$HOME/.cometens-sepolia-private/my-test-community-salt.json" \
  --phase commit
```

With no `COMETENS_SEPOLIA_RPC_URL` this produces a **locally encoded** `commitDraft` and `RPC_NOT_CONFIGURED`, exiting 2. It makes zero RPC requests. For optional real-chain *read-only* verification, supply an HTTPS RPC URL:

```bash
COMETENS_SEPOLIA_RPC_URL=https://YOUR_SEPOLIA_RPC \
  node scripts/prepare-g2-sepolia-ensv2-registration.mjs \
    --manifest /absolute/path/to/local-public-manifest.json \
    --salt-file "$HOME/.cometens-sepolia-private/my-test-community-salt.json" \
    --phase commit
```

The live preflight checks current chain ID, a fresh numbered block, independently provided registrar/MockUSDC codehash pins, `makeCommitment` against the local hash, `isAvailable`, minimum duration, current fee and accepted payment token through the price oracle, MockUSDC balance and a twofold Sepolia ETH gas reserve. It then calls **public-client `simulateContract` (`eth_call`) and `estimateContractGas`, not `writeContract`**, and rechecks the original block hash/chain. This returns a user-inspectable commit draft even after a successful simulation, explicitly labeled `EXTERNAL_WALLET_ACTION_REQUIRED` / `BLOCKED`. Only the owner may choose whether to sign and send calldata separately with their own wallet.

After an externally submitted commit is actually mined, run with `--phase reveal` and **the same salt file**. Before releasing reveal calldata, the script checks on-chain `commitmentAt` is nonzero and within the live `[MIN_COMMITMENT_AGE, MAX_COMMITMENT_AGE)` window, a current price below your cap, MockUSDC `balanceOf` and `allowance(wallet, registrar)` each sufficient, the gas reserve and successful registrar `register` simulation. **The allowance must also be no more than the cap**: the Registrar recalculates its price when the actual transaction executes, and its ERC20 `transferFrom` cannot spend more than the remaining on-chain allowance. An allowance above the cap or too small for the current quote returns an inert `approveDraft` to **reduce/set** allowance to the simulated price; the tool never sends it. The tool now also rereads the **latest chain head** immediately before emitting reveal data: a new block means the prior quote cannot be silently presented as fresh, so it returns `QUOTE_HEAD_ADVANCED (only after one full fresh-block retry also advances)`. This reduces stale-snapshot risk, **not** the race after a draft is produced.

**Mandatory wallet-side pre-signing check:** The unsigned handoff includes `quoteSafety.atomicPriceCap=false`, `quoteSafety.quotedAtBlock`, the requested maximum base units and `walletMustRecheckAllowanceBeforeSigning=true`. Independently verify the current allowance is **at least the latest price and no higher than your cap**, verify token runtime and registrar remain unchanged, and resimulate before signing; never increase allowance above the cap. A different wallet transaction (including a pending approval), a compromised owner, token upgrade or token allowance semantics, or price/availability changes after the check invalidate the snapshot. If the oracle raises the price *above the unchanged bounded allowance*, the upstream `transferFrom` should **revert**, not overspend; it does not lock in the old quoted price or guarantee registration. The successful reveal output necessarily embeds the commitment secret in `revealDraft.data`: treat that output as sensitive until you intentionally submit the reveal transaction. A draft does **not** reserve availability or guarantee future inclusion.

## Blocking real-world prerequisites

The workflow does not mint MockUSDC, fund Sepolia gas, send allowance/commit/reveal transactions or check resulting receipts. The public wallet must independently obtain Sepolia ETH and free Sepolia MockUSDC (ENS documents the mock token `mint(address,uint256)` as permissionless), and provide the real codehashes, available label and chosen duration/price cap. Without a mined commit and sufficient ERC20 approval, reveal stays blocked. Actual receipt finality, ENSv2 registration state, member handoff, permission/role review and CometENS sovereign authority remain separate G2 acceptance work. Neither success of a dry-run nor possession of a draft changes those statuses.

Reproduce offline tests: `pnpm exec vitest run test/unit/g2-sepolia-ensv2-register-offline.test.mjs`.
