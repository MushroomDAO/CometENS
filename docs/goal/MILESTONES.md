# CometENS Goal — 里程碑、子任务与验收

> 原始需求：[VISION.md](VISION.md) · 技术和信任边界：[ARCHITECTURE.md](ARCHITECTURE.md) · 当前进度：[STATUS.md](STATUS.md)。编号 G* 与历史 `docs/agent` 里的 M* 不冲突。

## 依赖与交付门

`G0 → G1 → G2 → G3 → G4 → G5 → G6 → G7`

同一 Goal 内的小任务可以并行，但前置接口、测试和签名契约必须先固定；**每个 G 的验收权在用户**。每个 Goal 以仓库中的 commit / PR、测试命令与输出、部署地址和交易哈希（如适用）、操作手册及风险清单作为完整交付包。完成代码但缺外部验收的状态是 `READY_FOR_ACCEPTANCE` 而非 `ACCEPTED`。

## G0 — 原始目标与安全架构基线（当前 Goal）

**目的**：明确七项需求、现状与实施顺序，先暴露旧系统会影响主网或委托安全的事实。

| ID | 子任务 | 交付物/检查 |
|---|---|---|
| G0.1 | 原样固化 7 项业务目标与分阶段门禁 | `VISION.md` 原文；后续技术口径可修改但不覆盖原文 |
| G0.2 | 核对链、SDK、Worker、授权、ENSv2 实现基线 | `ARCHITECTURE.md` 现状表引用真实代码/部署配置；不将 README 地址当成在线验证 |
| G0.3 | 划定每根域名主权、EOA 最小权限、撤销、L1/L2 信任边界 | `ARCHITECTURE.md` 安全设计与反例/失败策略 |
| G0.4 | 拆成逐阶段可验收开发/上线计划 | 本文件 G1–G7：任务、验证方法、风险、前置与交付范围 |
| G0.5 | 建立 Goal 状态与验收回执 | `STATUS.md`；保留 `AWAITING_USER` 门禁与下阶段队列 |

**机器验收**：`git diff --check`；`pnpm typecheck`；`pnpm vitest run test/unit/`；`(cd contracts && forge test -q)`（若工具链存在）。**人工验收**：用户确认原文完整、阶段顺序、G2 安全模型和 G6 主网门禁。G0 不触发交易/发布，也不声明测试网的在线健康状态。

## G1 — 可发布、可独立接入的 CometENS SDK

| ID | 子任务 | 验收判据 |
|---|---|---|
| G1.1 | 抽出独立包（例如 `@cometens/sdk`），提供 exports、ESM/types、构建与版本约定 | 从仓库外的空白示例项目 `pnpm add` 本地包产物后可 `import`、构建、运行；无 Vite/Worker 强依赖 |
| G1.2 | 链配置显式指定 chainId/配置档；L1/L2 实际 RPC chainId 交叉校验 | 自定义 RPC 名称也识别正确；故意错链 fail-closed；测试网是默认示例，主网需显式选择 |
| G1.3 | ReadOnly API：`getAddr/getText/getContenthash/resolve`，区分 L2 原始记录与全网 ENS 解析 | SDK 与链上 record 对照、标准 ENS 客户端解析一致；错误报告包含来源与实际网络 |
| G1.4 | Write API：mint/allocate、地址/文本/contenthash、owner/工作 EOA 调用接口，按真实 Worker 路由与 EIP-712 合同实现 | 正/反例：签名者、nonce、deadline、chainId、verifyingContract、parent 不一致均拒绝；禁止从 `Date.now()` 伪造已签署 nonce |
| G1.5 | 事件和错误码、README、最小 TS demo、SDK API 与现有 `@aastar/sdk` 包边界评审 | 无私钥示例、清晰错误语义、SDK test 与示例 CI 全绿；保留兼容层并声明 breaking changes |
| G1.6 | API 错配 fail-closed 与网关签名路由输入/错误处理安全修复 | ROOT_DOMAIN(S) 全空拒绝写入；sender/data 长度与格式、允许列表同等校验；任何原始 RPC 错误不得返回凭据 |

**门禁**：先固定 API/ABI/认证契约，随后提供 SDK 包和真实集成测试。旧版 `sdk/CometENS.ts` 的 `setText` placeholder 和过时 `/api/manage/*` 路由必须被修复或显式 deprecate；不能将其直接发布为正式 SDK。G1 可消费 V3 测试网，但标明写接口在 G2 新授权合约上线后如何升级适配。

## G2 — 多域名独立主权与可撤销工作 EOA

| ID | 子任务 | 验收判据 |
|---|---|---|
| G2.1 | 新版合约（V4/新部署），每个 `parentNode` 单独控制者 `rootController`；授权关系包含 operator、权限位、parent、配额、到期与 nonce | A 域 owner 不能授权/修改 B 域；任何 parent 子树之外的发行/改记录失败 |
| G2.2 | Owner 可 grant / scope-restrict / revoke / rotate EOA；热钱包只持最小权限 | 授权后能发子域；撤销 OP 链确认后不能再发，也不能改记录；跨域、过期、越额、重复签名失败 |
| G2.3 | 对成员 NFT 与记录实施真实权限边界 | 被撤销 operator 不能转走成员 NFT、覆写不属自己的记录；管理员 emergency 能力明确、可测试、可审计 |
| G2.4 | L1 `.eth` 控制权与 L2 `rootController` 的绑定/续接、转移/过期应对 | L1 owner/NameWrapper 授权证明被验证；转移/迁移/失效后旧授权不能继续扩权；不依赖未经验证的 Worker 声明 |
| G2.5 | CLI + SDK grant/status/revoke、多根租户隔离、事件索引/管理员 UI | 社区控制权始终在用户 owner；撤销可链上独立验证并带交易哈希和状态查询 |
| G2.6 | 原子 nonce 与签名代理合约路径；成员 NFT 转移后的旧记录处理策略 | 同 nonce 并发请求最多一个成功；Worker KV 丢失不能绕过合约防重放；转让后旧 addr/text 不会意外继续指向旧用户 |

**关键设计决定**：默认优先每社区隔离 owner/合约与签名域；共享合约必须具备同等的 root 级不可越权保证。**旧 V3 的全局 owner 可绕过 registrar、收回成员 NFT**，不得复用为“运营方再也不能碰”的主网承诺。G2 提供新合约与迁移脚本，保留 V3 的只读兼容；升级不可默默覆写旧记录。对于纯 offchain 子名，不能宣称它有 L1 自主退出权。

## G3 — 持续解析、ENSv1 兼容与 ENSv2 适配

| ID | 子任务 | 验收判据 |
|---|---|---|
| G3.1 | 解析策略层区分 `v1-unmigrated`、`v2-native`、`migrated`、`unknown/error` | v1 未迁移域名使用官方兼容路径；v2 已迁移域名不能静默降级到过时 v1 记录 |
| G3.2 | 保留 CCIP-Read（EIP-3668）、双网关和 OP 原始数据核对 | 常规 ENS 客户端可解析；任意一个网关离线，配置的第二节点可恢复；拒绝未经授权的签名和重放 |
| G3.3 | 监控 ENSv2 官方部署/ABI/迁移状态并提供兼容性清单 | 每次升级以官方链接、日期、链 ID、测试矩阵登记；出现不兼容时出具阻断报告 |
| G3.4 | 可观测性：链上读取/最终性、缓存 TTL、解析一致性、故障与回滚 | 公共状态页/指标与告警；不将签名应答伪装为 L2 证明；故障回落策略和数据新鲜度可查 |

**验收**：Sepolia 上真实 ENSv1/v2 域名样例 + 合成故障；独立 viem/ENS Explorer 核验；不通过旧记录“兜底”掩盖新控制权或迁移状态。解析需要 7×24 运行，G3 验收后持续运营及版本回归，不是一次性脚本。

## G4 — 安全、交互和开源自部署生态

| ID | 子任务 | 验收判据 |
|---|---|---|
| G4.1 | SDK 最小站点嵌入 demo：只读、申请/审批、自动授予、绑定、管理 | 两个独立 Web 项目（一静态、一框架项目）接入 SDK；无需登录 CometENS 才能读 |
| G4.2 | owner/operator UI：网络提示、grant/revoke 审核、权限范围展示、交易状态 | 错链/签名拒绝有可操作错误；375px 移动端、键盘、加载/空/失败四态验收 |
| G4.3 | 自部署工具：Docker 或 Workers 参考部署、配置校验、文档和升级/备份 | 陌生开发者以自己的域名和密钥在 Sepolia 跑通；无对 CometENS 托管账号依赖 |
| G4.4 | API 限流、审计、轮换、签名重放/存储攻击、权限最小化 | 压测、滥用/恶意输入测试、owner 与 operator 与 gateway signer 密钥分离均达标 |

**验收**：有记录的端到端屏幕操作、可复现实验与公开 OSS 示例链接；开放源代码、文档和许可持续有效。

## G5 — Sepolia 完整验收与主网安全门

| ID | 子任务 | 验收判据 |
|---|---|---|
| G5.1 | OP Sepolia + Ethereum Sepolia 完整部署 rehearsals | 合约地址、verified source、部署者、owner、chainId、commit、区块高度与交易哈希留痕 |
| G5.2 | 多租户、revocation、ENSv1/v2、CCIP-Read、客户端与恢复 E2E | 正反用例全过，包含旧 owner 路径绕过、跨根授权、网关伪造/降级、ENS 域名转移 |
| G5.3 | 安全评审/外部独立审计、威胁模型、gas 与运行成本复核 | Critical/High 问题清零；Medium 按用户认可的风险预算处理；不能只用单元测试代替安全审计 |
| G5.4 | 主网发布候选版本和回滚彩排 | 审计后的源代码冻结；可恢复 resolver/网关；参数、签名者、owner 多签、监控、预算清晰 |

**门禁**：G5 的证据齐全且用户签字验收后，G6 才可执行 Ethereum/OP 主网写操作。

## G6 — OP Mainnet + Ethereum Mainnet 生产部署

| ID | 子任务 | 验收判据 |
|---|---|---|
| G6.1 | 公布合约和运维参数、正式多签 owner 与最小权限 operator | 参数二次复核；各链 chainId、地址和源码在区块浏览器验证一致 |
| G6.2 | **OP Mainnet 部署 V4 L2 records**、Ethereum Mainnet 部署兼容 resolver | 部署哈希、source verification、owner/角色权读取和预定发布 commit 一致 |
| G6.3 | 首批自主选择的 `.eth` 社区 opt-in，真实姓名解析与撤销验证 | 社区用自己持有的 ENS 域名进行 `setResolver`/相应 v2 操作，不需转移域名 NFT；第三方客户端可解析 |
| G6.4 | 冗余解析、监控、应急恢复、公开 SLA/SLO 与主网接入文档 | 已执行实际故障演练；错误率/延时和告警有可审阅数据，关闭失败时 fail-closed |

**范围**：“为所有 ETH 域名提供服务”解释为 **任何合格 `.eth` owner 可自主选择接入**；不代表我们有权修改全部 `.eth` 域名。切主网的链上交易为单独用户批准点，未经 G5 验收不得广播。

## G7 — AAStar SDK / AirAccount 无缝集成

| ID | 子任务 | 验收判据 |
|---|---|---|
| G7.1 | `@aastar/sdk` 子路径或组合适配器，复用 CometENS SDK，不复制业务逻辑 | AAStar 示例导入可用；有版本约束和兼容性测试 |
| G7.2 | AirAccount 身份/智能账户接入，支持 EOA + EIP-1271/AA 签名策略 | AirAccount 控制的域名可授权、签名、撤销；gasless/代付选项不改变链上权限核验 |
| G7.3 | 双向示例、升级/迁移文档、开放发布和自动化回归 | 自部署 AirAccount demo、版本化 changelog、AAStar CI 全绿、用户完整验收 |

**持续工作**：每个里程碑执行期间，ENSv2 兼容性报告、已部署服务可用性和开源文档维护作为运营任务独立记录；持续维护不等于跳过用户的下一里程碑验收。
