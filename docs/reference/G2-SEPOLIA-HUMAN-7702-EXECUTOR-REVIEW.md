# Sepolia EIP-7702 local human revoke candidate — DRAFT, not approved for execution

Only test wallet `0xF7Bf79AcB7F3702b9DbD397d8140ac9DE6Ce642C`, Sepolia `11155111`, current pinned delegate `0x5804b6119d12ad403a430fd3cff12a8ff6e4064b`. The intended authorization uses `contractAddress: zeroAddress`, `executor:'self'` and nonce transaction nonce + 1. The command defaults to `check`. `execute` requires a real TTY, exact phrase, POSIX mode 0600 test-key file and a pre-existing unique journal location; it never logs key bytes. All fee/nonce/delegate checks are refreshed after consent and again after signing. An offline-signed Type-4 transaction hash (never raw transaction bytes or private keys) is written and fsynced in an exclusive .hash journal before the first network broadcast. A separate .attempt journal is fsynced before the single sendRawTransaction call. No retry is automatic; ambiguous outcomes must be investigated using the durable hash. Unknown RPC outcome MUST NOT trigger retry. A successful receipt still needs independent read-only cross-RPC finality verification.

Example order JSON keys: `version:1`, `action:'clear-7702'`, `chainId:11155111`, fixed `wallet`, `maxGas:'60000'`, `maxFeePerGasWei:'100000000'`, `maxPriorityFeePerGasWei:'2000000'`, `expiresAt:'<UTC ISO within 1 hour>'`. The suggested limits are illustrative, not live fee guidance.

**Execution review blockers**: No full Anvil Sepolia fork execution test for the actual delegated wallet and revocation, no validated type-4 serialized tx fixture signed with disposable key, and the second RPC may be stale/hostile. No code claims atomic nonce reservation. A trusted human must approve these gaps resolved before using execute. Do not ask AI agents to run execute or read key files. Clearing delegation breaks smart-account sessions and leaves prior storage intact.


## Security review update

The executor signs a Type-4 transaction offline, derives its hash with keccak256(serialized), persists the hash before transmission, and uses exactly one raw-transaction submission. An RPC timeout leaves the .hash journal for manual chain inspection. The key is opened with O_NOFOLLOW and checked by descriptor fstat before reading. Network calls have explicit timeout and zero retries.

A success receipt alone is insufficient: both providers must return the expected Type-4 transaction with the fixed sender, destination, nonce, and zero-address self-authorization at nonce + 1. The receipt must be included in finalized history reported by both providers, and code at the receipt block must be empty from both providers. Until that evidence is available, execution reports a blocked/pending result instead of declaring completion. Disposable local Anvil validation and external formal review are still required.

## Read-only recovery and reverted outer execution

Run: node scripts/g2-sepolia-human-7702-revoke.mjs recover /absolute/path/to/journal

Recovery reads only the protected journal.hash file and queries both RPCs. No signing key, signing, or broadcasting occurs. Repeat it after two confirmations until finality. PENDING_OR_RPC_DISAGREEMENT and AWAITING_FINALITY are not success states, and no automatic retry is allowed.

EIP-7702 authorization changes are applied before outer execution and persist if outer execution reverts. Recovery validates Type-4 transaction fields and authorization, independent of receipt.status, then checks wallet code at the finalized receipt block on both providers. The outerExecution field records success or reverted separately. Conflicting RPC results and delegated code remain non-success statuses.

Recovery requires both protected journal.hash and journal.attempt records to agree on hash, nonce and Sepolia chain ID; a signed-but-never-attempted transaction cannot be described as submitted. Missing receipts or transactions yield PENDING_NO_RETRY. Each provider must agree on the receipt's mined block hash and its canonical block at that height. Both independently reported finalized heights must include that mined block, but need not be equal. EIP-7702 code is checked at that receipt block regardless of outer transaction status.

Local signed EIP-7702 Type-4 Anvil test has passed using a disposable test key and local chain. This is not a Sepolia fork test, not an approval for live execution, and does not establish behavior on the target Sepolia wallet.
