# progress — 仓库实时状态

> 每推进一步就更新这份文件。`run` 持续维护。

## 此刻状态(2026-09-04,run 循环进行中)

- **DONE**:T1.0.1(PR #22 已合并)、T1.1.1(PR #23 已合并)
- **PR_OPEN**:T1.2.1 → PR #24;T1.5.0 → 本分支
- **规划层**:PR #21 已合并进 `preview`,`preview` 现为集成分支
- **跟进账本**:3 个 OPEN(FU-1 计数过期、FU-2 守卫覆盖面、FU-3 变异测试规程)
- **可清理的 worktree**(safe-cleanup 已列出,**删除由人执行**):
  `CometENS-F1.0`、`CometENS-F1.1`、`CometENS-plan`

## T1.2.2 OP Sepolia 实跑记录(2026-09-04)

按验收要求真跑了一次 `bootstrap:community --execute`:

| 项 | 值 |
|---|---|
| 合约 | `0xa67e4160618c0f7ad27508d23cd32379a5411c62` |
| 交易 | `0x939af95eef18e9fdd3a8401c3a797b76b50e23b966983bad6f211694185b187c` |
| 部署者 | `0xb5600060e6de5E11D3636731964218E53caadf0E` |
| `owner()` | `0x0000000000000000000000000000000000C0FFEE` ✓ 等于 `--owner` |

**owner 刻意取了一个不同于部署者的地址**——若两者相同,「owner() 等于 --owner」
这个断言在脚本忽略 `--owner` 时也会通过,那就是一次空验证。

两个由实跑暴露的问题(不实跑发现不了):
1. **preflight 当场拦住了第一次部署** —— 它检出 `.env.local` 里那个 403 的
   Alchemy RPC(正是 T1.0.1 那个 bug),拒绝在坏配置上继续。这一步的价值当场兑现。
2. **部署后立刻读 `owner()` 会与 RPC 索引赛跑**,公共节点返回 `0x`,而当时脚本
   直接抛栈退出 —— **用户付了 gas 却看不到合约地址**。已改为先打印地址再验证,
   并对读取加重试。第一次那个合约 `0x67FA4B682535466AaE05149E6a799c632e188a12`
   是靠 `cast compute-address` 按 nonce 推算才找回来的。

## 实测基线(2026-09-03 本机实跑)

| 项 | 结果 |
|---|---|
| `forge test` | **198 passed / 0 failed** |
| `pnpm vitest run test/unit/` | **101 passed / 0 failed**(7 文件) |
| `pnpm typecheck` | 干净,无输出 |

任何 PR 不得让上述三项退化。

## 已部署(测试网)

| 组件 | 位置 |
|---|---|
| 前端 | https://cometens.pages.dev |
| Gateway Worker | https://cometens-gateway.jhfnetboy.workers.dev |
| API Worker | https://cometens-api.jhfnetboy.workers.dev |
| L2RecordsV3 / HybridResolver | OP Sepolia / Ethereum Sepolia(地址见 `.env.local` 与 `docs/roadmap.md`) |

主网:**未部署,本阶段不做**。

## 待决事项

### ✅ ① 集成分支 `preview` —— 已解决(2026-09-03 建立并推送)
`main` 的 `required_approving_review_count=0` 会让 `--allow-trunk` fail-closed,
因此改走集成分支流:feature PR → `preview`,由人定期把 `preview` 合进 `main`。
分支已存在于本地与 origin。

### ② 评审服务需在另一会话启动
pilot 不自审自 PR。用户将启动 pr-daemon 承担该角色;
开 PR 后本会话用 ListAgents 找到该会话并对接。

### ✅ ③ TB.3 密钥架构 —— 已决策(2026-09-03)
KMS(TEE)保管密钥 + 三角色密钥分离 + owner 冷存不用于日常写入 + 签名器抽象
(自部署用 env-key,托管用 kms)。落地为 F1.5。
其中 **T1.5.0(网关签名钥热轮换)不依赖此决策,可立即做**。
注意:KMS 解决密钥保管,**不改变** owner 在链上被允许做什么,须在文档如实披露。

### ✅ ④ TB.4 自助注册流 —— 已决策(2026-09-03)
改造为「申请 → 审批 → 授予」,审批**可配置**:`auto`(自动批准,等价当前线上行为,
向后兼容)/ `manual`(管理员队列审批)。落地为 F1.6。

### ⚠️ ⑤ 环境阻塞(已给出兜底,见 T1.0.1)
- `.env.local` 的 `OP_SEPOLIA_RPC_URL`(Alchemy)返回 **403 OPT_SEPOLIA is not enabled**。
  夜间一律用公共节点 `https://sepolia.optimism.io`(已实测可用)。
- `.env.local` 的 `VITE_L2_RECORDS_ADDRESS=0x8836E89D…` 与线上 wrangler 的
  `0xbA692Cdf…` **不一致**。以 wrangler.toml 为准。

## ⚠️ 执行须知(run 每次开 worktree 都会撞,必读)

**新建的 worktree 里没有 `node_modules`**,于是 `pnpm run build` 报
`sh: vite: command not found` → `preflight.sh run` 失败 → **`git-guard.sh pr-create` 被拒,PR 开不出来**。
pilot 规定「一个 Feature = 一个专属 worktree」,所以**每开一个新 worktree 都会撞一次**。
本次 plan 阶段已实测复现两次。

**建 worktree 之后、跑 preflight 之前,必须先补依赖**,二选一:

```bash
# 快(推荐):链接主 checkout 的 node_modules
# <主checkout> 换成你自己这个仓库主 clone 的绝对路径(symlink 不能用相对路径可靠解析)
ln -s <主checkout>/node_modules <worktree>/node_modules

# 或:老实安装(慢,但完全独立)
cd <worktree> && pnpm install
```

漏了这一步的表现是 preflight FAIL 而非报缺依赖,容易误判成"代码有问题",别往那个方向查。

## 凭据可用性(已核实,未打印任何值)

| 需要 | 来源 | 状态 |
|---|---|---|
| Sepolia RPC | `~/Dev/.env` → `SEPOLIA_RPC` | ✅ 有 |
| Etherscan Key | `~/Dev/.env` → `ETHERSCAN_API_KEY` | ✅ 有 |
| OP Sepolia RPC | 仓库 `.env.local` → `OP_SEPOLIA_RPC_URL` | ✅ 有 |
| 部署/运营私钥 | 仓库 `.env.local` → `PRIVATE_KEY_JASON` / `WORKER_EOA_PRIVATE_KEY` | ✅ 有 |
| 私钥 in `~/Dev/.env` | — | ❌ **没有**,该文件只有 RPC 与各类 API key |

## 变更日志

- **2026-09-03(第四轮,pr-daemon REQUEST_CHANGES 后)**:修掉 3 条恒真/弱验收命令 ——
  T1.3.1 的 `grep -c "owner"` 恒真(现在就返回 25)改为精确检出
  `test_ownerCanStillRegisterAfterRevoke`;T1.3.1 性质 2 拆为正对照 2a + 具体 selector 2b;
  T1.1.1 的 "token≥10" 改用 `test … -ge 10` 真检查。修正 architecture.md 中归错的引用
  (配额绕过在 `_checkRegistrarQuota:183` 而非 :67),补 `setPrimaryNode:237`。
  新增 T1.5.0(网关签名钥热轮换,不依赖任何待决事项)。
- **2026-09-03(第三轮,用户拍板)**:TB.3 / TB.4 决策落定,新增 F1.5 / F1.6 共 6 个 task,
  T1.3.2 解除阻塞。
- **2026-09-03(第二轮,Codex 对抗式 review 后)**:修正 Mode B 信任模型的错误表述;
  T1.3.1 增加"owner 绕过"反向断言以堵死假阳性;新增 T1.0.1(RPC/地址漂移修复)、
  TB.3(密钥架构决策)、TB.4(register.html 处置);修正 roadmap 与 tasks 的依赖矛盾;
  preflight 增加密钥复用检查与"禁止打印私钥"硬要求。
- **2026-09-03** `pilot plan`:建立 `docs/agent/` 七件套 + `.pilot.yml`;
  完成产品化差距分析;拆出 F1.1–F1.4 共 11 个 READY task、2 个 BLOCKED。
  *(计数是 2026-09-03 立项当时的;后续拆分与新增见 tasks.md,那里才是现值。)*
  按用户口径修正范围:仅测试网、CometENS 为大系统组件、终端用户免登录、子域为授予制。

## 2026-09-04 · M1 验收逐条实核

主线 task 与跟进账本(FU-5 除外)全部完成。**2026-09-04 补:FU-5 已提升为 T1.7.1 / T1.7.2,两者均已完成(#73 / #74),此处的例外不再存在。**对 `acceptance.md` 逐条核实,读数如下。

### 代码侧:满足

| 判据 | 读数 |
|---|---|
| A1 preflight 部署前报错 | 可运行;`PREFLIGHT_KEY_SEPARATION=stict` → exit 2(拼错不静默降级) |
| A2 一条命令部署 | `pnpm bootstrap:community`,OP Sepolia 实跑过(`0xa67e416…`) |
| B1 委托生效 | 链上实测:`aastar.eth` 与 `forest.aastar.eth` 的 resolver 均为 HybridResolver `0xA54D63a6…` |
| B3 信任模型如实披露 | `DELEGATED-HOSTING.md` 写明覆写记录 / 收回 NFT / 改 registrar,并把三处逃生舱指到具体测试 |
| 成员两条路径 | API 自动(`/v1/register`,e2e 9 处链上断言)+ 管理员手动(`admin.ts:435`) |
| 界面三页 | 落地页 / 公开查询页 / 管理控制台均已重做 |

### ⛔ A4 未满足 —— 我原先用来"证明"它满足的那个读数,支撑的是相反结论

我写过:「`SELF-HOSTING.md` 里我们的 worker 域名出现 **0 次**」,并把它当成
"自部署不依赖我们"的证据。**那个 0 是真的,但它推不出那个结论。**

```
src/config.ts:49
  apiUrl:     env.VITE_API_URL     || 'https://cometens-api.jhfnetboy.workers.dev'
  gatewayUrl: env.VITE_GATEWAY_URL || 'https://cometens-gateway.jhfnetboy.workers.dev'
                                       ^^^ 我们的 worker,是**内置默认值**

'VITE_API_URL' 在 SELF-HOSTING.md 出现次数 = 0
  [正对照] 同一串在别处 6 个文件里出现 —— 那个 0 不是量具坏了
SELF-HOSTING.md:152「配好 .env.local(四个变量…)」—— 四个里没有这两个
```

**照着 SELF-HOSTING.md 从头走完的自建者,构建出的前端默认指向我们的 worker,
而文档里没有任何一处会让他发现。** 而「域名在文档里出现 0 次」**正是他发现不了的原因**。

同一个事实,我读成了"文档没依赖我们",实际是"文档没告诉他他依赖着我们"。

> **对照证明的是"量具能出非空读数",不是"这个读数支持你的结论"。**
> 对照挡得住坏仪器,挡不住错推理,这两道要分开走。(pr-daemon,#52)

产品侧怎么修另开 PR;这里只把账本记准 —— **一条被错记成满足的判据,比一条空着的更贵,
它会让后来的人跳过检查。**

### 未验证:三条,都不在代码里

1. **A3 —— 一个陌生开发者用自己的测试域名跑通全流程。**
   我原先写的理由是"写文档的人核不了",那**不太站得住**(很多作者照自己的文档能走通)。
   真正的理由是:**A3 的总体是"一个陌生人",而我按定义不是这个总体里的样本。**
   我真去走一遍,拿到的读数回答的是「这些步骤能不能跑通」—— A2/B1 已经各自答过了。
   它答不了 A3 真正问的:**一个不知道我脑子里那些默认假设的人,会不会在第 3 步卡住。**
   我带着全部上下文去走,恰恰是唯一保证不会卡住的走法。
   换成这个理由之后,它顺带说清了什么才算数:**一个没参与过这个仓库的人,一次录屏或一份卡点清单。**
2. **B2 —— 撤销可验证(社区在 L1 改回自己的 resolver)。** 需要域名持有者的 L1 私钥。
3. **⚠️ 线上 API worker 缺 4 个端点**(`/apply` `/approval-mode` `/applications` `/approve`,
   部署顺序检查实测(该命令随 PR #51 落地))。**申请/审批功能对外目前不存在。**
   代码在 `preview` 上,但没部署 = 没上线。

### 有判据但给不出读数

一条都不列会让上面那张表看起来是完整的,所以列在这里,每条一句为什么:

| 判据 | 为什么没有读数 |
|---|---|
| A3 陌生开发者 2 小时跑通 | 见上 —— 我不在那个总体里 |
| B2 撤销可验证 | 需要域名持有者的 L1 私钥 |
| 「界面像产品不像 demo」 | 描述性判据。**给不出读数的自评没有价值**,列在这里是为了让这张表的覆盖面本身可读 |

### 台账会漂,而且是同一个成因(2026-09-04 第二次)

`tasks.md` 里有五个 task 标着 `PR_OPEN`,而它们的 PR **全部 MERGED**
(#35 #38 #41 #42 #45,逐个查过而不是推断)。

**成因:每个分支只改自己那条状态,合并之后没人回头改别人的。**
我在 #41 修过一次同样的漂移,它又长回来了 —— 说明那次是"清理",不是"修根因"。

根因是这个流程本身:PR_OPEN → DONE 这一步发生在**合并之后**,
而合并时那个分支已经不在手上了。可行的对策有两条,都不在本次范围:
① 状态改成从 PR 状态推导而不是手写;② 合并动作里带一步"把该 task 标 DONE"。
在那之前,**这个计数会周期性地失真,而且失真方向恒定(偏向"还在进行中")**。

已把标注改成 `DONE (PR #n)` —— 带上 PR 号,下次核对不需要再搜一遍。

### 一个反复出现的自身错误,记在这里

今晚三次把**匹配不到的模式**当成"这东西不存在"的证据:
`str.replace` 锚点写错(静默无操作)、核对模式漏了反引号、
双引号里的 `\|` 在 ERE 下是字面反斜杠。三次都读出 0,三次都不是真的 0。

**规程(两条,顺序不能颠倒)**:

1. 临时 shell 核对里的"应当不存在"检查,必须在同一次运行里配一格**已知存在**的对照。
   这条在测试里一直在做,但在随手的命令行核对里没做 —— 而后者更容易被直接当结论汇报。
2. **对照过了之后,再单独问一次:这个读数支持我要下的那个结论吗?**
   A4 就是反例 —— 那个 0 通过了对照(它是真 0),然后被用去支撑一个它推不出的结论。
   **对照挡得住坏仪器,挡不住错推理。**
