# CHANGELOG

## [Unreleased]

### Milestone A — 可信签名 MVP（代码完成，待链上部署）

#### 安全修复（Security Review Pass）

- **[SECURITY] OffchainResolver：签名绑定请求 calldata**（防重放攻击）
  - 签名方案从 `keccak256(hex"1900" ++ resolver ++ expires ++ keccak256(result))` 升级为
    `keccak256(hex"1900" ++ resolver ++ expires ++ keccak256(callData) ++ keccak256(result))`（EIP-3668 §4.1）
  - 新增 `test_revertSignatureDoesNotBindToCalldata` 测试验证防重放
- **[SECURITY] OffchainResolver：`_recover` 使用 custom error**
  - 新增 `InvalidSignatureLength` 错误，替换 `require` 字符串
  - 新增 `ecrecover` 返回 `address(0)` 的显式检查
- **[SECURITY] Gateway：签名方案对齐 EIP-3668**
  - `handleResolveSigned` 现在接受 `resolverAddress`，绑定 calldata 并返回正确的 `abi.encode(result, expires, sig)` 格式
- **[SECURITY] vite.config.ts：请求体大小限制（10 KB）**
- **[SECURITY] vite.config.ts：输入字段校验**（`isAddress`、`isHex`、字符串非空检查）

#### 代码简化（Simplify Pass）

- `server/gateway/index.ts`：提取 `RESOLVE_ABI` 常量，消除重复 ABI 定义
- `vite.config.ts`：提取 `readBody`、`asBigInt`、`checkDeadline`、`withWriter` 工厂函数，消除 Worker EOA 实例化重复

#### 已完成（含初始里程碑 A）

- **测试框架**：集成 vitest + @vitest/coverage-v8，新增 `test` / `test:watch` / `test:coverage` 脚本
- **L2Records.sol**：部署在 L2（Optimism）的 ENS 记录合约，支持 `addr`/`text`/`contenthash` 读写及 `setSubnodeOwner` 子域名分配
- **OffchainResolver.sol**：L1 EIP-3668 CCIP-Read 解析器，`resolve()` 触发 OffchainLookup，`resolveWithProof()` 验证 Gateway 签名
- **Foundry 合约测试**：29 个测试全绿（L2Records × 17，OffchainResolver × 12）
- **Gateway 单元测试**：11 个测试，覆盖 `handleResolve`（addr/text/contenthash）、`handleResolveSigned`、EIP-712 签名验证
- **L2RecordsWriter**：Worker EOA 写路径（`setSubnodeOwner`/`setAddr`/`setText`/`setContenthash`），含 5 个 mock 单元测试
- **Gateway 写路径接入**：`vite.config.ts` 的 `/api/manage/register` 和 `/api/manage/set-addr` 验签通过后调用 Worker EOA 执行 L2 写入，返回 `txHash`
- **部署脚本**：`contracts/script/DeployL2Records.s.sol` 和 `DeployOffchainResolver.s.sol`
- **env 模板**：新增 `WORKER_EOA_PRIVATE_KEY`、`L1_OFFCHAIN_RESOLVER_ADDRESS` 字段

#### 测试覆盖

| 套件 | 工具 | 通过 |
|------|------|------|
| L2Records.t.sol | Foundry | 17/17 |
| OffchainResolver.t.sol | Foundry | 12/12 |
| gateway.test.ts | vitest | 5/5 |
| schemas.test.ts | vitest | 6/6 |
| writer.test.ts | vitest | 5/5 |
| **合计** | | **56/56** |

#### 待完成（需配置真实 env）

- [ ] 填写 `.env.op-sepolia`（RPC URL、Worker EOA 私钥、Supplier 私钥）
- [ ] 部署 L2Records → OP Sepolia（`forge script DeployL2Records`）
- [ ] 部署 OffchainResolver → Ethereum Sepolia（`forge script DeployOffchainResolver`）
- [ ] E2E 测试：注册子域名 + CCIP-Read 解析完整流程
- [ ] 在 Sepolia ENS 上绑定测试域名解析器

---

## 部署地址记录

### Testnet

| 合约 | 网络 | 地址 |
|------|------|------|
| L2Records | OP Sepolia (11155420) | `0x9Ed5d10101656b69B5bf50Ef15fd3cc33F55058b` |
| OffchainResolver | Ethereum Sepolia (11155111) | `0x87d97a2e3B334a4b62e1269d02bf4e2b168EbB45` |

### Mainnet

| 合约 | 网络 | 地址 |
|------|------|------|
| L2Records | Optimism | _待部署_ |
| OffchainResolver | Ethereum | _待部署_ |
