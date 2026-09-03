# spec — 精确规格(可照着实现)

## 1. `scripts/preflight.ts` — 部署前配置校验

命令:`pnpm preflight [--network op-sepolia] [--json]`
退出码:`0` 全通过;`1` 有 FAIL;`2` 用法错误。

检查项(每项输出 `PASS|WARN|FAIL` + 一句人话建议):

| # | 检查 | FAIL 条件 |
|---|---|---|
| 1 | 必需环境变量存在 | 缺 `L2_RECORDS_ADDRESS` / `ROOT_DOMAIN` / RPC 之一 |
| 2 | 私钥格式 | 非 `0x` + 64 hex |
| 3 | **私钥未用 VITE_ 前缀** | 任何 `VITE_*` 变量的值像私钥(0x+64hex) |
| 3b | **密钥未复用**(WARN) | owner / writer / gateway signer 三者派生同一地址 |
| 4 | L2 RPC 可达且 chainId 正确 | 连不上,或 chainId ≠ 期望值 |
| 5 | L2Records 合约存在 | 该地址 `eth_getCode` 返回 `0x` |
| 6 | 合约 `owner()` 可读 | 调用 revert |
| 7 | 运营 EOA 有余额 | 余额为 0(WARN 而非 FAIL) |
| 8 | `ROOT_DOMAIN` 是合法 ENS 名 | 不匹配 `^([a-z0-9-]+\.)+eth$` |

错误信息必须说人话并给出修法,例如:
`FAIL [3] VITE_PRIVATE_KEY 看起来是私钥 —— VITE_ 变量会被打进浏览器包。改名为 PRIVATE_KEY。`

**硬性安全要求**:preflight(以及任何脚本)**绝不打印私钥原值**。
只允许输出:是否存在、格式是否合法、派生出的**地址**、或掩码(如 `0x1234…ab`)。
违反此条的实现视为不合格,即使功能正确。

## 2. `scripts/bootstrap-community.ts` — 一键起一个社区(测试网)

命令:`pnpm bootstrap:community --root <name.eth> --owner <0x...> [--dry-run]`

步骤(每步幂等,失败可重跑):
1. 跑 preflight,不过就停。
2. 部署 `L2RecordsV3(owner)` 到 OP Sepolia,打印地址。
3. 计算并打印 `namehash(root)`。
4. 输出一份**可直接粘贴的收尾清单**:要设置的 `.env` 值、
   要在 ENS 上执行的 `setResolver(<HybridResolver>)` 操作、验证命令。
5. `--dry-run` 只打印将要做什么,不发交易。

验收:在 OP Sepolia 真跑一次,拿到合约地址,且 `owner()` == 传入的 owner。

## 3. `scripts/delegate.mjs` — 委托管理(**模式 A 的操作面**,不是模式 B)

```
pnpm delegate:grant  --parent <name.eth> --to <0x...> [--quota N] [--expiry <ISO8601>]
pnpm delegate:status --parent <name.eth> [--of <0x...>]
pnpm delegate:revoke --parent <name.eth> --from <0x...>
```

对应合约调用:`addRegistrar` / `getRegistrarInfo` / `removeRegistrar`(均 `onlyOwner`)。

⚠️ **定位澄清**:因为这三个调用都是 `onlyOwner`,它们只在**调用者就是合约 owner**时可用,
即"社区自部署后把日常发放权委托出去"(模式 A)。**模式 B 用不上它们** ——
托管场景 owner 是我们,社区没有这个杠杆,其撤销只能在 L1 改 resolver。
任何 CLI 帮助文本与文档都不得暗示这是模式 B 的撤销手段。

状态机:

```
未授权 ──grant──▶ 已授权(quota=N, expiry=T)
   ▲                    │
   │                    ├── 每次发子域 quota-- (quota=max 时不减)
   └──revoke────────────┤
                        └── block.timestamp > expiry ⇒ RegistrarExpired
```

错误处理(必须区分并给出不同提示):
- `Unauthorized` — 调用者不是合约 owner ⇒ "你不是这套合约的 owner,无法授权"
- `QuotaExceeded` — 配额用尽 ⇒ "该 registrar 配额已用尽,用 updateRegistrarQuota 追加"
- `RegistrarExpired` — 已过期 ⇒ "授权已于 <时间> 到期,需重新 grant"
- `ZeroAddress` — 传了 0 地址

## 4. 设计系统 `src/styles/design-system.css`

必须定义的 token(名字固定,页面只引用不重定义):

```
--c-bg --c-surface --c-border --c-text --c-text-muted
--c-accent --c-accent-hover --c-success --c-warn --c-danger
--sp-1..--sp-8            间距阶梯
--fs-xs..--fs-2xl        字号阶梯
--radius-sm/md/lg  --shadow-sm/md
```
必须提供的组件类:`.btn` `.btn-primary` `.btn-ghost` `.input` `.card`
`.badge` `.alert-{info,success,warn,error}` `.skeleton` `.empty-state`。

硬性要求:
- 支持深浅色(`prefers-color-scheme`),token 在两种模式下都定义。
- 375px 宽不出现横向滚动。
- 每个交互按钮有 `:hover`/`:focus-visible`/`:disabled` 三态。

## 5. 状态反馈规范(替换现有 alert/裸文本)

任何链上操作必须走四态:
`idle → pending(带 loading + 交易哈希链接) → success(可复制结果) | error(人话原因 + 重试入口)`

禁止:`alert()`、`console.log` 当作用户反馈、无 loading 直接卡住。

## 6. 测试凭据来源(重要)

- **L1 Sepolia RPC**:`~/Dev/.env` 的 `SEPOLIA_RPC`。
- **OP Sepolia RPC**:`.env.local` 的 `OP_SEPOLIA_RPC_URL` **当前是坏的**
  (Alchemy 返回 403 `OPT_SEPOLIA is not enabled for this app`)。
  夜间一律使用已实测可用的公共节点 **`https://sepolia.optimism.io`** 作为默认值,
  并允许用环境变量覆盖。任何脚本必须在 RPC 不可用时给出明确报错而不是静默重试。
- **合约地址**:`.env.local` 的 `VITE_L2_RECORDS_ADDRESS=0x8836E89D…` 与线上不一致;
  **线上真实地址以 `workers/*/wrangler.toml` 为准 = `0xbA692CdfDA33916BbE8d2a1f23E80218db8ebFDc`**。
  夜间任务读取地址时以 wrangler.toml 为准,不要信 `.env.local`。
- **私钥**:`~/Dev/.env` **没有**任何私钥;必须用仓库 `.env.local` 里的
  `PRIVATE_KEY_JASON` / `WORKER_EOA_PRIVATE_KEY` / `PRIVATE_KEY_SUPPLIER`。
- 私钥只允许出现在进程环境里,**绝不写进任何提交的文件、日志或 PR 描述**。

## 7. 两条授予路径(已存在的能力,本轮做的是产品化)

CometENS 是组件,不做用户登录。子域名由**授予**产生,共两条路径,端点均已实现:

### 7.1 API 自动授予(上游大系统调用)

```
POST /v1/register
鉴权:personal_sign,recover 出的签名者必须 ∈ UPSTREAM_ALLOWED_SIGNERS
入参:{ label, owner, parent }
返回:{ ok: true, name, node, txHash }
```
本轮要补的**不是**端点,而是:
- 上游接入文档(含一段可复制的 Node/TS 调用范例)
- 失败语义表(标签已占用 / 非法标签 / parent 不在白名单 / 签名者未授权)
- 一个 e2e 测试证明「上游签名 → 子域真的 mint 给目标地址」

### 7.2 管理员手动授予(控制台点按)

复用已有端点:`/register`(发子域)、`/set-addr`、`/set-text`、
`/add-registrar`、`/remove-registrar`、`/transfer-subnode`。
本轮要补的是**产品级操作面**:表单校验、四态反馈、错误说人话、操作结果可复制。

### 7.3 公开只读(免登录)

`/check-label`(标签是否可用)、`/lookup`(解析)、`/check-owner`、`/root-domains`。
公开查询页只依赖这几个端点,**不需要连钱包、不需要登录**。
