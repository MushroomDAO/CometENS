# CometENS 开发路线图

## 当前状态（2026-04-03 / v0.4.0）

| 里程碑 | 名称 | 状态 | Tag |
|--------|------|------|-----|
| **A** | 可信签名 MVP | ✅ 完成 | v0.3.0 |
| **A+** | 多签名者 OffchainResolver | ✅ 完成 | v0.3.0 |
| **v0.4.0** | Production API Server + Security Hardening | ✅ 完成 | v0.4.0 |
| **B** | NFT 子域 + Registrar 插件 | 🟡 进行中 | — |
| **C** | 状态证明（ENS v2） | 📋 计划中 | — |
| **D** | 生产强化（DO / Rate limit / 监控 / 主网） | 📋 计划中 | — |
| **E** | .box 写路径 | ⏳ 外部依赖 | — |

---

## 已完成（v0.4.0）

**合约（OP Sepolia 测试网）**
| 合约 | 地址 |
|---|---|
| L2RecordsV2 | `0x7E9840717CeD353eF5C6CE13673594e8bE4B5c5e` |
| OffchainResolver | `0xe138Ec90E6a793F69455a45cF78494c7baFd1A1b` |

**Cloudflare Workers（测试网）**
| Worker | URL |
|---|---|
| Gateway (CCIP-Read) | https://cometens-gateway.jhfnetboy.workers.dev |
| API | https://cometens-api.jhfnetboy.workers.dev |

### v0.4.0 功能清单
- [x] `cometens-api` CF Worker：全量 EIP-712 写端点（register/set-addr/set-text/set-contenthash/add-registrar/remove-registrar）
- [x] CF KV 边缘缓存：addr/text/contenthash 读取 <5ms（vs 链上 ~200ms）
- [x] 纯前端构建：vite.config.ts 精简到 17 行
- [x] Admin 页面：Query/Remove Registrar + Set Contenthash
- [x] ABI 单一来源（contracts/abi/L2RecordsV2.json）
- [x] 3 轮 Codex 安全审计，全部问题修复
- [x] 测试：109 Foundry + 21 unit + 16 e2e + 8 integration（全绿）
- [x] `aastar.eth` Sepolia ENS resolver 已更新

---

## Milestone B — NFT 子域 + Registrar 插件

**目标**：子域名 NFT 化，Registrar 可扩展插件架构。

| 编号 | 任务 | 优先级 |
|------|------|--------|
| B1 | L2RecordsV3 合约 — ERC-721 子域所有权（tokenId = uint256(node)） | 🔴 P0 |
| B2 | Registrar 插件接口 — IRegistrarPlugin（定价/白名单/Token Gate） | 🔴 P0 |
| B3 | V2 → V3 数据迁移脚本（事件回放，幂等） | 🔴 P0 |
| B4 | 前端适配：NFT 展示 + 转让 UI + /transfer-subnode API 端点 | 🟡 P1 |
| B5 | Foundry 测试：ERC-721 接口、转让、approve、插件场景 | 🔴 P0 |

**预计产出**：子域名可在 OpenSea/NFT 钱包中看到，Registrar 可自定义注册规则。

---

## Milestone C — 状态证明（ENS v2 标准路径）

**目标**：用 Bedrock storage proof 替代 Gateway 私钥签名，实现信任最小化。

| 编号 | 任务 | 优先级 |
|------|------|--------|
| C1 | OPResolver 合约（替代 OffchainResolver，实现 EVMFetcher 接口） | 🔴 P0 |
| C2 | Gateway Worker 支持证明模式（返回 Merkle storage proof） | 🔴 P0 |
| C3 | L1 链上验证 OP 状态根（无需信任 Gateway 私钥） | 🔴 P0 |
| C4 | 签名模式与证明模式并存（PROOF_MODE env 切换） | 🟡 P1 |
| C5 | 集成测试：本地 Anvil 双链证明验证端到端 | 🔴 P0 |

**参考**：`vendor/unruggable-gateways/`、`eval/unruggable-gateways/`

---

## Milestone D — 生产强化

**目标**：主网上线就绪，解决剩余 Codex 遗留问题，完善可观测性。

| 编号 | 任务 | 优先级 |
|------|------|--------|
| D1 | Durable Objects nonce store（替代 KV TOCTOU 竞态） | 🔴 P0 |
| D2 | Rate limiting（CF Rate Limiting API，按 IP + from 地址） | 🔴 P0 |
| D3 | 监控告警（CF Analytics Engine + 错误率告警） | 🟡 P1 |
| D4 | 主网部署（OP Mainnet + 主网 ENS aastar.eth resolver 更新） | 🔴 P0 |

---

## Milestone E — .box 写路径

- 依赖 my.box 官方 API 开放，跟进后接入

---

## 依赖关系与主网最短路径

```
v0.4.0（当前）
   │
   ├── Milestone D（D1+D2 可先做，不依赖 B/C）
   │     D1: Durable Objects nonce
   │     D2: Rate limiting
   │     D4: 主网部署（需要 D1+D2 完成）
   │
   ├── Milestone B（NFT 子域，可与 D 并行）
   │     B1 → B2 → B3 → B4
   │
   └── Milestone C（状态证明，可与 B/D 并行研发）
         C1 → C2 → C3 → C4

主网上线最短路径（仅需 D1+D2+D4）：
  v0.4.0 → D1（DO nonce）→ D2（Rate limit）→ D4（主网部署）

B/C 可主网上线后继续迭代。
```

---

## 测试覆盖矩阵

| 里程碑 | Foundry | TS Unit | E2E | Integration | 安全审计 |
|--------|---------|---------|-----|-------------|----------|
| v0.4.0 | ✅ 109 | ✅ 21 | ✅ 16 | ✅ 8 | ✅ 3轮 Codex |
| B | 🔴 需补充 | 🟡 | 🟡 | — | — |
| C | 🔴 需补充 | — | 🔴 | 🔴 | — |
| D | — | 🟡 | — | 🟡 | — |
