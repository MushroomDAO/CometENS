# CometENS 开发路线图

## 当前状态（2026-03）

| 里程碑 | 名称 | 状态 |
|--------|------|------|
| **A** | 可信签名 MVP | ✅ **已完成** |
| B | Name Wrapper + NFT 子域 | 计划中 |
| C | 状态证明（ENS V2 标准） | 计划中 |
| D | 生产强化与治理 | 计划中 |
| E | .box 写路径 | 待官方开放 |
| F | 多链扩展 | 远期规划 |

---

## 里程碑 A：可信签名 MVP ✅

**目标**：打通"L2 存储 → Gateway 读取 → L1 CCIP-Read 解析"完整闭环。

| 任务 | 内容 | 状态 |
|------|------|------|
| A1 | 部署 L2Records（OP Sepolia） | ✅ `0x9Ed5d10101656b69B5bf50Ef15fd3cc33F55058b` |
| A2 | 部署 OffchainResolver（Ethereum Sepolia） | ✅ `0x87d97a2e3B334a4b62e1269d02bf4e2b168EbB45` |
| A3 | aastar.eth 设置 OffchainResolver | ✅ Sepolia ENS 已配置 |
| A4 | Gateway CCIP-Read（addr/text/contenthash + 签名）| ✅ |
| A5 | Gateway 写路径（Worker EOA → L2）| ✅ |
| A6 | 前端用户注册（EIP-712 + register.html）| ✅ |
| A7 | Admin Portal（查询/设置地址/文本）| ✅ |
| A8 | 上游应用 API（/api/v1/register 签名鉴权）| ✅ |
| A9 | 测试覆盖（unit + e2e + integration）| ✅ |
| A10 | Cloudflare Workers 网关部署 | ✅ `workers/gateway/` 已配置 |
| A11 | Contenthash 前端管理入口 | 🟡 admin.html 补充 setContenthash |

**补充任务说明：**
- **A10 Cloudflare Workers**：已部署，生产环境使用 Cloudflare Worker 作为网关，替代 Vite 开发服务器
- **A11 Contenthash**：当前 admin.html 只支持 addr/text，需补充 contenthash 设置能力（IPFS/IPNS/Arweave 等）

---

## 里程碑 B：Name Wrapper + NFT 子域

**目标**：子域名成为真正的 ERC-1155 NFT，可转让、可交易，父域名所有者无法收回。

| 任务 | 内容 | 状态 |
|------|------|------|
| B1 | 接入 OP 上的官方 ENS Name Wrapper 合约 | 计划中 |
| B2 | Gateway Reader 扩展为 NameWrapperReader | 计划中 |
| B3 | Portal 支持 NFT 批量发放、冲突检测 | 计划中 |
| B4 | 提供 L2Records → Name Wrapper 数据迁移脚本 | 计划中 |
| B5 | 完整的 Contenthash 用户能力 | 🟡 用户可设置/修改/删除 contenthash |

**补充任务说明：**
- **B5 Contenthash 完整能力**：参考 CometENS-old 的设计，在 register.html 和 box.html 中支持用户设置 contenthash，用于去中心化网站托管（IPFS + IPNS）

---

## 里程碑 C：状态证明（ENS V2 标准路径）

**目标**：用 Bedrock 状态证明替代 Gateway 签名，实现信任最小化。

| 任务 | 内容 | 来源/参考 | 状态 |
|------|------|-----------|------|
| C1 | 部署 OPResolver（替代 OffchainResolver）| CometENS (aastar-dev) / unruggable-gateways | 计划中 |
| C2 | Gateway 返回 Merkle 状态证明而非签名 | OPFault Proof 验证机制 | 计划中 |
| C3 | L1 验证链上可验，不依赖 Gateway 诚实性 | 里程碑 C 核心目标 | 计划中 |
| C4 | 切换与回退策略 | 保证升级平滑 | 计划中 |
| C5 | OPResolver 状态证明集成测试 | eval/CometENS/providers.ts 配置参考 | 🟡 需配置多链 Provider |

**补充任务说明：**
- **C5 OPResolver 参考**：eval/CometENS/contracts/OPResolver.sol 提供了完整的 GatewayFetcher 模式实现，使用 @unruggable/gateways 库进行状态证明验证
- **技术要点**：OPResolver 通过 `GatewayFetcher` 构建链上可验证的存储证明请求，替代当前的签名模式

**背景**：签名模式需信任 Gateway 私钥；证明模式任何人可独立验证，是 ENS V2 的标准方向。

---

## 里程碑 D：生产强化与治理

**目标**：达到生产级安全与可运维标准。

| 任务 | 内容 | 优先级 | 来源/参考 |
|------|------|--------|-----------|
| D1 | OffchainResolver 多签名者支持 | 🔴 **主网上线前必须** | ENS-offchain-resolver |
| D2 | 在 L1 包裹根域名并烧断 `CANNOT_SET_RESOLVER` | 🟡 高 | 里程碑 D 核心 |
| D3 | Worker EOA 密钥轮换方案 | 🟡 高 | 配合多签名者 |
| D4 | Rate limiting、nonce 防重放强化 | 🟡 高 | 生产安全 |
| D5 | 告警、监控看板与应急预案 | 🟢 中 | 运维标准 |
| D6 | 多实例/多根域名支持 | 🟢 中 | 里程碑 D5 扩展 |
| D7 | IERC7996 直接解析路径（可选优化）| 🟢 低 | ens-contracts |

**关键任务详解：**

### D1 多签名者支持（🔴 主网上线前必须）

**现状问题**：当前 OffchainResolver 只支持单签名者
```solidity
address public signerAddress;  // 单一签名者
```

**生产风险**：
- 密钥轮换需停机（setSigner 即时切换，旧签名立即失效）
- 多网关部署需共享同一密钥
- 无法实现热/冷密钥分离

**解决方案**（约 20 行代码）：
```solidity
mapping(address => bool) public signers;  // 多签名者白名单

function addSigner(address signer) external onlyOwner {
    signers[signer] = true;
    emit SignerAdded(signer);
}

function removeSigner(address signer) external onlyOwner {
    signers[signer] = false;
    emit SignerRemoved(signer);
}

// resolveWithProof 中验证
if (!signers[recovered]) revert InvalidSigner();
```

**优势**：
- ✅ 零停机密钥轮换（先 add 新签名者，等旧 TTL 过期再 remove）
- ✅ 多网关可各用独立密钥
- ✅ 支持热/冷密钥分离

**参考实现**：eval/ENS-offchain-resolver/packages/contracts/contracts/OffchainResolver.sol

---

## 里程碑 E：.box 写路径（依赖官方）

**目标**：接入 my.box 写入能力（当前仅只读展示）。

- E1 跟进 my.box 官方 API/授权接口开放情况
- E2 与 .eth 管理闭环对齐

---

## 里程碑 F：多链扩展（远期规划）

**目标**：支持其他 OP-stack L2 链（Base、Arbitrum、Scroll 等）。

| 任务 | 内容 | 来源/参考 | 状态 |
|------|------|-----------|------|
| F1 | 多链 Provider 配置系统 | CometENS providers.ts | 规划中 |
| F2 | Base 网络支持 | eval/CometENS/base.ts | 规划中 |
| F3 | Arbitrum 网络支持 | eval/CometENS/arbitrum.ts | 规划中 |
| F4 | 统一的多链 Gateway 路由 | eval/CometENS/packages/gateway/ | 规划中 |

**参考资源**：
- eval/CometENS/providers.ts 包含 40+ 条链的完整 RPC 配置（Alchemy/Infura/Ankr/drpc/public）
- eval/CometENS/base.ts、arbitrum.ts、optimism.ts 提供各链的部署示例
- 支持链列表：Ethereum、Optimism、Base、Arbitrum、Scroll、Taiko、zkSync、Polygon、Linea、Blast、Mantle、Mode、Celo 等

---

## 历史仓库价值参考

| 内容 | 来源 | 里程碑 | 说明 |
|------|------|--------|------|
| 多签名者支持 | ENS-offchain-resolver | **D1** | 生产上线前必须添加（约20行）|
| Cloudflare Workers 网关 | ENS-offchain-resolver | **A10** ✅ | 已部署，生产环境使用 |
| Multi-chain Provider 配置 | CometENS (aastar-dev) | **F1** | 扩展到其他 OP-stack L2 时参考 |
| OPResolver 状态证明 | CometENS (aastar-dev) | **C5** | 里程碑 C 的实现参考 |
| Contenthash 前端入口 | CometENS-old | **A11/B5** | admin.html + register.html 补充 setContenthash |
| IERC7996 直接解析路径 | ens-contracts | **D7** | 主网可选优化，减少一次网络往返 |

---

## 参考：ENS V2 路径对应

```
CometENS 路径                  ENS V2 对应
─────────────────────────────────────────────
L2Records (里程碑A) ──────▶  L2 存储验证
OffchainResolver (里程碑A) ──▶  可信签名（过渡态）
OPResolver (里程碑C) ─────▶  状态证明（V2 标准）
Name Wrapper (里程碑B) ───▶  Per-name Registry
Fuse 烧断 (里程碑D) ──────▶  不可变信任根
Multi-chain (里程碑F) ────▶  ENSIP-11 多链地址
```

---

## 主网上线前必须完成清单（🔴 P0）

| 任务 | 里程碑 | 说明 |
|------|--------|------|
| OffchainResolver 多签名者支持 | D1 | 零停机密钥轮换能力 |
| Worker EOA 密钥轮换方案 | D3 | 配合多签名者实现 |
| Rate limiting、nonce 防重放 | D4 | 生产安全基础 |
| 完整的 ENS 配置测试 | A11/B5 | addr + text + contenthash 全覆盖 |

---

## 测试覆盖要求

| 里程碑 | 测试重点 |
|--------|----------|
| A | Gateway 签名验证、EIP-712 注册、CCIP-Read 端到端 |
| B | Name Wrapper NFT 转移、权限变更 |
| C | Merkle 证明验证、链上状态校验 |
| D | 多签名者轮换、密钥泄露应急响应 |
| F | 多链切换、跨链解析一致性 |
