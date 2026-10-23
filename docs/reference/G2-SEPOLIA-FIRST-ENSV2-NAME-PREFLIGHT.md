# First ENSv2 Sepolia parent-name experiment — read-only candidate snapshot

Target account: `0xF7Bf79AcB7F3702b9DbD397d8140ac9DE6Ce642C` (public address only). Network: Ethereum Sepolia `11155111`.

The official ENSv2 Sepolia contracts change during beta; use the current ENS deployments page and independently confirm all addresses before any write. This probe uses the October 2026 official ETHRegistry, ETHRegistrar and MockUSDC addresses. The historical July 2026 deployment is forbidden for this experiment. The approved first stage only reads a single finalized block.

Place the following non-secret manifest in a temporary local JSON file:

```json
{"wallet":"0xF7Bf79AcB7F3702b9DbD397d8140ac9DE6Ce642C","labels":["cometens-g2-20261023","cometens-g2-sandbox"]}
```

Run `COMETENS_SEPOLIA_RPC_URL=https://YOUR_SEPOLIA_RPC node scripts/check-g2-sepolia-ensv2-registration.mjs /path/to/manifest.json`.

It records Sepolia ETH, MockUSDC balance, candidate name state, owner and expiry, checks current deployment code presence, and verifies that the block hash has not changed. A `status=0`/zero-owner snapshot means only **unregistered at the sampled block**; it does NOT prove registrar availability, guarantee a quote, or authorize a commit/reveal. `registrationAvailableVerified`, `nativeAuthorityVerified` and `sovereignReceipt` remain false. The script does not use a signer, `sendTransaction`, `writeContract`, an allowance, or broadcast.

Before the first write, verify current ENS registrar methods and current official deployment codehashes; price and MockUSDC allowance; authorized control of the test account; registrar `available` and commitment lifecycle; exact chain ID, nonce, estimateGas and simulation. For the separate G2 native cross-chain issuance stack, address cyclic constructor dependencies and current EAC grant/upgrade authority. Use the official Sepolia ENS app for human wallet registration if direct G2 scripting is not ready; the app does not by itself certify G2 sovereignty.
