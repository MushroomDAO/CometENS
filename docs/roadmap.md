# CometENS 开发路线图

## 当前状态（2026-03）

| 里程碑 | 名称 | 状态 |
|--------|------|------|
| **A** | 可信签名 MVP | ✅ **已完成** |
| B | Name Wrapper + NFT 子域 | 计划中 |
| C | 状态证明（ENS V2 标准） | 计划中 |
| D | 生产强化与治理 | 计划中 |
| E | .box 写路径 | 待官方开放 |

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

---

## 里程碑 B：Name Wrapper + NFT 子域

**目标**：子域名成为真正的 ERC-1155 NFT，可转让、可交易，父域名所有者无法收回。

- B1 接入 OP 上的官方 ENS Name Wrapper 合约
- B2 Gateway Reader 扩展为 NameWrapperReader
- B3 Portal 支持 NFT 批量发放、冲突检测
- B4 提供 L2Records → Name Wrapper 数据迁移脚本

---

## 里程碑 C：状态证明（ENS V2 标准路径）

**目标**：用 Bedrock 状态证明替代 Gateway 签名，实现信任最小化。

- C1 部署 OPResolver（替代 OffchainResolver）
- C2 Gateway 返回 Merkle 状态证明而非签名
- C3 L1 验证链上可验，不依赖 Gateway 诚实性
- C4 切换与回退策略

**背景**：签名模式需信任 Gateway 私钥；证明模式任何人可独立验证，是 ENS V2 的标准方向。

---

## 里程碑 D：生产强化与治理

**目标**：达到生产级安全与可运维标准。

- D1 在 L1 包裹根域名并烧断 `CANNOT_SET_RESOLVER`（⚠️ 不可逆，执行前需充分测试）
- D2 Worker EOA 密钥轮换方案
- D3 Rate limiting、nonce 防重放强化
- D4 告警、监控看板与应急预案
- D5 多实例/多根域名支持

---

## 里程碑 E：.box 写路径（依赖官方）

**目标**：接入 my.box 写入能力（当前仅只读展示）。

- E1 跟进 my.box 官方 API/授权接口开放情况
- E2 与 .eth 管理闭环对齐

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
```
