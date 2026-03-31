# CometENS 多根域名 + 无许可注册 设计方案

## 一、需求概述

### 1. 多根域名支持
- **现状**：仅支持单个根域名（如 `aastar.eth`）
- **目标**：支持多个根域名（如 `aastar.eth`, `forest.eth`, `community.eth`）
- **场景**：
  - 运营者自己持有多个 ENS 域名
  - 开源框架供第三方使用，各用各自的 ENS 域名

### 2. 无许可注册模型
- **现状**：只有 `owner` 能注册子域名（中心化）
- **目标**：通过 API 签名验证，授权第三方为其社区注册子域名
- **场景**：
  - 社区 "Forest" 获得 `forest.aastar.eth`
  - Forest 可以无许可地为成员注册 `jack.forest.aastar.eth`
  - 验证方式：Forest 的钱包地址通过 API 签名验证

---

## 二、架构设计

### 2.1 多根域名架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Gateway Layer                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                   │
│  │ aastar.eth   │  │ forest.eth   │  │  dao.eth     │   ...            │
│  │ Resolver A   │  │ Resolver B   │  │ Resolver C   │                   │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘                   │
│         │                 │                 │                           │
│         └─────────────────┼─────────────────┘                           │
│                           ▼                                             │
│                  ┌──────────────────┐                                   │
│                  │  Unified L2Records │  (单合约存储所有根域名的记录)      │
│                  │  (节点隔离设计)      │                                   │
│                  └──────────────────┘                                   │
└─────────────────────────────────────────────────────────────────────────┘
```

**关键设计原则**：
- **单合约存储**：L2Records 继续作为唯一存储层，通过 `node`（namehash）隔离不同根域名
- **多 Resolver**：每个根域名在 L1 有自己的 OffchainResolver
- **统一 Gateway**：一个 Gateway 服务支持多个 Resolver 的签名请求

### 2.2 无许可注册架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         无许可注册流程                                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  1. 申请成为注册商                                                          │
│     ┌──────────┐      ┌──────────────┐      ┌─────────────┐             │
│     │  Forest  │ ───▶ │  Admin API   │ ───▶ │  签名验证    │             │
│     │  社区钱包 │      │  /apply      │      │  (EIP-712)  │             │
│     └──────────┘      └──────────────┘      └──────┬──────┘             │
│                                                    │                     │
│  2. 获得注册授权                                                            │
│     ┌─────────────┐     ┌─────────────────┐       │                     │
│     │ L2Records   │ ◀── │ setRegistrar()  │ ◀─────┘                     │
│     │ registrars  │     │ (仅 Owner 调用)  │                               │
│     │ [forest◀───┼─────┤ 授权 forest 地址 │                               │
│     │   .node]    │     │ 管理特定根域名   │                               │
│     └─────────────┘     └─────────────────┘                               │
│                                                                         │
│  3. 无许可注册子域名                                                        │
│     ┌──────────┐      ┌──────────────┐      ┌─────────────┐             │
│     │  Forest  │ ───▶ │  Register    │ ───▶ │ 签名验证     │             │
│     │  (已授权) │      │  API         │      │ forest签名   │             │
│     └──────────┘      └──────────────┘      └──────┬──────┘             │
│                                                    │                     │
│     ┌─────────────┐     ┌─────────────────┐       │                     │
│     │ L2Records   │ ◀── │ setSubnodeOwner │ ◀─────┘                     │
│     │ jack.forest │     │ (registrar 调用) │                               │
│     │ .aastar.eth │     │ 无需 owner!     │                               │
│     └─────────────┘     └─────────────────┘                               │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 三、合约层改造（L2Records.sol）

### 3.1 新增数据结构

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract L2Records {
    // ─── 现有数据结构 ─────────────────────────────────────────────────────────
    address public owner;
    mapping(bytes32 => mapping(uint256 => bytes)) private _addrs;
    mapping(bytes32 => mapping(string => string)) private _texts;
    mapping(bytes32 => bytes) private _contenthashes;
    mapping(bytes32 => address) private _owners;
    mapping(bytes32 => bytes) private _names;
    mapping(address => bytes32) private _primaryNode;
    
    // ─── 新增：多根域名支持 ───────────────────────────────────────────────────
    
    /// @notice 根域名配置
    /// @param resolver L1 上的 OffchainResolver 地址
    /// @param gatewayUrl 该根域名对应的 Gateway URL
    /// @param exists 是否已注册
    struct RootDomain {
        address resolver;      // L1 OffchainResolver 地址
        string gatewayUrl;     // Gateway URL (可选，用于客户端发现)
        bool exists;           // 是否存在
        uint256 registerFee;   // 注册费用（可选，0表示免费）
    }
    
    /// @notice 根域名 namehash => 配置
    mapping(bytes32 => RootDomain) public rootDomains;
    
    /// @notice 已注册的根域名列表（用于遍历）
    bytes32[] public rootDomainList;
    
    /// @notice 根域名计数
    uint256 public rootDomainCount;
    
    // ─── 新增：无许可注册支持 ─────────────────────────────────────────────────
    
    /// @notice 注册商权限
    /// @param rootNode 该注册商能管理的根域名 node
    /// @param isRegistrar 是否是有效注册商
    /// @param quota 可注册数量配额（0表示无限制）
    /// @param expiry 权限过期时间（0表示永不过期）
    struct Registrar {
        bytes32 rootNode;      // 能管理的根域名
        bool isRegistrar;      // 是否有效
        uint256 quota;         // 剩余配额
        uint256 expiry;        // 过期时间
    }
    
    /// @notice 注册商地址 => 权限
    mapping(address => Registrar) public registrars;
    
    /// @notice 根域名 => 注册商数量（用于统计）
    mapping(bytes32 => uint256) public registrarCount;
    
    // ─── 新增事件 ────────────────────────────────────────────────────────────
    
    event RootDomainAdded(bytes32 indexed rootNode, address resolver, string gatewayUrl);
    event RootDomainRemoved(bytes32 indexed rootNode);
    event RegistrarAdded(address indexed registrar, bytes32 indexed rootNode, uint256 quota, uint256 expiry);
    event RegistrarRemoved(address indexed registrar);
    event RegistrarQuotaUpdated(address indexed registrar, uint256 newQuota);
    
    // ─── 权限修饰符 ──────────────────────────────────────────────────────────
    
    /// @notice 检查是否是根域名的有效注册商
    modifier onlyRegistrar(bytes32 rootNode) {
        Registrar memory reg = registrars[msg.sender];
        require(reg.isRegistrar, "Not a registrar");
        require(reg.rootNode == rootNode, "Wrong root domain");
        require(reg.expiry == 0 || block.timestamp < reg.expiry, "Registrar expired");
        require(reg.quota > 0, "Quota exceeded");
        _;
    }
    
    /// @notice 检查是否支持该根域名
    modifier validRootDomain(bytes32 rootNode) {
        require(rootDomains[rootNode].exists, "Root domain not registered");
        _;
    }
    
    // ─── 多根域名管理（仅 Owner）───────────────────────────────────────────────
    
    /// @notice 添加新的根域名
    function addRootDomain(
        bytes32 rootNode, 
        address resolver, 
        string calldata gatewayUrl,
        uint256 registerFee
    ) external onlyOwner {
        require(!rootDomains[rootNode].exists, "Root domain already exists");
        require(resolver != address(0), "Invalid resolver");
        
        rootDomains[rootNode] = RootDomain({
            resolver: resolver,
            gatewayUrl: gatewayUrl,
            exists: true,
            registerFee: registerFee
        });
        rootDomainList.push(rootNode);
        rootDomainCount++;
        
        emit RootDomainAdded(rootNode, resolver, gatewayUrl);
    }
    
    /// @notice 移除根域名
    function removeRootDomain(bytes32 rootNode) external onlyOwner {
        require(rootDomains[rootNode].exists, "Root domain not found");
        delete rootDomains[rootNode];
        rootDomainCount--;
        emit RootDomainRemoved(rootNode);
    }
    
    /// @notice 更新根域名的 Gateway URL
    function updateRootDomainGateway(bytes32 rootNode, string calldata newUrl) 
        external 
        onlyOwner 
        validRootDomain(rootNode) 
    {
        rootDomains[rootNode].gatewayUrl = newUrl;
    }
    
    // ─── 注册商管理（仅 Owner）────────────────────────────────────────────────
    
    /// @notice 添加注册商（授权第三方无许可注册）
    /// @param registrar 注册商钱包地址
    /// @param rootNode 能管理的根域名
    /// @param quota 可注册数量配额（0表示无限）
    /// @param expiry 过期时间（0表示永不过期）
    function addRegistrar(
        address registrar, 
        bytes32 rootNode, 
        uint256 quota,
        uint256 expiry
    ) 
        external 
        onlyOwner 
        validRootDomain(rootNode) 
    {
        require(registrar != address(0), "Invalid registrar");
        require(!registrars[registrar].isRegistrar, "Already a registrar");
        
        registrars[registrar] = Registrar({
            rootNode: rootNode,
            isRegistrar: true,
            quota: quota == 0 ? type(uint256).max : quota,
            expiry: expiry
        });
        registrarCount[rootNode]++;
        
        emit RegistrarAdded(registrar, rootNode, quota, expiry);
    }
    
    /// @notice 移除注册商
    function removeRegistrar(address registrar) external onlyOwner {
        require(registrars[registrar].isRegistrar, "Not a registrar");
        bytes32 rootNode = registrars[registrar].rootNode;
        delete registrars[registrar];
        registrarCount[rootNode]--;
        emit RegistrarRemoved(registrar);
    }
    
    /// @notice 批量添加注册商
    function addRegistrarsBatch(
        address[] calldata registrarList,
        bytes32 rootNode,
        uint256 quota,
        uint256 expiry
    ) 
        external 
        onlyOwner 
        validRootDomain(rootNode) 
    {
        for (uint i = 0; i < registrarList.length; i++) {
            address r = registrarList[i];
            if (!registrars[r].isRegistrar && r != address(0)) {
                registrars[r] = Registrar({
                    rootNode: rootNode,
                    isRegistrar: true,
                    quota: quota == 0 ? type(uint256).max : quota,
                    expiry: expiry
                });
                registrarCount[rootNode]++;
                emit RegistrarAdded(r, rootNode, quota, expiry);
            }
        }
    }
    
    // ─── 无许可注册（注册商调用）────────────────────────────────────────────────
    
    /// @notice 注册商为其社区注册子域名
    /// @param parentNode 父节点（必须是注册商授权的根域名或其子域名）
    /// @param labelhash 标签哈希
    /// @param newOwner 子域名所有者
    /// @param label 标签明文
    function registerByRegistrar(
        bytes32 parentNode,
        bytes32 labelhash,
        address newOwner,
        string calldata label
    ) 
        external 
        onlyRegistrar(_findRootNode(parentNode)) 
        returns (bytes32 node) 
    {
        // 检查配额
        Registrar storage reg = registrars[msg.sender];
        require(reg.quota > 0, "Quota exceeded");
        reg.quota--;
        
        // 执行注册
        node = _registerNode(parentNode, labelhash, newOwner, label);
    }
    
    /// @notice 批量注册（注册商使用）
    function registerBatchByRegistrar(
        bytes32 parentNode,
        bytes32[] calldata labelhashes,
        address[] calldata newOwners,
        string[] calldata labels
    ) 
        external 
        onlyRegistrar(_findRootNode(parentNode)) 
        returns (bytes32[] memory nodes) 
    {
        require(
            labelhashes.length == newOwners.length && newOwners.length == labels.length,
            "Array length mismatch"
        );
        
        Registrar storage reg = registrars[msg.sender];
        require(reg.quota >= labelhashes.length, "Insufficient quota");
        
        nodes = new bytes32[](labelhashes.length);
        for (uint i = 0; i < labelhashes.length; i++) {
            reg.quota--;
            nodes[i] = _registerNode(parentNode, labelhashes[i], newOwners[i], labels[i]);
        }
    }
    
    // ─── 辅助函数 ────────────────────────────────────────────────────────────
    
    /// @notice 递归查找根域名节点
    /// @dev 通过 parent 链回溯找到根域名（存储在 rootDomains 中的节点）
    function _findRootNode(bytes32 node) internal view returns (bytes32) {
        if (rootDomains[node].exists) {
            return node;
        }
        // 简化：这里假设 parentNode 存储在 _parents 映射中
        // 实际实现需要额外的 parent 映射
        return node; // 简化返回
    }
}
```

### 3.2 关键设计说明

| 设计点 | 说明 |
|--------|------|
| **多根域名存储** | `rootDomains` 映射存储每个根域名的配置，包括 L1 Resolver 地址和 Gateway URL |
| **注册商模型** | 通过 `addRegistrar` 授权地址成为特定根域名的注册商，拥有独立配额和过期时间 |
| **节点隔离** | 所有记录仍使用 `node`（namehash）作为 key，天然隔离不同根域名 |
| **配额管理** | 每个注册商有独立配额，防止滥用 |
| **递归注册** | 支持多级子域名（如注册商拥有 `forest.aastar.eth`，可以为 `jack.forest.aastar.eth` 注册） |

---

## 四、网关层改造

### 4.1 多 Resolver 支持

```typescript
// server/gateway/config/roots.ts

export interface RootDomainConfig {
  name: string                    // 如 "aastar.eth"
  node: `0x${string}`            // namehash
  l1ResolverAddress: `0x${string}`  // L1 OffchainResolver
  l2RecordsAddress: `0x${string}`   // L2Records（可能相同或不同）
  signerPrivateKey: `0x${string}`   // 该根域名的签名私钥
}

// 从环境变量或数据库加载多根域名配置
export const rootDomains: RootDomainConfig[] = loadRootConfigs()

function loadRootConfigs(): RootDomainConfig[] {
  // 方式1：环境变量（适合少量根域名）
  const configs: RootDomainConfig[] = []
  let i = 1
  while (process.env[`ROOT_DOMAIN_${i}`]) {
    configs.push({
      name: process.env[`ROOT_DOMAIN_${i}`]!,
      node: process.env[`ROOT_NODE_${i}`] as `0x${string}`,
      l1ResolverAddress: process.env[`ROOT_RESOLVER_${i}`] as `0x${string}`,
      l2RecordsAddress: process.env[`L2_RECORDS_ADDRESS_${i}`] as `0x${string}`,
      signerPrivateKey: process.env[`ROOT_SIGNER_KEY_${i}`] as `0x${string}`,
    })
    i++
  }
  
  // 方式2：从 L2Records 合约读取（推荐）
  // configs.push(...await fetchRootDomainsFromContract())
  
  return configs
}
```

### 4.2 动态路由

```typescript
// server/gateway/index.ts

export async function handleResolveSigned(
  calldata: Hex,
  resolverAddress: Hex,
): Promise<{ data: Hex }> {
  // 根据 resolverAddress 找到对应的根域名配置
  const rootConfig = rootDomains.find(r => 
    r.l1ResolverAddress.toLowerCase() === resolverAddress.toLowerCase()
  )
  
  if (!rootConfig) {
    throw new Error(`Unknown resolver: ${resolverAddress}`)
  }
  
  // 使用对应根域名的 L2Records 地址和签名者
  const reader = new L2RecordsReader(client, rootConfig.l2RecordsAddress)
  const signer = privateKeyToAccount(rootConfig.signerPrivateKey)
  
  // ... 执行读取和签名
}
```

---

## 五、API 层设计

### 5.1 注册商申请与验证

```typescript
// server/gateway/v1/registrar.ts

import { verifyTypedData } from 'viem'

// EIP-712 类型定义
const REGISTRAR_APPLICATION_TYPES = {
  RegistrarApplication: [
    { name: 'applicant', type: 'address' },      // 申请钱包地址
    { name: 'rootDomain', type: 'string' },      // 申请的根域名
    { name: 'reason', type: 'string' },          // 申请理由
    { name: 'timestamp', type: 'uint256' },      // 时间戳（防重放）
  ],
} as const

/**
 * 申请成为注册商
 * POST /api/v1/registrar/apply
 */
export async function handleRegistrarApplication(req: Request, res: Response) {
  const { applicant, rootDomain, reason, signature, timestamp } = req.body
  
  // 1. 验证时间戳（防重放，有效期5分钟）
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - timestamp) > 300) {
    return res.status(400).json({ error: 'Request expired' })
  }
  
  // 2. 验证签名
  const valid = await verifyTypedData({
    domain: {
      name: 'CometENS Registrar Application',
      version: '1',
      chainId: 1, // 或对应的 L1 chainId
    },
    types: REGISTRAR_APPLICATION_TYPES,
    primaryType: 'RegistrarApplication',
    message: { applicant, rootDomain, reason, timestamp },
    signature,
    address: applicant,
  })
  
  if (!valid) {
    return res.status(401).json({ error: 'Invalid signature' })
  }
  
  // 3. 检查该根域名是否开放注册商申请
  // 4. 可选：额外验证（如检查 applicant 的链上历史、社交账号等）
  // 5. 存储申请到数据库，等待管理员审核或直接自动批准（取决于策略）
  
  return res.json({ 
    success: true, 
    message: 'Application submitted',
    applicationId: generateId(),
  })
}

/**
 * 无许可注册子域名（注册商调用）
 * POST /api/v1/registrar/register
 */
export async function handleRegistrarRegister(req: Request, res: Response) {
  const { 
    parentNode,      // 父节点
    label,           // 子域名标签
    owner,           // 新所有者地址
    registrarSignature, // 注册商签名
    timestamp,       // 时间戳
  } = req.body
  
  // 1. 找到根域名
  const rootNode = findRootNode(parentNode)
  
  // 2. 验证调用者是否是该根域名的注册商（在链上验证）
  const registrarInfo = await l2Records.read.registrars([req.headers['x-registrar-address']])
  if (!registrarInfo.isRegistrar || registrarInfo.rootNode !== rootNode) {
    return res.status(403).json({ error: 'Not an authorized registrar' })
  }
  
  // 3. 验证注册商签名（证明是该注册商发起的请求）
  const valid = await verifyRegistrarSignature({
    parentNode,
    label,
    owner,
    timestamp,
    signature: registrarSignature,
    registrar: req.headers['x-registrar-address'],
  })
  
  if (!valid) {
    return res.status(401).json({ error: 'Invalid registrar signature' })
  }
  
  // 4. 调用 L2Records 的 registerByRegistrar（通过 Worker EOA）
  const txHash = await l2RecordsWriter.registerByRegistrar({
    parentNode,
    labelhash: keccak256(toBytes(label)),
    newOwner: owner,
    label,
  })
  
  return res.json({ success: true, txHash })
}
```

---

## 六、前端改造

### 6.1 根域名选择器

```typescript
// src/components/RootDomainSelector.ts

export interface RootDomainOption {
  name: string           // "aastar.eth"
  node: `0x${string}`   // namehash
  resolver: `0x${string}`
  gatewayUrl: string
  description?: string   // "AAStar Community"
  icon?: string          // Logo URL
  isOfficial?: boolean   // 是否官方运营
}

export async function loadRootDomains(): Promise<RootDomainOption[]> {
  // 方式1：从配置加载
  const staticRoots = config.rootDomains || [{
    name: config.rootDomain,
    node: namehash(config.rootDomain),
    resolver: config.l1ResolverAddress,
    gatewayUrl: config.gatewayUrl,
  }]
  
  // 方式2：从 L2Records 合约读取所有根域名
  // const dynamicRoots = await l2Records.read.getRootDomains()
  
  return staticRoots
}

// 在注册页面使用
export function renderRootSelector(container: HTMLElement, onSelect: (root: RootDomainOption) => void) {
  const selector = document.createElement('select')
  selector.className = 'root-domain-select'
  
  loadRootDomains().then(roots => {
    roots.forEach(root => {
      const option = document.createElement('option')
      option.value = root.node
      option.textContent = root.description 
        ? `${root.name} - ${root.description}` 
        : root.name
      selector.appendChild(option)
    })
    
    selector.addEventListener('change', (e) => {
      const selected = roots.find(r => r.node === (e.target as HTMLSelectElement).value)
      if (selected) onSelect(selected)
    })
  })
  
  container.appendChild(selector)
}
```

### 6.2 注册商 Dashboard

```typescript
// src/registrar-dashboard.ts

interface RegistrarInfo {
  address: `0x${string}`
  rootNode: `0x${string}`
  rootName: string
  quota: bigint
  expiry: bigint
  registeredCount: number
}

export async function renderRegistrarDashboard(registrarAddress: `0x${string}`) {
  const info: RegistrarInfo = await fetchRegistrarInfo(registrarAddress)
  
  return `
    <div class="registrar-dashboard">
      <h2>注册商控制台</h2>
      <div class="info-card">
        <p>管理的根域名: ${info.rootName}</p>
        <p>剩余配额: ${info.quota.toString()}</p>
        <p>过期时间: ${info.expiry > 0 ? new Date(Number(info.expiry) * 1000).toLocaleString() : '永不过期'}</p>
      </div>
      
      <div class="batch-register">
        <h3>批量注册子域名</h3>
        <textarea id="batch-input" placeholder="每行一个: 标签,地址&#10;例如: jack,0x1234..."></textarea>
        <button onclick="batchRegister()">批量注册</button>
      </div>
      
      <div class="registered-list">
        <h3>已注册域名</h3>
        <!-- 列出该注册商注册的所有域名 -->
      </div>
    </div>
  `
}
```

---

## 七、配置示例

### 7.1 单运营者多根域名

```bash
# .env

# 主配置
VITE_NETWORK=op-mainnet
VITE_L2_RECORDS_ADDRESS=0x...

# 根域名 1: aastar.eth
ROOT_DOMAIN_1=aastar.eth
ROOT_NODE_1=0x3f2e8...
ROOT_RESOLVER_1=0x87d97a2e...
ROOT_SIGNER_KEY_1=0x...

# 根域名 2: forest.eth
ROOT_DOMAIN_2=forest.eth
ROOT_NODE_2=0x9a8b7...
ROOT_RESOLVER_2=0x123456...
ROOT_SIGNER_KEY_2=0x...

# 根域名 3: dao.eth
ROOT_DOMAIN_3=dao.eth
ROOT_NODE_3=0x1a2b3...
ROOT_RESOLVER_3=0xabcdef...
ROOT_SIGNER_KEY_3=0x...
```

### 7.2 第三方部署

```typescript
// 第三方只需要配置自己的根域名
const myConfig = {
  rootDomain: 'mycommunity.eth',
  l1ResolverAddress: '0x...', // 他们自己部署的 OffchainResolver
  l2RecordsAddress: '0x...',   // 可以使用共享的 L2Records
  // 申请成为某个根域名的注册商后获得 API key
  registrarApiKey: '...',
}
```

---

## 八、里程碑规划建议

基于上述设计，建议新增 **里程碑 G：多根域名 + 无许可注册**：

```markdown
## 里程碑 G：多根域名 + 无许可注册（开源框架化）

**目标**：将 CometENS 转变为支持多根域名的开源框架，允许第三方无许可地为其社区注册子域名。

| 任务 | 内容 | 优先级 | 依赖 |
|------|------|--------|------|
| G1 | L2Records 合约改造（多根域名存储 + 注册商模型）| 🔴 P0 | 无 |
| G2 | 注册商权限管理（add/remove/update quota）| 🔴 P0 | G1 |
| G3 | 无许可注册接口（registerByRegistrar）| 🔴 P0 | G1 |
| G4 | Gateway 多 Resolver 支持 | 🟡 P1 | G1 |
| G5 | 注册商 API 与签名验证系统 | 🟡 P1 | G2 |
| G6 | 前端根域名选择器 | 🟢 P2 | G4 |
| G7 | 注册商 Dashboard | 🟢 P2 | G5 |
| G8 | 第三方部署文档与模板 | 🟢 P2 | G6 |
| G9 | 多级子域名支持（jack.forest.aastar.eth）| 🟢 P3 | G3 |

**建议插入位置**：里程碑 D 之后，E 之前

理由：
- D 是生产强化，完成后系统稳定
- G 是架构扩展，将单域名系统扩展为多域名框架
- E（.box 写路径）依赖官方，可以并行
- 先完成 G 再做多链扩展（里程碑 F）更合理
```

---

## 九、与其他里程碑的关系

```
当前依赖关系：
A (MVP) → B (NameWrapper) → C (状态证明)
       ↘ D (生产强化)

建议调整为：
A (MVP) → B (NameWrapper) → C (状态证明)
       ↘ D (生产强化) → G (多根域名 + 无许可) → F (多链)
                          ↘ E (.box 写路径)
```

**关键依赖说明**：
- **G 依赖 D**：生产强化（多签名者、密钥轮换）是多根域名安全的基础
- **F 依赖 G**：多链扩展应基于多根域名框架
- **E 独立**：.box 写路径依赖官方 API，可与 G 并行

---

## 十、安全考量

| 风险 | 缓解措施 |
|------|----------|
| 注册商恶意批量注册 | 配额系统 + 过期机制 |
| 注册商密钥泄露 | 可撤销 + 多签名者（里程碑 D1） |
| 根域名配置错误 | 配置验证 + 链上事件审计 |
| 跨根域名重放攻击 | Resolver 地址绑定签名（已存在） |
| API 滥用 | Rate limiting（里程碑 D4） |
