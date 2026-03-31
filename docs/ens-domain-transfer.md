# ENS 域名转让与控制机制

## 核心概念：ENS 所有权 vs Resolver

```
ENS 注册表 (ENS Registry)
├── 记录域名所有者 (owner)
├── 记录域名 Resolver (解析器)
└── 记录域名 TTL

所有权控制：谁可以修改上述记录
Resolver 控制：谁可以设置解析记录
```

## 场景：转让 forest.aastar.eth

### 当前状态
```
aastar.eth (你持有)
└── forest.aastar.eth
    ├── ENS Owner: 你的地址
    ├── Resolver: OffchainResolver (L1)
    └── L2Records: 记录存储在 OP
```

### 目标状态
```
aastar.eth (你持有)
└── forest.aastar.eth
    ├── ENS Owner: 社区地址 (0xCommunity...)
    ├── Resolver: OffchainResolver (可以保持)
    └── L2Records: 社区控制 L2 注册
```

## 技术实现步骤

### 步骤1：在 ENS 上转让所有权

```javascript
// 使用 ethers.js 或 viem 与 ENS Registry 交互
// ENS Registry 地址：
// - Sepolia: 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e
// - Mainnet: 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e

// 调用 setOwner
const node = namehash("forest.aastar.eth")
await ensRegistry.setOwner(node, communityAddress)
```

### 步骤2：配置 L2Records 权限

**方案 A：使用同一个 L2Records 合约**
```solidity
// 在 L2Records 中添加社区地址为注册商
// 只有 Owner (你) 可以调用
function addRegistrar(
    address communityManager,  // 社区地址
    bytes32 rootNode,          // forest.aastar.eth 的 node
    uint256 quota,             // 可注册数量配额
    uint256 expiry             // 过期时间
)
```

**方案 B：社区部署自己的 L2Records**
```javascript
// 社区部署新的 L2Records 合约
// 优势：完全独立的控制权
// 劣势：需要修改 Resolver 指向新的存储
```

### 步骤3：Resolver 配置

```javascript
// 方案1：保持现有 Resolver，修改配置
// 在 OffchainResolver 中支持多根域名
// 每个根域名可以指向不同的 L2Records

// 方案2：社区部署自己的 Resolver
// 社区可以部署新的 OffchainResolver
// 设置为 forest.aastar.eth 的 Resolver
```

## 完整流程示例

### 你的操作（转让方）

```bash
# 1. 在 ENS 上设置 forest.aastar.eth 的 owner
# 访问 https://app.ens.domains/forest.aastar.eth
# 点击 "Transfer" 输入社区地址

# 或脚本操作
tsx scripts/transfer-ens-ownership.ts forest.aastar.eth 0xCommunityAddress

# 2. 在 L2Records 中授权社区
export ROOT_DOMAIN="forest.aastar.eth"
export COMMUNITY_ADDRESS="0x..."

# 调用 addRegistrar
tsx scripts/add-registrar.ts \
  --registrar $COMMUNITY_ADDRESS \
  --root $ROOT_DOMAIN \
  --quota 1000
```

### 社区的操作（接收方）

```bash
# 社区现在可以：
# 1. 设置自己的 Worker EOA（用于提交 L2 交易）
# 2. 控制自己的 Gateway（或使用你的 Gateway）
# 3. 为成员注册子域名

tsx scripts/register-by-owner.ts alice forest.aastar.eth
```

## ENS 权限模型

```
aastar.eth (你的)
├── 你可以创建子域名 forest.aastar.eth
├── 你可以设置 forest.aastar.eth 的 Owner
└── 你可以设置 forest.aastar.eth 的 Resolver

forest.aastar.eth (转让给社区后)
├── 社区可以创建子域名：alice.forest.aastar.eth
├── 社区可以设置子域名的 Resolver
└── 你不能再控制 forest.aastar.eth 下的任何操作
```

## 关键点

### 1. 二级域名所有权独立
- `forest.aastar.eth` 是一个独立的 NFT（在 ENS 注册表中）
- 转让后，你保留 `aastar.eth`，社区获得 `forest.aastar.eth`
- 双方各自控制自己的子域名

### 2. 解析器（Resolver）可以共用
- 多个域名可以共用同一个 OffchainResolver
- Resolver 通过 `node` 区分不同域名
- 无需为每个社区部署新的 Resolver

### 3. L2Records 存储分离

**共用存储**（推荐）：
```solidity
// 同一个 L2Records，通过权限控制
mapping(bytes32 => address) public nodeManagers;

// forest.aastar.eth 的 node => 社区地址
// 只有社区地址可以为该 node 注册子域名
```

**独立存储**（更复杂）：
```javascript
// 社区部署自己的 L2Records
// 需要修改 Resolver 指向新的存储地址
// 需要更新 Gateway 配置
```

## 代码实现

### 转让脚本

```typescript
// scripts/transfer-ens-subdomain.ts
import { createWalletClient, http, parseAbi } from 'viem'
import { namehash } from 'viem/ens'

const ENS_REGISTRY_ABI = parseAbi([
  'function setOwner(bytes32 node, address owner) external',
  'function owner(bytes32 node) external view returns (address)',
])

const ENS_REGISTRY = {
  sepolia: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e',
  mainnet: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e',
} as const

async function transferSubdomain(
  label: string,        // "forest"
  parentDomain: string, // "aastar.eth"
  newOwner: `0x${string}`,
) {
  const fullDomain = `${label}.${parentDomain}`
  const node = namehash(fullDomain)
  
  console.log(`Transferring ${fullDomain} to ${newOwner}`)
  console.log(`Node: ${node}`)
  
  // 调用 ENS Registry setOwner
  // 只有当前 owner 可以执行
  const tx = await walletClient.writeContract({
    address: ENS_REGISTRY[NETWORK],
    abi: ENS_REGISTRY_ABI,
    functionName: 'setOwner',
    args: [node, newOwner],
  })
  
  return tx
}
```

### L2Records 授权

```typescript
// 在社区获得 forest.aastar.eth 所有权后
// 在 L2Records 中添加社区为注册商

const parentNode = namehash("forest.aastar.eth")

await l2Records.addRegistrar(
  communityAddress,  // 社区地址
  parentNode,        // forest.aastar.eth
  1000,              // 可注册 1000 个子域名
  0                  // 永不过期
)
```

## 安全建议

### 1. 渐进式转让
```
阶段1：你保留所有权，社区作为注册商
阶段2：转让所有权给社区，但你保留紧急撤销权
阶段3：完全转让，社区完全控制
```

### 2. 紧急恢复机制
```solidity
// 在 L2Records 中设置备用 owner
// 即使 ENS 所有权转让，你仍可在紧急情况下介入
```

### 3. 合约升级路径
```
社区初期：使用你的 L2Records + Gateway
社区成熟：迁移到独立的 L2Records + Gateway
```

## 总结

| 问题 | 答案 |
|------|------|
| 可以转让 forest.aastar.eth 吗？ | ✅ 可以，通过 ENS Registry setOwner |
| 转让后谁控制子域名注册？ | 新的 owner（社区）|
| 需要改 Resolver 吗？ | 可选，可以共用或独立部署 |
| 需要改 L2Records 吗？ | 可选，可以授权或独立部署 |
| 你可以收回吗？ | ❌ 不可以，除非社区同意转回 |

这是 ENS 的标准功能，完全可行！
