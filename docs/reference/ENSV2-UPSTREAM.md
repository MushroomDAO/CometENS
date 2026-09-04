# ENSv2 上游文档 — 本地镜像与我们依赖的事实

*建立于 2026-09-04*

---

## 1. 本地镜像怎么用

```bash
pnpm docs:ens                 # 拉最新,并列出 ensv2/ 下变了哪些页面
pnpm docs:ens --check         # 不联网,只报告当前状态
pnpm docs:ens --addresses     # 顺带刷新 Sepolia 部署地址表
```

镜像落在 `vendor/ens-docs/`(**gitignore,不提交**),源是 <https://github.com/ensdomains/docs>,
许可 **CC0 1.0**。ENSv2 的正文在 `vendor/ens-docs/src/pages/ensv2/*.mdx`,17 个页面 336K,
本地 grep 比开浏览器快得多。

**为什么不把上游文档整份提交进来**:CC0 没有法律障碍,问题是陈旧。一份提交进仓库的副本不会自己更新,
而它看起来和上游一模一样 —— 下一个人不会去核对日期。三个月后它开始撒谎,且没有任何机制会喊。
所以整份走 gitignore 的克隆,**只有我们的方案实际依赖的事实**摘到本文件,带来源和抓取日期。

**§3 那张表由 `pnpm check:ensv2-citations` 机械守住** —— 表里每一条双引号引文,
都必须能在镜像里找得到,找不到就 exit 1。这条护栏是 PR#100 评审逼出来的:
「可核对」在那之前只是一句承诺,没有任何东西检查它。**护栏上线当天就抓出两条**
(F5、F10)—— 都不是编造,是**从渲染后的页面抄的引文丢了源码的强调标记**
(上游写 `*you*`,抄下来是 `you`)。所以脚本比对前会去掉 `*` `_` 和反引号:
去掉的是 markup 不是内容,改错一个词仍然会被抓到(反向对照验过)。

`pnpm docs:ens` 会打印上游 HEAD 和自上次同步以来变更的页面。浅克隆丢了旧 commit 时它会
**明说「无法 diff」并列出监视路径**,而不是打印「没变化」—— 静默的「没变化」比报错危险。

---

## 2. ⚠️ 我们最初读的是**预览部署**,它领先于上游默认分支

调研用的 URL 是 <https://e115ad60.docs-bao.pages.dev/ensv2/>,这是一个 **Cloudflare Pages 预览部署**,
不是 <https://docs.ens.domains>。两者已确认不一致:

| | 预览站 `e115ad60…` | 上游 `ensdomains/docs@master` |
|---|---|---|
| `ensv2/*` 主要页面 | 有 | 有(17 页,一致) |
| **`ensv2/hidden-contract-accounts`** | **导航里有** | **不存在**(`vocs.config.tsx` 无此条目,`src/pages` 无此文件) |

所以 `pnpm docs:ens` **不会**把 hidden-contract-accounts 拉下来 —— 它还没进上游默认分支。
（那一页的正文我们三次抓取都只拿到导航壳,从未读到,见 §4。）

**结论**:预览 URL 可以用来抢先看,但**任何写进方案的判断都要以本地镜像为准**,
因为镜像的来源和 commit 是可追的,预览 URL 的哈希前缀说不清它对应哪个 PR。

---

## 3. 我们的方案依赖的上游事实（逐条带出处）

抓取日期均为 2026-09-04;路径相对 `vendor/ens-docs/`。

| # | 事实 | 出处 |
|---|---|---|
| F1 | CCIP-Read / ERC-3668 在 V2 里原封不动;文档让开发者拿 `test.offchaindemo.eth` 做回归 | `src/pages/web/ensv2-readiness.mdx` **+ 已实测,见下** |
| F2 | **"all resolution still starts on Ethereum Mainnet"** —— V2 是 L1,多链靠委派 | `src/pages/web/ensv2-readiness.mdx:26` |
| F3 | `IRegistry` 只有 `getSubregistry` / `getResolver` / `getParent`;解析走最长后缀匹配 | `src/pages/ensv2/registry-hierarchy.mdx` |
| F4 | EAC:2^256 resource × 64 role(32 常规 + 32 admin)× 每 role 最多 15 个持有者;`revokeRoles` **可撤销** | `src/pages/ensv2/enhanced-access-control.mdx` |
| F5 | **"the roles that remain on `ROOT_RESOURCE` define how much subname owners must trust _you_"** | `src/pages/ensv2/tutorial-contract-developers.mdx:462` |
| F6 | 每账户一个 resolver 实例(VerifiableFactory + UUPS);权限可细到单条记录 | `src/pages/ensv2/permissioned-resolver.mdx` |
| F7 | **"Token IDs are not stable identifiers."** role 变更/过期重注册会 `TokenRegenerated` | `src/pages/ensv2/mutable-token-ids.mdx` |
| F8 | **"Do not hardcode a resolver address for write flows, not even one you deployed."** | `src/pages/ensv2/tutorial-app-developers.mdx` |
| F9 | DNS 名字:`ENS1 dnsalias.ens.eth com base.eth` 一条 TXT 即可把 `sub.example.com` 映射到 `sub.example.base.eth` | `src/pages/ensv2/dns-resolvers.mdx` |
| F10 | 合约与接口 **"not yet final and may change prior to mainnet deployment"** | `src/pages/ensv2/registry-hierarchy.mdx`、`registry-template.mdx` |
| F11 | 常见错误:只匹配 `.eth` 会漏掉 DNS 名字 | `src/pages/web/ensv2-readiness.mdx` |
| F12 | 上游对 L2 的全部说法只有 "improved support for existing L2 solutions" —— **没有 L2 registry 这个东西**,多链靠 CCIP-Read 委派 | `src/pages/web/multichain.mdx:7` |

> **F1 不再只是引文 —— 它现在有实测。** `pnpm check:ensv2` 拿 ENSv2 在 Sepolia 真实部署的
> `UniversalResolverV2`(`0x4a1817d1…`)解析 `forest.aastar.eth`,2026-09-04 实跑结果:
>
> ```
> OffchainLookup raised   yes     ← revert selector 0x556f1830
> CCIP-Read followed      yes
> resolver reported       0xae66c62A…  (ENSV1Resolver 镜像 —— 根域名还在 v1,符合预期)
> ```
>
> 反向对照:`pnpm check:ensv2 --name vitalik.eth`(v1 上有真实地址的名字)走同一个 URv2
> **不触发 OffchainLookup,检查 FAIL** —— 所以这条判据不是恒绿的。
>
> 这条之所以要实测而不是引用:整个迁移方案的可行性都压在它上面,
> **而上游同一批文档还写着接口 not yet final**。一句散文撑不起「一行不用改」这种结论。

---

## 4. 已知拿不到的

- **`ensv2/hidden-contract-accounts` 正文**。预览站导航里有,上游默认分支没有,三次抓取只回导航壳。
  但 Sepolia 地址表里确有 `StandaloneHCAFactory` / `StandaloneHCAImplementation` /
  `HCAOwnerAndSessionValidator` / `HCAUpgradeGate` / `TrustedHCASet` 五个合约,
  且 docs 仓库的部署脚本里出现路径 `project/src/hca/StandaloneSingleOwnerHCA.sol`
  —— 所以 **HCA = Hidden Contract Account 是真实存在且已部署的**,只是文档还没公开。
  **本仓库任何方案都没有基于它的判断**,等这一页进了上游再评估。
- **主网上线日期**。上游文档全站没有。
- **主网地址**。只有 Sepolia。

---

## 5. Sepolia 部署地址

见 [`ensv2-deployments-sepolia.md`](./ensv2-deployments-sepolia.md)(由 `pnpm docs:ens --addresses` 生成)。

那张表**不在 docs 仓库里** —— docs 在 build 时从 `ensdomains/contracts-v2` 的一个**钉住的 commit**
拉取。同步脚本从 `vendor/ens-docs/scripts/ensv2-deployments.ts` 里读那个 SHA,而不是自己写死,
所以上游换部署时我们跟着换,不会拿旧地址当真。

当前钉住:`contracts-v2@97a5729`,部署于 **2026-07-30**。我们要用到的几个:

| 合约 | Sepolia 地址 |
|---|---|
| `UniversalResolverV2` | `0x4a1817d13e9cf196f471725176355c1234b63c70` |
| `UpgradableUniversalResolverProxy` | `0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe` |
| `RootRegistry` | `0x8115186e8f2e0b0281e86ab91f0f48ba90364354` |
| `ETHRegistry` | `0xbdc85dd5b15d7ecb354cd7cb6f2c50b4f2c4f0e2` |
| `ETHRegistrar` | `0xa88553f454b77203b0d036a05c894d555eaaa2cc` |
| `VerifiableFactory` | `0x10dc6333cdfe1fcef624c6e0a8221b91804cd7ef` |
| `PermissionedResolverImpl` | `0x9eae5c2730a7dd16bdd1dee6421a1b91e3b0365e` |
| `UserRegistryImpl` | `0x624a25d67b59d587752ebec8dded8827dae52050` |
| `ENSV1Resolver`(v1 回退) | `0xae66c62acae72098bdac57d8e8aed53ef000b2ba` |

> ⚠️ **写路径不要照抄 resolver 地址**(F8)。上表里的 resolver 是 **implementation**,
> 每个账户的实例由 VerifiableFactory 另行部署 —— 写之前现查。

---

## 6. 上游给 AI 的入口（不用爬网页）

`https://docs.ens.domains/building-with-ai/` 列了三条,前两条我们能直接用:

- <https://docs.ens.domains/llms.txt> —— 精简版
- <https://docs.ens.domains/llms-full.txt> —— 全量版
- Context7 MCP:`claude mcp add context7 -- npx -y @upstash/context7-mcp`

**但优先用本地镜像。** `llms-full.txt` 是拍平的一大坨,拿它做逐条核对时找不到某句话属于哪一页;
本地 mdx 有文件边界,引用时能指到具体页面 —— §3 那张表的「出处」列就是这么来的。
