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
  按用户口径修正范围:仅测试网、CometENS 为大系统组件、终端用户免登录、子域为授予制。
