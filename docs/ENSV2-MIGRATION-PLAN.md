# ENSv2 迁移方案 — v0.9.0 规划

*2026-09-04 · 依据 ENSv2 正式文档（`/ensv2/*`，站点自述「contracts and interfaces are **not yet final**」）*

> 上游文档已镜像到本地：`pnpm docs:ens`。我们依赖的每条事实带出处，见
> [`docs/reference/ENSV2-UPSTREAM.md`](./reference/ENSV2-UPSTREAM.md)。

---

## 0. 这份文档取代了什么

仓库里已有 [`docs/ensv2-impact-analysis.md`](./ensv2-impact-analysis.md)（2026-04）。它的结论是
**「Nothing immediately. 现有部署继续工作。」**

那半句今天仍然成立，而且是这次读文档最重要的确认之一。**过期的是另外半句** —— 它当时只回答了
「V2 会不会打断我们」，没有回答「V2 内置了多少我们正在自己造的东西」。

答案是：**很多。而且集中在我们最吃力的那几块。**

两份文档的分工，写清楚免得下一个人以为它们矛盾：

| | `ensv2-impact-analysis.md`（2026-04） | 本文档（2026-09） |
|---|---|---|
| 问题 | V2 上线会不会让我们的东西不能用？ | V2 内置了什么，让我们可以少造什么？ |
| 结论 | 不会。CCIP-Read / `IExtendedResolver` 完全不变 | **仍然不会**，但有 6 处我们绕远实现的能力，V2 是原生的 |
| 仍然有效的部分 | 第 2、4 节（CCIP-Read 与 unruggable gateways） | — |
| 被本文档修正的部分 | 「(b) 我们需要更新什么：**Nothing**」 | 改成「不更新也能跑，但**不更新就要一直自己维护 V2 已经做掉的六件事**」 |

---

## 1. ENSv2 的核心变化（只保留对 CometENS 有影响的）

### 1.1 扁平 registry → 每个名字自己的 registry

ENSv1：一个全局 registry，靠 namehash 定位。
ENSv2：`inigo.montoya.eth` 是**一条跨多个 registry 的链** —— `montoya.eth` 的 registry 里有
`inigo` 这一条，`.eth` 的 registry 里有 `montoya` 这一条，用 subregistry 指针串起来。

`IRegistry` 接口只有三个函数（文档原话「deliberately minimal」）：

```solidity
getSubregistry(label)   // 向下走
getResolver(label)      // 找记录
getParent()             // 向上验证规范链
```

解析用**最长后缀匹配**：从根往下走，记住路径上最深的那个 resolver。父名过期或 subregistry 被摘掉
→ registry 返回 `address(0)` → **所有子名自动停止解析**。

### 1.2 NameWrapper fuse → Enhanced Access Control（EAC）

这是六条里最重要的一条。

| | ENSv1 NameWrapper | ENSv2 EAC |
|---|---|---|
| 粒度 | 整个名字 | 2^256 个 resource × 64 个 role（32 常规 + 32 admin） |
| 持有者 | 1 | **每个 role 每个 resource 最多 15 个** |
| 撤销 | ❌ **fuse 烧掉不可逆** | ✅ `revokeRoles`，随时 |
| 委托 | 无 | admin role（`role << 128`）可再授权 |

`ROOT_RESOURCE`（0x0）是主钥匙：在它上面授的 role 在全合约生效。role 检查同时看具体
resource 和 ROOT_RESOURCE。

### 1.3 共享 PublicResolver → 每账户一个 resolver 实例

每个账户通过 VerifiableFactory 部署自己的 UUPS 代理 resolver。权限分三层：root（所有名字所有
记录）/ name 级 / **record 级（某个 key 或某个 coinType）**。

带来两个我们没有的能力：

- **记录别名（Record Aliasing）** —— 一个名字直接引用另一个名字的记录，不复制。
- **记录版本（`clearRecords()`）** —— 版本计数器加一，一次清空全部记录。转让时用。

### 1.4 ERC-721 → ERC1155Singleton，且 **tokenId 是会变的**

每个 token 恰好一个 owner（`balanceOf` 只返回 0 或 1，转账 value 必须是 1）。

**`tokenId` 在 role 变更或过期重注册时会变** —— 旧 token 烧掉、新 token 铸给同一个 owner，
发 `TokenRegenerated(oldTokenId, newTokenId)`。文档原话：**"Token IDs are not stable identifiers."**
应用要存 labelhash，用 `getTokenId(anyId)` 现查。

设计意图是防抢跑：卖家挂单后偷偷撤 role，token id 一变，市场那笔转账直接失败。

### 1.5 registry / registrar 分层

registry 存名字和权限；registrar 管业务逻辑（定价、可用性、限额）。registrar 只要在 registry 的
`ROOT_RESOURCE` 上拿到 `ROLE_REGISTRAR` + `ROLE_RENEW` 就能发子名。

文档里那句警告值得抄在这里 —— 它直接对应我们的委托托管信任模型：

> "the roles that remain on `ROOT_RESOURCE` define how much subname owners must trust _you_."

### 1.6 DNS 名字原生进 ENS

`.com` / `.box` / `.cv` 这类 DNS 域名，开了 DNSSEC 之后，UniversalResolverV2 会自动：
查 v1 registry → **CCIP-Read 取 DNSSEC 签名的 TXT** → 解析 `ENS1` 前缀 → 委派给指定 resolver。

两种现成玩法，都不用自己写合约：

```
ENS1 dnstxt.ens.eth a[60]=0x1234... t[avatar]=https://...   # 记录直接写在 TXT 里
ENS1 dnsalias.ens.eth com base.eth                          # sub.example.com → sub.example.base.eth
```

---

## 2. 逐条对照：我们绕远实现的 vs V2 内置的

这一节是本文档的主体。每一行的判断依据都写在「凭什么这么判」列里，方便下一个人推翻。

| # | CometENS 现在的做法 | ENSv2 原生 | 判断 | 凭什么这么判 |
|---|---|---|---|---|
| 1 | **委托托管的撤销**：`L2RecordsV3.removeRegistrar()` + `onlyOwner`，撤销要靠我们自己不作恶；验收项 **B2「撤销可验证」自 M1 起一直无法验证** | `revokeRoles(resource, role, account)`，链上一笔交易，发事件 | ✅ **V2 完胜** | EAC 明写可撤销、最多 15 个持有者；我们的 `_registrars` mapping 只有 owner 能改，**社区要「验证我们撤不掉他」根本没有链上凭据可看** |
| 2 | **三角色密钥分离**（T1.5.2）：supplier 签名钥 / worker 写入钥 / owner 钥，靠**在合约外分密钥**模拟权限分层 | EAC role 分层 + admin role，**在合约里** | ✅ **V2 完胜** | 我们做的是「谁拿哪把私钥」，V2 做的是「谁有哪个 role」。前者丢钥即失控且无法审计，后者可撤销、有事件 |
| 3 | **registrar quota / expiry**：`registrarQuota` / `registrarExpiry` 两个 mapping + 自建校验 | PermissionedRegistry 内置 expiry + `AVAILABLE / RESERVED / REGISTERED` 状态机 + `ROLE_REGISTRAR` / `ROLE_RENEW` | ✅ **V2 更完整** | 我们没有 RESERVED 态（预留名字）、没有宽限期、没有 renew 语义 |
| 4 | **反向解析**：`setPrimaryNode` / `primaryNode` 自建 mapping，只在我们自己的合约里有意义 | `L2ReverseRegistrar` 每链一份 + `setNameForAddrWithSignature`（**gasless / 跨链**）+ inception timestamp 防重放 | ✅ **V2 完胜** | 我们那套**任何第三方钱包都不会去查** —— 它不是 ENS 反向解析，是我们合约的私有字段 |
| 5 | **多根域名**：`ROOT_DOMAINS` 环境变量，配置驱动 | 每个名字自己的 registry，**多根是结构本身** | ✅ **V2 更干净** | 我们的多根是 worker 里的一个字符串 split；V2 的多根是链上不同 registry 实例 |
| 6 | **M3 Web2 域名桥接**（`.box` / `.cv`，见 `DNS-DOMAIN-INTEGRATION.md` / `DNSSEC-VERIFY-RUNBOOK.md`） | `DNSTXTResolver` / `DNSAliasResolver`，DNSSEC + CCIP-Read 全内置 | ✅ **M3 大部分可以不做** | `dnsalias.ens.eth com base.eth` 这一条 TXT 就实现了我们 M3 想要的 `alice.mushroom.cv` 映射 |
| 7 | **子域名 NFT**：ERC-721，`tokenId = uint256(node)`，稳定 | ERC1155Singleton，**tokenId 会变** | ⚠️ **各有取舍** | 我们的稳定 id 对索引友好；V2 的可变 id 换来抢跑保护。**这条不是「我们绕远了」，是设计取向不同** |
| 8 | **记录清空 / 换主残留** | `clearRecords()` 版本计数器 | ✅ V2 有，我们没有 | 我们转让子域时旧记录会留下 |
| 9 | **记录别名** | Record Aliasing + `AliasChanged` | ✅ V2 有，我们没有 | 社区身份页（`IDENTITY-PAGES-PLAN.md`）想要的「一个人多个名字同一份资料」正是它 |

### 不变的部分（这几条撑住了整个迁移的可行性）

- **CCIP-Read / ERC-3668 / `IExtendedResolver` 完全不变。** 文档原话："All the libraries mentioned
  above implement CCIP Read"，并让开发者拿 `test.offchaindemo.eth` 做回归。
  → `OffchainResolver.sol`、`OPResolver.sol`、`HybridResolver.sol`、两个 worker **一行不用改**。
- **unruggable-gateways 仍是 ENS 指定的 L2 去信任路径**，没有被 V2 取代。
- **UniversalResolverV2 只是换了遍历方式**，`resolve()` / `reverse()` 对调用方一致。

---

## 3. 一条不能照搬的：为什么是按层拆，不是整体迁移

**用户的原话是「把整个东西都迁到 V2 上」。这里必须先说一句不同意见，然后我按完整方案继续。**

> **本节结构在 PR#99 评审后重排过。** 初稿把 gas 账当主论据、架构理由当补充，
> 而那笔账缺一个决定性变量（见 §3.2）。**现在主论据是架构，gas 是佐证** ——
> 这样即使 L1 变便宜、或用户规模远低于预期，结论仍然成立。
> 一个靠估算撑着的结论，会随估算一起晃。

### 3.1 主论据：按层拆本来就是 ENSv2 自己指的形态（不依赖任何估算）

ENSv2 的核心分层是 **registry 管权限、registrar 管业务逻辑**
（`tutorial-contract-developers.mdx`）：registrar 在 registry 的 `ROOT_RESOURCE` 上拿到
`ROLE_REGISTRAR` + `ROLE_RENEW`，就能发子名；定价、可用性、限额全在 registrar 这一侧。

**CometENS 的 L2 就是那个 registrar**，只不过跑在另一条链上，中间用 CCIP-Read 连。
这不是我们绕过 V2 的一种妥协形态，**这是 V2 给 registrar 留的位置**。

配合 1.5 引的那句：

> "the roles that remain on `ROOT_RESOURCE` define how much subname owners must trust _you_."

在按层拆的形态下，这句话**恰好可以当作我们对社区的公开承诺** ——
社区看得见我们手上只有 `ROLE_REGISTRAR`，而 `ROLE_SET_RESOLVER` 在他们自己手里。
整体迁到 L1 反而没有这个结构可讲。

### 3.2 佐证：gas 账 —— 以及它缺的那个数

**先说清楚这一步的依据，因为初稿在这里引错了。** F2 那句
"all resolution still starts on Ethereum Mainnet" 讲的是 **resolution**，
**它不蕴含「注册必须在 L1」** —— CCIP-Read 的全部意义正是解析入口在 L1、数据在别处，
而我们的结论恰恰依赖那一点成立。初稿把注册成本挂在这句引文下面，读起来像已被证明，实际没有。

**「注册在 L1」的真实依据是另外两条**：

1. ENSv2 的 registry 是 L1 合约 —— 目前公开的部署**只有 Sepolia**
   （`docs/reference/ensv2-deployments-sepolia.md`，34 个合约，chainId 11155111），
   没有任何 L2 部署。
2. 上游文档通篇**没有 L2 registry** 这个东西（§7 未决 4）；对 L2 的说法只有
   "improved support for existing L2 solutions" —— 也就是**通过 CCIP-Read 委派，正是我们在做的事**。

在此基础上：把子名注册搬到 V2 registry = **每注册一个子名一笔 L1 交易**。谁付？

- 用户付 → 不再免费，产品定位没了
- 我们付 → 成本是子名数量 N 的函数

**而这份文档给不出 N。** 我全文找过：预期子名规模没有记录，每名 L1 gas 也没有实测。
所以下表是**敏感度，不是结论**（假设：register ≈ 50k gas、10 gwei、ETH $3,000 ⇒ ≈ $1.5/名；
三个数都会变，V2 的 `register()` 实际 gas 我们没测过）：

| 子名数 N | ≈ L1 成本 | 占冷启动预算 $135,800 |
|---|---|---|
| 10,000 | $15,000 | 11% —— 扛得住 |
| 50,000 | $75,000 | 55% —— 很痛，但不致命 |
| 100,000 | $150,000 | **110% —— 超过全部预算** |

**如实标注：我不知道 `launch.mushroom.cv` 的预期规模，所以我无法判断「扛不住」是真是假。**
我能确立的只有一件事：**这一段在拿到 N 之前不能证明它自己的结论**。那个数只有维护者有。

**这不影响 §3.1。** 架构论据不依赖 N —— 即使 N 小到 gas 完全无所谓，
registry/registrar 分层仍然是 V2 给我们留的位置。gas 只决定这件事有多急，不决定方向。

### 3.3 结论形态

```
L1 (Ethereum) —— ENSv2 registry + EAC
    治理层：根域名归谁、谁能发子名、怎么撤销
    数量级：每个社区几笔交易，一次性
                    │
                    │  CCIP-Read (ERC-3668)  ← 完全不变
                    ▼
L2 (Optimism) —— L2Records + Gateway
    数据层：子域名记录、免费注册
    数量级：每个用户若干笔，持续
```

---

## 4. 目标形态（v0.9.0）

```
                       ┌─────────────────────────────────────┐
                       │  L1: ENSv2                          │
  社区 owner  ────────▶│  aastar.eth 的 PermissionedRegistry │
   （持根域名）         │                                     │
                       │  EAC roles on ROOT_RESOURCE:        │
                       │    ROLE_REGISTRAR  → CometENS       │◀── 社区随时 revokeRoles
                       │    ROLE_SET_RESOLVER → 社区自己保留  │    （这就是 B2）
                       │                                     │
                       │  resolver → CometENS OffchainResolver│
                       └──────────────┬──────────────────────┘
                                      │ CCIP-Read（不变）
                       ┌──────────────▼──────────────────────┐
                       │  L2: Optimism                       │
                       │  L2Records（子域记录，免费）          │
                       │  Gateway Worker（签名 / 证明 / 混合） │
                       └─────────────────────────────────────┘
```

### 4.1 B2「撤销可验证」—— 已在 Sepolia 实证(2026-09-04)

M1 的验收项 B2 卡了整个里程碑。它卡住不是因为没做,而是**现有结构里做不出来**:
`L2RecordsV3.removeRegistrar()` 是 `onlyOwner`,owner 是我们 —— 社区只能拿到一句承诺,
**没有任何链上凭据能让他们自己验证「我们撤不掉他」**。

`pnpm probe:ensv2-eac --execute` 在 ENSv2 的真实 Sepolia 部署上跑完了整个生命周期:

| 步骤 | 结果 | tx |
|---|---|---|
| 1. 社区部署自己的 registry(VerifiableFactory) | `0x673c11ce…fd2d` | [`0x38e71b4e…`](https://sepolia.etherscan.io/tx/0x38e71b4eb762b394f010475d3925e0850c3c9e5898ae0d6f9dd46a56ea0e5d55) |
| 2. 授 `ROLE_REGISTRAR` 给「CometENS」 | `hasRootRoles = true` | [`0xd17e2860…`](https://sepolia.etherscan.io/tx/0xd17e2860ed3546a8a2a433deb718c91366ce71cc020a8a519e7ce506ea979bf0) |
| 3. 委托方注册子名 `delegated` | **成功**,`findOwner` 归委托方 | [`0xf007bf4b…`](https://sepolia.etherscan.io/tx/0xf007bf4b606aac192e322fa24445534ce0c57babc49533bbc385feac87f8e05e) |
| 4. **社区撤销** ← 这就是 B2 | `hasRootRoles = false` | [`0x25ee90c8…`](https://sepolia.etherscan.io/tx/0x25ee90c82ca7d95e01937ded650ea54086135009b0ab7aedafe4380abef0f7e8) |
| 5. 委托方再注册 | **revert** | — |

**判据是第 5 步,而它需要对照组才算数。** 在同一个 registry 上实测:

```
owner(有 ROLE_REGISTRAR)   → 可注册
从未授权的陌生地址          → revert: EACUnauthorizedAccountRoles
撤销后的委托方              → revert(同一类)
```

委托方用的是**一次性生成的钥匙**,不是复用 owner —— 否则第 5 步的 revert 可能来自
「owner 恰好还有别的 role」而不是撤销生效。**判据要求两个身份真的不同。**

意义:社区不需要相信我们的承诺,也不需要拿到我们的私钥。**他们自己发一笔交易,
然后任何人拿这几个 hash 就能复核。** 这是 CometENS 现有结构给不出的东西。

⚠️ 上游明写合约未定稿(F10),所以这里证明的是**机制成立**,不是这些地址将来还在。

---

**一句话说清 v0.9.0 卖点**：社区把「发子名」这个 role 授给我们，**而且能自己一笔交易收回去** ——
不需要相信我们的承诺，不需要拿到我们的私钥，链上看得见。

---

## 5. 分阶段方案

### M4.1 — 不动生产的前置（可以立刻开始）

| Task | 内容 | 依赖 |
|---|---|---|
| T4.1.0 | 建立本地文档镜像 + 同步脚本（`pnpm docs:ens`），把我们依赖的上游事实摘进 `docs/reference/ENSV2-UPSTREAM.md` | ✅ **本 PR 已完成** |
| T4.1.1 | 在 Sepolia 上跑通 ENSv2：部署一个 PermissionedRegistry，注册一个子名，`grantRoles` / `revokeRoles` 各跑一次并留下 tx hash | 地址表已就位（`docs/reference/ensv2-deployments-sepolia.md`，`contracts-v2@97a5729`，部署于 2026-07-30） |
| T4.1.2 | 把 `resolve()` 的回归测试指向 UniversalResolverV2，并加 `test.offchaindemo.eth` / `ur.integration-tests.eth` 两条外部基线 | 无 |
| T4.1.3 | 放开 `bootstrap-community.mjs` / `delegate.mjs` 的 `.eth` 专用校验 —— **前置于 M3 与 DNS 名字，不是当前 bug**（见下） | M3 或 V2 DNS 落地时才必须 |
| T4.1.4 | 写路径 resolver 地址：**当前不适用**（见下），等 M4.2 引入 EAC 写路径时一并立规矩 | M4.2 |

#### T4.1.3 / T4.1.4 的实际审计结果（2026-09-04 实跑，**修正本文档初稿的说法**）

初稿在这里写的是「它们是当前代码里的真实缺陷」。**跑完审计发现这句说过头了，两条都不是当前缺陷。**
如实记在原地，因为一份夸大风险的方案会让下一个人在错的地方花时间：

**T4.1.3 —— 是限制，不是 bug。** 只有两处硬编码 `.eth`：

```
scripts/bootstrap-community.mjs:65   /^([a-z0-9-]+\.)+eth$/  → 拒绝非 .eth 根域
scripts/delegate.mjs:117             同上
```

但**当前配置的每个根域名都是 `.eth`**（`workers/api/wrangler.toml`：
`aastar.eth,forest.aastar.eth,game.aastar.eth`），而 `.box` 走的是 `src/main.ts` 里
另一条等官方接口的独立流程，**根本不经过这两个脚本**。所以今天没有任何用户会撞上它。

它会在两件事之一发生时变成真 bug：M3 的 `mushroom.cv` 落地，或 V2 的 DNS 名字进来。
**在那之前它是个待办，不是欠债。**（`Brood/orgs/mycelium/INTERFACES.md` 里那句
「多根域名支持：.box, .cv, .zparty.eth」相对这两个脚本是**超前声明** —— 那份文件在
Brood 仓库，不归本 PR 改，但值得下次同步时对齐。）

**T4.1.4 —— 当前不适用。** F8 警告的是「通过 resolver 写记录」这条路径。
CometENS 的写路径是 `API worker → L2Records`，**不经过任何 ENS resolver**；
`src/config.ts:47` 的 `l1ResolverAddress` 只用于读侧解析。
真正需要立这条规矩的时刻是 M4.2 引入 EAC 写路径的时候，那时再立。

### M4.2 — 治理层迁到 EAC（本次迁移的核心价值）

| Task | 内容 |
|---|---|
| T4.2.1 | 用 EAC role 模型重写委托托管：`ROLE_REGISTRAR` 授给我们，`ROLE_SET_RESOLVER` 留给社区 |
| T4.2.2 | ~~B2「撤销可验证」改成真验收~~ → ✅ **已在 Sepolia 实证,见 §4.1**(tx hash 在那里) |
| T4.2.3 | `delegate` CLI 重写：`grant` / `revoke` / `status` 三个子命令直接打 EAC |
| T4.2.4 | `DELEGATED-HOSTING.md` 重写信任模型章节 —— 从「我们承诺不作恶」改成「你随时可以撤，这是命令」 |

### M4.3 — 退役自建件

| Task | 内容 | 备注 |
|---|---|---|
| T4.3.1 | 退役 `setPrimaryNode` / `primaryNode`，改用 `L2ReverseRegistrar` | 我们那套第三方钱包不会查 |
| T4.3.2 | `registrarQuota` / `registrarExpiry` 交给 PermissionedRegistry | 保留 L2 侧的免费额度控制 |
| T4.3.3 | 多根域名从 `ROOT_DOMAINS` 环境变量改成「每根一个 registry」 | 配置 → 链上结构 |
| T4.3.4 | 接入 `clearRecords()` 语义：子域转让时清空旧记录 | 当前是真 bug，转让后旧记录还在 |

### M4.4 — M3 缩水（省下来的那部分）

原 M3「Web2 域名桥接」大部分被 `DNSAliasResolver` 吃掉。剩下要做的只有：
在 `mushroom.cv` 上加一条 `ENS1 dnsalias.ens.eth cv <root>.eth` TXT，验证 DNSSEC 链。
**原计划里的自建 DNS 解析合约全部删除。**

---

## 6. 需要用户拍板的（不替你决定）

| # | 问题 | 为什么不能由我定 |
|---|---|---|
| P1 | **子域名 NFT 换到 ERC1155Singleton 吗？** 换 = 跟 V2 一致 + 抢跑保护；不换 = tokenId 稳定，已发出去的 NFT 不失效 | 这是对已有持有者的兼容性承诺，是产品决策 |
| P2 | **v0.9.0 是否等 ENSv2 主网？** 文档明写接口未定稿、无上线日期 | 押上线时间是商业判断 |
| P3 | **§3 的「按层拆」你接受吗？** 你说的是「整体迁到 V2」，我给的是「治理上 L1、数据留 L2」 | 主论据是架构（§3.1，不依赖估算）；gas 只是佐证 |
| P4 | **`launch.mushroom.cv` 的预期子名规模 N 是多少？** | §3.2 的敏感度表在 N=10k 和 N=100k 之间从「11% 预算」翻到「超预算」。**这个数只有你有**，没有它那一段证明不了自己的结论 |

---

## 7. 未决与风险

1. ~~拿不到 Sepolia 部署地址表~~ → **已解决。** 那张表不在 docs 仓库里，它在 build 时从
   `ensdomains/contracts-v2` 的一个钉住的 commit 拉取。现在由 `pnpm docs:ens --addresses`
   生成到 [`docs/reference/ensv2-deployments-sepolia.md`](./reference/ensv2-deployments-sepolia.md)
   （`contracts-v2@97a5729`，部署于 2026-07-30，34 个合约）。**T4.1.1 不再被阻塞。**
2. **接口未定稿。** `/ensv2/registry-hierarchy` 和 `/ensv2/registry-template` 都明写
   "not yet final and may change prior to mainnet deployment"。**据此写死的合约代码有返工风险。**
   这是 M4.2 排在 M4.1 之后的原因：M4.1 的四条都不依赖 V2 合约 ABI 定稿。
3. **`/ensv2/hidden-contract-accounts` 仍未读到正文，但已知它是真的。** 那一页只存在于**预览部署**
   （调研用的 `e115ad60…` 域名），上游 `ensdomains/docs@master` 的导航和 `src/pages` 里都没有它。
   不过 Sepolia 地址表里有 `StandaloneHCAFactory` / `HCAOwnerAndSessionValidator` 等 5 个 HCA 合约，
   部署脚本里也出现 `src/hca/StandaloneSingleOwnerHCA.sol` —— **HCA 存在且已部署，只是文档没公开。**
   本文档没有任何判断基于它。
3b. **调研用的 URL 是预览部署，不是官方站。** 见 [`ENSV2-UPSTREAM.md §2`](./reference/ENSV2-UPSTREAM.md)。
   现在有了本地镜像，后续判断一律以镜像为准 —— 预览域名的哈希前缀说不清它对应哪个 PR。
4. **ENSv2 没有把 L2 registry 变成一等公民。** 文档只说 "improved support for existing L2 solutions"。
   我们的 L2 价值主张没有被吃掉 —— 但也意味着**没有官方的 L2 registry 可以直接用**，L2 那一半仍然自建自维护。
5. **mutable tokenId 会打穿索引。** 如果 P1 选了换，所有存了 tokenId 的地方（前端、SDK、KV 缓存）
   都要改成存 labelhash + 监听 `TokenRegenerated`。

---

## 8. 一句话结论

**不用迁也能活（CCIP-Read 不变），但迁了能少维护六件事，其中一件是 M1 至今验收不掉的 B2。**

迁移的正确形态是**按层拆**：L1 用 ENSv2 的 EAC 管治理与委托，L2 保留免费子域记录，
中间的 CCIP-Read 一行不改。

**这个判断的依据是架构，不是成本**：registry 管权限、registrar 管业务逻辑是 V2 自己的分层，
我们的 L2 就是那个 registrar（§3.1）。gas 账（§3.2）只说明这件事有多急，
而且**它在拿到预期规模 N 之前证明不了自己**——那个数在 §6 列为 P4，等你给。
