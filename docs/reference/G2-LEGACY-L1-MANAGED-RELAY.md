# G2.4: legacy L1 Sepolia → OP Sepolia MANAGED checkpoint relay (partial)

`contracts/src/G2LegacyL1CheckpointRelay.sol` is a permissionless **L1 Sepolia**
adapter for `LegacyL1AuthorityCheckpoint` (the separately reviewed ENSv1
source). It invokes the pinned L1 messenger's **exact**
`sendMessage(address target, bytes message, uint32 minGasLimit)` interface to
enqueue `G2RootCheckpointInbox.acceptCheckpoint` on **OP Sepolia**. This is a
local Foundry prototype only. No contract, messenger address or runtime hash
was invented as an official deployment; **nothing has been deployed**.

## Independently pinned deployment contract

Before any future deployment, verify (with official deployment metadata,
independent RPCs, audited source/implementation and codehash records) and
**explicitly supply** all six constructor inputs:

1. Actual deployed L1 `LegacyL1AuthorityCheckpoint` **address** and its exact
   **runtime bytecode hash** (including constructor-set immutable values).
2. Verified canonical **L1 Sepolia** `L1CrossDomainMessenger` **address** and its
   exact **runtime codehash**, not an arbitrary contract exposing `sendMessage`.
3. Expected unique **OP Sepolia** `G2RootCheckpointInbox` address and parent
   `.eth` namehash. The relay rereads `source.parentNode`, `destinationInbox`,
   source/destination chain IDs (11155111 → 11155420) and
   `AUTHORITY_VERSION = keccak256("COMETENS_G2_ROOT_CHECKPOINT_V1")` at
   construction **and every relay**; it refuses mismatches or code changes.

The L1 source constructor already needs the OP inbox address; the OP inbox
constructor needs this **relay's** L1 address as its trusted adapter; and the
relay constructor needs the source address. Actual deployments therefore need
**independently verified deterministic address precomputation / CREATE2
orchestrated sequencing**, checked for correct chains, salt, codehash and
constructor arguments. No deployment script, expected address, trusted factory
or shortcut is supplied by this PR. Incorrectly pinned inputs are a security
failure even if the Solidity constructor accepts them.

The relay, **not** the L1 source, is the L1 `msg.sender` of
`sendMessage(...)`. The OP messenger's `xDomainMessageSender()` must equal the
relay address and the decoded checkpoint's `sourceAdapter` must **also** equal
that relay address. `LegacyL1AuthorityCheckpoint` events continue to name their
own `sourceAdapter = address(source)` because they are source audit events;
neither the event payload nor a Worker assertion is passed through verbatim.

## L1 execution-time rules

- Anyone may call `relay(minGasLimit)`; the adapter checks `chainid == 11155111`,
  both pinned bytecode hashes and the source's domain metadata. Its caller can
  choose only bounded `minGasLimit`: `200_000..2_000_000` (engineering policy,
  **not** a guarantee of adequate execution gas, delivery or OP finality).
- It invokes `source.currentAuthority()` to re-read native legacy Registry,
  NameWrapper and BaseRegistrar state. If the previously recorded native holder
  is no longer current, it **permissionlessly calls** `source.observeLoss()`
  before reading `state()`; this yields the source's zero-controller freeze.
- Positive messages require nonzero matching current native holder, nonzero
  controller, nonzero source epoch, a new source sequence, nonexpired lease
  `leaseUntil > L1 block.timestamp` and `<= now + 2h`, and `leaseUntil <=
  l1ValidUntil <= currentAuthority().validUntil`. The last inequality rejects
  stale longer validity if native expiry was shortened since the source bound.
- Freeze messages are valid only if source state has zero controller/native
  holder/lease/validUntil. The adapter **never** invents a positive controller,
  increases a lease or derives authority from the relay caller.
- `lastSentSequence` and `lastSentEpoch` advance *before* the external messenger
  call; duplicate / callback reentry fails. If the messenger transaction
  reverts, these changes and any `observeLoss()` performed in the same L1 tx
  revert atomically. This is **L1 submission** replay protection; the inbox
  separately rejects duplicate/stale deliveries and invalid OP leases.

The old state may be reactivated only by a fresh native holder operation on the
L1 source, which advances sequence and epoch as required. A valid checkpoint
has no privileged path to transfer an existing member ERC721 or edit private
member records.

## Security and timing limits

This adapter does **not** satisfy the frozen G2.4 transfer-time safety gate.
An L1 transfer after the read/send, or while a previous OP checkpoint is in
flight, can leave an obsolete controller live on OP until it receives a freeze
or its lease expires (up to two hours). A transfer *away and back* before any
L1 observation can be invisible to the ENSv1 source. An ENSv1 → ENSv2 migration
may leave stale v1-looking state unchanged: this adapter has **no independent
ENSv2 migration oracle**, and cannot prove continued authority from legacy
readers alone. A migration that alters observed legacy custody fails closed or
causes a freeze, but **unobserved migration cannot be guaranteed rejected**.
Do not claim G2.4 complete or use these checks as a native ownership proof.

L1 `sendMessage` execution is a message queue operation; it does not prove
delivery or finalized L1 ownership. L1 source inclusion can be reorged, and
OP delivery may first exist in an **unsafe** head before becoming **safe** and
then **finalized**. Delivery acknowledgement must pair a verifiably finalized
Ethereum L1 source block, canonical message nonce/hash, and an independently
finalized OP inbox receipt; arbitrary confirmation counts or a successful L1
transaction alone do not supply that evidence. OP unsafe reads must not
authorize native `SOVEREIGN` claims.

The L1 messenger may be a **proxy**: pinning `address.codehash` prevents an
unexpected proxy shell/replacement but **does not pin its implementation**, and
an upgrade may keep the same proxy codehash while changing relay semantics.
Before a real deployment, separately inspect implementation, proxy admin,
upgrade authority, contract provenance, paused state, gas-version behavior and
canonical chain routing. The destination's OP messenger address is fixed to
`0x4200000000000000000000000000000000000007` in the reviewed inbox; the L1
messenger address is intentionally **not hardcoded or asserted here**.

**Known follow-up blockers:** audited official L1 messenger identity and
implementation pinning, deterministic deployment/address proof, independently
verified ENSv2 migration freeze, bridge proof/finality monitoring, transfer
race controls and integration with a lease-gated OP V4 successor. This PR only
enqueues a **MANAGED** source checkpoint; it does not authorize or deploy that
successor, add a Worker write path or complete G2.4.
