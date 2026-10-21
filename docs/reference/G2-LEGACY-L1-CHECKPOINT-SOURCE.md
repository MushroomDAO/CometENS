# G2.4 experimental legacy ENSv1 L1 checkpoint source — MANAGED ONLY

**Scope:** `contracts/src/LegacyL1AuthorityCheckpoint.sol` is an independent L1
Sepolia **event producer**, not an OP inbox, canonical messenger, deployment,
recovery guarantee or `SOVEREIGN` handoff. **Not deployed; local Foundry only.**
The full frozen G2.4 transfer-time requirement remains **PENDING**. A transfer
after an L1 checkpoint but before OP delivery can leave **old OP privileges
usable for the remainder of the managed lease (maximum 2 hours)**. No bridge
is implemented in this PR; an ordinary log or relayer cannot authenticate an
L1→OP state transition. Never connect these events to an OP write API or promote
them to sovereign authority without a separately reviewed canonical messenger,
source-finality proof, receiver identity, replay protection and OP lease gates.

**Official legacy ENS Sepolia contracts (2026-10-21):**
[ENS deployment table](https://docs.ens.domains/learn/deployments/) lists
ENSv1 Registry `0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e`,
NameWrapper `0x0635513f179D50A207757E05759CbD106d7dFcE8`, and
BaseRegistrar `0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85`.
Official [wrapped states](https://docs.ens.domains/wrapper/states/),
[wrapper expiry](https://docs.ens.domains/wrapper/expiry/) and
[ETH registrar](https://docs.ens.domains/registry/eth/) describe registrar
ERC721 custody, wrapper ERC1155 owner and registration expiry/grace. **These are
legacy contracts**; Sepolia's current app/UniversalResolver use ENSv2.

Reported runtime keccak256 observations from **one public Sepolia RPC** at
`finalized` on 2026-10-21 (not independently reproduced by the reviewer;
reverify using a separate RPC and verified source before any deployment):

| Registry | `0x8ea75f170914f04bc7c03e47eac3d7f5763f40fd5337cad69011bc7245fcf4a0` |
| NameWrapper | `0x3f3544614f9feb7eb861df74d7864b601920b47f78c4ad9cabc3c587387b48d6` |
| BaseRegistrar | `0xd7d99a683d1a24fb7af58dc110335c71e09931208bff8b4e00d7787749d030ed` |

The constructor requires **caller-supplied** hashes equal the on-chain runtime
codehashes **at constructor execution**; it does not hardcode or attest the
three observed values above and this PR has no deployment script. It pins chainId
`11155111`, legacy contract addresses, a strict ASCII-LDH `.eth` 2LD parent
label and an explicit OP inbox (address only). Every operation checks
all three runtime hashes **on L1 execution**, and reads native state:
ENS Registry `owner(parentNode) == NameWrapper`; registrar
`ownerOf(labelhash) == NameWrapper`; wrapper `ownerOf(parentNode)` and
`getData(parentNode).owner` agree. The **current wrapped ERC1155 holder**
must be `msg.sender` to bind/renew or cancel. A holder-controlled contract
wallet is supported by ordinary `msg.sender` checks, not an EOA signature,
platform administrator, keeper assertion or ERC1155 approved operator.
Unwrapped/missing/expired names **cannot** create a positive checkpoint.
The registrar's raw `nameExpires` **excludes its 90-day grace period**; a
24-hour safety margin is subtracted from the minimum registrar/wrapper expiry.

`bindOrRenew(controller, requestedLease)` emits a versioned
`RootCheckpoint` only for valid native ownership and
`0 < requestedLease <= 7200` seconds, with `leaseUntil <= l1ValidUntil`.
`sequence` strictly increases, and `sourceEpoch` increases on new owner,
controller rotation or rebind after freeze; renewing same owner/controller
keeps epoch but increments sequence. `cancel()` is current-holder-only and
emits zero-controller freeze; `observeLoss()` is permissionless, rereads
the live registry/registrar/wrapper and emits freeze only after it detects
lost native authority. An unchanged observation emits nothing and consumes no
sequence. There is no platform-wide admin, emergency transfer or member-NFT
write function in this contract.

**Independent verifier responsibilities:** the actual source contract address
and bytecode must additionally be pinned; confirm the finalized L1 transaction,
checkpoint fields/source epoch/sequence/lease/cancellation, and separately a
canonical finalized OP inbox execution. OP must reject duplicates, old epochs,
incorrect destination/parent/version, and privilege expansion with expired
leases. Freeze may be delayed, and an old holder may remain authorized on OP
until lease expiry. Even identical owner after an offchain/unobserved
transfer-back cannot be proven continuously authorized from this event alone.
This prototype intentionally **does not implement a bridge or claim that the
frozen G2.4 transfer-time requirement has passed**.
