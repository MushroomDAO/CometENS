# CometENS 使用手册

CometENS 让任何人都能在你的根域名下（例如 `aastar.eth`）免费注册二级子域名，并通过 CCIP-Read 在 ENS 全网解析。

---

## 角色概览

| 角色 | 关心的问题 |
|------|-----------|
| **运维/部署者** | 如何部署合约、配置环境、启动服务 |
| **普通用户** | 如何注册和管理自己的子域名 |
| **上游应用** | 如何通过 API 自动为用户注册域名 |

---

## Part 1 — 运维/部署者

### 1.1 系统要求

```
Node.js   >= 20
Foundry   (forge/anvil)  — brew install foundry
钱包      两个 Sepolia ETH（部署合约用）
RPC       Alchemy / Infura — 需要 OP Sepolia + Ethereum Sepolia 端点
```

### 1.2 安装

```bash
git clone https://github.com/MushroomDAO/CometENS
cd CometENS
npm install
git submodule update --init          # vendor/unruggable-gateways
cd contracts && forge install && cd ..
```

### 1.3 部署合约

详见 [DEPLOY.md](./DEPLOY.md)，简要流程：

```bash
# 1. 部署 L2Records (Optimism Sepolia)
cd contracts
forge script script/DeployL2Records.s.sol \
  --rpc-url $OP_SEPOLIA_RPC_URL --broadcast
# → 记录输出地址，填入 OP_L2_RECORDS_ADDRESS

# 2. 部署 OffchainResolver (Ethereum Sepolia)
forge script script/DeployOffchainResolver.s.sol \
  --rpc-url $SEPOLIA_RPC_URL --broadcast
# → 记录输出地址，填入 L1_OFFCHAIN_RESOLVER_ADDRESS
```

### 1.4 配置环境

```bash
cp .env.op-sepolia .env.local
```

编辑 `.env.local`，**必填项**：

```env
# 网络
VITE_NETWORK=op-sepolia

# 根域名（你在 Sepolia ENS 上注册并设置了 resolver 的域名）
VITE_ROOT_DOMAIN=aastar.eth

# 合约地址
VITE_L2_RECORDS_ADDRESS=0x9Ed5d10...     # L2Records on OP Sepolia
VITE_L1_OFFCHAIN_RESOLVER_ADDRESS=0x87d97a2e...  # OffchainResolver on Sepolia
VITE_EIP712_VERIFYING_CONTRACT=0x9Ed5d10...      # 同 L2Records

OP_L2_RECORDS_ADDRESS=0x9Ed5d10...       # 同上（服务端使用）
L1_OFFCHAIN_RESOLVER_ADDRESS=0x87d97a2e...

# 网关
VITE_GATEWAY_URL=http://localhost:4173/api/ccip
GATEWAY_URL=http://localhost:4173/api/ccip

# RPC 端点
VITE_L2_RPC_URL=https://opt-sepolia.g.alchemy.com/v2/YOUR_KEY
VITE_L1_SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
OP_SEPOLIA_RPC_URL=https://opt-sepolia.g.alchemy.com/v2/YOUR_KEY
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY

# 签名密钥（绝不暴露到前端）
PRIVATE_KEY_SUPPLIER=0x...    # CCIP-Read 签名密钥
WORKER_EOA_PRIVATE_KEY=0x...  # L2 写操作执行账号

# 上游 API 密钥（供上游应用调用 /api/v1/register）
UPSTREAM_API_KEY=              # openssl rand -hex 32
```

### 1.5 在 ENS 上设置 Resolver

1. 访问 https://sepolia.app.ens.domains
2. 找到你的 `.eth` 域名 → More → Edit Resolver
3. 填入 `L1_OFFCHAIN_RESOLVER_ADDRESS` 地址
4. 确认（会有 3 个 interface 警告，正常现象，CCIP-Read resolver 不实现那些旧接口）

### 1.6 启动服务

```bash
npm run dev          # 开发模式，端口 4173，包含所有 API 中间件
npm run build        # 生产构建（静态文件 + 需要单独部署网关）
```

### 1.7 生成 UPSTREAM_API_KEY

```bash
openssl rand -hex 32
# 填入 .env.local 的 UPSTREAM_API_KEY
# 将同一个值告知上游应用开发者
```

### 1.8 测试验证

```bash
# 单元测试（无需网络，秒级完成）
npm test -- test/unit/

# E2E 测试（需要本机安装 Anvil，自动启动本地链）
npm test -- test/e2e/

# 集成测试（需要 .env.local 中的真实 RPC 和合约地址，约 50s）
set -a && source .env.local && set +a
npm test -- test/integration/
```

---

## Part 2 — 普通用户

### 2.1 注册子域名

1. 打开 `http://localhost:4173/register.html`（或部署后的公网地址）
2. 在输入框中输入你想要的名字，例如 `alice`
   - 页面会实时显示完整名称：`alice.aastar.eth`
   - 只允许小写字母、数字、连字符，最长 63 个字符
3. 点击 **Connect Wallet** → MetaMask 弹出授权
4. 点击 **Register** → MetaMask 弹出签名请求（EIP-712，不花 Gas）
5. 签名后页面显示注册结果和交易哈希

注册完成后，`alice.aastar.eth` 的 ETH 地址会指向你的钱包地址，可在任何支持 ENS 的 dApp 使用。

### 2.2 查询记录

1. 打开 `/admin.html`（也可用于自查）
2. 在 **Query** 区域输入 `alice.aastar.eth`
3. 选择 **L2 (CometENS)** 或 **L1 ENS**（L1 需 CCIP-Read 解析，结果相同）
4. 点击 Query Addr / Query Text / Query Contenthash

### 2.3 更新 ETH 地址

1. 打开 `/admin.html` → **Set Addr** 区域
2. 填入域名、新地址，coinType 默认 60（ETH）
3. 点击 **Connect & Sign SetAddr** → MetaMask 签名
4. 签名后提交到网关，Worker EOA 代执行 L2 写入

### 2.4 设置社交账号（text record）

1. 打开 `/admin.html` → **Set Text** 区域
2. 域名填 `alice.aastar.eth`，key 填 `com.twitter`，value 填 `@alice`
3. 签名并提交

常用 text record key：

| Key | 用途 |
|-----|------|
| `com.twitter` | Twitter/X 账号 |
| `com.github` | GitHub 账号 |
| `email` | 邮箱 |
| `url` | 个人主页 |
| `description` | 个人描述 |
| `avatar` | 头像 URL |

---

## Part 3 — 上游应用 (API 接入)

上游应用（如用户注册系统、邮件平台等）可以在用户注册时自动为其创建子域名，**无需用户手动操作**。

### 3.1 认证方式

所有 `/api/v1` 请求必须在 HTTP Header 中携带 API 密钥：

```
X-Api-Key: <UPSTREAM_API_KEY>
```

密钥由运维人员通过 `openssl rand -hex 32` 生成，通过安全渠道（非代码库）传递给上游应用。

### 3.2 注册子域名

**`POST /api/v1/register`**

注册一个子域名并（可选地）同时设置 ETH 地址记录。

**请求：**

```http
POST /api/v1/register
Content-Type: application/json
X-Api-Key: d379e33f...

{
  "label": "alice",
  "owner": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "addr": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `label` | string | ✅ | 子域名标签，仅小写字母/数字/连字符，1-63 字符 |
| `owner` | address | ✅ | 子域名所有者地址 |
| `addr` | address | 可选 | ETH 地址记录，默认与 owner 相同 |

**响应：**

```json
{
  "ok": true,
  "name": "alice.aastar.eth",
  "node": "0xabcdef...",
  "txHash": "0x1234..."
}
```

**错误响应：**

```json
{ "error": "Invalid label: must be 1-63 lowercase alphanumeric or hyphen chars" }
```

| HTTP 状态 | 含义 |
|-----------|------|
| 200 | 成功 |
| 400 | 参数错误 |
| 401 | API 密钥无效或缺失 |
| 503 | 服务端未配置 UPSTREAM_API_KEY |

### 3.3 代码示例

**Node.js / TypeScript：**

```typescript
async function registerSubdomain(label: string, ownerAddress: string) {
  const response = await fetch('https://ens.aastar.io/api/v1/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': process.env.COMETENS_API_KEY!,
    },
    body: JSON.stringify({
      label,
      owner: ownerAddress,
    }),
  })

  if (!response.ok) {
    const err = await response.json()
    throw new Error(`ENS registration failed: ${err.error}`)
  }

  const result = await response.json()
  console.log(`Registered: ${result.name}`)  // alice.aastar.eth
  console.log(`TX: ${result.txHash}`)
  return result
}

// 用户注册流程示例
async function onUserSignup(user: { username: string; wallet: string }) {
  // 注册 ENS 子域名（异步，不阻塞用户注册）
  registerSubdomain(user.username, user.wallet)
    .then(r => console.log('ENS registered:', r.name))
    .catch(e => console.error('ENS registration failed (non-critical):', e.message))
}
```

**Python：**

```python
import requests
import os

def register_subdomain(label: str, owner_address: str) -> dict:
    response = requests.post(
        "https://ens.aastar.io/api/v1/register",
        headers={
            "Content-Type": "application/json",
            "X-Api-Key": os.environ["COMETENS_API_KEY"],
        },
        json={"label": label, "owner": owner_address},
        timeout=60,  # L2 tx can take up to 30s
    )
    response.raise_for_status()
    return response.json()
```

**cURL：**

```bash
curl -X POST https://ens.aastar.io/api/v1/register \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $COMETENS_API_KEY" \
  -d '{"label": "alice", "owner": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"}'
```

### 3.4 注意事项

1. **注册时间**：`/api/v1/register` 会等待 L2 交易确认后才返回，OP Sepolia 约 5-15 秒，OP Mainnet 约 2 秒。建议上游应用异步调用，不要阻塞用户响应。

2. **重复注册**：同一 label 重复注册会覆盖 owner（合约不报错），可用于转移所有权。

3. **label 规则**：与 ENS 标准对齐，仅允许 `[a-z0-9-]`，长度 1-63。如果用户使用了大写或特殊字符，上游应自行转换（`.toLowerCase()`）。

4. **API 密钥保管**：API 密钥只有单一因素保护，请勿提交到代码仓库，通过环境变量或 Secrets 管理器传递。如需更高安全性，联系我们使用 HMAC 签名方案。

5. **查询无需认证**：读取记录直接调用链上合约或通过 ENS 解析，无需 API 密钥。

---

## 完整 API 端点列表

| 端点 | 方法 | 认证 | 用途 |
|------|------|------|------|
| `/api/ccip` | POST | 无 | CCIP-Read 网关（ENS 客户端自动调用） |
| `/api/v1/register` | POST | X-Api-Key | 上游应用注册子域名 |
| `/api/manage/register` | POST | EIP-712 签名 | 前端用户注册子域名 |
| `/api/manage/set-addr` | POST | EIP-712 签名 | 前端用户更新 ETH 地址 |
| `/api/manage/set-text` | POST | EIP-712 签名 | 前端用户更新 text record |

---

## 架构速览

```
用户浏览器
  /register.html → POST /api/manage/register (EIP-712)
  /admin.html    → POST /api/manage/set-addr / set-text (EIP-712)

上游应用 (server-to-server)
  POST /api/v1/register (X-Api-Key)
         ↓
    Worker EOA → L2Records.setSubnodeOwner (OP Sepolia/Mainnet)

ENS 解析
  任意 ENS 客户端 (viem/ethers)
    → L1 ENS → OffchainResolver.resolve()
    → OffchainLookup → POST /api/ccip
    → L2Records.addr() / text()
    → 签名 → resolveWithProof()
    → 返回解析结果
```

---

## 已部署合约（Testnet）

| 合约 | 网络 | 地址 |
|------|------|------|
| L2Records | OP Sepolia | `0x9Ed5d10101656b69B5bf50Ef15fd3cc33F55058b` |
| OffchainResolver | Ethereum Sepolia | `0x87d97a2e3B334a4b62e1269d02bf4e2b168EbB45` |
| Root Domain | Sepolia ENS | `aastar.eth` |
| Gateway | Local dev | `http://localhost:4173/api/ccip` |
| Gateway | Production (planned) | `https://ens.aastar.io/api/ccip` |
