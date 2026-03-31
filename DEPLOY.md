# CometENS Deployment Guide

## 目录
- [测试网部署](#测试网部署) - 开发测试环境
- [主网部署清单](#主网部署清单) - 生产环境完整配置
- [域名所有权转让](#域名所有权转让) - ENS 域名管理
- [运维与监控](#运维与监控) - 部署后维护

---

## 测试网部署

### Prerequisites
- Node.js >= 20
- Foundry (`curl -L https://foundry.paradigm.xyz | bash`)
- A wallet with testnet ETH (Sepolia + OP Sepolia)

### 1. Install Dependencies
```bash
pnpm install
git submodule update --init
cd contracts && forge install
```

### 2. Deploy Contracts

#### 2a. Deploy L2Records (OP Sepolia)
```bash
cd contracts
export DEPLOYER_ADDRESS=0x...
export PRIVATE_KEY=0x...
forge script script/DeployL2Records.s.sol \
  --rpc-url $OP_SEPOLIA_RPC_URL \
  --broadcast --verify
```
Note the deployed address → set as OP_L2_RECORDS_ADDRESS

#### 2b. Deploy OffchainResolver (Ethereum Sepolia)
```bash
export SIGNER_ADDRESS=0x...
export GATEWAY_URL=https://cometens-gateway.jhfnetboy.workers.dev
forge script script/DeployOffchainResolver.s.sol \
  --rpc-url $SEPOLIA_RPC_URL \
  --broadcast --verify
```
Note the deployed address → set as L1_OFFCHAIN_RESOLVER_ADDRESS

### 3. Configure Environment

```bash
cp .env.op-sepolia .env.local
# Fill in all values (see comments in .env.op-sepolia)
```

Required vars:
- VITE_ROOT_DOMAIN=aastar.eth
- VITE_L2_RECORDS_ADDRESS=0x...
- VITE_L1_OFFCHAIN_RESOLVER_ADDRESS=0x...
- VITE_GATEWAY_URL=https://cometens-gateway.jhfnetboy.workers.dev
- VITE_L2_RPC_URL=...
- VITE_L1_SEPOLIA_RPC_URL=...
- OP_SEPOLIA_RPC_URL=...
- SEPOLIA_RPC_URL=...
- PRIVATE_KEY_SUPPLIER=0x...
- WORKER_EOA_PRIVATE_KEY=0x...

### 4. Set ENS Resolver on Sepolia
1. Go to https://sepolia.app.ens.domains
2. Register your .eth name (needs Sepolia ETH)
3. Set resolver to: L1_OFFCHAIN_RESOLVER_ADDRESS

### 5. Start Development Server
```bash
pnpm dev
```
Opens on http://localhost:4173

### 6. Run Tests

```bash
# Unit tests (fast, no network)
pnpm vitest run test/unit/

# E2E tests (requires Anvil: brew install foundry)
pnpm vitest run test/e2e/

# Integration tests (requires .env.local with real RPCs)
pnpm vitest run test/integration/
```

### 7. Deploy CCIP Gateway to Cloudflare Workers

The CCIP-Read gateway must be publicly accessible for third-party tools (viem, ethers, ENS app) to resolve subdomains. It is deployed as a Cloudflare Worker.

```bash
cd workers/gateway
pnpm install
wrangler deploy

# Set secrets (never committed to git)
wrangler secret put OP_SEPOLIA_RPC_URL
wrangler secret put PRIVATE_KEY_SUPPLIER
```

**Currently deployed:** `https://cometens-gateway.jhfnetboy.workers.dev`

To add a custom domain, add a route in `workers/gateway/wrangler.toml` and configure DNS in the Cloudflare dashboard. After changing the gateway URL, redeploy the OffchainResolver with the new URL (or call `setGatewayUrl()` if the contract supports it).

### 8. Deployed Contracts (Testnet)

| Contract | Deployed by | Network | Address |
|---|---|---|---|
| L2Records | CometENS | OP Sepolia (11155420) | [`0xf8df7ffd1cefd1226bf0f302120cafd8f6119115`](https://sepolia-optimism.etherscan.io/address/0xf8df7ffd1cefd1226bf0f302120cafd8f6119115) |
| OffchainResolver | CometENS | Ethereum Sepolia (11155111) | [`0x87d97a2e3B334a4b62e1269d02bf4e2b168EbB45`](https://sepolia.etherscan.io/address/0x87d97a2e3B334a4b62e1269d02bf4e2b168EbB45) |
| ENS Registry | ENS Official | Ethereum Sepolia | [`0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e`](https://sepolia.etherscan.io/address/0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e) |
| ENS Universal Resolver | ENS Official | Ethereum Sepolia | [`0x21B000Fd62a880b2125A61e36a284BB757b76025`](https://sepolia.etherscan.io/address/0x21B000Fd62a880b2125A61e36a284BB757b76025) |
| Root Domain | — | Sepolia ENS | `aastar.eth` |

---

## 主网部署清单

### 📋 部署前准备

#### 1. 资金准备
```
所需资金：
├── Ethereum Mainnet ETH (L1)
│   ├── 合约部署: ~0.05 ETH
│   ├── ENS 注册费: ~0.01 ETH/年
│   └── 测试交易: ~0.01 ETH
│
├── Optimism Mainnet ETH (L2)
│   ├── L2Records 部署: ~0.001 ETH
│   └── 后续操作 Gas: ~0.01 ETH
│
└── 总计准备: ~0.1 ETH (建议准备 0.2 ETH)
```

#### 2. 密钥安全
```
需要生成的密钥对：

1. 合约部署者密钥 (Deployer)
   └── 用途：部署 L2Records 和 OffchainResolver
   └── 安全要求：高，建议硬件钱包

2. CCIP 签名者密钥 (Supplier)
   └── 用途：签名 CCIP-Read 响应
   └── 安全要求：中，需要在线

3. Worker EOA 密钥 (Relayer)
   └── 用途：提交 L2 注册交易
   └── 安全要求：中，需要在线

4. 域名管理密钥 (Owner)
   └── 用途：控制 ENS 域名所有权
   └── 安全要求：极高，建议多签

密钥存储建议：
├── Deployer: 硬件钱包，离线存储
├── Supplier: Cloudflare Secrets / AWS KMS
├── Relayer: Cloudflare Secrets / AWS KMS
└── Owner: Gnosis Safe 多签钱包
```

#### 3. 域名准备
```
主网 ENS 域名获取：
1. 访问 https://app.ens.domains
2. 搜索并注册根域名 (如 aastar.eth)
3. 确认注册年限（建议多年）
4. 记录域名到期时间，设置提醒

可选：提前注册二级域名
├── forest.aastar.eth
├── dao.aastar.eth
└── 其他子品牌域名
```

---

### 🔧 主网部署步骤

#### Step 1: 部署 L2Records (Optimism Mainnet)

```bash
cd contracts

# 设置环境
export MAINNET_DEPLOYER_KEY=0x...
export OP_RPC_URL=https://mainnet.optimism.io

# 部署
forge script script/DeployL2Records.s.sol \
  --rpc-url $OP_RPC_URL \
  --broadcast --verify \
  --chain-id 10

# 记录部署地址
export L2_RECORDS_ADDRESS_MAINNET=0x...
```

**部署后验证：**
```bash
# 验证合约所有权
# 在 Optimistic Etherscan 确认部署者地址
```

#### Step 2: 部署 OffchainResolver (Ethereum Mainnet)

```bash
# 设置参数
export MAINNET_SIGNER_ADDRESS=0x...
export MAINNET_GATEWAY_URL=https://gateway.yourdomain.com
export ETH_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY

# 部署
forge script script/DeployOffchainResolver.s.sol \
  --rpc-url $ETH_RPC_URL \
  --broadcast --verify \
  --chain-id 1

# 记录地址
export L1_RESOLVER_ADDRESS_MAINNET=0x...
```

#### Step 3: 配置 ENS Resolver

```bash
# 方式1: 通过 ENS App 手动设置
# 访问 https://app.ens.domains
# 找到你的域名 (如 aastar.eth)
# Settings → Resolver → Set to L1_RESOLVER_ADDRESS_MAINNET

# 方式2: 脚本设置
export ENS_REGISTRY=0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e
export ROOT_NODE=$(cast namehash aastar.eth)

# 调用 setResolver
cast send $ENS_REGISTRY \
  "setResolver(bytes32,address)" \
  $ROOT_NODE \
  $L1_RESOLVER_ADDRESS_MAINNET \
  --rpc-url $ETH_RPC_URL \
  --private-key $OWNER_KEY
```

#### Step 4: 配置 Cloudflare Worker (生产环境)

```bash
cd workers/gateway

# 设置环境变量
export CF_ENV=production

# 部署
wrangler deploy --env production

# 设置 Secrets（生产密钥，永不提交到 git）
wrangler secret put OP_RPC_URL --env production
# 输入: https://mainnet.optimism.io

wrangler secret put PRIVATE_KEY_SUPPLIER --env production
# 输入: 0x...（CCIP 签名者私钥）

wrangler secret put WORKER_EOA_PRIVATE_KEY --env production
# 输入: 0x...（Worker EOA 私钥）

wrangler secret put REGISTRATION_SECRET --env production
# 输入: your-secure-password（注册认证密码）
```

**配置 wrangler.toml：**
```toml
[env.production]
name = "cometens-gateway-production"
[env.production.vars]
NETWORK = "op-mainnet"
L2_RECORDS_ADDRESS = "0x..."  # 主网 L2Records 地址
ROOT_DOMAIN = "aastar.eth"
ALLOWED_REGISTRANTS = ""      # 可选白名单

# 自定义域名
[[env.production.routes]]
pattern = "gateway.yourdomain.com/*"
custom_domain = true
```

#### Step 5: 配置本地环境

```bash
# 创建主网环境文件
cat > .env.local << 'EOF'
# === Network ===
VITE_NETWORK=op-mainnet

# === Contracts ===
VITE_L2_RECORDS_ADDRESS=0x...          # 主网 L2Records
VITE_L1_OFFCHAIN_RESOLVER_ADDRESS=0x... # 主网 Resolver
VITE_ROOT_DOMAIN=aastar.eth

# === RPC ===
VITE_L2_RPC_URL=https://mainnet.optimism.io
VITE_L1_MAINNET_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
OP_MAINNET_RPC_URL=https://mainnet.optimism.io

# === Gateway ===
VITE_GATEWAY_URL=https://gateway.yourdomain.com

# === Keys (本地开发使用) ===
PRIVATE_KEY=0x...                        # 你的私钥
REGISTRATION_SECRET=your-secure-password # 认证密码

# === Server Keys (Vite dev server) ===
PRIVATE_KEY_SUPPLIER=0x...               # CCIP 签名者
WORKER_EOA_PRIVATE_KEY=0x...             # Worker EOA
EOF
```

---

### ✅ 部署后验证

#### 1. 合约验证
```bash
# 验证 L2Records 部署
# Optimistic Etherscan 自动验证（如果使用了 --verify）

# 手动验证 Resolver
cast call $L1_RESOLVER_ADDRESS_MAINNET "owner()" --rpc-url $ETH_RPC_URL
cast call $L1_RESOLVER_ADDRESS_MAINNET "signerAddress()" --rpc-url $ETH_RPC_URL
cast call $L1_RESOLVER_ADDRESS_MAINNET "gatewayUrl()" --rpc-url $ETH_RPC_URL
```

#### 2. ENS 配置验证
```bash
# 查询 Resolver 是否设置正确
export ENS_REGISTRY=0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e
export ROOT_NODE=$(cast namehash aastar.eth)

cast call $ENS_REGISTRY "resolver(bytes32)" $ROOT_NODE \
  --rpc-url $ETH_RPC_URL
# 应该返回: L1_RESOLVER_ADDRESS_MAINNET
```

#### 3. Gateway 健康检查
```bash
# 检查 Gateway 状态
curl https://gateway.yourdomain.com/health

# 预期响应:
# {
#   "status": "ok",
#   "network": "op-mainnet",
#   "rootDomain": "aastar.eth",
#   "registrationEnabled": true
# }
```

#### 4. 端到端测试
```bash
# 注册测试域名
tsx scripts/register-with-auth.ts test-label

# 等待交易确认

# 解析测试
curl -X POST https://gateway.yourdomain.com/api/ccip \
  -H "Content-Type: application/json" \
  -d '{
    "calldata": "0x3b3b57de...",  # addr(bytes32) selector + node
    "sender": "0x..."               # Resolver 地址
  }'

# 或使用 ethers.js 解析
node scripts/resolve-mainnet.ts test-label
```

---

## 域名所有权转让

### 核心概念

```
ENS 域名权限模型：

aastar.eth (你持有)
├── 你可以创建子域名: forest.aastar.eth
├── 你可以转让 forest.aastar.eth 给其他人
└── 转让后，你失去对 forest.aastar.eth 的控制权

转让的关键点：
├── 二级/三级域名在 ENS 中是独立的 NFT
├── 默认情况下可以随时转让
├── 如果使用了 Name Wrapper 并烧断 fuse，则无法转让
└── 没有熔断 = 完全可转让和收回
```

### 转让流程

#### 前提条件检查
```solidity
// 检查是否使用了 Name Wrapper
// 如果域名是 wrapped（ERC-1155），需要检查 fuses

// 没有 Name Wrapper 的情况（默认）：
// ✅ 可以自由转让

// 使用 Name Wrapper 的情况：
// - 如果烧断了 CANNOT_TRANSFER fuse：❌ 不可转让
// - 如果没有烧断：✅ 可以转让
```

#### 转让二级域名给社区

```bash
# 1. 在 ENS App 操作
# 访问 https://app.ens.domains/forest.aastar.eth
# Transfer → 输入社区地址 → Confirm

# 2. 或使用命令行
export ENS_REGISTRY=0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e
export FOREST_NODE=$(cast namehash forest.aastar.eth)
export COMMUNITY_ADDRESS=0x...

# 转让所有权
cast send $ENS_REGISTRY \
  "setOwner(bytes32,address)" \
  $FOREST_NODE \
  $COMMUNITY_ADDRESS \
  --rpc-url $ETH_RPC_URL \
  --private-key $YOUR_KEY
```

#### 收回域名（如果社区同意转回）

```bash
# 社区需要将域名转让回给你
# 这必须由当前 owner（社区）主动操作

# 如果社区不配合，你无法强制收回
# 除非在转让时设置了特殊机制
```

### 安全转让模式

#### 模式1：直接转让（不可逆）
```
流程:
1. 你 → 社区: 转让 forest.aastar.eth
2. 社区成为完全 owner
3. 你无法收回（除非社区同意）

风险: 高
适用: 完全信任的长期合作
```

#### 模式2：注册商模式（推荐）
```
流程:
1. 你保留 forest.aastar.eth 所有权
2. 在 L2Records 中添加社区为注册商
3. 社区可以注册子域名，但不能转让域名
4. 你可以随时撤销注册商权限

优势:
- 保留控制权
- 可撤销权限
- 社区可以无许可注册
```

**注册商模式实现：**
```solidity
// 在 L2Records 中添加注册商
function addRegistrar(
    address communityManager,  // 社区地址
    bytes32 forestNode,        // forest.aastar.eth 的 node
    uint256 quota,             // 可注册数量
    uint256 expiry             // 过期时间
)

// 社区注册子域名
// 调用 registerByRegistrar，无需你审批

// 你可以随时移除
function removeRegistrar(address communityManager)
```

#### 模式3：时间锁转让
```solidity
// 高级：设置时间锁，到期后自动收回
// 或使用可撤销的授权机制
```

### 关键结论

| 场景 | 是否可以转让 | 是否可以收回 | 说明 |
|------|------------|------------|------|
| 默认 ENS 域名 | ✅ 是 | ✅ 是（需新owner配合） | 没有熔断，完全自由 |
| Name Wrapper + 无熔断 | ✅ 是 | ✅ 是（需新owner配合） | 和默认一样 |
| Name Wrapper + 已熔断 | ❌ 否 | ❌ 否 | 永久锁定，无法转让 |
| 注册商模式 | N/A | ✅ 是（你可以撤销） | 你不转让所有权 |

**重要提示：**
- 没有熔断 = 随时可以转让
- 转让后，只有新 owner 能转让回给你
- 建议先用注册商模式测试，再考虑完全转让

---

## 运维与监控

### 监控指标

```bash
# 检查 Gateway 状态
curl https://gateway.yourdomain.com/health

# 监控 Worker 日志
wrangler tail --env production

# 检查合约状态
cast call $L2_RECORDS_ADDRESS "owner()" --rpc-url $OP_RPC_URL
```

### 密钥轮换

```bash
# 1. 生成新密钥
# 2. 在 L2Records 添加新 signer（多签名者支持）
# 3. 更新 Cloudflare Secrets
# 4. 测试新密钥
# 5. 移除旧密钥
```

### 紧急响应

```bash
# 紧急暂停（如果合约支持）
cast send $L2_RECORDS_ADDRESS "pause()" --private-key $OWNER_KEY

# 紧急切换 Resolver
cast send $ENS_REGISTRY "setResolver(bytes32,address)" \
  $ROOT_NODE $BACKUP_RESOLVER --private-key $OWNER_KEY
```

---

## 参考

- [ENS Documentation](https://docs.ens.domains/)
- [Optimism Docs](https://docs.optimism.io/)
- [Foundry Book](https://book.getfoundry.sh/)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
