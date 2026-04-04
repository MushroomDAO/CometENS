# CometENS 开发路线图

## 当前状态（2026-04-04 / v0.5.1）

| 里程碑 | 名称 | 状态 | Tag |
|--------|------|------|-----|
| **A** | 可信签名 MVP | ✅ **已完成** | v0.3.0 |
| **A+** | Production API Server + Security Hardening | ✅ **已完成** | v0.4.0 |
| **B** | Name Wrapper + NFT 子域（B1/B4） | ✅ **已完成** | v0.5.0 |
| **C** | 状态证明（ENS V2 标准） | 🟡 **脚手架完成（C1/C2）** | v0.5.0 |
| **D** | 生产强化 | 🟡 **进行中（D3 ✅，D4 待做）** | v0.5.0 |
| E | .box 写路径 | ⏳ 待官方开放 | — |

**注**：B2（插件架构）已删除 — 开源免费项目，单一职责原则，根域名管理足够控制访问。D1（Durable Objects）已删除 — 链上唯一性保证足够。D2（Rate Limiting）已关闭 — EIP-712 鉴权是真正的门卫。

---

## 里程碑 A：可信签名 MVP ✅

**目标**：打通"L2 存储 → Gateway 读取 → L1 CCIP-Read 解析"完整闭环。

| 任务 | 内容 | 状态 |
|------|------|------|
| A1 | 部署 L2Records（OP Sepolia） | ✅ `0x9Ed5d10101656b69B5bf50Ef15fd3cc33F55058b` |
| A2 | 部署 OffchainResolver（Ethereum Sepolia） | ✅ `0x87d97a2e3B334a4b62e1269d02bf4e2b168EbB45` |
| A3 | aastar.eth 设置 OffchainResolver | ✅ Sepolia ENS 已配置 |
| A4 | Gateway CCIP-Read（addr/text/contenthash + 签名）| ✅ |
| A5 | Gateway 写路径（Worker EOA → L2）| ✅ |
| A6 | 前端用户注册（EIP-712 + register.html）| ✅ |
| A7 | Admin Portal（查询/设置地址/文本）| ✅ |
| A8 | 上游应用 API（/api/v1/register 签名鉴权）| ✅ |
| A9 | 测试覆盖（unit + e2e + integration）| ✅ |

---

## 里程碑 A+：Production API Server + Security Hardening ✅（v0.4.0）

**目标**：API 服务生产化，安全审计通过，CF Workers 上线。

**已部署合约（OP Sepolia 测试网）**

| 合约 | 地址 |
|---|---|
| L2RecordsV2 | `0x7E9840717CeD353eF5C6CE13673594e8bE4B5c5e` |
| OffchainResolver | `0xe138Ec90E6a793F69455a45cF78494c7baFd1A1b` |

**已部署 Cloudflare Workers（测试网）**

| Worker | URL |
|---|---|
| Gateway (CCIP-Read) | https://cometens-gateway.jhfnetboy.workers.dev |
| API | https://cometens-api.jhfnetboy.workers.dev |

| 任务 | 内容 | 状态 |
|------|------|------|
| A+1 | cometens-api CF Worker：全量 EIP-712 写端点 | ✅ |
| A+2 | CF KV 边缘缓存（addr/text/contenthash <5ms）| ✅ |
| A+3 | 纯前端构建（vite.config.ts 精简至 17 行）| ✅ |
| A+4 | Admin 页面：Query/Remove Registrar + Set Contenthash | ✅ |
| A+5 | ABI 单一来源（contracts/abi/L2RecordsV2.json）| ✅ |
| A+6 | 3 轮 Codex 安全审计，全部问题修复 | ✅ |
| A+7 | 测试：109 Foundry + 21 unit + 16 e2e + 8 integration | ✅ |
| A+8 | aastar.eth Sepolia ENS resolver 更新 | ✅ |

---

## 里程碑 B：Name Wrapper + NFT 子域 ✅（v0.5.0）

**目标**：子域名成为真正的 ERC-721 NFT，可转让、可交易。

| 任务 | 内容 | 优先级 | 状态 |
|------|------|--------|------|
| B1 | L2RecordsV3 合约：ERC-721 子域所有权（tokenId = uint256(node)） | 🔴 P0 | ✅ 完成 |
| B4 | 前端适配：NFT 转让 UI + /transfer-subnode API 端点 | 🟡 P1 | ✅ 完成 |

**已完成合约**：`contracts/src/L2RecordsV3.sol`（21KB，主网可部署）

**已删除**：
- B2（插件架构）— 删除。开源免费，根域名管理即访问控制，无需插件。
- B3（数据迁移脚本）— 取消。V2 无生产用户，V3 主网全新部署。

---

## 里程碑 C：状态证明（ENS V2 标准路径）🟡 脚手架完成

**目标**：用 Bedrock 状态证明替代 Gateway 签名，实现信任最小化。

**背景**：当前系统信任 Gateway EOA 私钥。状态证明使 L1 合约直接验证 OP 链上数据的 Merkle 证明，完全去信任化，是 ENS V2 的设计方向。

| 任务 | 内容 | 优先级 | 状态 |
|------|------|--------|------|
| C1 | OPResolver 合约（替代 OffchainResolver，`verifyProofs` flag） | 🔴 P0 | ✅ 完成（脚手架） |
| C2 | Gateway Worker 支持证明模式（PROOF_MODE + DEV_MODE 双 guard，返回 501 stub） | 🔴 P0 | ✅ 完成（stub） |
| C3 | L1 链上验证 OP 状态根（Bedrock Merkle proof 实际验证）| 🟡 P1 | 📋 待实现 |
| C4 | Gateway 实际返回 eth_getProof 结果，OPResolver 链上验证 | 🟡 P1 | 📋 待实现 |

**参考**：`vendor/unruggable-gateways/`、`eval/unruggable-gateways/`

---

## 里程碑 D：生产强化 🟡 进行中

**目标**：达到生产级安全与可运维标准。

| 任务 | 内容 | 优先级 | 状态 |
|------|------|--------|------|
| D3 | 监控告警（CF Analytics Engine 可选 stub + `/health` timestamp）| 🟡 P1 | ✅ 完成 |
| D4 | 主网部署（OP Mainnet + 主网 ENS aastar.eth resolver 更新）| 🔴 P0 | 📋 待实现 |
| D5 | Worker EOA 密钥轮换方案 | 🟢 P2 | 📋 待实现（上线前不急） |
| D6 | 多根域名支持（forest.aastar.eth、game.aastar.eth 等） | 🟡 P1 | 📋 待实现 |
| D7 | Rate Limiting（CF 原生或 DO per-key，多 PoP 正确性）| 🟢 P2 | 📋 待实现（实际滥用出现后再做） |

**已删除/关闭**：
- D1（Durable Objects nonce）— 删除。链上唯一性（AlreadyRegistered）是真正的保障，KV eventually-consistent 够用。
- D2（KV 滑动窗口限速）— 关闭。EIP-712 鉴权是实际门卫。代码注释保留，D7 是正式入口。

---

## 里程碑 E：.box 写路径（依赖官方）

**目标**：接入 my.box 写入能力（当前仅只读展示）。

- E1 跟进 my.box 官方 API/授权接口开放情况
- E2 与 .eth 管理闭环对齐

---

## 当前 TODO（优先级排序）

```
🔴 P0 — 主网上线阻塞
  D4  主网部署（OP Mainnet L2RecordsV3 + OffchainResolver + ENS resolver 更新）

🟡 P1 — 近期
  D6  多根域名支持（forest.aastar.eth 等，提升优先级）
  C3  Bedrock 状态证明实际实现（跟随 ENS V2 规范进度）
  C4  Gateway 返回真实 eth_getProof + OPResolver 链上验证

🟢 P2 — 有时间再做
  D5  Worker EOA 密钥轮换
  D7  Rate Limiting 升级（有实际滥用问题再做）
  NFT marketplace 集成（OpenSea metadata）
```

---

## 主网最短路径

```
v0.5.1（当前，合约 21KB 可部署）
   │
   └── D4: 主网部署 ──→ 上线
         │
         ├── D6: 多根域名（上线后迭代）
         └── C3/C4: 状态证明（跟进 ENS V2）
```

---

## 依赖关系

```
CometENS 路径                  ENS V2 对应
─────────────────────────────────────────────
L2Records (里程碑A) ──────▶  L2 存储验证
OffchainResolver (里程碑A) ──▶  可信签名（过渡态）
OPResolver (里程碑C) ─────▶  状态证明（V2 标准）
ERC-721 子域 (里程碑B) ───▶  Per-name Registry
```

---

## 测试覆盖矩阵

| 里程碑 | Foundry | TS Unit | E2E | Integration | 安全审计 |
|--------|---------|---------|-----|-------------|----------|
| A / A+ | ✅ 109 | ✅ 21 | ✅ 16 | ✅ 8 | ✅ 3轮 Codex |
| B (B1/B4) | ✅ 40 | ✅ 16 | ✅ 4 | — | ✅ Codex |
| C (C1/C2) | ✅ 20 | — | — | — | — |
| D (D3) | — | — | — | — | — |
