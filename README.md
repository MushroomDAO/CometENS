# CometENS

**给社区成员一个属于他们自己的 ENS 名字。** 开源、可自部署、Apache-2.0。

社区拥有一个 `.eth` 域名,成员加入时获得它下面的一个子域名 —— `alice.community.eth`。
成员可以自己改记录、可以转让,不需要经过谁。

> ⚠️ **当前仅测试网**(OP Sepolia + Ethereum Sepolia)。主网未上线。

[English](#english) · [自部署指南](docs/SELF-HOSTING.md) · [上游 API](docs/UPSTREAM-API.md) · [委托托管](docs/DELEGATED-HOSTING.md)

---

## 它解决什么

ENS 官方提供根域名注册,不提供"社区如何低成本地向成千上万成员分发子域并托管解析"。
在 L1 上每发一个子域都要付 gas,规模化不可行。

CometENS 把记录写在 Optimism,解析走 CCIP-Read(EIP-3668),L1 上只需要一次 `setResolver`。
分发成本趋近于零。

```
社区拥有一级域名           community.eth          ← 归社区,正常持有,不交给任何人
   ↓ 成员加入
成员获得二级域名           alice.community.eth    ← ERC-721,归成员本人
   ↓
全网可解析                 viem.getEnsAddress('alice.community.eth')
```

子域名由**授予**产生,不是自助注册:上游系统调 API 自动授予,或管理员在控制台手动发放。
成员不需要在这里注册账号、不需要登录。

## 两种用法

| | 自己部署 | 交给运营方代跑 |
|---|---|---|
| 谁持有密钥 | **你** | 运营方 |
| 你要做什么 | 部署一套(约 2 小时) | 在 ENS 上做一次 `setResolver` |
| 怎么收回 | 不适用 —— 本来就在你手里 | 改回你自己的 resolver,立即生效 |
| 需要信任谁 | **不需要信任任何人** | 信任运营方这个组织 |

**托管模式有一条必须先读清楚的**:已发出的子域,运营方在技术上仍能覆写记录、
收回 NFT,并且**能让任何名字对任何查询者解析到任何地址**(那条连 proof 模式都挡不住)。
这不是缺陷,是那套架构的必然结果 —— 详见 [DELEGATED-HOSTING.md](docs/DELEGATED-HOSTING.md)。

自部署把这些能力放到你手里。代价是你要自己保管密钥。

## 快速开始

**自部署** → [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)(六步 + 排查表,全部基于实跑)

```bash
pnpm install
pnpm preflight                                        # 先检查配置,别急着部署
pnpm bootstrap:community --root your.eth --owner 0x… --dry-run
```

**从上游系统接入 API** → [docs/UPSTREAM-API.md](docs/UPSTREAM-API.md)(含失败语义表与调用范例)

**查一个名字**(免登录、不连钱包)→ 前端的 `/lookup.html`

## 已部署(测试网)

| | 地址 |
|---|---|
| L2RecordsV3 (OP Sepolia, 11155420) | `0xbA692CdfDA33916BbE8d2a1f23E80218db8ebFDc` |
| HybridResolver (Ethereum Sepolia, 11155111) | `0xA54D63a6223B66EDED35286522336e45F21BE512` |
| Gateway Worker | https://cometens-gateway.jhfnetboy.workers.dev |
| API Worker | https://cometens-api.jhfnetboy.workers.dev |

> ⚠️ **这台 API worker 上还没有申请/审批那组端点**(`/apply` `/approval-mode`
> `/applications` `/approve`)—— 代码在本仓库里,但**没部署 = 没上线**。
> 也就是说:仓库里的注册页会调它们,而线上这台目前返回 404。
> 自己跑一遍看现状:`pnpm check:deploy-order`。

> **地址的唯一事实来源是 `workers/*/wrangler.toml`**,不是这张表也不是 `.env.local` ——
> 本地文件漂移过。`pnpm check:chain` 会读 wrangler 并核对链上状态,请以它为准。

## 解析模式 — 用户拿到什么,你信任谁

对终端用户,两种模式的结果完全一样;区别只在**信任假设**:

| | 签名模式 | 证明模式 |
|---|---|---|
| 用户能力 | 名字全网可解析 | **相同** |
| 信任 | 信任网关签名钥 | 去信任 —— L1 合约验证 OP 链数据的 Merkle 证明 |
| 新记录延迟 | **即时** | 需等 OP 争议期 |
| 状态 | 已实现,默认 | 已实现(`PROOF_MODE=true`) |

CometENS **按记录年龄自动组合两者**,并刻意避开昂贵的"乐观证明"路径:

- **新记录(< ~7 天)→ 签名模式**。OP 存储证明只能证明**已终局**的 L2 状态,
  刚写入的记录还没终局,证明覆盖不到它。
- **老记录(≥ ~7 天)→ 终局证明模式**(`MIN_AGE_SEC=0`)。此时 Bedrock 存储证明
  既**快**(锚点根视为有效,无挑战窗校验循环)又**完全去信任**。

乐观证明路径(`MIN_AGE_SEC > 0`)是唯一同时有冷启动开销**和**更弱信任假设的那条,
CometENS 完全不走。结果:新名字即时解析,老名字额外获得去信任可验证性,
**不需要任何证明索引服务或缓存预热基础设施**。

> 直接在 Optimism 上读 `L2Records` 的 dApp/SDK **本来就是去信任的**(不经过网关)。
> 信任问题只存在于通用 ENS 钱包走的那条 **L1 CCIP-Read 路径**。

## 开发

```bash
pnpm dev            # 前端 dev server,端口 4173
pnpm build          # 生产构建
pnpm typecheck      # 类型检查(窄口径:只 src/)
pnpm check:typecheck-scope   # 宽口径:test/ server/ sdk/ + 两个 worker,带错误预算
pnpm test           # 全部测试

pnpm vitest run test/unit/        # 单元测试(快,无网络)
pnpm vitest run test/e2e/         # E2E(需 Anvil + pnpm dev)
pnpm vitest run test/integration/ # 集成(需 .env.local 真实 RPC)

cd contracts && forge test        # Solidity 测试

pnpm check:chain    # 链与合约连通性
pnpm preflight      # 部署前配置校验
pnpm delegate       # registrar 授权 / 查询 / 撤销(模式 A)
pnpm check:approval-sha <PR>  # 合并前:批准的 commit 是不是当前 head
```

`pnpm typecheck` 保持窄口径(`src/`)并始终 rc=0 —— 一个红着的门禁会没人看。
更宽的范围由 `pnpm check:typecheck-scope` 管,它跑一个**允许有错误预算**的配置,
**超预算和低于预算都失败**(低于时要求同一个提交里把预算一起降下来)。
它还单独跑 `workers/gateway` 自己的 tsconfig —— 那份配置一直存在、写得也对,
但在此之前**没有任何东西执行它**,所以没人发现它根本编译不过。

> 网关 worker 是带自有 lockfile 的独立 pnpm 项目。
> 第一次跑 `check:typecheck-scope` 前先 `cd workers/gateway && pnpm install`,
> 否则它会报缺依赖(它会明说是缺依赖,不会伪装成类型错误)。

Cloudflare Workers 部署:

```bash
cd workers/gateway && pnpm install && wrangler deploy --env testnet
cd workers/api     && wrangler deploy --env testnet
```

## 架构

```
第三方 DApp / viem
   ↓ getEnsAddress('alice.community.eth')
L1 ENS Registry → HybridResolver → [OffchainLookup] → Gateway Worker
                                                            ↓
                                                    L2RecordsV3 (Optimism)
                                                            ↓
                                        签名应答 或 Bedrock 存储证明
```

Vite + TypeScript,无框架。唯一运行时依赖是 **viem**。合约用 Foundry。

- `contracts/` — `L2RecordsV3`(ERC-721 子域 + registrar 插件)、`HybridResolver`、`OPResolver`
- `workers/gateway/` — CCIP-Read 解析(签名 / 证明双模式)
- `workers/api/` — 写操作、申请与审批、只读查询
- `sdk/CometENS.ts` — 第三方集成 SDK,直接读 L2,不经过网关
- `docs/agent/` — 规划层(路线图、任务台账、架构边界)

更多:[架构与边界](docs/agent/architecture.md) · [路线图](docs/agent/roadmap.md) · [密钥轮换](docs/KEY-ROTATION.md)

## License

Apache-2.0。开源、免费、无许可 —— 任何人都可以使用、修改和部署。

---

<a name="english"></a>

## English

**Give community members an ENS name that is genuinely theirs.** Open source, self-hostable, Apache-2.0.

A community owns one `.eth` name; members receive a subdomain under it — `alice.community.eth`.
Members can edit their own records and transfer the name without going through anyone.

> ⚠️ **Testnet only** (OP Sepolia + Ethereum Sepolia). Mainnet is not live.

Records live on Optimism and resolve through CCIP-Read (EIP-3668), so issuing a subdomain
costs effectively nothing — the L1 side needs a single `setResolver`.

Two ways to run it: **self-host** (you hold every key, you trust nobody) or **delegated**
(one `setResolver`, revocable at any time — but read
[DELEGATED-HOSTING.md](docs/DELEGATED-HOSTING.md) first: the operator retains the technical
ability to overwrite records, reclaim NFTs, and forge resolution responses — **the last of
which proof mode does not prevent**).

Start here: [SELF-HOSTING.md](docs/SELF-HOSTING.md) · [UPSTREAM-API.md](docs/UPSTREAM-API.md)
