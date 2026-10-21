# V4 member record nonce contract (G2.6)

`L2CommunityRecordsV4` is an OP application-layer record/NFT contract. Its nonce
rules provide transaction-order replay protection for member record writes;
they do **not** attest L1 ENS/NameWrapper ownership or create a sovereign name.

## One holder nonce, all names and record types

- `nonces(holder)` is a single on-chain sequence per **current ERC-721 holder**,
  shared across that holder's nodes and `SetAddr`, `SetText`, and
  `SetContenthash` signatures. Every relay must carry exactly the current
  `nonces(holder)` and current `recordEpoch(node)`; the contract consumes the
  nonce atomically **before** validating an EOA / ERC-1271 signature. An invalid
  signature reverts that nonce update. The digest also binds chainId, the
  deployed V4 verifying contract, node, record value, deadline and epoch.
- A direct call by the current member to `setAddr`, `setText` or
  `setContenthash` advances that member's nonce by one. This cancels a relay
  signed with the previously current nonce, including relays for *other* nodes
  the same member owns; existing records at those other nodes remain intact.
- `invalidateNonce(node, newNonce)` requires `msg.sender` to own that specific
  V4 token **now**, and `newNonce > nonces(msg.sender)`. It skips directly to
  the requested nonce (excluding `uint256.max` to avoid exhaustion). Useful
  when a member loses access to a relayer or has signed multiple consecutive
  requests and wants to reject all known older nonce values. Both direct
  actions and invalidation emit `MemberNonceAdvanced(holder,node,old,new)`;
  relayed writes additionally emit `MemberNonceConsumed(holder,node,nonce)`.
- A nonce update cannot undo a relay already executed in an earlier
  transaction, and cannot preempt a signature preauthorized at a **future nonce
  at or above** the new value. Members cancelling a known signed sequence
  must advance beyond its highest signed nonce. Transaction ordering is the
  only authority when a relay and a direct write race in the same block.

## Transfer, ERC-1271 and deadlines

An NFT transfer increments `recordEpoch(node)` and hides earlier record data.
Old signatures cannot revive it on transfer or a transfer back: both the
current holder and epoch must match. The former holder loses the ability to
invalidate that node's nonce; their personal nonce value is unaffected by the
transfer. The new holder starts from **their own** pre-existing shared nonce.

An ERC-1271 smart account must directly **call the contract** to set a record
or invalidate its own nonce. `SignatureChecker` invokes `isValidSignature` by
`staticcall` after pre-incrementing the nonce: a wallet inspecting
`nonces(address(this))` from that callback sees **signed nonce + 1**. The
staticcall cannot change NFT ownership or storage during validation. An
EIP-7702 delegated EOA enters the ERC-1271 path when it has code; if its
delegate does not support ERC-1271, signatures fail closed without a fallback
to ECDSA. This is distinct from direct wallet transactions.

The relay's `deadline` is a signed **execution cutoff**, and the existing
contract enforces `block.timestamp <= deadline <= block.timestamp + 1 day`
at submission time. It does **not** prove the signature was created within
the preceding day; a far-future deadline may become valid once close enough.
The contract has no signed `issuedAt`, so clients should issue short deadlines
and advance the nonce to cancel compromised or indefinitely pending intents.

The new Foundry tests generate EIP-712 digests with the independent
`vm.eip712HashTypedData(JSON)` implementation for all three record types,
including a nonzero record epoch and mutations of key/value or bytes. They
exercise actual on-chain nonce storage; Cloudflare KV cannot overrule it.
