# CometENS 注册安全机制

## 概述

为了防止任何人都能随意注册域名，我们实现了一个简单的签名认证机制。

## 安全模型

```
.env.local (服务端 & 客户端共享)
├── REGISTRATION_SECRET="your-secret-password"  (仅服务端和授权客户端知道)
├── PRIVATE_KEY="0x..."                         (客户端私钥，用于签名)
└── ...

注册流程:
1. 客户端读取 REGISTRATION_SECRET
2. 用 PRIVATE_KEY 签名消息: "cometens:auth:{secret}:{timestamp}"
3. 发送: {signature, address, timestamp, label}
4. 服务端验证:
   - 签名是否来自 claimed address
   - 消息格式是否正确（包含正确的 secret）
   - 时间戳是否在有效期内（5分钟）
   - 地址是否在白名单中（可选）
5. 验证通过后执行注册
```

## 配置

### 1. 服务端配置

#### Vite 开发服务器 (.env.local)
```bash
# 认证配置
REGISTRATION_SECRET="your-secret-password-here"
ALLOWED_REGISTRANTS="0x1234...,0x5678..."  # 可选：白名单地址

# 合约配置
L2_RECORDS_ADDRESS="0x..."
ROOT_DOMAIN="aastar.eth"
WORKER_EOA_PRIVATE_KEY="0x..."  # 提交 L2 交易的私钥
```

#### Cloudflare Worker
```bash
# 设置 secrets
wrangler secret put REGISTRATION_SECRET --env testnet
wrangler secret put WORKER_EOA_PRIVATE_KEY --env testnet

# 可选：设置白名单（在 wrangler.toml 中）
[env.testnet.vars]
ALLOWED_REGISTRANTS = "0x1234...,0x5678..."
```

### 2. 客户端配置

#### 脚本使用 (.env.local)
```bash
# 客户端需要知道 SECRET 才能生成正确签名
REGISTRATION_SECRET="your-secret-password-here"
PRIVATE_KEY="0x..."  # 你的私钥
L2_RECORDS_ADDRESS="0x..."
```

## 使用示例

### 方法1：使用脚本（推荐）

```bash
# 1. 设置环境变量
cp .env.example .env.local
# 编辑 .env.local，添加 REGISTRATION_SECRET 和 PRIVATE_KEY

# 2. 执行注册
tsx scripts/register-with-auth.ts alice
```

### 方法2：直接调用 API

```bash
# 1. 生成签名（用 viem 或其他工具）
# 消息格式: "cometens:auth:your-secret:timestamp"

# 2. 调用 API
curl -X POST https://your-gateway.com/api/register \
  -H "Content-Type: application/json" \
  -d '{
    "label": "alice",
    "auth": {
      "address": "0xYourAddress",
      "timestamp": 1712345678,
      "signature": "0xYourSignature"
    }
  }'
```

### 方法3：前端集成

```typescript
import { privateKeyToAccount } from 'viem/accounts'

// 生成认证签名
async function generateAuthSignature(privateKey: Hex, secret: string) {
  const account = privateKeyToAccount(privateKey)
  const timestamp = Math.floor(Date.now() / 1000)
  const message = `cometens:auth:${secret}:${timestamp}`
  const signature = await account.signMessage({ message })
  return { address: account.address, timestamp, signature }
}

// 注册
async function register(label: string) {
  const secret = process.env.REGISTRATION_SECRET
  const privateKey = process.env.PRIVATE_KEY
  
  const auth = await generateAuthSignature(privateKey, secret)
  
  const response = await fetch('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, auth })
  })
  
  return response.json()
}
```

## 安全考虑

### 1. SECRET 泄露风险

**风险**：如果 REGISTRATION_SECRET 泄露，任何人都可以用前端代码注册。

**缓解措施**：
- 使用白名单（ALLOWED_REGISTRANTS）限制可注册地址
- 定期更换 SECRET
- 使用更复杂的认证机制（如多重签名、NFT 持有验证）

### 2. 私钥安全

**风险**：客户端私钥泄露。

**缓解措施**：
- 私钥只在服务端脚本中使用，不要放在前端代码
- 使用专门的注册账户（不要和主账户共用）
- 限制该账户权限（只用于注册，不持有大量资金）

### 3. 重放攻击

**风险**：截获有效签名后重复使用。

**缓解措施**：
- 时间戳有效期仅 5 分钟
- 服务端可记录已使用的签名（可选）

## 升级路径

### 阶段1：简单签名（当前）
- 共享 SECRET
- 地址白名单

### 阶段2：API Key 模式
- 每个注册者分配独立的 API Key
- 支持配额限制

### 阶段3：NFT 持有验证
- 只有持有特定 NFT 才能注册
- 无需共享 SECRET

### 阶段4：完全去许可
- 基于质押或付费的开放注册
- 智能合约控制权限

## 故障排查

### 错误："Timestamp expired"
- 检查客户端和服务端时间是否同步
- 时间戳有效期只有 5 分钟

### 错误："Signature mismatch"
- 检查 REGISTRATION_SECRET 是否一致
- 检查消息格式是否正确

### 错误："Address not in allowed list"
- 检查 ALLOWED_REGISTRANTS 配置
- 地址需要小写格式

### 错误："Registration not configured"
- 检查服务端是否正确设置了 REGISTRATION_SECRET
