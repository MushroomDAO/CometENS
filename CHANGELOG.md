# CHANGELOG

## [Unreleased]

### Milestone A — 可信签名 MVP（进行中）

#### 已完成

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
| **合计** | | **45/45** |

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
| L2Records | OP Sepolia | _待部署_ |
| OffchainResolver | Ethereum Sepolia | _待部署_ |

### Mainnet

| 合约 | 网络 | 地址 |
|------|------|------|
| L2Records | Optimism | _待部署_ |
| OffchainResolver | Ethereum | _待部署_ |
