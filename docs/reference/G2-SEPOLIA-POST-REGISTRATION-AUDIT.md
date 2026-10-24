# G2 Sepolia ENSv2 post-registration observation (not sovereignty)

After a successful, independently checked Sepolia ETHRegistrar transaction, `auditG2Ensv2Parent` joins its receipt to a separate finalized ENSv2 `inspectEnsv2` observation. The method requires the transaction to be successful, routed to the current Sepolia ETHRegistrar, the sampled finalized block to be at least as recent as the transaction, the target parent to be registered, non-expired, and held by the expected test wallet.

It returns `REGISTERED_OWNER_RPC_OBSERVED_ONLY` **only** when the snapshot predicates pass; every failure returns `BLOCKED`. It always sets `eacExclusiveControlVerified=false`, `independentlyFinalized=false`, and `sovereignReceipt=false`: the sampled role inventory cannot exhaustively disprove hidden approvals, upgrade paths or current future EAC revocation, and a single finalized RPC cannot establish canonical consensus independently. A successful registration receipt does not imply G2.4 native subname issuance, independent member resolver control or instant OP revocation.

This evidence must be paired with the separate registrar commit/reveal workflow, exact transaction logs/receipt and independent finalized RPC cross-check before the G2 acceptance matrix can advance. User acceptance and permission to broadcast are distinct from this audit output.
