# CometENS 开发路线图

## 当前状态（2026-04-04 / v0.5.0）

| 里程碑 | 名称 | 状态 | Tag |
|--------|------|------|-----|
| **A** | 可信签名 MVP | ✅ **已完成** | v0.3.0 |
| **A+** | Production API Server + Security Hardening | ✅ **已完成** | v0.4.0 |
| **B** | Name Wrapper + NFT 子域 | ✅ **已完成（B1/B2/B4）** | v0.5.0 |
| **C** | 状态证明（ENS V2 标准） | 🟡 **脚手架完成（C1/C2）** | v0.5.0 |
| **D** | 生产强化与治理 | 🟡 **进行中（D1/D2/D3 ✅，D4 deferred）** | v0.5.0 |
| E | .box 写路径 | ⏳ 待官方开放 | — |

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

**遗留已知限制（Milestone D 解决）**：
- KV nonce TOCTOU（需 Durable Objects）
- nonce 在 tx 前消费（已知 UX 权衡）

---

## 里程碑 B：Name Wrapper + NFT 子域 ✅（v0.5.0）

**目标**：子域名成为真正的 ERC-721 NFT，可转让、可交易；Registrar 可插拔插件架构。

| 任务 | 内容 | 优先级 | 状态 |
|------|------|--------|------|
| B1 | L2RecordsV3 合约：ERC-721 子域所有权（tokenId = uint256(node)） | 🔴 P0 | ✅ 完成 |
| B2 | Registrar 插件接口：IRegistrarPlugin + FreePlugin/WhitelistPlugin/FlatFeePlugin | 🔴 P0 | ✅ 完成 |
| B4 | 前端适配：NFT 转让 UI + /transfer-subnode API 端点 | 🟡 P1 | ✅ 完成 |

**已完成合约**：`contracts/src/L2RecordsV3.sol`、`contracts/src/IRegistrarPlugin.sol`、`contracts/src/plugins/`

**遗留**：
- B3（L2Records → V3 数据迁移脚本）— 未实现，主网部署前需要
- NFT marketplace 集成、链上 metadata — 未计划

---

## 里程碑 C：状态证明（ENS V2 标准路径）🟡 脚手架完成

**目标**：用 Bedrock 状态证明替代 Gateway 签名，实现信任最小化。

| 任务 | 内容 | 优先级 | 状态 |
|------|------|--------|------|
| C1 | OPResolver 合约（替代 OffchainResolver，`verifyProofs` flag） | 🔴 P0 | ✅ 完成（脚手架） |
| C2 | Gateway Worker 支持证明模式（PROOF_MODE + DEV_MODE 双 guard，返回 501 stub） | 🔴 P0 | ✅ 完成（stub） |
| C3 | L1 链上验证 OP 状态根（Bedrock Merkle proof 实际验证）| 🟡 P1 | 📋 待实现 |
| C4 | Gateway 实际返回 eth_getProof 结果，OPResolver 链上验证 | 🟡 P1 | 📋 待实现 |

**参考**：`vendor/unruggable-gateways/`、`eval/unruggable-gateways/`

**背景**：C1/C2 脚手架已就位，PROOF_MODE 可安全切换；C3/C4 是真正的去信任化实现，是 ENS V2 的标准方向。

---

## 里程碑 D：生产强化与治理 🟡 进行中

**目标**：达到生产级安全与可运维标准，解决 v0.4.0 遗留问题。

| 任务 | 内容 | 优先级 | 状态 |
|------|------|--------|------|
| D1 | Durable Objects nonce store（消除 KV TOCTOU 竞态，`blockConcurrencyWhile` 原子化）| 🔴 P0 | ✅ 完成 |
| D2 | Rate limiting（KV 滑动窗口，写 10/min，v1 60/min，best-effort）| 🔴 P0 | ✅ 完成（best-effort） |
| D3 | 监控告警（CF Analytics Engine + `/health` timestamp）| 🟡 P1 | ✅ 完成 |
| D4 | 主网部署（OP Mainnet + 主网 ENS aastar.eth resolver 更新）| 🔴 P0 | ⏳ deferred |
| D5 | Worker EOA 密钥轮换方案 | 🟡 P1 | 📋 待实现 |
| D6 | 多实例 / 多根域名支持 | 🟢 P2 | 📋 待实现 |
| D7 | Rate limiting 升级（CF 原生 Rate Limiting 或 DO per key，解决多 PoP 并发绕过）| 🟡 P1 | 📋 待实现 |

---

## 里程碑 E：.box 写路径（依赖官方）

**目标**：接入 my.box 写入能力（当前仅只读展示）。

- E1 跟进 my.box 官方 API/授权接口开放情况
- E2 与 .eth 管理闭环对齐

---

## 依赖关系与主网最短路径

```
v0.4.0（当前）
   │
   ├── Milestone D（D1+D2 可先做，不依赖 B/C）
   │     D1: Durable Objects nonce  ──┐
   │     D2: Rate limiting          ──┤→ D4: 主网部署
   │
   ├── Milestone B（NFT 子域，可与 D 并行）
   │     B1（ERC-721合约）→ B2（插件架构）→ B4（前端）
   │
   └── Milestone C（状态证明，可与 B/D 并行研发）
         C1（OPResolver）→ C2（Gateway proof）→ C3（L1验证）

主网上线最短路径：
  v0.4.0 → D1 → D2 → D4（主网上线，B/C 主网后迭代）

执行顺序（当前计划）：
  D1 → D2 → B1 → B2 → C1 → C2
```

---

## 参考：ENS V2 路径对应

```
CometENS 路径                  ENS V2 对应
─────────────────────────────────────────────
L2Records (里程碑A) ──────▶  L2 存储验证
OffchainResolver (里程碑A) ──▶  可信签名（过渡态）
OPResolver (里程碑C) ─────▶  状态证明（V2 标准）
Name Wrapper (里程碑B) ───▶  Per-name Registry
Fuse 烧断 (里程碑D) ──────▶  不可变信任根
```

---

## 测试覆盖矩阵

| 里程碑 | Foundry | TS Unit | E2E | Integration | 安全审计 |
|--------|---------|---------|-----|-------------|----------|
| A / A+ | ✅ 109 | ✅ 21 | ✅ 16 | ✅ 8 | ✅ 3轮 Codex |
| B | 🔴 需补充 | 🟡 | 🟡 | — | — |
| C | 🔴 需补充 | — | 🔴 | 🔴 | — |
| D | — | 🟡 | — | 🟡 | — |
