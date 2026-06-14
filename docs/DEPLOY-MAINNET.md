# CometENS 主网部署 Runbook (v0.6.0)

> ⚠️ 根目录的 `DEPLOY.md` 主网章节是旧架构(V1 `L2Records`)，已过时，**以本文档为准**。

---

## 🎯 解析策略(先读这一节)

CometENS 采用**按记录年龄组合两种模式**的策略,**刻意绕开昂贵的乐观证明路径**(详见 [README · Resolution Modes](../README.md#resolution-modes--what-users-get-and-who-you-trust)):

| 记录年龄 | 路径 | 上线优先级 |
|---|---|---|
| **新记录(< ~7 天)** | **签名模式**(即时) | 🔴 上线必备 |
| **老记录(≥ ~7 天)** | **终结证明模式**(`MIN_AGE_SEC=0`,快且去信任) | 🟡 去信任增强,可后置 |

**关键含义,影响下面怎么部署:**
- **上线走签名模式**:部署 `OffchainResolver`(签名版),`aastar.eth` 指向它,gateway 开签名模式(`PROOF_MODE=false`,用 `PRIVATE_KEY_SUPPLIER` 签名)。即时解析所有记录。这是 P0。
- **去信任层走终结证明**:之后(或同时)部署 `OPResolver` + verifier,gateway `PROOF_MODE=true` 且 **`MIN_AGE_SEC=0`(终结,不是乐观的 3600)**。只对 ≥7 天的记录有效,但又快又去信任,无需任何 index/预热基建。
- **不要用 `MIN_AGE_SEC > 0`(乐观)**:它是唯一有冷启动性能坑(~15s 验证循环)且信任更弱的路径,本方案已弃用。

> 下面的 Step 1–7 是**证明模式(去信任层)**的部署。**签名模式上线**更简单:部署 `OffchainResolver`(签名)代替 Step 2 的 OPResolver stack,gateway 设 `PROOF_MODE=false` + `PRIVATE_KEY_SUPPLIER` secret,其余(L2RecordsV3、registrar、ENS setResolver、前端)相同。

---

## 架构回顾(部署什么、为什么)

```
DApp/钱包 → L1 ENS(aastar.eth) → OPResolver(主网 L1)
                                      │ resolve() 触发 CCIP-Read
                                      ▼
                          Gateway Worker(/{sender}/{data})
                                      │ 用 @unruggable/gateways 生成
                                      │ OP Bedrock 存储证明
                                      ▼
                          L2RecordsV3(OP Mainnet)读记录
                                      │
                                      ▼
                  OPResolver 在 L1 用 OPFaultVerifier 验证证明 → 返回记录
```

- **无 Gateway 私钥信任**:L1 上 `OPFaultVerifier` 验证 Merkle 证明，gateway 只是证明搬运工。
- 写路径(注册/改记录)仍由 `cometens-api` worker 的 **Worker EOA** 提交 L2 交易。

---

## Step 0 — 部署前决策与准备(必须先确认)

### 0.1 关键决策 ⚠️(部署前必须定)

| 决策 | 选项 | 建议 |
|------|------|------|
| **`MIN_AGE_SEC`**(OPResolver) | `0` = **仅接受已终结(DEFENDER_WINS)的 game** → 最去信任,但最陈旧(OP 主网 game 终结约 3.5 天,新记录要数天后才可解析);`>0` = 接受**已达 minAgeSec 且未被挑战**的 game(即便未终结) → 更新鲜(只等 minAgeSec),代价是信任"窗口内无人挑战" | 见文末 [MIN_AGE_SEC 决策详解](#附minagesec--windowsec-决策详解)。**注意与 `WINDOW_SEC` 联动**:windowSec 必须 ≥ 你接受的 game 相对最新 game 的滞后,否则 `CommitTooOld` 报错。 |
| **L2RecordsV3 owner** | 部署者 EOA / Gnosis Safe 多签 | **建议多签**(DEPLOY.md 安全要求:Owner 极高)。owner 控制 registrar 增删。 |
| **Worker EOA 角色** | owner 本身 / 被 addRegistrar 授权的热钱包 | **建议独立热钱包 + addRegistrar**，与高价值 owner 分离。 |
| **根域名** | `aastar.eth` / 其他 | 确认你在**主网**(非 Sepolia)拥有 `aastar.eth` 控制权 |

### 0.2 资金(主网真金)
- Ethereum Mainnet:合约部署(OPResolver stack，~0.05 ETH) + ENS setResolver 交易(~0.005 ETH)
- Optimism Mainnet:L2RecordsV3 部署(~0.001 ETH) + addRegistrar(~0.0005 ETH)
- 建议预备 **0.15 ETH(L1)+ 0.02 ETH(OP)**

### 0.3 密钥(4 把，见 DEPLOY.md §密钥安全)
| 密钥 | 用途 | 存储 |
|------|------|------|
| Deployer | 部署合约 | 硬件钱包，部署后即可冷藏 |
| Owner | L2RecordsV3 / OPResolver owner | **Gnosis Safe 多签** |
| Worker EOA (Relayer) | 提交 L2 注册交易 | Cloudflare Secret |
| Supplier(可选) | 签名模式回退(证明模式不需要) | Cloudflare Secret |

### 0.4 RPC
- L1 主网:`ETH_RPC_URL`(Alchemy/Infura，需归档节点支持 `eth_getProof`)
- L2 主网:`OP_RPC_URL = https://mainnet.optimism.io`(或付费节点，证明生成对 RPC 压力较大，建议付费)

### 0.5 工具
```bash
pnpm install
git submodule update --init
cd contracts && forge install && forge build   # 确认编译通过
cd workers/gateway && pnpm install              # 证明模式依赖 @unruggable/gateways
```

---

## Step 1 — 部署 L2RecordsV3 到 Optimism Mainnet

```bash
cd contracts
export DEPLOYER_ADDRESS=0x...        # 部署者地址(将成为初始 owner)
export OP_RPC_URL=https://mainnet.optimism.io

forge script script/DeployL2RecordsV3.s.sol \
  --rpc-url $OP_RPC_URL \
  --broadcast --verify \
  --chain-id 10 \
  --private-key $DEPLOYER_KEY

# 记录输出:
#   L2RecordsV3 deployed at: 0x____  ← 记为 L2_MAINNET
```

**验证**:
```bash
cast call $L2_MAINNET "owner()(address)"  --rpc-url $OP_RPC_URL   # = DEPLOYER_ADDRESS
cast call $L2_MAINNET "name()(string)"    --rpc-url $OP_RPC_URL   # ERC-721 名称
```

> 若 owner 要用多签:部署后调用 `transferOwnership(safeAddr)`(由 DEPLOYER_KEY 签)。注意 transfer 后续 registrar 管理需走多签。

---

## Step 2 — 部署 OPResolver stack 到 Ethereum Mainnet

### 2.1 ⚠️ 先复核主网 AnchorStateRegistry(血泪教训，roadmap.md:115)

```bash
# 从 gateway 实际依赖的库里读主网 ASR —— 不要直接抄下面的值
grep -A4 "mainnetConfig" \
  workers/gateway/node_modules/@unruggable/gateways/dist/cjs/op/OPFaultRollup.cjs \
  | grep AnchorStateRegistry
# 截至库版本 20251205,主网值 = 0x23B2C62946350F4246f9f9D027e071f0264FD113
# OP Stack 升级后地址会变;以你机器上库的实际输出为准。
# Gateway 的 mainnetConfig 与 OPFaultVerifier 必须用同一个 ASR,否则证明永远验证失败。
```

### 2.2 部署

```bash
cd contracts
export DEPLOYER_ADDRESS=0x...
export GATEWAY_URL=https://cometens-gateway-production.<your-subdomain>.workers.dev/{sender}/{data}
export L2_RECORDS_ADDRESS=$L2_MAINNET                                  # Step 1 的地址
export ANCHOR_STATE_REGISTRY=0x23B2C62946350F4246f9f9D027e071f0264FD113  # Step 2.1 复核后的值
export MIN_AGE_SEC=0          # 【已选定:终结证明】只对已终结状态出证明,快且去信任。新记录的即时解析由签名模式覆盖。详见文末附录
export WINDOW_SEC=604800      # 终结 game 滞后 ~7 天,窗口需 >= 7 天
export ETH_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY

forge script script/DeployOPResolver.s.sol \
  --rpc-url $ETH_RPC_URL \
  --broadcast --verify \
  --chain-id 1 \
  --private-key $DEPLOYER_KEY

# 记录输出(脚本会打印):
#   EthVerifierHooks / OPFaultGameFinder / OPFaultVerifier / OPResolver
#   ← OPResolver 记为 OP_RESOLVER_MAINNET
```

> 脚本会提示 "AnchorStateRegistry used: ..." —— 再次核对它与 2.1 一致。
> `GATEWAY_URL` 这里先用预期的 production worker URL;Step 4 部署 worker 后确认一致(若用自定义域名，填自定义域名)。

---

## Step 3 — 授权 Worker EOA 为 registrar(L2RecordsV3 上)

Worker EOA 要能代用户写注册，必须是 owner 或被授权的 registrar。建议用独立热钱包 + addRegistrar:

```bash
export ROOT_NODE=$(cast namehash aastar.eth)
export WORKER_EOA=0x...        # cometens-api 的 Worker EOA 地址
export QUOTA=1000000           # 该 registrar 可注册数量(按需)
export EXPIRY=0                # 0 = 永不过期

# 由 owner(若已转多签则走 Safe)调用
cast send $L2_MAINNET \
  "addRegistrar(bytes32,address,uint256,uint256)" \
  $ROOT_NODE $WORKER_EOA $QUOTA $EXPIRY \
  --rpc-url $OP_RPC_URL --private-key $OWNER_KEY

# 多根域名(如 forest.aastar.eth)各自再 addRegistrar 一次,parentNode 换成对应 namehash
```

> 若 owner 与 Worker EOA 是同一把 EOA，可跳过本步(owner 天然可注册)，但安全性较低。

---

## Step 4 — 配置并部署 Cloudflare Workers(production)

### 4.1 创建主网 KV namespaces(production 段当前是注释占位)

```bash
cd workers/api
wrangler kv namespace create REGISTRY --env production
wrangler kv namespace create RECORD_CACHE --env production
# 记录返回的 id,填入 workers/api/wrangler.toml [env.production] 的 kv_namespaces(取消注释)
# gateway 复用同一个 RECORD_CACHE id —— 把该 id 也填到 workers/gateway/wrangler.toml production 段
```

### 4.2 更新 `workers/gateway/wrangler.toml` [env.production]
```toml
[env.production.vars]
NETWORK = "op-mainnet"
L2_RECORDS_ADDRESS = "0x____"          # = L2_MAINNET (Step 1)
ROOT_DOMAIN = "aastar.eth"
PROOF_MODE = "true"                     # ← 取消注释,启用证明模式
ALLOWED_SENDERS = "0x____"              # = OP_RESOLVER_MAINNET (Step 2)
```

### 4.3 更新 `workers/api/wrangler.toml` [env.production]
```toml
[env.production.vars]
NETWORK = "op-mainnet"
L2_RECORDS_ADDRESS = "0x____"          # = L2_MAINNET
ROOT_DOMAIN = "aastar.eth"
ROOT_DOMAINS = "aastar.eth,forest.aastar.eth"   # 多根可选
```

### 4.4 部署 + 设置 secrets
```bash
# Gateway(证明模式:需要 L1 + L2 RPC,不需要签名私钥)
cd workers/gateway
wrangler deploy --env production
wrangler secret put ETH_RPC_URL --env production   # L1 主网归档 RPC
wrangler secret put OP_RPC_URL  --env production    # L2 主网 RPC

# API(写路径)
cd ../api
wrangler deploy --env production
wrangler secret put WORKER_EOA_PRIVATE_KEY  --env production   # Step 3 的 registrar 热钱包
wrangler secret put OP_RPC_URL              --env production
wrangler secret put UPSTREAM_ALLOWED_SIGNERS --env production   # /v1/register 白名单(逗号分隔)
# PRIVATE_KEY_SUPPLIER 仅签名模式回退需要;纯证明模式可不设
```

---

## Step 5 — 设置主网 ENS aastar.eth resolver → OPResolver

⚠️ 不可逆的链上操作，由 aastar.eth 主网 owner 执行。

```bash
export ENS_REGISTRY=0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e   # 主网 ENS Registry
export ROOT_NODE=$(cast namehash aastar.eth)

cast send $ENS_REGISTRY \
  "setResolver(bytes32,address)" \
  $ROOT_NODE $OP_RESOLVER_MAINNET \
  --rpc-url $ETH_RPC_URL --private-key $OWNER_KEY

# 多根域名各自 setResolver 到同一个 OPResolver(OPResolver 与具体 name 无关)
```

**验证**:
```bash
cast call $ENS_REGISTRY "resolver(bytes32)(address)" $ROOT_NODE --rpc-url $ETH_RPC_URL
# 应返回 OP_RESOLVER_MAINNET
```

---

## Step 6 — 前端配置(主网)

`.env.local` / 部署平台环境变量:
```
VITE_NETWORK=op-mainnet
VITE_ROOT_DOMAIN=aastar.eth
VITE_L2_RECORDS_ADDRESS=0x____          # L2_MAINNET
VITE_L1_OFFCHAIN_RESOLVER_ADDRESS=0x____ # OP_RESOLVER_MAINNET
VITE_GATEWAY_URL=https://cometens-gateway-production.<sub>.workers.dev
VITE_API_URL=https://cometens-api-production.<sub>.workers.dev
VITE_L2_RPC_URL=https://mainnet.optimism.io
VITE_L1_MAINNET_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
```
```bash
pnpm build   # 产出生产前端
```

---

## Step 7 — 部署后端到端验证

```bash
# 1. Gateway 健康
curl https://cometens-gateway-production.<sub>.workers.dev/health
#   期望 network=op-mainnet

# 2. 注册一个测试子域(走 api worker /v1/register 或前端)，等 L2 交易确认

# 3. 证明模式解析(关键 —— 验证去信任路径打通)
#    用主网 RPC 通过 ENS Universal Resolver 解析 <test>.aastar.eth 的 addr
cast resolve-name <test>.aastar.eth --rpc-url $ETH_RPC_URL    # 若 cast 版本支持
#    或用 viem/ethers 脚本走 UniversalResolver.resolve()
#    成功返回地址 = 证明模式 end-to-end PASS(对应测试网 5df883c)
```

> 证明模式首次解析可能因 dispute game 成熟度/`MIN_AGE_SEC` 有延迟。若 `MIN_AGE_SEC` 设得较大，新写入的记录要等对应 L2 区块进入一个足够成熟的 game 才能被证明。

---

## 回滚 / 应急

```bash
# 切回签名模式(临时):gateway wrangler.toml PROOF_MODE=false + 设 PRIVATE_KEY_SUPPLIER,
#   并把 aastar.eth resolver 指向一个签名模式 OffchainResolver(需另行部署)
# 紧急切换 resolver:
cast send $ENS_REGISTRY "setResolver(bytes32,address)" $ROOT_NODE $BACKUP_RESOLVER \
  --rpc-url $ETH_RPC_URL --private-key $OWNER_KEY
# OPResolver 可换 verifier 而不换 resolver:
cast send $OP_RESOLVER_MAINNET "setVerifier(address)" $NEW_VERIFIER \
  --rpc-url $ETH_RPC_URL --private-key $OWNER_KEY
```

---

## 地址记录表(部署时填写)

| 项 | 地址 | 网络 |
|----|------|------|
| L2RecordsV3 | `0x____` | OP Mainnet (10) |
| EthVerifierHooks | `0x____` | Ethereum Mainnet (1) |
| OPFaultGameFinder | `0x____` | Ethereum Mainnet (1) |
| OPFaultVerifier | `0x____` | Ethereum Mainnet (1) |
| OPResolver | `0x____` | Ethereum Mainnet (1) |
| AnchorStateRegistry(库提供) | `0x23B2C62946350F4246f9f9D027e071f0264FD113`(部署时复核) | Ethereum Mainnet (1) |
| Worker EOA (registrar) | `0x____` | — |
| L2RecordsV3 owner | `0x____`(建议 Safe) | — |

---

## 参考(测试网 C3' 已部署，作对照模板)

| 项 | 测试网地址 |
|----|-----------|
| L2RecordsV3 (OP Sepolia) | `0x8836E89D654141a858f680e995CA86f6644A29a5` |
| OPResolver (Eth Sepolia) | `0x9070d42C9C12333053565e7ee8c4BdDE9Ca73083` |
| AnchorStateRegistry (Sepolia) | `0xa1Cec548926eb5d69aa3B7B57d371EdBdD03e64b` |
| Gateway | `https://cometens-gateway.jhfnetboy.workers.dev` |
| API | `https://cometens-api.jhfnetboy.workers.dev` |

---

## 附:`MIN_AGE_SEC` + `WINDOW_SEC` 决策详解

### 机制(源码 `OPFaultGameFinder.sol::_isGameUsable`)

OP 是 Optimistic Rollup:L2 状态通过 **FaultDisputeGame** 提交到 L1,提议的 output root 要经过挑战期才"终结"。OPResolver 通过 gateway 取某个 game 的存储证明,在 L1 验证。`MIN_AGE_SEC` 决定**接受哪种成熟度的 game**:

```
if (minAgeSec > 0) {
    若 game 年龄 < minAgeSec        → 拒绝(太新)
    若 game 已达 minAgeSec 且未被挑战 → 接受(即便尚未终结)
}
否则 → 要求 game 状态 == DEFENDER_WINS(已终结/防御方胜)
```

- **`MIN_AGE_SEC = 0`**:跳过年龄判断,直接要求 game **已终结(DEFENDER_WINS)**。
  - 信任:最高(完全去信任——output root 已扛过挑战期)。
  - 新鲜度:最差。OP 主网 game 终结约 **3.5 天**(MAX_CLOCK_DURATION),意味着**用户新注册的子域名要约 3.5 天后才能被解析**。
- **`MIN_AGE_SEC > 0`(如 1~6 小时)**:接受年龄 ≥ minAgeSec 且**未被挑战**的 game,即使还没终结。
  - 信任:较弱——赌"在 minAgeSec 窗口内不会出现有效挑战"。OP 主网当前为 permissionless 提议 + 看门人挑战,欺诈 root 通常会被快速挑战,但不是零风险。
  - 新鲜度:好。新记录只需等 minAgeSec(几小时)即可解析。

### `WINDOW_SEC` 的联动(源码 `AbstractVerifier.sol::_checkWindow`)

```
if (被验证 game 的时间 + WINDOW_SEC < 最新 game 的时间) revert CommitTooOld
```

它限制 gateway 取的 game 相对最新 game 的滞后上限(防止 gateway 用过旧但合法的状态)。**关键**:它必须 ≥ 你按 `MIN_AGE_SEC` 策略所接受 game 的滞后:
- `MIN_AGE_SEC = 0`(终结 game 滞后 ~3.5 天)→ `WINDOW_SEC` 需 ≥ 约 7 天(`604800`),否则合法的终结 game 会被判 `CommitTooOld`。
- `MIN_AGE_SEC = 几小时` → 接受的 game 接近最新,`WINDOW_SEC = 86400`(1 天)足够。

### 三种取值对照(供决策)

| 取值 | MIN_AGE_SEC | WINDOW_SEC | 证明可覆盖的记录 | 信任模型 | 性能 |
|------|:-----------:|:----------:|:----------------:|----------|------|
| **✅ 终结证明(已选定)** | `0` | `604800` | ≥ ~7 天的记录 | **零信任**(仅终结状态) | **快**(锚定根直接有效,无验证循环) |
| 乐观(已弃用) | `>0` | `86400` | 新记录也可 | 赌窗口内无挑战 | **慢**(~15s 验证循环,worker 超时)|

**为什么选 `0`(终结):** 新记录的即时解析由**签名模式**负责(见顶部策略),所以证明模式无需追求"新记录也能证明"。把证明模式定位成"老记录的去信任层",用 `MIN_AGE_SEC=0` 即可——它**没有乐观路径那个冷启动性能坑**,也无需 index 服务或缓存预热。两全其美。

> 测试网用 `MIN_AGE_SEC=0`/`WINDOW_SEC=86400` 能跑通,是因为 **OP Sepolia 的 game 终结远快于主网**,滞后落在 1 天窗口内。主网照搬 `0`/`86400` 会因终结 game 太老而 `CommitTooOld` 解析失败——这是主网必须重新决策这两个值的根本原因。

> **建议**:CometENS 是面向普通用户的注册服务,数天延迟的 UX 不可接受。推荐**均衡档(`MIN_AGE_SEC=3600`,`WINDOW_SEC=86400`)**:利用 OP 主网活跃的挑战者,新名字约 1 小时生效。若你的优先级是"哪怕牺牲 UX 也要绝对去信任",再选 `0`/`604800`。
