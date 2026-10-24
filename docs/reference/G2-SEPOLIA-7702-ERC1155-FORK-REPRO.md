# Sepolia ENSv2 ERC-1155 mint versus EIP-7702 delegation: live fork regression

A **read-only fork of actual Ethereum Sepolia block 11982132** reproduces why wallet `0xF7Bf79AcB7F3702b9DbD397d8140ac9DE6Ce642C` cannot presently receive its native ENSv2 name. The test creates a **synthetic new commitment** with an unrelated hard-coded local-only salt. It never reads the user's secret, signs, sends any real transaction, replaces the live EIP-7702 delegation, or changes the original commitment.

The first negative test sends an ENSv2 ETHRegistrar registration on the local fork, confirms `ERC1155InvalidReceiver(address)` (selector `0x57f447ce`) because the wallet still has EIP-7702 delegation. The second test uses `vm.etch(wallet, hex"")` **inside Foundry's fork only** to simulate a cleared EIP-7702 delegation, then confirms the exact same official Registrar registration successfully returns a native ERC-1155 token ID. This is a controlled causal test, not evidence the wallet has been repaired on live Sepolia.

Run separately after installing Foundry dependencies:

```sh
cd contracts
forge test --fork-url https://sepolia.drpc.org --fork-block-number 11982132 --match-contract G2Sepolia7702RegisterForkTest -vv
```

Expected: **2 passed**. The `setUp` skips outside chain 11155111. No signing or broadcast code exists. Reverting a real wallet's EIP-7702 delegation is a separate **human-authorized change** that can disable smart-wallet features and must be explicitly approved by the owner, with independent receiver-code and `register` re-simulation afterwards. The existing commitment expires after MAX_COMMITMENT_AGE; never regenerate the actual salt or assume this fork observation reserves the name.
