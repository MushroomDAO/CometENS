# 自部署:用你自己的 .eth 跑一套 CometENS

> 目标:一个从没见过这个项目的开发者,照着走 **2 小时内跑通,全程不需要联系我们**。
> 当前只覆盖**测试网**(OP Sepolia + Ethereum Sepolia)。主网见 roadmap 的 M2。

## 为什么自部署

因为这样你**不需要信任任何人**。

托管模式下运营方持有合约 owner 私钥和网关签名钥,技术上能覆写你成员的记录、
转走他们的子域 NFT,以及**让任何名字对任何查询者解析到任何地址**(网关签名钥那条
连 proof 模式都挡不住)。那不是缺陷,是那套架构的必然结果 ——
详见 [DELEGATED-HOSTING.md](DELEGATED-HOSTING.md)。

自部署把这些钥匙放在你手里。代价是你要自己保管它们。

---

## 前置

| 需要 | 说明 |
|---|---|
| 一个你拥有的 `.eth` 名字 | 在 **Ethereum Sepolia** 上。子域名会发在它下面 |
| Node ≥ 20 + pnpm | 本仓库用 pnpm |
| [Foundry](https://getfoundry.sh) | 编译与部署合约 |
| 一个 Cloudflare 账号 | 两个 Worker 跑在上面(免费额度够用) |
| 少量测试网 ETH | OP Sepolia(部署合约)与 Ethereum Sepolia(设置 resolver) |

```bash
git clone <this repo> && cd CometENS
pnpm install
```

---

## 第 1 步 — 先检查配置,别急着部署

```bash
pnpm preflight
```

它会检查必需变量、私钥格式、**有没有把私钥放在 `VITE_` 前缀下**(那会被编译进浏览器包
公开分发)、密钥角色是否复用、RPC 能不能连通且 chainId 正确、合约是否存在。

FAIL 就停下来先修。这一步不是形式:我们自己第一次跑 bootstrap 时,
**它当场拦下了一个 403 的 RPC 配置** —— 那个 RPC 的服务商账号没启用 OP Sepolia,
每次调用都失败,而错误会出现在三步之后的无关位置。

> `pnpm preflight` 不需要任何配置就能跑。
>
> ⚠️ **刚 clone 完时它不会说"什么都没配"** —— 仓库自带的 `wrangler.toml` 里是**我们的**
> 参考部署,所以合约地址、根域名、owner 都读得出来。它会明确告诉你这些是**仓库示例值、
> 不是你的**(检查项 1 与 8 报 WARN)。看到那两条 WARN 就说明你还没开始配,
> 而不是配好了。等你把自己的值填进 `wrangler.toml`,它们会变回 PASS。

---

## 第 2 步 — bootstrap

先看它要做什么(**不发任何交易**):

```bash
pnpm bootstrap:community --root 你的名字.eth --owner 0x<你的多签地址> --dry-run
```

确认无误后真跑:

```bash
pnpm bootstrap:community --root 你的名字.eth --owner 0x<你的多签地址> --execute
```

它会跑一遍 preflight、编译合约、把 `L2RecordsV3` 部署到 OP Sepolia,
然后**读回 `owner()` 确认构造参数真的生效**,最后打印一份收尾清单。

**`--owner` 用你控制的多签,不要用热钱包。** 这个地址将拥有绕过一切限制的权力
(发放任意子域、覆写任意记录、转移任意 NFT、改任意反向解析)。
付 gas 的账户可以是另一个热钱包 —— 用 `DEPLOYER_PRIVATE_KEY` 指定,它**不必是 owner**。

---

## 第 3 步 — 部署 L1 resolver

**bootstrap 不做这一步。** L2Records 存记录,但 Ethereum 上还需要一个 resolver 合约
把 CCIP-Read 请求转给你的网关:

```bash
cd contracts
forge script script/DeployHybridResolver.s.sol --rpc-url <eth sepolia rpc> --broadcast --slow
```

> `--slow` 不是可选的:如果你的部署账户做过 EIP-7702 委托,RPC 会限制在途交易数,
> 不加会中途失败。

记下部署出来的地址。

---

## 第 4 步 — 配置并部署两个 Worker

把第 2、3 步的地址填进 `workers/api/wrangler.toml` 和 `workers/gateway/wrangler.toml`
的 `[env.testnet.vars]`:

```toml
L2_RECORDS_ADDRESS = "0x<第 2 步的地址>"
ROOT_DOMAIN        = "你的名字.eth"
ALLOWED_SENDERS    = "0x<第 3 步的 resolver 地址>"   # gateway 侧
```

设置密钥(**用 wrangler secret,不要写进 toml**):

```bash
cd workers/gateway && wrangler secret put PRIVATE_KEY_SUPPLIER --env testnet
cd ../api        && wrangler secret put WORKER_EOA_PRIVATE_KEY --env testnet
```

> 这两把钥匙**应该是不同的**,而且都不应该是第 2 步那个 owner。`pnpm preflight`
> 的检查项 3b 会告诉你它是**验证到了**分离,还是只是**没看到**那几把钥匙 ——
> 后者在密钥保管得当时是正常的。

部署:

```bash
cd workers/gateway && wrangler deploy --env testnet
cd ../api          && wrangler deploy --env testnet
```

---

## 第 5 步 — 在 ENS 上指过去

在 Ethereum Sepolia 上,把 `你的名字.eth` 的 resolver 设成第 3 步那个地址:

```
ENS Registry.setResolver(namehash("你的名字.eth"), 0x<你的 L1 resolver>)
```

用 [app.ens.domains](https://app.ens.domains) 或 `cast send` 都行。
**工具不替你做这一步** —— 它是一笔发生在你自己名字上的交易,
不该由一个部署脚本代持你的账户。

---

## 第 6 步 — 验证

按这个顺序,前两条不需要任何额外配置:

```bash
pnpm check:chain     # chainId、合约地址、owner()
pnpm preflight       # 全量配置检查
```

然后配好 `.env.local`(**六个变量**,前两个来自第 2 步,第三个来自第 3 步,
最后两个指向**你自己部署的 workers**):

```
VITE_ROOT_DOMAIN=你的名字.eth
VITE_L2_RECORDS_ADDRESS=0x<第 2 步>
VITE_L1_OFFCHAIN_RESOLVER_ADDRESS=0x<第 3 步>
VITE_L1_SEPOLIA_RPC_URL=<一个 Ethereum Sepolia RPC>

# ⚠️ 这两个不设的话,前端会**默认指向我们的 worker** —— 你的部署会依赖我们。
VITE_API_URL=https://<你的 api worker>.workers.dev
VITE_GATEWAY_URL=https://<你的 gateway worker>.workers.dev
```

> 这两个默认值(`src/config.ts`)是为了让本仓库的开发者不配任何东西就能跑起来。
> 对**自建者**它们是错的默认值:不覆盖就等于把解析和写入都托给我们,
> 而构建过程不会有任何提示。`pnpm preflight` 现在会检出这一点。

发一个子域,然后端到端解析:

```bash
bash scripts/resolve-testnet.sh alice.你的名字.eth
```

**最终验收是用第三方工具解析出你的地址**,而不是看我们的脚本说成功:

```ts
import { createPublicClient, http } from 'viem'
import { sepolia } from 'viem/chains'

const client = createPublicClient({ chain: sepolia, transport: http('<你的 L1 RPC>') })
const addr = await client.getEnsAddress({ name: 'alice.你的名字.eth' })
// 返回 alice 的地址即为成功
```

> 新记录需要等一段挑战期才具备去信任的证明解析路径。在那之前解析走签名模式,
> 结果是对的,但信任模型不同 —— 见 README 的 Resolution Modes 一节。

---

## 常见问题排查

下面每一条都是我们自己踩过的,不是设想出来的。

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 所有 RPC 调用返回 403 / `is not enabled for this app` | 服务商账号没为该网络启用 | 在服务商后台启用 OP Sepolia,或改用公共节点 `https://sepolia.optimism.io` |
| `preflight` 报 `VITE_… 看起来是私钥` | 私钥放在了 `VITE_` 前缀下 | **改名并把那把钥匙当作已泄露处理** —— `VITE_` 变量会被编译进浏览器包公开分发 |
| `--owner is required`,但你明明传了 | 地址位数不对 | 必须是 `0x` + **40 位**十六进制(共 42 字符)。我们自己数错过一次 |
| 部署成功但脚本报 `owner() returned no data` | 刚部署的合约,读请求打到了还没同步的节点 | 脚本已内置重试;若仍失败,**合约是好的**,用打印出来的地址手动 `cast call <addr> 'owner()(address)'` 核对 |
| `forge script` 中途失败,报在途交易限制 | 部署账户做过 EIP-7702 委托 | 加 `--slow` |
| 解析返回空,但 `check:chain` 正常 | ENS 上还没 `setResolver`,或 resolver 地址填错 | 回到第 5 步;用 `cast call <ENS Registry> 'resolver(bytes32)(address)' <namehash>` 核对 |
| `resolve-testnet.sh` 报缺变量 | `.env.local` 少了第 6 步那四个中的某个 | 四个都要,少一个就跑不完 |
| Worker 报 `ROOT_DOMAIN not configured` | `wrangler.toml` 改了但没重新 `wrangler deploy` | 重新部署 |

---

## 你现在拥有什么

- **合约 owner** 是你指定的地址。发放、改记录、转移 NFT 的最终权力在你手里。
- **网关签名钥**在你手里 —— 也就是说没有第三方能伪造你的域名的解析结果。
- **成员的子域是真正属于他们的** ERC-721:他们可以自己改记录、自己转让。
  但要清楚:**你作为 owner 仍然能覆写和收回**。如果你希望对成员做出更强的承诺,
  把 owner 交给一个成员参与的多签,是目前唯一能兑现的做法。

## 想把日常发放权交出去

你可以把某个父域名下的发放权授予一个热钱包或某个小组,带配额和到期,**可随时撤销**:

```bash
pnpm delegate grant  --parent finance.你的名字.eth --to 0x<小组地址> --quota 100
pnpm delegate status --parent finance.你的名字.eth --of 0x<小组地址>
pnpm delegate revoke --parent finance.你的名字.eth --from 0x<小组地址>
```

⚠️ **撤销只对被授权方生效,对 owner 自己不生效** —— owner 无条件绕过允许列表、
配额与到期。这一点有测试钉住
(`contracts/test/L2RecordsV3.t.sol::test_ownerCanStillRegisterAfterRevoke`)。

写命令默认拒绝对**已部署的线上合约**动手,必须显式 `--i-know-this-is-live`。
指向你自己的部署时用 `--contract 0x<你的地址>`。

---

## 部署顺序:先 API worker,后前端

前端和 API worker 是**分开部署**的,所以前端可能先上线、调用一个还不存在的端点。
这不是假想 —— 2026-09-04 实测,线上 worker 还没有 `/apply`、`/approval-mode`、
`/applications`、`/approve`,而已发布的前端会调它们四个。

```bash
pnpm check:deploy-order                  # 默认查 VITE_API_URL 或内置的测试网地址
pnpm check:deploy-order --api-url https://your-api.workers.dev
```

它把前端**源码里实际打的端点**列出来(不是一份手写清单 —— 手写只能覆盖有人记得的),
逐个探活。退出码:

| exit | 含义 |
|---|---|
| 0 | 全部存在,可以发前端 |
| 1 | 有端点缺失 —— **先 `cd workers/api && wrangler deploy --env testnet`** |
| 2 | 查不了(网络不通,或探针自检失败)—— **不是通过**,重试 |

> 探针自己带一格对照:先探一个**必然不存在**的路径,如果那个也被判成"存在",
> 说明这台 worker 分不清有无路由,整轮结果无意义 → 直接 exit 2。
