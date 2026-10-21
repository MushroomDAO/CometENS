# CometENS Goal — PROGRESS / 恢复点

> 此文件是 G0–G7 业务目标的**唯一持续进度入口**。每次开始开发/读审/失败/修复/发布时追加一条“日期、动作、证据、风险、下一步”记录。不得因模型或聊天会话变化而覆盖历史。准确验收状态以 [STATUS.md](STATUS.md) 为准。当前时间参考 Asia/Bangkok。

## 本次会话可恢复摘要（2026-10-20）

- Repo：MushroomDAO/CometENS；工作树：/dev/mycelium/CometENS。
- G0 工作分支：goal/g0-community-ens-plan，用户验收回执记录于 8652eb8（最初规划提交为 6ada685，仅作历史追溯）；GitHub [PR #110](https://github.com/MushroomDAO/CometENS/pull/110) 另有代码评审门禁。G1 在独立 worktree/PR 开发；每次恢复应查询各 PR 最新 head 和 CI。
- 用户的七条原始目标完整保留在 [VISION.md](VISION.md)。2026-10-20 复审要求 AAStar 托管 + 免费层、SDK 可配置 API/key/合约、自部署、运营方退出后的真实产权/解析保障、临时超级权限清理、社区 L1 ENS 原生子名、续费基金、三张架构图、每步写 progress。
- G0 **2026-10-20 已获用户验收**；G1 已解锁并开始实施，G2 继续等待 G1 的独立验收。
- 新主方案：[SECURITY-AND-SERVICE.md](SECURITY-AND-SERVICE.md)，包含 V3/ENSv1/ENSv2 架构、两阶段状态机、Managed/Sovereign/Locked Record 等级、故障兜底、续费基金、独立交权凭证与可重跑验收矩阵。新增子任务已进入 [MILESTONES.md](MILESTONES.md)，状态见 [STATUS.md](STATUS.md)。
- 现有测试基线（来自本轮此前 G0 执行记录，非本次修订后重跑）：2026-10-20，pnpm typecheck PASS；38 文件/706 项 Vitest unit PASS；forge test -q PASS。CI 在本次修订前的原 G0 commit 6ada685 上 cla-check 和 test 均 SUCCESS；本次修订推送后应重新看新 head CI。
- G0 初始代码基线的关键风险：V3 global owner 可覆写节点、代转 ERC721 和绕开 registrar；HybridResolver owner 可换 signer/verifier/网关/L2 地址，gateway 可选择 SIG 模式；**旧版 SDK** 猜 RPC 网址链型、写旧 API 和重建 nonce，这些 SDK 问题在独立 G1 PR 中修复。现有 OP ERC721 不是 ENS 原生子名产权；主网未部署。
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

### 2026-10-20 · G0 文档修订首次提交与推送

已完成 Git commit **f30816ea8e851678279ea54add77f2738eae3a6e**，提交说明为 docs(goal): define AAStar hosted profiles and verifiable ENS handoff；origin/goal/g0-community-ens-plan 已成功推送，远端 refs/heads/goal/g0-community-ens-plan 指向该 SHA。GitHub PR #110 API 确认 head 已同步、状态 OPEN、mergeable=true，但因 review requirement 仍 blocked。按 2026-10-20 清迈时间约 15:15 的实时检查，新 head cla-check PASS、test PENDING；检查结果是当时快照，后续应重新读取 CI 实时状态。

该提交记录的是 G0 的设计修订。继续等待**用户明确 G0 验收**才可实现 G1；GitHub PR 合并与用户业务验收是两种独立动作。

### 2026-10-20 · 用户 G0 验收，授权 G1 开始

用户原文：「可以,按你建议来,验收通过,每个G完成,记得commit, push,发pr,所有工作在独立worktree或者分支,可以并行subagent互不影响」。确认 G0 交付物（验收时分支 head f92a4b4），允许进入 G1。流程规则：每个 Goal 验证完成后 commit、push、PR，并等待用户验收；并行工作使用彼此独立的 branch/worktree，保护他人更改，禁止跳过门禁。

当前 GitHub G0 PR #110（head f92a4b4）cla-check/test 均 PASS，mergeable=true，但 reviewDecision=REVIEW_REQUIRED；需按仓库规则继续评审，不把聊天验收冒充 GitHub PR 审核。

### 2026-10-20 · G1 worktree 并行启动

基线：G0 用户验收文档提交 8652eb8f7607825898553ae1e458e460a81f8711，已推送 origin/goal/g0-community-ens-plan。独立 worktree：goal/g1-sdk 位于 ../CometENS-g1-sdk（SDK package/profile/typed write，worker-2）；goal/g1-api 位于 ../CometENS-g1-api（API Worker / Gateway fail-closed，worker-1）；goal/g1-integration 位于 ../CometENS-g1-integration（SDK 独立 demo、文档、合并与整体验证，由 prime 负责）。

集成支线已开始 docs/SDK-INTEGRATION.md 和 examples/sdk-vanilla（外部可消费 TS demo）；修正旧 docs/ens-domain-transfer.md 里的普通 Registry 转让后不可能收回的错误安全承诺。待两 worker 提交、实测 SDK 最终 public API，再校正 sample imports/config、执行独立 build/typecheck/pack 及主仓库 tests。本条记录是进行中事实，尚不代表 G1 已交付。

### 2026-10-20 · G1.6 API 安全分支完成，已普通合并至集成分支

worker-1 独立工作树 goal/g1-api 交付并推送 9f6ba66a92fede8df7eb9cf79c3bfb0a9d968fa8。API/CCIP Gateway 加强空 parent/allowlist fail-closed、nonce KV 不可用拒绝写入、32 KiB 请求边界、签名请求校验及错误脱敏，新增 13 路由级负例。集成分支以普通 merge 提交 078c995 引入该提交（无 rebase/force）。

**集成复验**：Node22 pnpm typecheck PASS；Node22+Foundry pnpm vitest run test/unit/，39 test files / 743 tests PASS。当前 Worker KV 的 get/put 仍非原子，不能证明并发 nonce 只成功一次；G2 需链上/强一致机制。生产示例 wrangler 配置中 ALLOWED_SENDERS 可能未启用，现在缺少配置的 gateway 明确拒绝请求；部署前必须填写真实 resolver 地址，详见 docs/SDK-INTEGRATION.md。

### 2026-10-20 · G1 SDK + API 初次集成复验、线上只读探针

SDK worker 首次提交 70599ab（独立包、配置、EIP712、读写和单测），普通合并到 goal/g1-integration，merge commit b899d08。当前集成根项目 Node22 typecheck、Vite build、41 test files / 754 Vitest tests、Foundry forge test -q、SDK standalone build 均 PASS。examples/sdk-vanilla 独立 pnpm install/typecheck/build PASS；dist-secrets scanner PASS。SDK worker正在处理独立安全 review 后续修复，故以上为初始合并快照，不能代替最终复验。

真实测试网读取（无交易）：OP Sepolia chainId 11155420、SDK profile 双链/字节码验证通过；直接 L2Records 上 aastar.eth 有 ETH 地址 0xb5600060e6de5E11D3636731964218E53caadf0E，而 getEnsAddress(aastar.eth) 的标准 Ethereum Sepolia ENS 查询为 null。此差异不能伪装为一致性证明，说明 L1 resolver 指针与 OP 记录的完整端到端验证仍需补齐。详细回执在 [G1-ACCEPTANCE.md](G1-ACCEPTANCE.md)。

### 2026-10-20 · G1 SDK 复审收尾与最终集成验证

worker-2 分支 goal/g1-sdk 提交并推送 70599ab、6034814、c580f1f（最终 c580f1fbcae6104fd1d4f0119134392cb5642edf），基于 8652eb8，含 ESM/types、可配置 profile、6 种 EIP-712 API 和 server-only 密钥、codehash 可选校验、60 秒复查/写前再验、HTTP 错误语义及 RPC 脱敏。独立安全审核 worker-1 检查了签名 schema parity 与威胁路径。SDK 修改普通合并至集成分支（b899d08 初合并，4c59c20 安全修复合并）。SDK external package tarball ESM+types 消费测试由 worker 通过；SDK 构建和独立 Vanilla demo 由 Prime 再次验证。

**最终机器验证（Node v22 + Foundry）**：pnpm typecheck PASS；pnpm vitest run test/unit/ **41 files / 766 tests PASS**；pnpm build PASS；sdk pnpm build PASS；contracts forge test -q PASS；examples/sdk-vanilla pnpm install --force / pnpm typecheck / pnpm build PASS；pnpm check:dist-secrets PASS；git diff --check PASS。无 npm publish/主网交易。

**已知安全边界**：G1 完成 SDK 的兼容接入和 fail-closed Worker，不具备 G2 的 per-parent 原生不可夺权合约。Worker KV replay consume get+put 非原子，需 G2 处理。ENS L1/OP L2 结果对同名可能不同；已记录真实测试网样本，G3/G5 再做生产等级连续解析与可重跑 E2E。Gateway 需要设置实际 ALLOWED_SENDERS，G4 的 API key 计费/免费额度服务端尚未实现。G1 功能待用户验收，不允许因此自动进入 G2。
### 2026-10-20 · G0 PR #110 评审整改

PR-Daemon 对 G0 接受回执 head 8652eb8 提出 CHANGES_REQUESTED：G0 已验收的表格和部分未同步的“当前仍只执行 G0”说明矛盾。逐项修订 STATUS/VISION/MILESTONES/PROGRESS 的状态、恢复步骤和当前/历史叙述；统一两份 G1 NetworkProfile 技术草案，修正 V3 Worker 实际可能持有全局 owner 权限的图示。此条记录针对 GitHub 审核整改，**不撤销用户已经确认的 G0 业务验收**。修正提交 a0b34c0 已推送至 G0 PR #110，并通过普通 merge 同步到 G1 的 goal/g1-integration（最终 merge commit 以 Git 日志为准）；PR #110 仍需 GitHub reviewer 重新审阅，G1 的 READY_FOR_ACCEPTANCE 不代表业务验收通过。

### 2026-10-20 · G0 GitHub review 修复同步及 G1 PR 开立

G0 GitHub PR #110 在用户 G0 业务验收后因旧文档状态未统一而遭 CHANGES_REQUESTED。G0 分支以 a0b34c07874bbbcb2e73bc33519bab99f3cee540 修订并推送，38 单测文件/724 项 PASS、Node22 typecheck PASS、Foundry PASS、Markdown 链接和格式检查 PASS；PR #110 仍需新 head 的 GitHub 代码 review。G1 集成分支使用普通 merge 2156952 纳入该 G0 父分支（无 rebase/force），PROGRESS 冲突为两个分支在同一位置追加日志，已合并保留全部历史。

G1 已 push 并创建 [PR #111](https://github.com/MushroomDAO/CometENS/pull/111)，base 为 goal/g0-community-ens-plan；已在纳入 G0 审核修订的 G1 集成树上复跑 Node22 typecheck PASS、root Vite build PASS、41 Vitest unit 文件/766 tests PASS，git diff --check PASS。SDK/Foundry/独立 demo 的前一次完整验收结果继续适用，改动只涉及 G0 文档；最终 GitHub 新 head CI/review 需实际读取，G1 尚需用户验收后才解锁 G2。

### 2026-10-20 · G1 PR 拆分及最新完整复验

按 2026-10-20 用户规定的独立 worktree/原子 PR 和 PR-Daemon v1.4.1 检查，G1 原聚合 PR #111 进一步拆分为从 G0 出发的顺序栈：

1. [#112](https://github.com/MushroomDAO/CometENS/pull/112)，goal/g1-api（最终含 G0 parent 的普通 merge 039351a），仅 API/CCIP Worker fail-closed；2 文件/19 定向安全测试 PASS；pre-pr-check 1.4.1 block 0。
2. [#113](https://github.com/MushroomDAO/CometENS/pull/113)，goal/g1-sdk-foundation（a5a4bef），独立 Profile/EIP-712 schema/4 项协议负例，Node22 typecheck/定向测试 PASS；pre-pr-check block 0。
3. [#114](https://github.com/MushroomDAO/CometENS/pull/114)，goal/g1-sdk（SDK 依次普通 merge API 和 foundation，附 0.1.0 CHANGLELOG、LICENSE 等）；24 项 SDK 定向测试 PASS；pre-pr-check block 0。
4. [#111](https://github.com/MushroomDAO/CometENS/pull/111)，goal/g1-integration，SDK 最新原子栈普通 merge 3239d47；GitHub PR base 已改为 goal/g1-sdk，仅保留独立示例、文档、验收和状态（无需 rebase 或 force）。

最新**整合集成本地复验**：Node22 pnpm typecheck PASS；**42 files / 770 unit tests PASS**；主应用 Vite build PASS；SDK package build PASS；独立示例 TS typecheck + Vite build PASS；Foundry forge test -q PASS；git diff --check PASS；此前 browser dist secret scan PASS。无主网交易，无 npm 正式发布，G1 用户验收仍 PENDING，G2 BLOCKED。

正式 GitHub `test.yml` workflow 的 pull_request 触发目标仅为 main/preview，当前叠加式 goal/* base 的 PR 无独立测试 check，CLA 可以运行但不可假称 CI 全绿。代码分支均已本地复验；在 G0、G1 PR 顺序合并并 retarget 后，再以 GitHub 合并结果 CI 作为合并条件。G0 PR #110 自身 cla/test 成功，但此前 reviewer 的 CHANGES_REQUESTED 仍需新审查解除。

### 2026-10-20 · G0 重新请求审核与 G1 精细化 PR 检查

用户 G0 验收有效。G0 PR #110 head a0b34c0 GitHub cla-check/test 两项成功，旧的 clestons CHANGES_REQUESTED 针对前一 head。作者已更新 PR body、逐项答复 Medium/Low findings，并重新向 clestons 请求精确提交复审；PR 尚未合并。独立 PR-Daemon 1.4.1 (3105515ec11c) 通过 selftest，所有 G0/G1 PR block 级命中为 0；G0 564 行纯文档架构合同有 SZ-1 review 级说明，SDK 代码按 300/500 行约束拆层。

G1 子任务 PR 正式组成：[API #112](https://github.com/MushroomDAO/CometENS/pull/112)（基于 G0）、[SDK Foundation #113](https://github.com/MushroomDAO/CometENS/pull/113)（基于 API）、[SDK Package #114](https://github.com/MushroomDAO/CometENS/pull/114)（基于 foundation）、[Demo/Goal 验收 #111](https://github.com/MushroomDAO/CometENS/pull/111)（基于 SDK package）。#113 包括 4 项可独立复现的 EIP-712/profile 安全负例，#114 已补充 v0.1.0 CHANGELOG，#111 仅保留集成 Demo/文档并显示安全类型错误。最新 full local pass 42 suites / 770 tests、SDK/Vite/demo build/Foundry PASS；最终 PR 评论和 GitHub CI 状态仍以远端实时查询为准。

### 2026-10-20 · G1 最终 CI 收口与全套端到端本地测试

为重现 `.github/workflows/test.yml` 实际流程，在 G1 集成 worktree 运行 Node 22、Foundry、根项目及 `workers/gateway` 的各自 `pnpm install --frozen-lockfile`。发现新依赖环境下的 Vitest mock 未覆盖另一份 viem 实例，导致签名路线测试返回 502；改为确定性的 KV 测试夹具，并在 Worker 中显式导入 Cloudflare 类型。同时 SDK EIP-712 变体测试采用各自的强类型签名调用，解决宽范围类型回归。上述修复由 #112 的 8c95e6c 开始、下游按顺序 ordinary merge，不 rebase/force，SDK 类型测试提交 eb33a28 已被纳入 #114。

完整 `pnpm vitest run`：**48 文件 809 PASS，1 文件 9 SKIPPED**，跳过项是需要真实 Sepolia RPC/部署的集成测试；`pnpm check:skipped vitest-report.json` PASS。主站/SDK/独立 Demo build、root typecheck、Foundry `forge test -q` PASS。`pnpm check:typecheck-scope` 发现上层 SDK 修复使宽范围错误从 6 减为 5；依据已有 T1.7.1 不允许静默吸收进步的规定，新建独立 [#115](https://github.com/MushroomDAO/CometENS/pull/115)（goal/g1-typecheck-budget，ec206e2、b380ef5）将预算收紧至 5、更新任务账本，并使 `test.yml` 的 pull_request 支持 `goal/**` base。#115 本地 Worker 自身类型 0，wide errors 5/budget 5，检查 PASS；YAML 可解析。G1 集成普通 merge 纳入 #115 后仍需重跑与确认新的 GitHub CI。

最新 PR 合并次序：G0 #110 → API #112 → SDK foundation #113 → SDK package #114 → CI #115 → G1 demo/验收 #111。所有 PR 必须分别得到当前 head 审批、CI 通过与可合并状态；用户已经接受 G0，但 **G1 业务验收尚未收到**，所以 G2 继续 BLOCKED。线上 ENS L1 与 OP L2 同名解析结果可能不一致，仍由后续 G3/G5 的真实部署与故障演练验证，不列为 G1 已解决。

### 2026-10-20 · GitHub G1 最终集成 CI 验证完成

G1 新增的 Goal PR CI 触发器已由 GitHub 实际验证：[PR #115](https://github.com/MushroomDAO/CometENS/pull/115) 的 `cla-check` 和 `test` 均 SUCCESS。最终 [PR #111](https://github.com/MushroomDAO/CometENS/pull/111) 在 head `9306f21b5c7522124f5cc6340e13fd24abe977f6` 上的 [Tests 工作流 run 39413890122](https://github.com/MushroomDAO/CometENS/actions/runs/39413890122) `conclusion=success`，同一 head 的 `cla-check` SUCCESS。该证据证明 `goal/**` 基分支可以运行完整 GitHub 门禁，但**不代替**上游各 PR 独立 reviewer 的批准。

本记录如通过新的 commit 写入 #111，**前一提交的 CI 绿灯不得自动视作新 head 的绿灯**；再次检查最新 GitHub head/status 后才可宣称最终 ready。G0 #110 在 head a0b34c0 cla-check/test SUCCESS，旧的 `CHANGES_REQUESTED` 尚待 clestons 对修复后的 head 重新审批。用户 G1 验收仍 PENDING，G2 继续 BLOCKED。

### 2026-10-20 夜间 · G0 合并及 G1 Review landing（PR #110–#115）

最新 GitHub 状态复核：G0 #110 由 clestons 在 head a0b34c0 重新 APPROVE，cla-check/test SUCCESS，2026-10-20 合并到 main，merge commit `813f1e219f12f3bcc1d35a2b08a7ee925f046104`。G1 #112/#113/#114/#115 的原始 head 都曾收到 APPROVE，只有最终 Demo/文档 PR #111 在 head 8d8d1be 收到两项 Medium 的 REQUEST_CHANGES。

为了确保 G1 真正进入 main，先将 #112 的 base 从原 G0 分支更新到 main，正常 merge origin/main 至其独立 worktree 并 push 新 head `46868083c05395ec60c58a7c34d4bec5189766f2`（未使用 rebase/force）。当前 head 的 GitHub cla-check/test 均 SUCCESS，GitHub 因 base/head 更新将此前审批转成 REVIEW_REQUIRED；已逐条回复并重新邀请 clestons 审查精确 head。其余 PR 需等父 PR 合入 main 后顺序更新 base、重新核验 CI/reviewer，再合并。

#111 两项 Medium 已在独立 goal/g1-integration worktree 修复：提交之前检查 `.gitignore` 的 `.env*` 排除导致实际有 `.env.example` 但未追踪；新增精确豁免并纳入文件、添加五个 VITE_ 字段说明和 Git-tracked 契约测试。把错误的「Mainnet profiles disabled」更正为「AAStar 不提供主网 preset，但 SDK 支持自部署主网 1/10」并补 SDK API 负例/正例。Demo 不再通过 `as NetworkProfile` 绕过配置验证，启动时构造 `createSelfHostedProfile`，错误时禁用按钮并指导用户修改 .env。相关 Low 的 bytecode/optional codehash 和父域名解析范围声明同步修正。以上变更须在最终集成测试通过、git commit/push 后请求精确 head 复审。

G1 用户业务验收仍待确认，**G2 BLOCKED**。无正式 npm publish 或新链上写入，历史 G1 09:00 的测试读数仅表示其对应 head。

### 2026-10-20 深夜 · PR 审批后的顺序合并与两项 Medium 修复完成

复查全部六个 PR 的 live Review/CI：G0 #110 对 a0b34c0 APPROVED/CI 绿并合并进 main（`813f1e2`）。G1 API #112 对旧 head 8c95e6c 曾 APPROVED；因更新 base 到 main，GitHub 正确废止旧审批。普通合并 origin/main 后 head `46868083c05395ec60c58a7c34d4bec5189766f2` 新 CI 两项成功、clestons 在最新 head 重新 APPROVE，现已合并进 main，merge `2734474c20eb8adf9ca6fbbdb1c207a17f0ed76e`。未使用 rebase 或 force。

SDK Foundation #113 已将 base 更新到 main，并普通合并最新 origin/main，head `4416b105795df66e6a6f34d539c92c1d0d0539e0`；GitHub cla/test SUCCESS、mergeable，但 GitHub 由于基线变化要求重新审批（reviewDecision=REVIEW_REQUIRED），已在 PR 逐项解释 parent sync 并重新请求 clestons 审核。未获 APPROVE 不执行 merge，也不提前更新后续 PR 的 base 破坏原有 stack 合同。

Demo #111 原 head 8d8d1be 被要求修改两项 Medium：`.env.example` 被 `.gitignore` 排除；文档错误宣称 SDK 阻止自部署主网。当前修复 head `afd13cabc601ae90365f450716a51f85e5a8cce5` 已推送，新增 git-tracked 环境示例、五字段运行指南、启动时真实 SDK profile 检查，明确 AAStar 只有 testnet preset 而用户主网 1/10 profile 可用，补 2 个回归测试，亦修正 codehash pin 等 Low。该 head 本地 49 test files / 811 PASS，9 个需实时部署的测试按既有规则跳过，主站/独立 Demo/typecheck/Foundry 均 PASS；[GitHub run 39458665006](https://github.com/MushroomDAO/CometENS/actions/runs/39458665006) 完整 test SUCCESS，CLA SUCCESS。修复详情已在 PR 评论说明，await exact-head reviewer；父 PR 进入 main 后需普通同步主分支与新 head Review。

按照已冻结的 Goal 模式，**用户尚未验收 G1，G2 BLOCKED**；在上游审核门仍未解除时停止进一步 G1 合并，但所有可修改内容均已修复、测试、提交并推送。

### 2026-10-21 · G1 全部 PR Approved + CI 通过并合入 main

接续上一轮检查，PR #113 在新 head `4416b10` 通过完整 GitHub CI 并获 clestons 重新 APPROVE，合入 main `40ee3400fe0afeae49a5ba6fa3f88e3b11a70aa6`。#114 更新 main 后 CI 首次真实失败：`pnpm check:typecheck-scope` 量到 5 errors，预算仍为 6；将已在 #115 审查过的预算降级提交 `ec206e2` 以 `cherry-pick -x` 正常提交至 #114（新 head `9ffda25`），满足“SDK 类型改进与同 PR 预算收紧”规则。再次获得新 head APPROVE/CI 全绿后合入 main `d5fc6874bde1594657ba67db46638f853dc0f2ef`。无 rebase/force。

#115 相应调整为主要交付 `goal/**` 的 pull_request CI 触发，普通合并最新 SDK 父分支并消解 `docs/agent/tasks.md` 中同内容改动；最新 head `ab6934b` 完整 CI 全绿、重新 APPROVE，合入 main `b434750a57a0e8153b03b9308a7a60320ef6b480`。最后 #111 普通合并最新 main，head `848b71c` 与此前获 APPROVE 的 `df0cacb` 整棵 Git 文件树一致（`git diff --stat` 为空），再次获得独立 [CI run 39535343002](https://github.com/MushroomDAO/CometENS/actions/runs/39535343002) SUCCESS、CLA SUCCESS、最新 head APPROVE 及 MERGEABLE 后合并为 `3390adfc2d09d004c7362615eaaa7b6370075be3`。

**当前恢复结论**：G0 已被用户验收且合并；G1 独立 SDK、API/CCIP 安全、EIP-712、Vanilla Demo、自部署文档和 CI 均已 GitHub 落地。此前完整本地验证 `811 PASS / 9 预设在线部署测试跳过`，GitHub 最终 head `848b71c` 的工作流整体绿。没有执行 npm publish 或主网部署。G1 **业务验收仍未收到**，STATUS 保持 `READY_FOR_ACCEPTANCE`；G2 继续 `BLOCKED`。独立工作树已逐个检查：合并的 G1 部分工作树移除，子模块 worktree 在确认子模块均干净后才安全强制移除；当前 main 工作树更新到 `3390adf`。本条为合并后的额外文档 checkpoint，不能当作用户验收 G1。

### 2026-10-21 · 用户正式验收 G1，G2 启动授权（已确认）

助手启动并提供本地 SDK Vanilla Demo（`http://127.0.0.1:5188/`，仅绑定 127.0.0.1）、操作步骤和只读探针结果后，用户明确回复（本记录来自与用户的会话，不额外声称逐项观察到其浏览器操作）：「啊，验收通过了，你继续开发吧。」因此 **G1 ACCEPTED**（此前仅 READY_FOR_ACCEPTANCE）；此授权以 G1 已冻结范围为准：可独立安装的 TS SDK、V3 安全 Worker 与 EIP-712 API、公开 Sepolia 配置的 OP L2Records 只读与 Demo。验收**不表示** L1 ENS 原生产权移交、L1/OP 解析一致、Worker KV 原子 nonce、主网部署或 npm 发布完成；相关交付属于 G2–G6 独立门禁。

G1 正式验收前，独立 PR #117 的测试网默认禁止广播安全补丁已经 APPROVED/CI 绿并合入 main `33e1954`；PR #119 独立 AST 接线保护已于 2026-10-21 同样 APPROVED/CI 绿合并为 main `478a74de955e1af3f679a048cc93351ddb64ff4d`。日常回归不再凭本地 RPC/私钥自动启用 live Sepolia 读写；[#118](https://github.com/MushroomDAO/CometENS/issues/118) 持续追踪历史解析/签名 proof 测试网配置偏差。G1 本地服务及 SDK 探针验证：HTTP 200，SDK 在公共 Ethereum Sepolia / OP Sepolia 成功校验合约、`aastar.eth` 直接 OP 记录返回非空地址；L1 ENS 为 null，属于已披露差异，不得宣称 `SOVEREIGN`。

依据用户批准启动 **G2 IN_PROGRESS**，按 [G2-ACCEPTANCE.md](G2-ACCEPTANCE.md) 九项安全关卡执行：先独立 V4 per-parent 核心与 revocable operator；后跟 SDK、L1 authority、ENS NameWrapper 原生交权、nonce/迁移和第三方 handoff proof。所有工作独立 worktree/分支、≤300 行生产 PR 目标、commit/push/PR、GitHub CI + review 双绿后方可合并。**G2 未全部完成并获用户再验收之前不得解锁 G3**；不得擅自链上写入、发布 npm 或做主网部署。

### 2026-10-21 · G1 验收记录措辞对账及 G2 恢复指引收口

针对 #120 独立 reviewer 的不阻塞 Low，明确区分用户在对话中正式业务验收与助手本地启动/HTTP/RPC 探针的可复现事实：已提供只读 Demo 的访问地址和步骤，用户明确回复「啊，验收通过了，你继续开发吧」，但未获取其逐个点击的浏览器遥测，故不再声称观察到了所有浏览器动作；GitHub CI/review 并非代替用户验收。修复 STATUS 里混写 G0/G1/文档/安全 PR 号的措辞，并把「下一次进入项目时」的旧 G1 BLOCKED 操作指令修正为当前状态 G1 ACCEPTED、G2 IN_PROGRESS、G3 BLOCKED。G2.1–G2.3 正在交付，不能因此认定 G2 全部九项完成。

## 下一次进入项目时

1. 首先读取本文件、[STATUS.md](STATUS.md)、[SECURITY-AND-SERVICE.md](SECURITY-AND-SERVICE.md)、[MILESTONES.md](MILESTONES.md)、G0 原始目标 [VISION.md](VISION.md)；随后核对实时 Git branch/head/PR/CI 和未提交改动。
2. G0 已于 2026-10-20、G1 于 2026-10-21 获用户业务验收；检查当前 G2.1–G2.9 的 PR、review、CI 与可复现安全证据。**G2 IN_PROGRESS，用户明确验收 G2 之前 G3 保持 BLOCKED**。
3. 每个 Goal 先固定 API/ABI、权限与可重跑验收；实现后附 unit + Foundry + Sepolia 链上交易和独立验证证据。主网广播只属于完成 G5 且用户明确批准的 G6。
4. 每完成一次审计、设计、修复、提交或阻塞，**追加**此文件的时间、结果、证据、失败、下一步；最后更新 STATUS，避免依赖聊天上下文。
