# CometENS 设计文档

## 1. 产品定位

CometENS 是一个开源框架，让任何持有 `.eth` 根域名的组织能够：
- 向用户免费分发二级子域名（如 `alice.aastar.eth`）
- 通过 CCIP-Read 在整个 ENS 生态中透明解析
- 支持普通用户（前端 EIP-712）和上游应用（机器间 API）两种注册路径

**AAStar 的具体使用场景：**
- AirAccount：为每个注册钱包的用户提供确定归属的 ENS 子域名
- SuperPaymaster：用 `bob.paymaster.aastar.eth` 作为 Gas Sponsor 服务的唯一标识（DAPI）

---

## 2. 核心技术决策

### 2.1 存储层选型（MVP → 长期）

| 方案 | 优点 | 局限 | 适用阶段 |
|------|------|------|----------|
| **自有 L2Records**（当前） | 实现快、结构可控、Gas 低 | 不带 Name Wrapper NFT 语义 | MVP / 早期 |
| **官方 Name Wrapper + Public Resolver** | 语义完备（ERC-1155、Fuses）、生态兼容 | 接入复杂度高 | 稳定上线后 |

**决策**：MVP 先用 L2Records 打通闭环，稳定后提供迁移工具灰度切换到官方 Name Wrapper。

### 2.2 L1 Resolver 选型（可信签名 → 状态证明）

| 方案 | 信任模型 | 当前状态 |
|------|----------|----------|
| **OffchainResolver（当前）** | 信任 Gateway 签名密钥 | 已部署，线上运行 |
| **OPResolver（里程碑C）** | 零信任，Bedrock 状态证明 | 计划中 |

**决策**：OffchainResolver 已足够安全用于 MVP，状态证明为里程碑 C 的升级路径。

### 2.3 鉴权方案

| 入口 | 鉴权方式 | 防重放 |
|------|----------|--------|
| 前端用户注册 | EIP-712 typed data 签名 | nonce + deadline |
| 上游应用 API | secp256k1 personal_sign + 白名单 | timestamp ±60s |
| CCIP-Read 解析 | 无需鉴权（只读） | — |

---

## 3. 与 ENS V2 的对齐关系

ENS V2 正在将 `.eth` 注册/续费全部迁移到 L2，与 CometENS 的路径高度一致：

| CometENS 组件 | ENS V2 对应 | 状态 |
|---------------|-------------|------|
| L2Records | L2 存储层 | ✅ 已完成（里程碑A） |
| OffchainResolver | 可信签名解析（过渡态） | ✅ 已部署 |
| OPResolver（里程碑C） | 状态证明解析（V2 标准） | 计划中 |
| Name Wrapper on L2（里程碑B） | Per-name Registry | 计划中 |

---

## 4. 安全考量：信任根与 Fuse

**风险**：`aastar.eth` 的 L1 所有者若更换 resolver，所有子域名的 L1 解析路径将中断（L2 数据不丢失，但变成"数据孤岛"）。

**终极解法**（里程碑 D，不可逆，需谨慎）：
1. 在 L1 用 Name Wrapper 包裹 `aastar.eth`
2. 调用 `setFuses` 永久烧断 `CANNOT_SET_RESOLVER`

**结果**：任何人（包括所有者）都无法再更改 L1 resolver，子域名生态永久有效。
**代价**：`OffchainResolver` 无法再升级（可通过代理合约模式缓解）。

---

## 5. 账户与交易模型

- **当前（阶段一）**：用户 EIP-712 签名授权，Worker EOA 代理执行并支付 Gas
- **计划（阶段二）**：支持 ERC-4337 AA 账户，通过 Paymaster 实现 Gasless 体验
- **探索**：EIP-7702 为 EOA 用户提供备选 Gasless 方案

---

## 6. EIP-712 消息类型定义

```typescript
// 注册子域名
RegisterTypes: {
  parent: string     // 父域名，如 "aastar.eth"
  label: string      // 子域标签，如 "alice"
  owner: address     // 子域所有者
  nonce: uint256
  deadline: uint256
}

// 设置地址记录
SetAddrTypes: {
  node: bytes32      // namehash(fullName)
  coinType: uint256  // 60 = ETH, ENSIP-11 多链
  addr: bytes
  nonce: uint256
  deadline: uint256
}

// 设置文本记录
SetTextTypes: {
  node: bytes32
  key: string        // "com.twitter", "email" 等
  value: string
  nonce: uint256
  deadline: uint256
}
```

---

## 7. 上游应用签名格式

规范消息（canonical message）：
```
CometENS:register:{label}:{owner}:{timestamp}
```
- `timestamp`：Unix 秒，必须在服务端当前时间 ±60s 内
- 签名方式：`personal_sign`（EIP-191）
- 服务端：`recoverMessageAddress(message, signature)` 验证地址是否在白名单
