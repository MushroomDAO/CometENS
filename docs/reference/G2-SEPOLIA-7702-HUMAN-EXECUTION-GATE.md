# Sepolia EIP-7702 revocation: execution blocked pending proof

User permission for a one-time Sepolia delegation-clear transaction is documented. However permission does not make signing safe by itself. This isolated tool only extends #184's unsigned, fixed-wallet proposal with an optional **read-only** type-4 receipt/postcondition observer. Commands:

- `node scripts/check-g2-sepolia-7702-human-execution.mjs check examples/g2-sepolia/04-revoke-7702.json` (the example expiration must be refreshed)
- `node scripts/check-g2-sepolia-7702-human-execution.mjs receipt 0xEXISTING_TRANSACTION_HASH`

There is **no execute or sign command**. Both commands use two Sepolia RPCs and no private key. A successful observed type-4 receipt must match the intended sender, transaction hash, block identity and `eth_getCode(wallet) == 0x`. This is a read-only observation and is not finality proof.

Viem's self-authorized EIP-7702 flow requires `signAuthorization({contractAddress:zeroAddress,executor:'self',chainId:11155111})` with authorization nonce equal to the transaction nonce plus one, then a type-4 transaction with that authorization list. This branch intentionally does not implement those signing calls: nonce reservation and independent pending tx races, exact fee caps through signing/broadcast, protection against losing a hash on an RPC submission timeout, and atomic post-sign state rechecks lack rigorous full-path tests. A separate formal security review and owner-operated implementation are required before any instruction to transact. Removing delegation changes smart-account behavior; the local salt and owner identity remain unchanged.
