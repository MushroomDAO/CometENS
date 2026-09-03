# progress — 仓库实时状态

> 每推进一步就更新这份文件。`run` 持续维护。

## 此刻状态(2026-09-03,plan 阶段刚结束)

- **分支**:`main`(干净),无 open PR,无 open issue
- **集成分支**:`preview` ✅ 已创建并推送 origin(与 main 同点)
- **版本**:v0.7.0(测试网发行)
- **在做**:无(等待用户确认后启动 `pilot run`)

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

### 🔴 ③ TB.3 托管模式密钥架构 —— 需用户拍板(不阻塞夜间其余任务)
线上 owner / writer / gateway signer 是同一把私钥,且 owner 绕过一切限制。
详见 tasks.md TB.3。**在拍板前不写 DELEGATED-HOSTING.md。**

### 🔴 ④ TB.4 register.html 自助注册流处置 —— 需用户拍板
与"用户不登录、授予制"定位冲突,且已上线。详见 tasks.md TB.4。

### ⚠️ ⑤ 环境阻塞(已给出兜底,见 T1.0.1)
- `.env.local` 的 `OP_SEPOLIA_RPC_URL`(Alchemy)返回 **403 OPT_SEPOLIA is not enabled**。
  夜间一律用公共节点 `https://sepolia.optimism.io`(已实测可用)。
- `.env.local` 的 `VITE_L2_RECORDS_ADDRESS=0x8836E89D…` 与线上 wrangler 的
  `0xbA692Cdf…` **不一致**。以 wrangler.toml 为准。

## 凭据可用性(已核实,未打印任何值)

| 需要 | 来源 | 状态 |
|---|---|---|
| Sepolia RPC | `~/Dev/.env` → `SEPOLIA_RPC` | ✅ 有 |
| Etherscan Key | `~/Dev/.env` → `ETHERSCAN_API_KEY` | ✅ 有 |
| OP Sepolia RPC | 仓库 `.env.local` → `OP_SEPOLIA_RPC_URL` | ✅ 有 |
| 部署/运营私钥 | 仓库 `.env.local` → `PRIVATE_KEY_JASON` / `WORKER_EOA_PRIVATE_KEY` | ✅ 有 |
| 私钥 in `~/Dev/.env` | — | ❌ **没有**,该文件只有 RPC 与各类 API key |

## 变更日志

- **2026-09-03(第二轮,Codex 对抗式 review 后)**:修正 Mode B 信任模型的错误表述;
  T1.3.1 增加"owner 绕过"反向断言以堵死假阳性;新增 T1.0.1(RPC/地址漂移修复)、
  TB.3(密钥架构决策)、TB.4(register.html 处置);修正 roadmap 与 tasks 的依赖矛盾;
  preflight 增加密钥复用检查与"禁止打印私钥"硬要求。
- **2026-09-03** `pilot plan`:建立 `docs/agent/` 七件套 + `.pilot.yml`;
  完成产品化差距分析;拆出 F1.1–F1.4 共 11 个 READY task、2 个 BLOCKED。
  按用户口径修正范围:仅测试网、CometENS 为大系统组件、终端用户免登录、子域为授予制。
