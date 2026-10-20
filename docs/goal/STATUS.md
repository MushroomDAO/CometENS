# CometENS Goal — 当前交付状态与用户验收回执

记录日期：2026-10-20（Asia/Bangkok）；完整步骤见 [MILESTONES.md](MILESTONES.md)。状态值：`PENDING`、`IN_PROGRESS`、`READY_FOR_ACCEPTANCE`、`ACCEPTED`、`BLOCKED`。

| Goal | 当前状态 | 下一解锁事件 |
|---|---|---|
| **G0 原文/架构/计划基线** | `ACCEPTED`（用户 2026-10-20 明确确认；[PR #110](https://github.com/MushroomDAO/CometENS/pull/110) 仍待 GitHub review） | G1 可启动；G0 PR cla/test 全绿，已重新请求 reviewer 撤销旧 CHANGES_REQUESTED，需单独按 GitHub 合并规则收口 |
| G1 独立 SDK | `READY_FOR_ACCEPTANCE`（2026-10-20；[PR #111](https://github.com/MushroomDAO/CometENS/pull/111) 已创建） | 需 GitHub CI/review 和用户 G1 验收；此前不得进入 G2 |
| G2 per-parent owner / 可撤销 operator | `BLOCKED` | G1 被用户验收 |
| G3 ENSv1 兼容 + ENSv2 适配及 7×24 解析 | `BLOCKED` | G2 被用户验收 |
| G4 开源自部署、demo、UI 安全 | `BLOCKED` | G3 被用户验收 |
| G5 Sepolia 全量安全验收 | `BLOCKED` | G4 被用户验收 |
| G6 OP + Ethereum 主网部署 | `BLOCKED` | G5 完成且用户确认生产参数/交易 |
| G7 AAStar SDK / AirAccount 集成 | `BLOCKED` | G6 被用户验收 |

## G0 2026-10-20 复审

用户复审提出的产品/安全约束已于 **2026-10-20 随 G0 完成用户验收**。新增 [SECURITY-AND-SERVICE.md](SECURITY-AND-SERVICE.md)（默认托管/自部署、NameWrapper/v2、两阶段交权、保障等级、续费基金和证明方案），[PROGRESS.md](PROGRESS.md) 记录每一步和恢复点。

## G1 交付清单（用户验收前）

- [x] 可打包 @cometens/sdk 0.1.0（只生成产物、未正式 npm 发布）
- [x] API/gateway fail-closed 加固与独立安全 review
- [x] AAStar testnet profile、自部署 network profile、服务端 API-key 客户端与 EIP-712 全签名数据协议
- [x] 独立 Vanilla TS Demo 与包消费测试
- [x] 集成 Node22 root typecheck、完整 Vitest 48 文件/809 通过、9 项在线集成测试按预设跳过，root+SDK+demo build、Foundry、secret scan/diff-check PASS
- [x] OP Sepolia live check:chain 及 SDK real read；记录 L2 与 L1 ENS 结果可不同，不将其等同
- [x] G1 原子 PR 栈均已创建和推送：[API #112](https://github.com/MushroomDAO/CometENS/pull/112) → [协议基础层 #113](https://github.com/MushroomDAO/CometENS/pull/113) → [SDK 客户端 #114](https://github.com/MushroomDAO/CometENS/pull/114) → [最终集成 Demo / 验收 #111](https://github.com/MushroomDAO/CometENS/pull/111)，基于 G0 [#110](https://github.com/MushroomDAO/CometENS/pull/110)
- [x] 增加独立 [G1 CI #115](https://github.com/MushroomDAO/CometENS/pull/115)：宽范围类型错误从 6 收口为 5，CI `pull_request` 支持 `goal/**` base；本地 `pnpm check:typecheck-scope` 通过
- [x] GitHub [#115](https://github.com/MushroomDAO/CometENS/pull/115) 及最终集成 [#111](https://github.com/MushroomDAO/CometENS/pull/111) 的 `cla-check` / 完整 `test` 均在对应已验证 head 通过（run 链接见 G1-ACCEPTANCE）；后续 head 更新需重新验证
- [ ] G0/G1 PR 完成 GitHub reviewer 审核与新 head CI，工作流触发及完整 CI 仍须用 GitHub 实际结果核对；G0 #110 历史 `CHANGES_REQUESTED` 尚待重新审批
- [ ] 用户明确 G1 验收（完成后才进入 G2）

验收证据与例外见 [G1-ACCEPTANCE.md](G1-ACCEPTANCE.md)，[PROGRESS.md](PROGRESS.md)。

## G0 交付清单

- [x] 七条需求及执行指令原文：`VISION.md`
- [x] 既有能力、SDK、合约权限、跨链解析、ENSv2 路线：`ARCHITECTURE.md`
- [x] G0–G7 子任务、验收门槛和依赖：`MILESTONES.md`
- [x] 基线：2026-10-20 `pnpm typecheck` PASS；`pnpm vitest run test/unit/` 38 files/706 tests PASS；`forge test -q` PASS（本机 Node v22/Foundry）
- [x] G0 已提交分支 `goal/g0-community-ens-plan`，验收 [PR #110](https://github.com/MushroomDAO/CometENS/pull/110)；以 PR 最新 head SHA 为准
- [x] G0 复审设计与至少三张架构图、故障/状态/证据方案
- [x] G0 持续记录：PROGRESS.md
- [x] 复审后本机验证：Node v22 pnpm typecheck PASS；38 文件/724 个 unit tests PASS；contracts 下 forge test -q PASS；文档链接/5 张 Mermaid/diff-check PASS
- [x] 用户 G0 验收回执：2026-10-20 用户回复「可以,按你建议来,验收通过」；认可 G0 修订版，起始验收 head f92a4b4；G1 已解锁

## G0 已确认的验收内容

1. 这七条原文是否准确，G0–G7 的先后顺序是否符合预期。
2. G2 是否同意选择 **链上 per-parent 独立 owner、受限可撤销 operator、NFT 持有人不可被平台直接没收** 的目标模型；V3 老部署只作兼容，另发新合约。
3. 接受以 L1 原生 ENS 名称、NameWrapper fuse/EAC 断权证明为 Sovereign 前提；Managed 与 Locked Record 各自另有条件，所有保障受期限限制。
4. 接受 AAStar 多签限于服务合约与基金，SDK profile 可替换，生产不得保留可重新夺权的超级管理员。
5. G6 在 G5 的测试和审计门通过后才执行，且每个 `.eth` owner **主动选择** 设置 ENS resolver / 子 registry。

## 近期必须重新核实的事项

1. 截至 G0 文档设计验收尚未完成真实 CCIP-Read 和完整部署链验证，**不作线上整体“绿”声明**；G1 开发期间的 OP Sepolia 独立只读探针见 G1 交付证据。
2. 生产 `scripts/deploy-production.sh`、`scripts/deploy-v3.sh` 与生产 `workers/*/wrangler.toml` 需要 G5 对网络作用域及版本做专项复核。
3. 官方 ENSv2 仍会迭代；任何 v2 主网兼容承诺必须建立在当时官方部署地址、ABI 和实链验证上。

## 回执模板

`G0 ACCEPTED / CHANGES_REQUESTED — 日期 — 验收提交 SHA — 意见/阻塞`。

G0 已于 2026-10-20 由用户明确验收通过。G1 现可启动；G1 只有在实现、验证、提交推送 PR 并取得用户下一次明确验收后，才能开启 G2。GitHub review/CI 和用户业务验收是独立门禁。
