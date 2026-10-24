# G2.6 OP V4 signed issuance receipt observation

`observeV4SignedIssuanceReceipt({client,profile})` is a **read-only** evidence helper for a completed OP Sepolia `L2CommunityRecordsV4.issueBySig` transaction. It requires a finalized RPC receipt, exact tx sender/destination/calldata, historical codehash, parent node and member owner, exactly one `SubnodeIssued` and one `IssuanceNonceConsumed` event, and rechecks the block after observing it. The caller must supply an independently sourced expected runtime codehash; the same RPC cannot establish its own trustworthiness.

Required profile: `{chainId:11155420, contract, codeHash, parentNode, label, member, operator, nonce:"7", transactionHash}`. Only the OP **application NFT** is observed. This is not an Ethereum ENS native title, not a verified L1 controller, not independent consensus, not a current member owner certificate, and not evidence that another relayer cannot submit a different pending transaction. Never upgrade the returned `sovereignReceipt:false`, `nativeAuthorityVerified:false`, or `currentOwnerVerified:false` to true based on this observation.

No key, wallet, broadcast or Worker KV access is performed. This helper cannot complete G2.4/G2.6/G2.8 or unblock G3 by itself.
