# CometENS Goal — 当前交付状态与用户验收回执

记录日期：2026-10-20（Asia/Bangkok）；完整步骤见 [MILESTONES.md](MILESTONES.md)。状态值：`PENDING`、`IN_PROGRESS`、`READY_FOR_ACCEPTANCE`、`ACCEPTED`、`BLOCKED`。

| Goal | 当前状态 | 下一解锁事件 |
|---|---|---|
| **G0 原文/架构/计划基线** | `READY_FOR_ACCEPTANCE`（[PR #110](https://github.com/MushroomDAO/CometENS/pull/110)，待用户确认） | 用户明确接受 G0 交付物及阶段划分 |
| G1 独立 SDK | `BLOCKED` | G0 被用户验收 |
| G2 per-parent owner / 可撤销 operator | `BLOCKED` | G1 被用户验收 |
| G3 ENSv1 兼容 + ENSv2 适配及 7×24 解析 | `BLOCKED` | G2 被用户验收 |
| G4 开源自部署、demo、UI 安全 | `BLOCKED` | G3 被用户验收 |
| G5 Sepolia 全量安全验收 | `BLOCKED` | G4 被用户验收 |
| G6 OP + Ethereum 主网部署 | `BLOCKED` | G5 完成且用户确认生产参数/交易 |
| G7 AAStar SDK / AirAccount 集成 | `BLOCKED` | G6 被用户验收 |

## G0 交付清单

- [x] 七条需求及执行指令原文：`VISION.md`
- [x] 既有能力、SDK、合约权限、跨链解析、ENSv2 路线：`ARCHITECTURE.md`
- [x] G0–G7 子任务、验收门槛和依赖：`MILESTONES.md`
- [x] 基线：2026-10-20 `pnpm typecheck` PASS；`pnpm vitest run test/unit/` 38 files/706 tests PASS；`forge test -q` PASS（本机 Node v22/Foundry）
- [x] G0 已提交分支 `goal/g0-community-ens-plan`，验收 [PR #110](https://github.com/MushroomDAO/CometENS/pull/110)；以 PR 最新 head SHA 为准
- [ ] 用户 G0 验收回执（填写日期与明确结论后才开启 G1）

## G0 验收者需要确认

1. 这七条原文是否准确，G0–G7 的先后顺序是否符合预期。
2. G2 是否同意选择 **链上 per-parent 独立 owner、受限可撤销 operator、NFT 持有人不可被平台直接没收** 的目标模型；V3 老部署只作兼容，另发新合约。
3. G6 在 G5 的测试和审计门通过后才执行，且每个 `.eth` owner **主动选择** 设置 ENS resolver / 子 registry。

## 近期必须重新核实的事项

1. 尚未运行线上 `/check:chain`、真实 CCIP-Read 及 `/check:deploy-order`，**不作在线“绿”声明**。
2. 生产 `scripts/deploy-production.sh`、`scripts/deploy-v3.sh` 与生产 `workers/*/wrangler.toml` 需要 G5 对网络作用域及版本做专项复核。
3. 官方 ENSv2 仍会迭代；任何 v2 主网兼容承诺必须建立在当时官方部署地址、ABI 和实链验证上。

## 回执模板

`G0 ACCEPTED / CHANGES_REQUESTED — 日期 — 验收提交 SHA — 意见/阻塞`。

只有收到用户明确 `G0 ACCEPTED`（或等效意思）才能把 G1 改成 `IN_PROGRESS`。每个阶段都沿用同一机制；不能自动跳过。
