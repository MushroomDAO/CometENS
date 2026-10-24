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

The commitment is `keccak256(abi.encode(label, owner, secret, subregistry, resolver, duration, referrer))` from upstream Solidity; **payment token is included only in reveal, not in the commitment**. Registrar `register` debits the actual transaction sender via ERC20 `transferFrom` for `base + premium`. The live values, not documentation defaults, determine `MIN_COMMITMENT_AGE`, `MAX_COMMITMENT_AGE`, `MIN_REGISTER_DURATION`, token acceptance and price.

## Create local manifest and private salt directory

Copy this JSON to an **untracked file**; replace the two runtime hashes only after independently verifying deployed bytecode hashes. These intentionally invalid hashes prevent blind use. Registration defaults to a bare name (`subregistry=0`, `resolver=0`, `referrer=0`), with full future member/community configuration left to a separate user-controlled transaction and review.

```json
{
  "wallet": "0xF7Bf79AcB7F3702b9DbD397d8140ac9DE6Ce642C",
  "label": "my-test-community",
  "durationSeconds": "31536000",
  "maxTotalCost": "100000000",
  "expectedRegistrarCodeHash": "REPLACE_WITH_0x_PLUS_64_HEX",
  "expectedTokenCodeHash": "REPLACE_WITH_0x_PLUS_64_HEX"
}
```

`maxTotalCost` is a hard cap in **MockUSDC base units** (six decimals, `100000000` = 100 MockUSDC). A single local salt file must be stored in an existing directory owned by you with mode `0700`, **outside the repository**. Only the explicit path is opened. The script creates a new file atomically (`O_EXCL|O_NOFOLLOW`, mode `0600`), generates 32 random bytes with the OS CSPRNG, writes and fsyncs salt/commitment bound to exact label, wallet and duration. Re-running commit safely reuses the identical salt and commitment. It refuses a symlink, incorrect permissions, tampered commitment or changed label/duration, and never prints the salt during commit preparation. Back up this local file securely before any actual on-chain commit; losing it makes your prior commitment unrevealable.

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

After an externally submitted commit is actually mined, run with `--phase reveal` and **the same salt file**. Before releasing reveal calldata, the script checks on-chain `commitmentAt` is nonzero and within the live `[MIN_COMMITMENT_AGE, MAX_COMMITMENT_AGE)` window, a current price below your cap, MockUSDC `balanceOf` and `allowance(wallet, registrar)` each sufficient, the gas reserve and successful registrar `register` simulation. **The allowance must also be no more than the cap**: the Registrar recalculates its price when the actual transaction executes, and its ERC20 `transferFrom` cannot spend more than the remaining on-chain allowance. An allowance above the cap or too small for the current quote returns an inert `approveDraft` to **reduce/set** allowance to the simulated price; the tool never sends it. This bounded-spend protection applies only while the allowance has not subsequently been increased and the pinned MockUSDC runtime still enforces ERC20 allowance. The successful reveal output necessarily embeds the commitment secret in `revealDraft.data`: treat that output as sensitive until you intentionally submit the reveal transaction. A draft does **not** reserve availability or guarantee future inclusion.

## Blocking real-world prerequisites

The workflow does not mint MockUSDC, fund Sepolia gas, send allowance/commit/reveal transactions or check resulting receipts. The public wallet must independently obtain Sepolia ETH and free Sepolia MockUSDC (ENS documents the mock token `mint(address,uint256)` as permissionless), and provide the real codehashes, available label and chosen duration/price cap. Without a mined commit and sufficient ERC20 approval, reveal stays blocked. Actual receipt finality, ENSv2 registration state, member handoff, permission/role review and CometENS sovereign authority remain separate G2 acceptance work. Neither success of a dry-run nor possession of a draft changes those statuses.

Reproduce offline tests: `pnpm exec vitest run test/unit/g2-sepolia-ensv2-register-offline.test.mjs`.
