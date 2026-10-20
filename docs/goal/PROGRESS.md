# CometENS Goal — PROGRESS / 恢复点

> 此文件是 G0–G7 业务目标的**唯一持续进度入口**。每次开始开发/读审/失败/修复/发布时追加一条“日期、动作、证据、风险、下一步”记录。不得因模型或聊天会话变化而覆盖历史。准确验收状态以 [STATUS.md](STATUS.md) 为准。当前时间参考 Asia/Bangkok。

## 本次会话可恢复摘要（2026-10-20）

- Repo：MushroomDAO/CometENS；工作树：/dev/mycelium/CometENS。
- 当前 G0 工作分支：goal/g0-community-ens-plan；原始提交 6ada685，GitHub [PR #110](https://github.com/MushroomDAO/CometENS/pull/110)。本次修订需要检查最后一次提交和 CI 结果，不应以旧 SHA 作为最新 head。
- 用户的七条原始目标完整保留在 [VISION.md](VISION.md)。2026-10-20 复审要求 AAStar 托管 + 免费层、SDK 可配置 API/key/合约、自部署、运营方退出后的真实产权/解析保障、临时超级权限清理、社区 L1 ENS 原生子名、续费基金、三张架构图、每步写 progress。
- 正在执行 G0 **架构设计修订**。用户尚未正式验收 G0；按照 Goal 模式，G1 的代码实施不得自动开始。
- 新主方案：[SECURITY-AND-SERVICE.md](SECURITY-AND-SERVICE.md)，包含 V3/ENSv1/ENSv2 架构、两阶段状态机、Managed/Sovereign/Locked Record 等级、故障兜底、续费基金、独立交权凭证与可重跑验收矩阵。新增子任务已进入 [MILESTONES.md](MILESTONES.md)，状态见 [STATUS.md](STATUS.md)。
- 现有测试基线（来自本轮此前 G0 执行记录，非本次修订后重跑）：2026-10-20，pnpm typecheck PASS；38 文件/706 项 Vitest unit PASS；forge test -q PASS。CI 在本次修订前的原 G0 commit 6ada685 上 cla-check 和 test 均 SUCCESS；本次修订推送后应重新看新 head CI。
- 现有关键风险：V3 global owner 可覆写任何节点、代转 ERC721 和绕开 registrar；HybridResolver 的 owner 可换 signer/verifier/网关/L2 地址，gateway 可选择 SIG 模式；SDK 仍猜 RPC 网址链型、写旧 API 和重建 nonce。现有 OP ERC721 不是 ENS 原生子名产权。主网未部署。
- 上游 ENSv1 NameWrapper 的 PCC/CU/expiry 有期限和父名安全前提，且 NameWrapper 上游本身具升级/治理信任；ENSv2 采用可重新授予的 EAC 角色，不能自动继承 v1 fuse 保障。公开产品话术不得绝对保证“无条件永久”。

## 执行日志（追加记录）

### 2026-10-20 · G0 初版（此前完成）

动作：核对现有代码和本地测试，保留七条目标、建立 G0–G7 计划。证据：6ada685，PR #110，VISION/ARCHITECTURE/MILESTONES/STATUS，基础测试记录。结论：G0 可供评审，尚未用户验收。

### 2026-10-20 · 用户反馈与架构复审

动作：检查当前分支/CI、V3 和 HybridResolver、SDK/Worker；两条独立只读审计检查了 ENS NameWrapper 及服务配置。查阅 ENS 官方 NameWrapper fuse、expiry、Offchain/L2、ENSv2 EAC 和迁移文档。证据：ARCHITECTURE.md 新增复审段、SECURITY-AND-SERVICE.md 和 MILESTONES.md 新增 G0/G1/G2/G3/G4/G5/G6 安全交付子任务。

决定：保留 G0 当前阶段；以 Managed 运营发行 → Sovereign L1 ENS 子名交接实现核心主权，Locked Record 单独满足不可变记录诉求；AAStar 运营多签不得持已交权名字的越权入口；引入独立可验证的 handoff receipt；续费基金为 opt-in，不承诺无条件永久。

尚未完成：G1 新 SDK/API key/限额、G2 新合约/原生交权、G3 ENSv2 adapters 与 proof-only 解析、G4 自部署/免费层/基金、G5 故障与安全实测、G6 Mainnet、G7 AAStar/AirAccount 联合集成。禁止将本次文档设计写成上述功能已上线。

### 2026-10-20 · 本次 G0 复审交付与机器验证

动作：修订 VISION/ARCHITECTURE/MILESTONES/STATUS/README；新增 SECURITY-AND-SERVICE（共 5 张 Mermaid 图）及本进度恢复文档。使用机器检查全部本目录相对链接、Mermaid fence、子任务表格结构。命令及结果：

- 文档链接/Markdown fence/至少 5 Mermaid/里程碑编号检查：PASS。
- git diff --check：PASS（提交前）。
- Node v22.22.2：pnpm typecheck — PASS。
- Node v22.22.2：pnpm vitest run test/unit/ — 38 test files、724 tests PASS。
- Foundry：在 contracts/ 下 forge test -q — PASS。
- GitHub PR #110 是持续验收入口；请读取其实时 head、CLA、test 和 Review 状态，不能引用旧 CI 来代表新 head。

结果：仅提交 G0 架构、图和里程碑文档，无 SDK/合约业务实现、无链上交易。本批次接受标准仍须用户审阅后明确给出 G0 ACCEPTED；未获得前不可开始 G1。
下一步：提交/推送本批文档至 PR #110，检查 CI/Review；如安全模型获用户确认再解除 G1 阻塞。

## 下一次进入项目时

1. 首先读取本文件、[STATUS.md](STATUS.md)、[SECURITY-AND-SERVICE.md](SECURITY-AND-SERVICE.md)、[MILESTONES.md](MILESTONES.md)、G0 原始目标 [VISION.md](VISION.md)；随后核对实时 Git branch/head/PR/CI 和未提交改动。
2. 若用户已认可 G0 并明确给出验收结论，将其日期、head SHA 和条件写入 STATUS；G1 才进入 IN_PROGRESS。若还没有验收，继续处理 G0 评论/复审，勿开始 G1 合约/SDK 实施。
3. 每个 Goal 先固定 API/ABI、权限与可重跑验收；实现后附 unit + Foundry + Sepolia 链上交易和独立验证证据。主网广播只属于完成 G5 且用户明确批准的 G6。
4. 每完成一次审计、设计、修复、提交或阻塞，**追加**此文件的时间、结果、证据、失败、下一步；最后更新 STATUS，避免依赖聊天上下文。
