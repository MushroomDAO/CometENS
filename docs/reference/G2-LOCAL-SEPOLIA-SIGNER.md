# G2 Sepolia owner-operated local signer (approve → commit)

**This CLI signs only when the human directly runs `execute` in a TTY and types the exact confirmation.** ChatGPT/agents must not invoke execute. The account secret stays in `~/.config/cometens-g2-sepolia/test-wallet.key` (0600); the existing salt and public manifest stay in the same 0700 directory. Never paste a private key into JSON, chat, commits or logs. The CLI deliberately has no register/reveal or arbitrary-call support.

Run on macOS/Linux (POSIX ownership checks required) in the CometENS repository/worktree with Node 22 and installed dependencies. Windows is unsupported and fails closed before reading private files:

```bash
node scripts/g2-local-sepolia-signer.mjs check examples/g2-sepolia/01-approve.json
node scripts/g2-local-sepolia-signer.mjs execute examples/g2-sepolia/01-approve.json
node scripts/g2-local-sepolia-signer.mjs check examples/g2-sepolia/02-commit.json
node scripts/g2-local-sepolia-signer.mjs execute examples/g2-sepolia/02-commit.json
```

Read the output and save both transaction hashes. Send **only transaction hashes** to the AI for read-only receipts. After the commit is mined and at least `MIN_COMMITMENT_AGE` seconds have passed, the next registered/reveal transaction needs a separate fresh security review and signer extension; **do not send it yet**. Never regenerate or expose the salt. The JSON expires at 2026-10-27 00:00 UTC, and any fee or allowance drift causes a fail-closed denial. `check` never reads the private key. `execute` requires a terminal; no noninteractive bypass.

The CLI guards Sepolia 11155111, fixed sender, fixed token/registrar, deployed code hashes against pinned verified values, current name availability, limited approval exact to fresh oracle quote <= cap, zero existing allowance, valid persisted commitment binding, empty onchain commitment, fresh revalidation after terminal confirmation, onchain simulation, and >=2-confirmation receipt. Some systemic risks remain: an external transfer/approval between simulation and inclusion, malicious RPC, fee spikes, underlying contract upgrades, terminal or local user compromise, and registrar repricing. **It cannot provide atomic register price bounds, ENSv2 sovereignty or a production authorization model**.
