# Sepolia EIP-7702 revocation: human-controlled preparation

This tool is intentionally **READ ONLY**. It cannot sign, execute or broadcast a type-4 transaction. It pins chain 11155111, wallet `0xF7Bf79AcB7F3702b9DbD397d8140ac9DE6Ce642C`, and delegate `0x5804b6119d12ad403a430fd3cff12a8ff6e4064b`. The delegate runtime hash is pinned to `0xa7537d192ef8051322146be7540c39537d9ee4428a8cde0c74f6d3980173aeb3`, observed on Sepolia block `11982132`. Independently verify the source and the current code before any human wallet action:

```sh
node scripts/check-g2-sepolia-7702-revocation.mjs --rpc https://sepolia.drpc.org
```

The command checks wallet code is **exactly** the EIP-7702 delegation designator, verifies delegate codehash, and refuses mismatched chain or any pending nonce difference. It exits nonzero even on `READY_FOR_HUMAN_REVIEW` and never prints credentials, salt, signatures, or an executable signed transaction. Do not place secrets in shell arguments.

## Human action (separate trusted wallet, never this script)

EIP-7702 [official specification](https://eips.ethereum.org/EIPS/eip-7702) permits delegation removal through authorization to `0x0000000000000000000000000000000000000000`. Viem documents [signAuthorization](https://viem.sh/docs/eip7702/signAuthorization) with `{ contractAddress: zeroAddress, executor: 'self', chainId: 11155111 }` and a type-4 [sendTransaction](https://viem.sh/docs/eip7702/sending-transactions) with the resulting `authorizationList` for a self-executing wallet. **This documentation is not an instruction to run an unreviewed snippet.** Human must choose a trusted wallet that implements these semantics, inspect chain, recipient, authorization, nonce, wallet address and fees, and explicitly consent in the terminal/wallet. Avoid a blind private-key import or third-party authorization website.

Self execution increments the sender's nonce before EIP-7702 authorization processing, so the expected signed authorization nonce is **transaction nonce + 1**. The returned snapshot expires immediately on any new transaction or chain/delegate change. No transaction is included here because robust nonce reservation, trust of the signer and timely revalidation cannot be guaranteed by an offline draft. No automatic signer shall ingest this output.

Clearing delegation changes smart-account functionality and may disrupt sessions, recovery, scheduled or batch actions. It does **not** wipe account storage, nor erase an already-issued authorization which could later be submitted. Once the user-controlled transaction is mined, independently verify `eth_getCode(wallet) == 0x` on Sepolia and recheck commitment validity, fresh register quote, bounded allowance, receiver compatibility and register simulation before any separate ENS registration action. The original committed owner is fixed; switching owners requires a new commitment. Never raise allowance based on ERC1155InvalidReceiver.
