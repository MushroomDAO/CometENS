# CometENS Testnet is Live: Free ENS Subdomains on Optimism, with Trustless Resolution

*June 2026 — OP Sepolia testnet release (v0.7.0)*

**CometENS lets anyone claim a free subdomain under a root `.eth` name (e.g. `alice.aastar.eth`), registered on Optimism and resolvable across the entire ENS ecosystem.** Today we're launching the public testnet — including a new **hybrid resolver** that gives you instant resolution *and* a path to fully trustless verification.

---

## What you get

- 🪪 **Your own ENS subdomain** — `alice.aastar.eth`, owned as an NFT in your wallet.
- 💸 **Free and gasless** — you only sign in your wallet; the protocol pays the L2 gas. No "confirm payment" popups, ever.
- 🌍 **Resolves everywhere** — any ENS-aware wallet/app (MetaMask, Etherscan, dapps) can resolve it via CCIP-Read (EIP-3668).
- 🎛️ **You control it** — point it at an address, set text records (Twitter, etc.), bind a decentralized website.

> Testnet runs on **OP Sepolia** — for trying things out; names have no mainnet value yet.

---

## How it works (in one diagram)

```
You (wallet) ──sign(free)──▶ CometENS
                                │  Worker EOA pays gas, writes record to Optimism L2
                                ▼
                       L2RecordsV3 (Optimism)   ← source of truth, an ERC-721 subdomain
                                │
   any ENS app ──resolve()──▶ L1 ENS ──▶ HybridResolver ──CCIP-Read──▶ Gateway ──▶ your record
```

Three ways to register/manage, all gasless (you only sign):
1. **Register page** — connect wallet, pick a name, sign. Done.
2. **Admin page** — set address / text records.
3. **SDK / API** — for apps that want to register on a user's behalf.

---

## The interesting part: hybrid trustless resolution

An L2 record has to be proven to L1 for generic ENS apps to resolve it. There are two ways, with different trust:

| | Signature mode | Finalized proof mode |
|---|---|---|
| Trust | the gateway's signing key (run by the community) | **trustless** — L1 verifies a Bedrock storage proof of Optimism state |
| Speed | instant | needs the L2 state to finalize (~7 days on OP) |

Most systems pick one. **CometENS's HybridResolver picks automatically, per record:**

- **Fresh record (< ~7 days)** → served by **signature** (instant).
- **Aged & unchanged record (≥ ~7 days)** → served by a **finalized Bedrock proof** (trustless).

This deliberately avoids the costly "optimistic proof" path and means: your name works *immediately* after you register it, and *also* becomes independently verifiable once Optimism finalizes its state — with **no extra infrastructure**.

And note: anything that reads `L2Records` on Optimism directly (our SDK does) is **already trustless** — the gateway is only involved in the L1 ENS path used by generic apps.

A single L1 contract verifies both: a signature against the authorized key, or a Merkle proof against Optimism's finalized state root. The proof path can never be forged — the request it proves is pinned by the resolver itself, and the on-chain verifier independently enforces finality.

---

## Verification — we tested this, end to end

- **312 automated tests green**: 198 Solidity (Foundry) + 101 TypeScript unit + 29 Anvil E2E.
- **On-chain E2E on OP Sepolia**: `resolve(aastar.eth, addr)` → CCIP-Read → gateway → `HybridResolver` callback → returns the correct address.
- The resolver contract passed a multi-round adversarial review (the proof request is non-substitutable; the signature scheme is bound to resolver + calldata + result + expiry).

---

## Deployed (OP Sepolia testnet)

| Contract / service | Address / URL |
|---|---|
| L2RecordsV3 (Optimism Sepolia) | `0xbA692CdfDA33916BbE8d2a1f23E80218db8ebFDc` |
| HybridResolver (Ethereum Sepolia) | `0xA54D63a6223B66EDED35286522336e45F21BE512` |
| OPFaultVerifier | `0x136D6a500C80C00A62B124F6809178a4f5f309ff` |
| Gateway | `https://cometens-gateway.jhfnetboy.workers.dev` |
| API | `https://cometens-api.jhfnetboy.workers.dev` |
| Root domains | `aastar.eth`, `forest.aastar.eth` (Sepolia ENS) |

---

## Why we build this

CometENS is part of **Mycelium Protocol** — digital public goods: open-source, free, permissionless. Identity should belong to people, not platforms. A free, self-sovereign, globally-resolvable name is a small but real piece of that.

**Next:** mainnet deployment (owner secured by multisig), then iterate. Code is Apache-2.0 and open: [github.com/MushroomDAO/CometENS](https://github.com/MushroomDAO/CometENS).

*Try it, break it, tell us what's confusing.* 🍄
