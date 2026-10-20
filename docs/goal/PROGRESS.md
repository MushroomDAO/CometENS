# CometENS Goal — PROGRESS / 恢复点

> 此文件是 G0–G7 业务目标的**唯一持续进度入口**。每次开始开发/读审/失败/修复/发布时追加一条“日期、动作、证据、风险、下一步”记录。不得因模型或聊天会话变化而覆盖历史。准确验收状态以 [STATUS.md](STATUS.md) 为准。当前时间参考 Asia/Bangkok。

## 本次会话可恢复摘要（2026-10-20）

- Repo：MushroomDAO/CometENS；工作树：/dev/mycelium/CometENS。
- 当前 G0 工作分支：goal/g0-community-ens-plan；原始提交 6ada685，GitHub [PR #110](https://github.com/MushroomDAO/CometENS/pull/110)。本次修订需要检查最后一次提交和 CI 结果，不应以旧 SHA 作为最新 head。
- 用户的七条原始目标完整保留在 [VISION.md](VISION.md)。2026-10-20 复审要求 AAStar 托管 + 免费层、SDK 可配置 API/key/合约、自部署、运营方退出后的真实产权/解析保障、临时超级权限清理、社区 L1 ENS 原生子名、续费基金、三张架构图、每步写 progress。
- G0 **2026-10-20 已获用户验收**；G1 已解锁并开始实施，G2 继续等待 G1 的独立验收。
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

## 下一次进入项目时

1. 首先读取本文件、[STATUS.md](STATUS.md)、[SECURITY-AND-SERVICE.md](SECURITY-AND-SERVICE.md)、[MILESTONES.md](MILESTONES.md)、G0 原始目标 [VISION.md](VISION.md)；随后核对实时 Git branch/head/PR/CI 和未提交改动。
2. 若用户已认可 G0 并明确给出验收结论，将其日期、head SHA 和条件写入 STATUS；G1 才进入 IN_PROGRESS。若还没有验收，继续处理 G0 评论/复审，勿开始 G1 合约/SDK 实施。
3. 每个 Goal 先固定 API/ABI、权限与可重跑验收；实现后附 unit + Foundry + Sepolia 链上交易和独立验证证据。主网广播只属于完成 G5 且用户明确批准的 G6。
4. 每完成一次审计、设计、修复、提交或阻塞，**追加**此文件的时间、结果、证据、失败、下一步；最后更新 STATUS，避免依赖聊天上下文。
