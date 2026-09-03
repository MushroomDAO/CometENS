# architecture — 技术骨架与不可破边界

## 现有骨架(已建成,不重造)

```
第三方 DApp / viem
   ↓ getEnsAddress('jack.aastar.eth')
L1 ENS Registry (Sepolia)
   ↓ resolver = HybridResolver
HybridResolver.sol            ← 按记录新鲜度自动路由
   ├─ 新记录(<~7d) → OffchainLookup → Gateway Worker 签名应答(秒级)
   └─ 老记录(≥~7d) → Bedrock finalized 状态证明(去信任)
        ↓
Gateway Worker (Cloudflare)   ← 读 L2、生成签名/证明
        ↓
L2RecordsV3.sol (Optimism)    ← 唯一事实来源
        ↑ 写
API Worker (Cloudflare)       ← EIP-712 鉴权 → Worker EOA 发交易
        ↑
前端 (Cloudflare Pages)
```

## 权限模型 —— 以及它的真实边界(2026-09-03 复核修正)

`L2RecordsV3` 内置三级权限:

| 角色 | 存储 | 能做什么 |
|---|---|---|
| `owner` | `address public owner` | **无条件通过一切检查**:任意 parentNode 发子域、覆写任意节点记录、转移任意子域 NFT |
| `registrar` | `_registrars[parentNode][addr]` + quota + expiry | **仅**在被授权的 parentNode 下发子域,受配额与到期限制 |
| 子域持有人 | ERC-721 `_ownerOf(uint256(node))` | 改自己名字的记录;可转让 NFT |

### ⚠️ owner 是一个逃生舱,不是普通角色

这三处让 owner 绕过一切限制,**且都有测试背书 —— 是刻意设计,不是 bug**:

- `onlyOwnerOrRegistrar`(L2RecordsV3.sol:67):`msg.sender != owner` 才进检查,owner 直接放行
- `_requireNodeAuth`(:300):`if (msg.sender == owner) return;` → owner 可覆写**任意用户**的记录
- `transferSubnodeByGateway`(:209):`onlyOwner`,链上**无签名校验** → owner 可把任意子域 NFT 转走
  (测试:`test_contractOwnerCanAlwaysSetAddr`、`test_gatewayTransfer_succeeds`)

API 层确实做了 EIP-712 验签 + 链上归属校验,但那是 **off-chain 约束**;
持有 owner 私钥者可以绕开 Worker 直接发交易。

### 线上现状(已实测,必须正视)

部署在 OP Sepolia 的 `0xbA692CdfDA33916BbE8d2a1f23E80218db8ebFDc`,
`owner() == 0xb5600060e6de5E11D3636731964218E53caadf0E`。而 `.env.local` 里
`WORKER_EOA_PRIVATE_KEY`、`PRIVATE_KEY_JASON`、`PRIVATE_KEY_SUPPLIER`
**三者派生出的都是这同一个地址**。即:

> 合约 owner = 写入管道执行者 = CCIP-Read 网关签名者 = 同一把私钥。
> 这把钥匙泄露一次,既能伪造全网解析应答,又能没收任意用户的名字。

### 两种模式的真实机制(修正此前的错误表述)

之前把 registrar 当成 Mode B 的原语,**是错的**:`addRegistrar` 是 `onlyOwner`,
托管模式下 owner 是我们,社区**无法**授予或撤销我们。正确的对应关系是:

| | Mode A 自部署 | Mode B 委托托管 |
|---|---|---|
| 合约 owner | 社区自己(建议多签) | 我们 |
| registrar 的用途 | **社区把日常发放权委托出去**(给热钱包或给我们),带配额/到期 | 用不上 |
| 撤销机制 | 社区 `removeRegistrar`,**真实有效** | **只能在 L1 改 `setResolver`**,`removeRegistrar` 对 owner 无效 |
| 用户名字的最终保障 | 社区自己的信任域 | **依赖运营方不作恶(owner 可没收)** |

因此:**registrar + quota + expiry 是 Mode A 的能力,不是 Mode B 的。**
Mode B 必须如实告知社区:域名所有权在你手里(随时可改 resolver 走人),
但**已发出的子域,运营方在技术上有能力覆写与收回**。

## 不可破的边界(改动触碰这些要停下)

1. **自部署零依赖**:自部署路径不得依赖我们的 Worker、密钥、域名或任何托管服务。
   任何"必须调用 cometens-api.workers.dev"的设计一律拒绝。
2. **根域名必须配置驱动**:`ROOT_DOMAIN`/`ROOT_DOMAINS` 是唯一来源,
   代码里不得出现硬编码 `aastar.eth`(HTML 占位符/文档示例除外)。
3. **registrar 越权必须失败**:跨 parentNode 发子域必须 revert,且有测试。
   注意:此性质**只约束第三方 registrar,不约束 owner**。任何声称"撤销后我们再也发不出子域"的
   文案,必须先确认该场景下我们不是 owner。
4. **子域所有权归用户**:`_registerNode` 一定 mint 给 `newOwner`,
   不得改成 mint 给运营方再转让。
5. **私钥只经环境变量/Workers secret**,绝不进仓库、绝不进前端 bundle
   (`VITE_` 前缀的变量会被打进浏览器,私钥永远不能用 `VITE_`)。
   **任何脚本不得打印私钥原值**,只能校验格式或做掩码输出。
6. **当前阶段只连测试网**:所有脚本默认 OP Sepolia / Ethereum Sepolia;
   主网参数必须显式传入且带二次确认。

## 本轮要新增的骨架

```
scripts/preflight.ts            配置校验器:部署前把错配拦下来
scripts/bootstrap-community.ts  一键为一个新社区拉起全套(测试网)
scripts/delegate.ts             委托管理:授权 / 查询 / 撤销 registrar
src/styles/design-system.css    统一设计系统(唯一样式来源)
```

设计系统是**唯一样式来源**:新增边界 —— 页面不得再写内联 `<style>` 块定义配色/间距,
只能引用 design system 的 CSS 变量与组件类。

## 测试基线(2026-09-03 实测)

- Foundry:**198 passed / 0 failed**
- TS unit:**101 passed / 0 failed**
- `pnpm typecheck`:干净
任何 PR 不得让这三项退化。
