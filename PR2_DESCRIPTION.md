# PR #2: L2Records V2 + Registrar Model + Security Enhancement

## 📋 变更概览

本 PR 实现了 CometENS 的多项重要升级，主要包括：
1. **L2Records V2 合约** - 支持注册商（Registrar）模式
2. **签名认证机制** - 增强注册安全性
3. **管理工具** - 新增 CLI 和 UI 工具
4. **部署文档** - 完整的主网部署指南

---

## 🏗️ 核心变更

### 1. 智能合约升级 (L2RecordsV2.sol)

**新功能：**
- ✅ `addRegistrar()` - 添加注册商（仅 Owner）
- ✅ `removeRegistrar()` - 移除注册商（仅 Owner）
- ✅ `updateRegistrarQuota()` - 更新注册商配额
- ✅ `isRegistrar()` - 检查地址是否为有效注册商
- ✅ `getRegistrarInfo()` - 获取注册商详细信息

**权限模型升级：**
```solidity
// V1: 只有 Owner 可以注册
function registerSubnode(...) external onlyOwner

// V2: Owner 或授权注册商可以注册
function registerSubnode(...) external onlyOwnerOrRegistrar(parentNode)
```

**注册商配额管理：**
- 每个注册商可设置独立的注册配额
- 支持过期时间设置
- 配额自动递减，用完即止

### 2. 安全增强 - 签名认证机制

**新文件：**
- `server/gateway/auth/simple-sig.ts` - 签名验证模块

**安全模型：**
```
客户端                          服务端
  │                              │
  ├─ 签名: "cometens:auth:{secret}:{timestamp}" ─┤
  │                              ├─ 验证签名
  │                              ├─ 验证时间戳（5分钟窗口）
  │                              ├─ 验证白名单（可选）
  │                              └─ 执行操作
  │
```

**环境变量：**
```bash
REGISTRATION_SECRET="your-secret-password"  # 服务端 & 授权客户端共享
ALLOWED_REGISTRANTS="0x...,0x..."           # 可选白名单
```

### 3. 管理工具

#### CLI 脚本
| 脚本 | 用途 | 示例 |
|------|------|------|
| `scripts/register-by-owner.ts` | Owner 直接注册域名 | `tsx register-by-owner.ts alice aastar.eth` |
| `scripts/register-public.ts` | 公开注册（带白名单） | `tsx register-public.ts bike forest.aastar.eth` |
| `scripts/register-with-auth.ts` | 带签名认证的注册 | `tsx register-with-auth.ts alice` |
| `scripts/manage-registrar.ts` | 管理注册商 | `tsx manage-registrar.ts add forest.aastar.eth 0x... 1000` |

#### Admin UI 增强
- 新增 "Add Registrar" 面板
- 支持设置父域名、注册商地址、配额、过期时间
- 自动验证 Owner 权限

### 4. Gateway 更新 (Cloudflare Worker)

**新端点：**
- `POST /api/register` - 带签名验证的注册接口
- `GET /health` - 健康检查

**新 Secrets：**
```bash
wrangler secret put REGISTRATION_SECRET      # 认证密码
wrangler secret put WORKER_EOA_PRIVATE_KEY   # Worker 私钥
```

### 5. 文档更新

**DEPLOY.md 增强：**
- 主网部署完整清单
- 成本估算（~0.1 ETH）
- 密钥安全建议
- 域名所有权转让指南

**新增文档：**
- `docs/registration-auth.md` - 签名认证机制详解
- `docs/ens-domain-transfer.md` - ENS 域名转让机制
- `docs/multi-root-permissionless-design.md` - 多根域名架构设计

---

## 📁 文件变更列表

### 新增文件
```
contracts/src/L2RecordsV2.sol                 # V2 合约
contracts/script/DeployL2RecordsV2.s.sol      # V2 部署脚本
server/gateway/auth/simple-sig.ts             # 签名认证模块
server/gateway/writer/L2RecordsWriterV2.ts    # V2 Writer 类
scripts/register-by-owner.ts                  # Owner 注册脚本
scripts/register-public.ts                    # 公开注册脚本
scripts/register-with-auth.ts                 # 签名认证注册脚本
scripts/manage-registrar.ts                   # 注册商管理脚本
docs/registration-auth.md                     # 认证文档
docs/ens-domain-transfer.md                   # 域名转让文档
docs/multi-root-permissionless-design.md      # 架构设计文档
```

### 修改文件
```
admin.html                                    # 添加 Add Registrar UI
src/admin.ts                                  # 添加注册商管理逻辑
server/gateway/manage/schemas.ts              # 添加 AddRegistrarTypes
server/gateway/writer/L2RecordsWriter.ts      # 保留 V1 兼容
vite.config.ts                                # 添加 /add-registrar 端点
workers/gateway/src/index.ts                  # 添加注册接口和认证
workers/gateway/wrangler.toml                 # 添加新环境变量
DEPLOY.md                                     # 主网部署指南
README.md                                     # 更新使用说明
```

---

## 🔄 使用流程

### 场景1：Owner 直接注册（当前模式）

```bash
# 1. 设置环境
cp .env.example .env.local
# 编辑 .env.local 添加 PRIVATE_KEY 和 REGISTRATION_SECRET

# 2. 注册域名
tsx scripts/register-by-owner.ts alice aastar.eth

# 3. 验证
curl https://gateway.yourdomain.com/api/ccip \
  -d '{"calldata":"0x...","sender":"0x..."}'
```

### 场景2：授权社区注册（注册商模式）

```bash
# 1. Owner 添加注册商
tsx scripts/manage-registrar.ts add \
  forest.aastar.eth \
  0xCommunityAddress \
  1000 \
  0

# 2. 社区使用私钥签名注册
# 社区设置 REGISTRATION_SECRET（与 Owner 相同）
tsx scripts/register-with-auth.ts bob forest.aastar.eth

# 3. Owner 可以随时撤销
tsx scripts/manage-registrar.ts remove \
  forest.aastar.eth \
  0xCommunityAddress
```

### 场景3：通过 Admin UI 管理

```
1. 访问 http://localhost:4173/admin.html
2. 连接 MetaMask（必须是 Owner 地址）
3. 在 "Add Registrar" 面板：
   - Parent Domain: forest.aastar.eth
   - Registrar Address: 0xCommunity...
   - Quota: 1000
   - Expiry: 0
4. 点击 "Connect & Sign AddRegistrar"
5. 等待交易确认
```

---

## ⚠️ 影响范围

### 破坏性变更
- **无** - 本 PR 新增功能，不修改现有接口

### 兼容性
- V1 合约继续可用
- V2 合约向后兼容 V1 功能
- 前端 UI 可选择性使用新功能

### 部署依赖
1. **部署 V2 合约**（测试网/主网）
2. **更新环境变量**：
   ```bash
   VITE_L2_RECORDS_ADDRESS=<V2地址>
   REGISTRATION_SECRET=<密码>
   ```
3. **更新 Cloudflare Worker Secrets**
4. **重新部署 Gateway**

---

## ✅ 测试清单

### 单元测试
```bash
pnpm vitest run test/unit/
```

### E2E 测试
```bash
# 1. 启动本地服务器
pnpm dev

# 2. 测试注册
pnpm vitest run test/e2e/register.test.ts

# 3. 测试 CCIP 解析
pnpm vitest run test/e2e/ccip.test.ts
```

### 集成测试
```bash
# 需要 .env.local 配置真实 RPC
pnpm vitest run test/integration/deployed.test.ts
```

### 手动测试流程
1. 部署 V2 合约
2. 更新 .env.local
3. 测试 Owner 注册
4. 测试 Add Registrar
5. 测试注册商注册
6. 验证 ENS 解析

---

## 🔐 安全考虑

| 风险 | 缓解措施 |
|------|---------|
| SECRET 泄露 | 使用白名单 + 定期更换 |
| 私钥泄露 | 分离 Owner/Supplier/Worker 密钥 |
| 重放攻击 | 5分钟时间戳窗口 |
| 注册商滥用 | 配额限制 + 可随时撤销 |
| 合约漏洞 | 建议审计后主网部署 |

---

## 📚 相关文档

- [DEPLOY.md](./DEPLOY.md) - 部署指南
- [docs/registration-auth.md](./docs/registration-auth.md) - 认证机制
- [docs/ens-domain-transfer.md](./docs/ens-domain-transfer.md) - 域名转让
- [docs/roadmap.md](./docs/roadmap.md) - 项目路线图

---

## 🎯 后续计划

1. **部署 V2 合约**（等待网络恢复）
2. **E2E 测试** 完整流程
3. **更新 Cloudflare Worker** 生产环境
4. **主网部署**（按 DEPLOY.md 清单）
5. **社区测试** 注册商模式

---

## 💬 备注

- 本 PR 代码已完成，待网络稳定后部署合约
- V2 合约已通过编译，ABI 已生成
- 所有脚本已测试（除链上部署外）

/label ~enhancement ~security ~documentation
/milestone "Phase 2: Multi-community Support"
