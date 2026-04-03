# CometENS Changelog

所有重要变更均记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/)。

---

## [Unreleased] — Production API Server + Security Hardening（2026-04-03）

### 架构重构：纯前端 + CF Worker API

**Phase 1 — cometens-api Cloudflare Worker**（`workers/api/`）
- 完整 EIP-712 鉴权写端点：`/register`、`/set-addr`、`/set-text`、`/set-contenthash`、`/add-registrar`、`/remove-registrar`
- 上游应用端点：`POST /v1/register`（personal_sign + UPSTREAM_ALLOWED_SIGNERS 白名单）
- 公开查询端点：`/check-label`、`/check-owner`、`/lookup`
- CF KV `REGISTRY` 绑定（address→label 持久化，仅 API Worker）

**Phase 2 — CF KV 边缘缓存**（`workers/gateway/`）
- Gateway Worker 在链上读取前先查 `RECORD_CACHE` KV
  - `addr(node)` → `addr60:{node}`，命中 <5ms（vs 链上 ~200ms）
  - `text(node, key)` → `text:{node}:{key}`
  - `contenthash(node)` → `ch:{node}`
- API Worker 每次成功写入后同步更新 / 删除对应 KV 键
- 两个 Worker 共享同一 `RECORD_CACHE` KV namespace

**Phase 3 — 纯前端构建**
- `vite.config.ts` 精简至 17 行（移除全部 ~420 行服务器中间件）
- `src/register.ts` / `src/admin.ts` 所有 `/api/manage/*` 改为 `${config.apiUrl}/*`（指向 CF Worker）
- `src/config.ts` 新增 `apiUrl`（`VITE_API_URL` 环境变量，默认指向 CF Worker）

### Admin 页面新增
- **Query Registrar Info** — 查询地址是否被授权为 Registrar
- **Remove Registrar** — 撤销 Registrar 授权（Owner Only，EIP-712）
- **Set Contenthash** — 设置内容哈希（Name Owner，EIP-712）

### ABI 去重（单一来源）
- `contracts/abi/L2RecordsV2.json` 从 Foundry artifact 提取，纳入 git 追踪
- `server/gateway/abi.ts` 统一导出 shim，5 个消费方移除各自内联 ABI
- `scripts/sync-abi.mjs` + `pnpm abi:sync` — forge build 后自动同步

### 安全加固（自审 + Codex + Kimi 三轮）

**三个高危问题（开发阶段发现并修复，无需外部补丁）：**
1. **跨合约签名重放**：`verifyingContract` 强制取自 `env.L2_RECORDS_ADDRESS`，不再信任客户端请求体中的 `domain.verifyingContract`
2. **EIP-712 签名重放**：`consumeNonce()` 将 `nonce:{from}:{nonce}` 写入 `REGISTRY` KV（带 deadline TTL），重复提交返回 409
3. **所有权检查绕过**：`primaryNode` 防刷检查改为对比 `message.owner`（而非 signer 地址），修复了 Registrar 可为同一 owner 重复注册的漏洞

**中危修复：**
- `add-registrar` / `remove-registrar`：`consumeNonce` 移至 owner 鉴权之后，避免鉴权失败的请求消耗 nonce
- `admin.ts`：`l2Client` 根据 `config.network` 选择 `optimism` / `optimismSepolia`（修复主网误连测试网）
- `admin.ts`：`addRegistrar` / `removeRegistrar` 增加 `check-owner` 响应 `.ok` 守卫
- `admin.ts`：`setContenthash` 输入 hex 格式校验（签名前拒绝非法格式）

**部署脚本安全加固：**
- `deploy-production.sh`：显式要求 `PRIVATE_KEY_SUPPLIER`、`WORKER_EOA_PRIVATE_KEY`、`UPSTREAM_ALLOWED_SIGNERS` 三个变量，任一未设置则退出，移除对部署者密钥的任何 fallback
- 清理 `sed` 遗留的 `.bak` 文件，防止敏感配置泄漏至仓库

### 安全审计结论
三轮审计（Codex / Kimi / 人工自审）**未发现残留高危问题**。所有高危项均在开发阶段修复，PR 提交时代码状态已通过完整安全审查。

---

## [Unreleased] — Milestone A+（2026-03-30）

### 合约：OffchainResolver.sol — Breaking Change

**构造函数签名变更**（需重新部署）：
```solidity
// 旧版（已废弃）
constructor(address _owner, address _signer, string memory _gatewayUrl)

// 新版
constructor(address _owner, address[] memory _signers, string memory _gatewayUrl)
```

**新增：多签名者支持**
- `mapping(address => bool) public signers` 替代 `address public signerAddress`
- `addSigner(address)` / `removeSigner(address)` — onlyOwner，零停机密钥轮换
- 事件 `SignerAdded` / `SignerRemoved`（移除旧 `SignerUpdated`）
- 轮换流程：`addSigner(newKey)` → 网关切换私钥 → `removeSigner(oldKey)`，全程无中断

**新增：IERC7996 接口 stub**
- `supportsFeature(bytes4 featureId) external pure returns (bool)` — 当前返回 false
- `supportsInterface()` 新增 `0x582de3e7`（IERC7996 selector）
- ENS v2 UniversalResolver 通过此接口识别直接解析路径（减少一次网络往返）

### 部署脚本（DeployOffchainResolver.s.sol）
- 适配新构造函数，自动将单个 `SIGNER_ADDRESS` 包装为 `address[]`

### 测试（OffchainResolver.t.sol）— 25 个测试，全部通过
- 双签名者分别签名 → 均被接受
- removeSigner 后签名 → 被拒绝
- addSigner 后新签名者 → 被接受
- calldata binding 检查（签名绑定了请求内容）
- supportsInterface 覆盖 EIP-165 / IExtendedResolver / IERC7996

### E2E 测试修复（ccip.test.ts）
- OffchainResolver 构造函数参数同步：`signer.address` → `[signer.address]`

### 文档新增
- `docs/durin-analysis.md` — Durin 深度分析（架构对比、分阶段借鉴策略、长期跟踪建议）
- `eval/durin` — namestonehq/durin 加入 git submodule

---

## [Milestone A] — 2026-03-28 ✅

打通"L2 存储 → Gateway 读取 → L1 CCIP-Read 解析"完整闭环。

### 已部署合约（Sepolia 测试网）
| 合约 | 网络 | 地址 |
|---|---|---|
| L2Records | OP Sepolia | `0x9Ed5d10101656b69B5bf50Ef15fd3cc33F55058b` |
| OffchainResolver | Ethereum Sepolia | `0x87d97a2e3B334a4b62e1269d02bf4e2b168EbB45` |

`aastar.eth` 在 Sepolia ENS 已配置 OffchainResolver。

### 新增功能

**Gateway API**
- `POST /api/ccip` — CCIP-Read 处理器：解码 calldata → 读 L2 记录 → 签名返回
- `POST /api/manage/register` — EIP-712 用户注册（nonce + deadline 防重放）
- `POST /api/manage/set-addr` / `set-text` — EIP-712 记录管理
- `POST /api/v1/register` — 上游应用 API（secp256k1 personal_sign + timestamp 防重放）

**前端**
- `register.html` — 用户子域名注册页（MetaMask EIP-712，无 Gas）
- `admin.html` — 管理员查询/设置地址/文本记录

**合约（L2Records.sol）**
- `setSubnodeOwner(parentNode, labelhash, owner)` — 子域名注册
- `setAddr(node, coinType, addr)` — 多链地址（ENSIP-11）
- `setText(node, key, value)` — 文本记录
- `setContenthash(node, hash)` — 内容哈希
- `resolve(name, data)` — 批量解析分发

**合约（OffchainResolver.sol）初版**
- EIP-3668 OffchainLookup 标准实现
- EIP-3668 §4.1 签名绑定（resolver + expires + keccak(calldata) + keccak(result)）
- personal_sign 格式（Gateway 与合约双侧一致，自洽）
- IExtendedResolver（`0x9061b923`）+ EIP-165 支持

### 安全措施
- EIP-712 nonce + deadline（用户操作防重放）
- 上游 API timestamp ±60s 窗口（机器间防重放）
- EIP-3668 calldata binding（防签名复用攻击）
- CCIP-Read 响应过期机制

### 测试覆盖（全部通过）
| 文件 | 类型 | 覆盖场景 |
|---|---|---|
| `test/unit/gateway.test.ts` | Unit | 签名格式、编码解码 |
| `test/unit/schemas.test.ts` | Unit | EIP-712 domain/types |
| `test/unit/upstream-auth.test.ts` | Unit | 上游鉴权逻辑 |
| `test/unit/writer.test.ts` | Unit | L2RecordsWriter |
| `test/e2e/ccip.test.ts` | E2E | 完整 CCIP-Read 流程（Anvil 双链） |
| `test/e2e/register.test.ts` | E2E | 子域名注册 + 链上验证 |
| `test/e2e/upstream-api.test.ts` | E2E | 上游 API 完整流程（含拒绝场景） |
| `test/integration/deployed.test.ts` | Integration | 对接已部署 Sepolia 测试网 |
| `contracts/test/OffchainResolver.t.sol` | Foundry | 合约单元测试 |
| `contracts/test/L2Records.t.sol` | Foundry | 合约单元测试 |

### 文档体系建立
- `docs/architecture.md` — 6 视角架构图（Mermaid）
- `docs/design.md` — 技术决策与 ENS v2 对齐分析
- `docs/roadmap.md` — 里程碑 A-E 路线图
- `DEPLOY.md` — 完整部署指南
- `MANUAL.md` — 用户/开发者/运维手册

### ENS 生态深度评估（evaluation 分支）
- 评估子模块：CometENS-old、CometENS(历史)、ENS-offchain-resolver、ensjs、ens-docs、ens-contracts
- **Issue 1（签名格式）确认无问题**：深度追踪 AbstractUniversalResolver → CCIPBatcher → resolveWithProof，Gateway 与合约均使用 personal_sign，自洽一致
- **Issue 2（单签名者）已修复**：见 Milestone A+ 条目
- ENS v2 兼容性确认：IExtendedResolver + resolveWithProof 架构已对齐

---

## 待发布（路线图）

### Milestone B — Name Wrapper + NFT 子域
- 参考 Durin `L2Registry.sol`，L2Records 升级为 ERC-721 所有权模型
- `createSubnode()` 原子注册（一笔 tx）
- Registrar 插件架构（定价/白名单/Token Gate）
- L2Records → 新合约数据迁移脚本

### Milestone C — 状态证明（ENS v2 标准路径）
- 部署 OPResolver，使用 Bedrock 状态证明替代 Gateway 签名
- 信任最小化：任何人可独立验证，不依赖 Gateway 私钥诚实性

### Milestone D — 生产强化
- `setL2Registry()` 链上路由（参考 Durin，无需许可发行）
- Stuffed calldata 多链无状态网关
- L1 Name Wrapper 包裹 + 烧断 `CANNOT_SET_RESOLVER`（⚠️ 不可逆）
- Rate limiting、监控告警、多实例支持

### Milestone E — .box 写路径
- 依赖 my.box 官方 API 开放
