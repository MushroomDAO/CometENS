# CometENS 开发路线图

## 当前状态（2026-09-04 / v0.7.0）

> ⚠️ **当前仅测试网**（OP Sepolia + Ethereum Sepolia）。主网未上线，且**本轮不做** ——
> 用户 2026-09 明确当前阶段只提供测试网部署与测试地址。

| 里程碑 | 名称 | 状态 | Tag |
|--------|------|------|-----|
| **A** | 可信签名 MVP | ✅ **已完成** | v0.3.0 |
| **A+** | Production API Server + Security Hardening | ✅ **已完成** | v0.4.0 |
| **B** | Name Wrapper + NFT 子域（B1/B4） | ✅ **已完成** | v0.5.0 |
| **C** | 状态证明（ENS V2 标准） | ✅ **C3/C4 完成** | v0.6.0 |
| **F** | HybridResolver：按记录年龄自动组合签名 / 终局证明 | ✅ **已完成，测试网 E2E 通过** | v0.7.0 |
| **D** | 生产强化 | 🟡 **D3 ✅；D4 主网部署推迟到 M2** | v0.5.0 |
| **M1** | 产品化（自部署 / 委托托管 / UI / 申请审批） | 🚧 **进行中，见 `docs/agent/roadmap.md`** | — |
| E | .box 写路径 | ⏳ 待官方开放 | — |

**这份文件与 `docs/agent/roadmap.md` 的分工**：这份记录「技术做到哪」（里程碑 A–F 的历史），
那份记录「产品要去哪」（M1 产品化）。两者不冲突，但**当前全部精力在 M1**。

**测试基线（2026-09-04 实跑）**：Foundry 203 · TS unit 423（19 个文件）。
表尾那张覆盖矩阵是各里程碑**当时**的数字，不是现值。

**里程碑 F — HybridResolver（v0.7.0，本文件此前完全没有记录）**：
L1 解析按记录年龄自动路由 —— 新记录（< ~7 天）走签名模式（即时），
老记录（≥ ~7 天）走终局存储证明（`MIN_AGE_SEC=0`，去信任）。
刻意避开乐观证明路径（`MIN_AGE_SEC > 0`）——它是唯一同时有冷启动开销**和**更弱信任假设的那条。
合约 `contracts/src/HybridResolver.sol`；部署在 Ethereum Sepolia。

**⚠️ 下文各里程碑段落里的合约地址是当时的部署，不是现值。**
现值的唯一事实来源是 `workers/*/wrangler.toml`（`pnpm check:chain` 会读它并核对链上状态）。
例如里程碑 A 的 `0x9Ed5d101…` 早已不是在用的 L2Records —— 那个地址上仍有代码，
所以照着它集成的人不会报错，只会**什么都查不到**。

**ENS V2 影响评估（2026-04）**：ENS V2 = 纯 L1 registry 重写（Namechain 已取消）。CCIP-Read/ERC-3668/IExtendedResolver 接口**完全不变**。CometENS 的 OPResolver + Gateway 零修改可运行，上线后再跟进 V2 subregistry 迁移（可选、一笔交易）。详见 [docs/ensv2-impact-analysis.md](ensv2-impact-analysis.md)。

> ⚠️ **上面这段已被 2026-09 的评估部分取代。** 「接口完全不变 / 零修改可运行」仍然成立;
> 但它没有回答「V2 内置了多少我们正在自己造的东西」——答案是九处,其中包括 M1 验收项 **B2
> 「撤销可验证」至今验收不掉的根因**。迁移方案见 [docs/ENSV2-MIGRATION-PLAN.md](ENSV2-MIGRATION-PLAN.md)。

**注**：B2（插件架构）已删除 — 开源免费项目，单一职责原则，根域名管理足够控制访问。D1（Durable Objects）已删除 — 链上唯一性保证足够。D2（Rate Limiting）已关闭 — EIP-712 鉴权是真正的门卫。

---

## 里程碑 A：可信签名 MVP ✅

**目标**：打通"L2 存储 → Gateway 读取 → L1 CCIP-Read 解析"完整闭环。

> 下表的地址是**里程碑 A 当时**的部署，**不是现值**，早已被取代。照着集成会静默拿到空结果。

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

> 下表是**里程碑 A+ 当时**的部署，**不是现值**。现值见 `workers/*/wrangler.toml`。

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

## 里程碑 C：状态证明（ENS V2 标准路径）✅ v0.6.0

**目标**：用 Bedrock 状态证明替代 Gateway 签名，实现信任最小化。

**背景**：当前系统信任 Gateway EOA 私钥。状态证明使 L1 合约直接验证 OP 链上数据的 Merkle 证明，完全去信任化，是 ENS V2 的设计方向。

| 任务 | 内容 | 优先级 | 状态 |
|------|------|--------|------|
| C1 | OPResolver 合约（C1 脚手架 → C3 实际实现） | 🔴 P0 | ✅ 完成 |
| C2 | Gateway Worker 支持证明模式（C2 stub → C4 真实实现） | 🔴 P0 | ✅ 完成 |
| C3 | OPResolver + unruggable-gateways v1.3.5：GatewayFetchTarget + OPFaultVerifier | 🟡 P1 | ✅ 完成，37 tests |
| C4 | Gateway GET /{sender}/{data}：OPFaultRollup 证明，module-level 单例，sender 白名单 | 🟡 P1 | ✅ 完成 |

**已部署依赖**：
- `contracts/lib/unruggable-gateways` Foundry library (v1.3.5)
- `workers/gateway`: `@unruggable/gateways: 1.3.5` + `ethers: ^6.0.0`
- OP Sepolia AnchorStateRegistry: `0x218CD9489199F321E1177b56385d333c7876e1d3`

**已部署合约（Ethereum Sepolia，2026-04-04 C3' redeploy）**：

> ⚠️ 下表是**里程碑 C 当时**的部署，**不是现值**。限定写在表前而不是表后——
> 读者读完一张表之后才看到"其实这些都过期了"，那句限定已经太晚。

| 合约 | 地址 |
|---|---|
| EthVerifierHooks | `0x68E526600e89aDD227B0912b075E02B394a23DCf` |
| OPFaultGameFinder | `0x21e35d3Ef6511B34C6c0D1e6893c587e8d4420d2` |
| OPFaultVerifier | `0x0954FD2908c06182127b6bed0A964e9eEA41a7EA` |
| OPResolver | `0x9070d42C9C12333053565e7ee8c4BdDE9Ca73083` |

**~~`aastar.eth` 和 `forest.aastar.eth` resolver 均已指向 OPResolver。~~ 这句话现在是错的。**
2026-09-04 链上实测（Sepolia ENS Registry `resolver()`）：

```
aastar.eth         resolver = 0xA54D63a6223B66EDED35286522336e45F21BE512
forest.aastar.eth  resolver = 0xA54D63a6223B66EDED35286522336e45F21BE512
```

两者都指向**里程碑 F 的 HybridResolver**，不是 OPResolver。
这与 `workers/gateway/wrangler.toml` 的 `ALLOWED_SENDERS` 一致。

**⚠️ 经验教训 — AnchorStateRegistry 地址必须从库里读**：
```bash
# 在部署前，先查 @unruggable/gateways 库实际使用的 ASR 地址：
grep "sepoliaConfig" -A5 \
  workers/gateway/node_modules/@unruggable/gateways/dist/cjs/op/OPFaultRollup.cjs \
  | grep AnchorStateRegistry
# 当前值：0xa1Cec548926eb5d69aa3B7B57d371EdBdD03e64b
# 不要从文档/roadmap 里复制旧地址 — OP Stack 升级后地址会变
# Gateway 的 sepoliaConfig 和 OPFaultVerifier 必须使用同一个 ASR，否则证明永远验证失败
```

**部署步骤（以后参考）**：
```bash
# 0. 查 ASR 地址（必须）
ASR=$(grep -A5 "sepoliaConfig" workers/gateway/node_modules/@unruggable/gateways/dist/cjs/op/OPFaultRollup.cjs | grep AnchorStateRegistry | grep -o '0x[0-9a-fA-F]*')
# 1. Set secrets
wrangler secret put ETH_RPC_URL --env testnet   # L1 Sepolia RPC
# 2. Deploy OPResolver stack to Ethereum Sepolia
DEPLOYER_ADDRESS=... GATEWAY_URL=https://cometens-gateway.jhfnetboy.workers.dev/{sender}/{data} \
  L2_RECORDS_ADDRESS=0x7E9840717CeD353eF5C6CE13673594e8bE4B5c5e \
  ANCHOR_STATE_REGISTRY=$ASR \
  forge script contracts/script/DeployOPResolver.s.sol --broadcast --rpc-url $ETH_RPC_URL
# 3. Set aastar.eth + forest.aastar.eth resolver = deployed OPResolver address (on Sepolia ENS)
# 4. Set ALLOWED_SENDERS = deployed OPResolver address in wrangler.toml
# 5. wrangler deploy --env testnet (gateway worker)
```

**参考**：`docs/ensv2-impact-analysis.md`

---

## 里程碑 D：生产强化 🟡 进行中

**目标**：达到生产级安全与可运维标准。

| 任务 | 内容 | 优先级 | 状态 |
|------|------|--------|------|
| D3 | 监控告警（CF Analytics Engine 可选 stub + `/health` timestamp）| 🟡 P1 | ✅ 完成 |
| D4 | 主网部署（OP Mainnet + 主网 ENS aastar.eth resolver 更新）| ⏸ **推迟到 M2** | 本轮不做（用户 2026-09 决定） |
| D5 | Worker EOA 密钥轮换方案 | 🟢 P2 | ✅ **已完成**（`scripts/rotate-gateway-signer.mjs` + `docs/KEY-ROTATION.md`，T1.5.0） |
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
🎯 当前全部精力 — M1 产品化（测试网验收）
  见 docs/agent/tasks.md，逐 task 有验收命令与证据

⏸ 推迟到 M2 — 主网
  D4  主网部署（OP Mainnet L2RecordsV3 + HybridResolver + ENS resolver 更新）
      前置：M1 全部验收通过 + 主网参数评审

🟡 P1 — 近期
  D6  多根域名支持（ROOT_DOMAINS 配置已具备，端到端流程与文档缺失）

🟢 P2 — 有时间再做
  D7  Rate Limiting 升级（有实际滥用问题再做）
  NFT marketplace 集成（OpenSea metadata）

✅ 本轮已完成而此前列在待办里的
  D5  Worker EOA 密钥轮换 → T1.5.0
  C3' OPResolver 测试网验证 → 已被里程碑 F 的 HybridResolver E2E 覆盖
```

---

## 主网最短路径

```
v0.7.0（当前：HybridResolver 测试网 E2E 通过）
   │
   └── M1: 产品化 ──→ 任何社区能自部署 / 能委托托管（全部测试网验收）
         │
         └── M2: D4 主网部署 ──→ 上线
               │
               └── D6: 多根域名（上线后迭代）
```

**主网不是下一步，M1 才是。** 把 D4 排在 M1 之前会得到一个上了主网、
但没人能自部署也没人能托管的服务 —— 那正是 2026-09 判断"技术内核接近就绪、
产品化没到"时要避免的。

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
| C (C3/C4) | ✅ 37 | — | — | — | ✅ 2轮 Codex |
| D (D3) | — | — | — | — | — |
| F (Hybrid) | ✅ 含在总数内 | — | ✅ 测试网 E2E | — | ✅ Codex |
| **现值（2026-09-04 实跑）** | **203** | **423** | 需 Anvil | 需 .env.local | 逐 PR 对抗 review |
