# CometENS 任务台账 — Task

> 前置:[`roadmap.md`](roadmap.md) · [`architecture.md`](architecture.md) · [`spec.md`](spec.md) · [`acceptance.md`](acceptance.md)
> 状态:BACKLOG · READY · IN_PROGRESS · BLOCKED · PR_OPEN · CHANGES_REQUESTED · APPROVED · DONE
> **全部任务只跑测试网**(OP Sepolia / Ethereum Sepolia)。任何需要主网的操作一律标 BLOCKED。
> **凭据**:L1 RPC 用 `~/Dev/.env` 的 `SEPOLIA_RPC`;私钥只能用仓库 `.env.local`,
> `~/Dev/.env` 里没有私钥。**OP Sepolia 一律用公共节点 `https://sepolia.optimism.io`**
> (`.env.local` 的 Alchemy 地址已 403 失效)。**线上合约地址以 `wrangler.toml` 为准
> (`0xbA692Cdf…`),不要信 `.env.local` 里的 `0x8836E89D…`**。
> 私钥绝不写入任何提交文件、日志或 PR 描述,**任何脚本不得打印私钥原值**。

**不可退化的基线**(每个 PR 都要保持):Foundry 198 passed · TS unit 101 passed · `pnpm typecheck` 干净。

---

## F1.0 — 环境与配置修正(必须最先做,否则链上任务全挂)

### T1.0.1 修正 RPC 与合约地址的配置漂移  `READY`
- **优先级**:critical
- **目标**:让后续所有链上任务连得上正确的网络与正确的合约。
- **开发范围**:①`.env.op-sepolia` 示例与文档里把 OP Sepolia 默认 RPC 改为
  `https://sepolia.optimism.io`(可被环境变量覆盖);②修正 `.env.local` 说明/示例中
  过期的 `VITE_L2_RECORDS_ADDRESS`,并在文档里写明"线上地址以 wrangler.toml 为准";
  ③加一条 npm 脚本 `pnpm check:chain` 打印当前连到的 chainId、合约地址、`owner()`。
- **明确不做**:不改 `wrangler.toml` 里的线上配置;不重新部署任何合约或 Worker。
- **依赖**:无
- **交付物**:更新的 env 示例/文档 + `pnpm check:chain`
- **验收命令**:`pnpm check:chain` 必须成功输出 chainId=11155420 且
  `owner()` 非零(用公共 RPC,不依赖 Alchemy)
- **涉及文件**:`.env.op-sepolia`、`scripts/`、`package.json`、`README.md`
- **证据**:

---

## F1.1 — 主干流程 UI 产品化

### T1.1.1 建立统一设计系统  `READY`
- **优先级**:high
- **目标**:用一套共享 CSS token + 组件类取代各页内联 `<style>`,成为唯一样式来源。
- **开发范围**:按 spec.md §4 建 `src/styles/design-system.css`,定义全部 token
  (配色/间距/字号/圆角/阴影)与组件类(`.btn` `.input` `.card` `.badge` `.alert-*`
  `.skeleton` `.empty-state`);支持深浅色;按钮三态。在 `index.html` 先接入验证。
- **明确不做**:不引入任何 UI 框架/Tailwind CDN;保持零运行时依赖(viem 之外)。
- **依赖**:无
- **交付物**:`src/styles/design-system.css` + `index.html` 接入
- **验收命令**:`pnpm build && pnpm typecheck && grep -c '^\s*--c-' src/styles/design-system.css`
  (build 与 typecheck 必须通过;token 数 ≥ 10)
- **涉及文件**:`src/styles/design-system.css`、`index.html`、`vite.config.ts`(如需)
- **证据**:

### T1.1.2 落地页重做(讲清楚这是什么)  `READY`
- **优先级**:high
- **目标**:让不懂链的人 30 秒内明白产品是什么、两种运营模式是什么。
- **开发范围**:重写 `index.html`,用设计系统;讲清「社区拥有一级域名 → 成员获赠二级域名」
  这条主线,以及自部署/委托托管两种模式的入口;标注**当前仅测试网**。
- **明确不做**:不做登录、不做注册表单、不做营销夸大话术。
- **依赖**:T1.1.1
- **交付物**:产品级 `index.html`
- **验收命令**:`pnpm build && node -e "const s=require('fs').readFileSync('index.html','utf8'); if(!/design-system/.test(s)) throw new Error('未接入设计系统'); if(!/(测试网|testnet|Testnet)/.test(s)) throw new Error('未标注测试网')"`
- **涉及文件**:`index.html`
- **证据**:

### T1.1.3 公开查询页(免登录)  `READY`
- **优先级**:high
- **目标**:任何人不连钱包、不登录,输入名字即可看到解析结果与归属。
- **开发范围**:一个查询面(可并入落地页或独立页),调用已有只读端点
  `/lookup`、`/check-owner`、`/check-label`;四态反馈(idle/loading/success/error);
  空状态与错误说人话。
- **明确不做**:不连钱包、不做写操作。
- **依赖**:T1.1.1
- **交付物**:查询页 + 对应 TS 逻辑 + 单测(输入校验与状态机)
- **验收命令**:`pnpm vitest run test/unit/ && pnpm build && pnpm typecheck`
- **涉及文件**:`index.html` 或新页、`src/`、`test/unit/`
- **证据**:

### T1.1.4 管理控制台产品化(管理员手动授予)  `READY`
- **优先级**:high
- **目标**:把 `admin.html` 从 demo 表单堆变成运营者用得下去的控制台。
- **开发范围**:用设计系统重做;把"手动授予子域"做成第一动作(标签 + 目标地址 → 授予);
  registrar 授权/撤销分区;所有链上操作走 spec.md §5 的四态反馈,
  错误按 spec.md §3 的错误表说人话;操作结果(name/node/txHash)可一键复制。
- **明确不做**:不做用户账号体系;不改后端端点契约。
- **依赖**:T1.1.1
- **交付物**:产品级 `admin.html` + `src/admin.ts` 重构
- **验收命令**:`pnpm build && pnpm typecheck && pnpm vitest run test/unit/ && node -e "const s=require('fs').readFileSync('src/admin.ts','utf8'); if(/\balert\(/.test(s)) throw new Error('仍在用 alert 做用户反馈')"`
- **涉及文件**:`admin.html`、`src/admin.ts`
- **证据**:

---

## F1.2 — 自部署路径

### T1.2.1 preflight 配置校验器  `READY`
- **优先级**:high
- **目标**:部署前就把错配拦下来,而不是运行时炸。
- **开发范围**:按 spec.md §1 实现 `scripts/preflight.ts`(检查项、人话建议、
  `--json`、退出码 0/1/2);**重点:①私钥被误加 `VITE_` 前缀必须 FAIL;
  ②新增 3b 密钥复用检查 —— owner/writer/gateway signer 派生同址时给 WARN
  (当前线上就是这种状态)**。
- **明确不做**:不自动修改任何配置文件,只报告。
- **硬性安全要求**:**绝不打印私钥原值**,只能输出存在性/格式/派生地址/掩码。
- **依赖**:无
- **交付物**:`scripts/preflight.ts` + `pnpm preflight` + 单测
- **验收命令**:`pnpm vitest run test/unit/preflight.test.ts && pnpm preflight --json`
  (单测必须覆盖:缺变量 FAIL、VITE_ 私钥 FAIL、密钥复用 WARN、合法配置 PASS,
  并断言**输出中不含任何 64 位 hex 私钥串**)
- **涉及文件**:`scripts/preflight.ts`、`test/unit/preflight.test.ts`、`package.json`
- **证据**:

### T1.2.2 一键 bootstrap 部署脚本(测试网实跑)  `READY`
- **优先级**:high
- **目标**:一条命令为一个新社区在 OP Sepolia 拉起全套,并输出收尾清单。
- **开发范围**:按 spec.md §2 实现 `scripts/bootstrap-community.ts`
  (先跑 preflight → 部署 L2RecordsV3 → 打印 namehash → 输出可粘贴的收尾清单);
  支持 `--dry-run`;每步幂等。
- **明确不做**:不碰主网;不自动改 ENS(setResolver 由使用者自己执行,脚本只输出指引)。
- **依赖**:T1.2.1
- **交付物**:`scripts/bootstrap-community.ts` + `pnpm bootstrap:community` + 一次 OP Sepolia 实跑记录
- **验收命令**:`pnpm bootstrap:community --root test.eth --owner 0x... --dry-run`
  必须成功;并**在 OP Sepolia 真跑一次**,把合约地址与 `owner()` 校验结果记进 progress.md
- **风险/回滚**:会发真实测试网交易,消耗测试网 ETH。仅限 Sepolia,失败可重跑。
- **涉及文件**:`scripts/bootstrap-community.ts`、`package.json`
- **证据**:

### T1.2.3 SELF-HOSTING.md 自部署指南  `READY`
- **优先级**:high
- **目标**:陌生开发者照着能在 2 小时内跑通,全程不需要联系我们。
- **开发范围**:基于 T1.2.2 的**实跑结果**写(不是凭空写):前置条件 → preflight →
  bootstrap → 配置 Workers → setResolver → 验证解析;含常见错误排查表。
- **明确不做**:不写主网步骤(标注"主网见 M2")。
- **依赖**:T1.2.2(必须先有实跑输出)
- **交付物**:`docs/SELF-HOSTING.md`
- **验收命令**:`node -e "const s=require('fs').readFileSync('docs/SELF-HOSTING.md','utf8'); for (const k of ['preflight','bootstrap','setResolver','getEnsAddress']) if(!s.includes(k)) throw new Error('缺少步骤: '+k)"`
- **涉及文件**:`docs/SELF-HOSTING.md`
- **证据**:

---

## F1.3 — 委托托管闭环(管理权/所有权分离)

### T1.3.1 delegate CLI + 撤销的**诚实**链上验证  `READY`
- **优先级**:high
- **目标**:把 registrar 授权/查询/撤销做成可用命令(**模式 A 用**),
  并用测试**同时证明它有效、和它的边界在哪**。
- **开发范围**:按 spec.md §3 实现 `scripts/delegate.ts`(grant/status/revoke),
  错误按错误表分类给提示。补 Foundry 测试守住**三条**性质:
  1. registrar **不能越权**到别的 parentNode(revert);
  2. `removeRegistrar` 后该 registrar 再发子域 **revert**;
  3. **⚠️ 反向断言(本任务的重点)**:同样撤销之后,**合约 owner 仍然能发出该 parentNode 的子域、
     仍能覆写记录、仍能转移他人 NFT** —— 必须有测试把这个事实钉死。
- **为什么必须有第 3 条**:只测 1+2 会得到"撤销已验证 ✅"的**假阳性**,
  而托管场景下我们就是 owner,撤销对我们根本不生效。少了这条测试,
  文档就会写出当前不成立的安全承诺。
- **明确不做**:不新增合约、不改 owner 权限语义(那属于 TB.3 的架构决策)。
- **依赖**:T1.0.1(需要可用的 RPC)
- **交付物**:`scripts/delegate.ts` + 3 组 Foundry 测试 + 一次链上实跑记录
- **验收命令**:`forge test` 全绿;且
  `grep -c "owner" contracts/test/L2RecordsV3.t.sol` 对应的新增用例必须存在并断言
  **owner 在 revoke 之后依然成功**(不是 revert)
- **风险/回滚**:发测试网交易。**必须在 T1.2.2 新部署的合约上跑,
  严禁对线上 `0xbA692Cdf…` 执行任何写操作**(线上 owner 与运营 EOA 同址,误操作会影响已上线服务)。
- **涉及文件**:`scripts/delegate.ts`、`contracts/test/L2RecordsV3.t.sol`、`package.json`
- **证据**:

### T1.3.2 DELEGATED-HOSTING.md + 上游 API 接入文档  `BLOCKED`
- **优先级**:mid
- **目标**:让社区看懂"我交出了什么、保留了什么、怎么收回";让上游系统能照着接 API。
- **开发范围**:写 `docs/DELEGATED-HOSTING.md`(所有权 vs 管理权、授权/撤销流程、
  基于 T1.3.1 实跑结果);写 `docs/UPSTREAM-API.md`(按 spec.md §7.1:
  `/v1/register` 调用范例 + 失败语义表)。
- **明确不做**:不承诺 SLA、不写计费。
- **依赖**:T1.3.1 **+ TB.3 必须先拍板**
- **阻塞原因**:托管模式的信任模型尚未定案(见 TB.3)。在定案前写
  `DELEGATED-HOSTING.md` 必然写出过度承诺,定案后还要重写。
  **可以拆出不受阻塞的部分先做**:`docs/UPSTREAM-API.md`(纯 API 文档,与信任模型无关)。
- **交付物**:`docs/DELEGATED-HOSTING.md`(阻塞)、`docs/UPSTREAM-API.md`(可先做)
- **验收命令**:`node -e "const fs=require('fs'); const a=fs.readFileSync('docs/DELEGATED-HOSTING.md','utf8'); const b=fs.readFileSync('docs/UPSTREAM-API.md','utf8'); if(!/撤销|revoke/.test(a)) throw new Error('未写撤销'); if(!/v1\/register/.test(b)) throw new Error('未写端点')"`
- **涉及文件**:`docs/DELEGATED-HOSTING.md`、`docs/UPSTREAM-API.md`
- **证据**:

### T1.3.3 上游授予路径 e2e 测试  `READY`
- **优先级**:mid
- **目标**:证明「上游签名 → 子域真的 mint 给目标地址」,而不是只测了签名校验。
- **开发范围**:补 `test/e2e/` 用例:构造 personal_sign 请求打 `/v1/register`,
  断言返回 `{name,node,txHash}` 且 `subnodeOwner(node)` == 目标地址;
  覆盖失败分支(签名者不在白名单 / parent 不在白名单 / 标签已占用)。
- **依赖**:无
- **交付物**:`test/e2e/upstream-grant.test.ts`
- **验收命令**:`pnpm vitest run test/e2e/upstream-grant.test.ts`
- **涉及文件**:`test/e2e/upstream-grant.test.ts`
- **证据**:

---

## F1.4 — 文档与规划一致性

### T1.4.1 同步 docs/roadmap.md 到真实状态  `READY`
- **优先级**:mid
- **目标**:消除"文档说 v0.6.0、实际 v0.7.0 且已上测试网"的脱节。
- **开发范围**:更新 `docs/roadmap.md`:补 HybridResolver、Cloudflare 部署、
  198 测试基线;**把 D4 主网标为推迟到 M2**;补当前阶段"仅测试网"的定位声明。
- **依赖**:无
- **交付物**:更新后的 `docs/roadmap.md`
- **验收命令**:`node -e "const s=require('fs').readFileSync('docs/roadmap.md','utf8'); if(!/v0\.7\.0/.test(s)) throw new Error('未同步版本'); if(!/Hybrid/.test(s)) throw new Error('缺 HybridResolver')"`
- **涉及文件**:`docs/roadmap.md`
- **证据**:

### T1.4.2 README 重写为开源自部署定位  `READY`
- **优先级**:mid
- **目标**:README 第一屏说清"这是可自部署的开源社区 ENS 域名组件",而不是项目日志。
- **开发范围**:重写 README:一句话定位、核心用户旅程图、两种模式、
  **当前仅测试网**、快速开始(指向 SELF-HOSTING.md)、API 指向 UPSTREAM-API.md。
- **依赖**:T1.2.3、T1.3.2(要能指过去)
- **交付物**:重写的 `README.md`
- **验收命令**:`node -e "const s=require('fs').readFileSync('README.md','utf8'); for(const k of ['SELF-HOSTING','UPSTREAM-API','Apache']) if(!s.includes(k)) throw new Error('缺: '+k)"`
- **涉及文件**:`README.md`
- **证据**:

---

## BLOCKED — 需要用户拍板,夜间不得自行决定

### TB.1 主网部署(D4)  `BLOCKED`
- **阻塞原因**:用户 2026-09 明确当前阶段只做测试网。主网属 M2。
- **解除条件**:M1 验收通过 + 用户明确指示上主网。

### TB.3 托管模式的信任模型 / 密钥架构决策  `BLOCKED` 🔴 最高优先待决
- **问题**:线上合约 `0xbA692Cdf…` 的 `owner`、写入管道 EOA、CCIP-Read 网关签名者
  **三者是同一把私钥**(`0xb5600060…`)。而 owner 无条件绕过 registrar/quota/expiry,
  可覆写任意记录、转移任意子域 NFT。因此:
  - 托管模式下"社区可撤销我们"在链上**不成立**(只能在 L1 改 resolver);
  - 该密钥泄露一次 = 既能伪造全网解析应答,又能没收任意用户的名字。
- **需要你在三者中选一**:
  1. **每个托管社区独立部署一份 L2RecordsV3**,owner 用冷钱包/多签,
     日常只用 registrar 权限写入(改动小,复用现有部署脚本);
  2. **共享实例但拆密钥**:owner 进多签冷存,日常写入用另一把只被授予 registrar 的热钥;
  3. **接受现状**,但在 `DELEGATED-HOSTING.md` 里如实披露"运营方可没收",不做技术约束。
- **解除条件**:你选定方案。选定前 T1.3.2 的 DELEGATED-HOSTING.md 不动笔。
- **注意**:此项**不影响** F1.0/F1.1/F1.2 与 T1.3.1 的执行,夜间可照常推进其余任务。

### TB.4 register.html 自助注册流的处置  `BLOCKED`
- **问题**:`register.html` + `src/register.ts` 是一条**已上线**的自助注册流
  (连钱包即可自行申领),从 `index.html:32` 直接链接,
  `workers/api/src/index.ts:569` 注释写明 "Self-service model: any wallet can register
  their own subdomain."。这与你定的"用户不登录、子域由 API/管理员授予"直接冲突。
- **需要你在三者中选一**:
  1. **下线**:移除首页入口与页面,写路径只保留 API 授予 + 管理员授予;
  2. **保留但收口**:作为自部署者可选开关(默认关),默认部署不暴露;
  3. **承认为第三条路径**:保留并在文档中如实写明"支持自助申领",
     同时修正 acceptance.md 里"jack 不注册"的表述。
- **解除条件**:你选定方案。选定前不改动 register 相关代码。

### TB.2 DNSSEC → ENS 导入验证  `BLOCKED`
- **阻塞原因**:需要用户在域名注册商侧启用 DNSSEC 并配置 `_ens` TXT,
  且需用户指定该域名的链上 owner 地址。见 `docs/DNSSEC-VERIFY-RUNBOOK.md`。
- **解除条件**:用户完成注册商侧操作并给出 owner 地址。
