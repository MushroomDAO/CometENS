# CometENS 任务台账 — Task

> 前置:[`roadmap.md`](roadmap.md) · [`architecture.md`](architecture.md) · [`spec.md`](spec.md) · [`acceptance.md`](acceptance.md)
> 状态:BACKLOG · READY · IN_PROGRESS · BLOCKED · PR_OPEN · CHANGES_REQUESTED · APPROVED · DONE
> **全部任务只跑测试网**(OP Sepolia / Ethereum Sepolia)。任何需要主网的操作一律标 BLOCKED。
> **凭据**:L1 RPC 用 `~/Dev/.env` 的 `SEPOLIA_RPC`;私钥只能用仓库 `.env.local`,
> `~/Dev/.env` 里没有私钥。**OP Sepolia 一律用公共节点 `https://sepolia.optimism.io`**
> (`.env.local` 的 Alchemy 地址已 403 失效)。**线上合约地址以 `wrangler.toml` 为准
> (`0xbA692Cdf…`),不要信 `.env.local` 里的 `0x8836E89D…`**。
> 私钥绝不写入任何提交文件、日志或 PR 描述,**任何脚本不得打印私钥原值**。

> **验收命令的硬规矩(两轮评审各拦下一批,记死)**:命令必须在**任务尚未完成时是红的**,
> 否则分不出"做了"和"没做"。因此:①**不要**拿"跑既有测试套件"(`pnpm vitest run test/unit/`、
> `pnpm typecheck`、`pnpm build`)当闸门——它们今天就 exit 0;要指向**本任务新增的**测试文件。
> ②**不要**用 `vitest -t '<用例名>'` 钉用例——过滤器不匹配时 exit **0**(实测),
> 要钉到用例粒度只能用 `grep -q 'function <名字>'`。③反向判据(如"不含 alert")
> 在目标文件本来就没有该模式时是**空的**,要先确认它今天是红的,否则改用正向锚。

**不可退化的基线**(每个 PR 都要保持):Foundry 198 passed · TS unit 101 passed · `pnpm typecheck` 干净。

---

## F1.0 — 环境与配置修正(必须最先做,否则链上任务全挂)

### T1.0.1 修正 RPC 与合约地址的配置漂移  `DONE`
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
- **涉及文件**:`.env.op-sepolia`、`scripts/check-chain.mjs`、`package.json`
- **证据**:分支 `fix/T1.0.1-chain-config-drift` → PR(见 progress.md)

---

## F1.1 — 主干流程 UI 产品化

### T1.1.1 建立统一设计系统  `DONE`
- **优先级**:high
- **目标**:用一套共享 CSS token + 组件类取代各页内联 `<style>`,成为唯一样式来源。
- **开发范围**:按 spec.md §4 建 `src/styles/design-system.css`,定义全部 token
  (配色/间距/字号/圆角/阴影)与组件类(`.btn` `.input` `.card` `.badge` `.alert-*`
  `.skeleton` `.empty-state`);支持深浅色;按钮三态。在 `index.html` 先接入验证。
- **明确不做**:不引入任何 UI 框架/Tailwind CDN;保持零运行时依赖(viem 之外)。
- **依赖**:无
- **交付物**:`src/styles/design-system.css` + `index.html` 接入
- **验收命令**:
  `pnpm vitest run test/unit/design-system.test.ts && pnpm build && pnpm typecheck && test "$(grep -c '^[[:space:]]*--c-' src/styles/design-system.css)" -ge 10`
  (`grep -c` 单独用只能区分 0 与非 0——1 个 token 也会 exit 0 让整条链通过,
  必须用 `test … -ge 10` 才真的检查数量。
  **另加 design-system.test.ts:token 数量与 build 都查不到「token 组合出来的效果」**——
  PR #23 评审实测出每个按钮 hover 时文字与背景同色、对比度 1.00,而 build 绿、
  token 数也绿。该测试断言所有前景/背景配对满足 WCAG AA,并自带必失败对照)
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
- **交付物**:查询页 + 对应 TS 逻辑 + 新增单测 `test/unit/lookup.test.ts`(输入校验与状态机)
- **验收命令**:`pnpm vitest run test/unit/lookup.test.ts && pnpm build && pnpm typecheck`
  (必须指向**本任务新增的**测试文件;指向整个 `test/unit/` 今天就是 exit 0,
  分不出"做了"和"没做")
- **涉及文件**:`index.html` 或新页、`src/`、`test/unit/`
- **证据**:

### T1.1.4 管理控制台产品化(管理员手动授予)  `PR_OPEN`
- **优先级**:high
- **目标**:把 `admin.html` 从 demo 表单堆变成运营者用得下去的控制台。
- **开发范围**:用设计系统重做;把"手动授予子域"做成第一动作(标签 + 目标地址 → 授予);
  registrar 授权/撤销分区;所有链上操作走 spec.md §5 的四态反馈,
  错误按 spec.md §3 的错误表说人话;操作结果(name/node/txHash)可一键复制。
- **明确不做**:不做用户账号体系;不改后端端点契约。
- **依赖**:T1.1.1
- **交付物**:产品级 `admin.html` + `src/admin.ts` 重构
- **验收命令**:
  `pnpm vitest run test/unit/ui-state.test.ts test/unit/page-wiring.test.ts && pnpm build && pnpm typecheck && node -e "const s=require('fs').readFileSync('src/admin.ts','utf8'); if(/\balert\(/.test(s)) throw new Error('仍在用 alert 做用户反馈')"`
  (原来那半是 `pnpm vitest run test/unit/`,今天就 exit 0,分不出做没做;
  改指向本任务新增的 `test/unit/ui-state.test.ts`。
  alert 那条判据**本身有效**——`src/admin.ts` 改前确有 1 处,反例对照也命中;
  但它是纯文本匹配,分不清代码与注释,写注释时要避开 `alert(` 字面量)
- **涉及文件**:`admin.html`、`src/admin.ts`
- **证据**:

---

## F1.2 — 自部署路径

### T1.2.1 preflight 配置校验器  `DONE`
- **优先级**:high
- **目标**:部署前就把错配拦下来,而不是运行时炸。
- **开发范围**:按 spec.md §1 实现 `scripts/preflight.ts`(检查项、人话建议、
  `--json`、退出码 0/1/2);**重点:①私钥被误加 `VITE_` 前缀必须 FAIL;
  ②新增 3b 密钥复用检查 —— owner/writer/gateway signer 派生同址时给 WARN
  (当前线上就是这种状态)**。
- **明确不做**:不自动修改任何配置文件,只报告。
- **硬性安全要求**:**绝不打印私钥原值**,只能输出存在性/格式/派生地址/掩码。
- **依赖**:无
- **交付物**:`scripts/preflight.mjs` + `pnpm preflight` + `test/unit/preflight.test.ts`
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
  1. registrar **不能越权**到别的 parentNode:
     `vm.expectRevert(L2RecordsV3.Unauthorized.selector)`(**不接受裸 `expectRevert()`**);
  2a. **正对照** —— 撤销**之前**,该 registrar 调 `setSubnodeOwner` 必须**成功**
     (没有这条,"撤销后失败"可能只是因为它从来就没成功过);
  2b. 撤销**之后**,同一 registrar 再发子域必须
     `vm.expectRevert(L2RecordsV3.Unauthorized.selector)`(同样不接受裸 revert);
  3. **⚠️ 反向断言(本任务的重点)**:同样撤销之后,**合约 owner 仍然能发出该 parentNode 的子域、
     仍能覆写记录、仍能转移他人 NFT** —— 必须有测试把这个事实钉死。
     该用例固定命名 `test_ownerCanStillRegisterAfterRevoke`,供验收命令精确检出。

> 注:本文件里的三条性质必须自足。`pilot run` 只读 tasks.md、**不读 acceptance.md**
> (`~/.claude/skills/pilot/phases/run.md:125`),写在别处的更严格版本到不了执行者手上。
- **为什么必须有第 3 条**:只测 1+2 会得到"撤销已验证 ✅"的**假阳性**,
  而托管场景下我们就是 owner,撤销对我们根本不生效。少了这条测试,
  文档就会写出当前不成立的安全承诺。
- **明确不做**:不新增合约、不改 owner 权限语义(那属于 TB.3 的架构决策)。
- **依赖**:T1.0.1(需要可用的 RPC)
- **交付物**:`scripts/delegate.ts` + 3 组 Foundry 测试 + 一次链上实跑记录
- **验收命令**:
  `forge test && grep -q 'function test_ownerCanStillRegisterAfterRevoke' contracts/test/L2RecordsV3.t.sol`
  (**当前树上这条是红的**;此前用的 `grep -c "owner" …` 恒真——现在就返回 25/exit 0,
  区分不了"反向断言写了"和"什么都没写",正是本任务要消灭的假阳性)
- **风险/回滚**:发测试网交易。**必须在 T1.2.2 新部署的合约上跑,
  严禁对线上 `0xbA692Cdf…` 执行任何写操作**(线上 owner 与运营 EOA 同址,误操作会影响已上线服务)。
- **涉及文件**:`scripts/delegate.ts`、`contracts/test/L2RecordsV3.t.sol`、`package.json`
- **证据**:

### T1.3.2 DELEGATED-HOSTING.md + 上游 API 接入文档  `READY`
- **优先级**:mid
- **目标**:让社区看懂"我交出了什么、保留了什么、怎么收回";让上游系统能照着接 API。
- **开发范围**:写 `docs/DELEGATED-HOSTING.md`(所有权 vs 管理权、授权/撤销流程、
  基于 T1.3.1 实跑结果);写 `docs/UPSTREAM-API.md`(按 spec.md §7.1:
  `/v1/register` 调用范例 + 失败语义表)。
- **明确不做**:不承诺 SLA、不写计费。
- **依赖**:T1.3.1(TB.3 已于 2026-09-03 决策,不再阻塞)
- **必须写进 DELEGATED-HOSTING.md 的两条**:①按 TB.3 决策描述密钥架构
  (KMS/TEE 保管 + 三钥分离 + owner 冷存不用于日常写入);
  ②如实披露 KMS **不改变** owner 在链上被允许做什么,运营方技术上仍可覆写/收回已发子域。
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

## F1.5 — 签名器抽象与密钥分离(TB.3 落地)

### T1.5.0 网关签名钥轮换脚本 + runbook(**不依赖任何待决事项**)  `DONE`
- **优先级**:high
- **目标**:把三钥复用里**最容易解掉的一把**先解掉:那把 7×24 在线的 CCIP-Read 签名钥。
- **为什么现在就能做**:网关签名用 `PRIVATE_KEY_SUPPLIER`
  (`workers/gateway/src/index.ts:366`),写入用 `WORKER_EOA_PRIVATE_KEY`
  (`workers/api/src/index.ts:855`)——**是两个 Worker 里两个不同的变量,复用是配置不是架构**。
  且 `HybridResolver:112/118` 与 `OffchainResolver:60/66` 都有 `addSigner`/`removeSigner`,
  因此 `addSigner(新)` → 换 secret → `removeSigner(旧)` 即可热轮换,
  **不需要重新部署、不需要多签、不依赖 TB.3 的任何决策**。
- **开发范围**:写 `scripts/rotate-gateway-signer.ts`,分三步且**每步之间做验证**
  (加新签名者 → 确认链上已生效 → 换 secret → 实测解析仍通过 → 摘旧签名者);
  必须支持 `--dry-run`;写 `docs/KEY-ROTATION.md` runbook。
- **明确不做**:**夜间不得对线上环境真执行轮换**——顺序错一步会让网关解析全挂。
  夜间只交付「脚本 + dry-run 通过 + runbook」,真轮换是人工步骤。
- **依赖**:无
- **交付物**:`scripts/rotate-gateway-signer.ts` + `docs/KEY-ROTATION.md`
- **验收命令**:`pnpm typecheck && pnpm rotate:gateway-signer --dry-run`
  (dry-run 必须打印完整步骤与每步的验证点,且**不发任何交易**)
- **风险/回滚**:脚本本身零风险(dry-run);真执行由人做,runbook 须含回滚步骤
  (摘错了就把旧签名者 addSigner 回去)。
- **涉及文件**:`scripts/rotate-gateway-signer.ts`、`docs/KEY-ROTATION.md`、`package.json`
- **证据**:

### T1.5.1 抽象签名器接口 + env-key 实现  `READY`
- **优先级**:high
- **目标**:把"用哪把钥匙、怎么签"从业务逻辑里剥离,为 KMS 留出插槽,
  同时保证自部署者只需一个环境变量即可运行。
- **开发范围**:定义 `Signer` 接口(至少 `signTransaction` 与 `signMessage`/`signTypedData`);
  实现 `EnvKeySigner`(从环境变量读私钥,默认实现);
  把 API worker 的写路径与 gateway 的 EIP-3668 应答签名改为经此接口获取签名者。
- **明确不做**:本任务**不实现 KMS**(见 T1.5.3);不改任何链上合约。
- **依赖**:无
- **交付物**:signer 接口 + `EnvKeySigner` + 两个 worker 接入 + 新增 `test/unit/signer.test.ts`
- **验收命令**:`pnpm vitest run test/unit/signer.test.ts && pnpm typecheck`
  (该文件当前不存在 → 今天 exit 1,fail-closed;
  须覆盖:接口契约、EnvKeySigner 派生地址正确、缺钥时报错清晰)
- **风险/回滚**:改动签名路径,**必须保证现有 e2e 解析仍通过**;
  不得改变已部署合约与线上 Worker 的对外行为。
- **涉及文件**:`workers/api/src/`、`workers/gateway/src/`、`test/unit/`
- **证据**:

### T1.5.2 三角色密钥分离 + preflight 校验  `READY`
- **优先级**:high
- **目标**:让 owner / writer / gateway-signer 在配置层就是三把独立的钥匙,
  并让 preflight 能检出"又混用了"。
- **开发范围**:配置上区分 `OWNER_KEY` / `WRITER_KEY` / `GATEWAY_SIGNER_KEY`
  (保留旧变量名兼容,但标记 deprecated);把 T1.2.1 的 3b 检查从 WARN 升级为
  可配置(自部署默认 WARN,托管配置下 FAIL);文档写明三者职责与最小权限。
- **明确不做**:不在本任务里轮换线上密钥(那是运维动作,需你执行)。
- **依赖**:T1.2.1、T1.5.1
- **交付物**:配置分离 + preflight 规则 + 文档章节
- **验收命令**:`pnpm vitest run test/unit/preflight.test.ts`
  (须有用例:三钥同址 → 触发告警/失败;三钥不同址 → PASS)
- **涉及文件**:`scripts/preflight.ts`、`.env.op-sepolia`、`workers/*/wrangler.toml` 注释、文档
- **证据**:

### T1.5.3 KMS(TEE)签名器实现  `BLOCKED`
- **阻塞原因**:需要一个可运行 TEE 的节点与 KMS 服务端,属基础设施,非夜间开发范围。
  另需确定 CometENS 写路径是留在 Cloudflare Workers(只能 HTTPS 调 KMS)
  还是迁到与 KMS 同机的自托管节点(可走 IPC)。
- **解除条件**:KMS 服务可用 + 你确定写路径部署形态。

---

## F1.6 — 申请 / 审批 / 授予流程(TB.4 落地)

### T1.6.1 审批策略与申请端点  `READY`
- **优先级**:high
- **目标**:把"直接发放"改成"提交申请",并支持 `auto` / `manual` 两种审批模式。
- **开发范围**:新增 `APPROVAL_MODE`(`auto`|`manual`,默认 `auto` 以兼容线上行为);
  新增申请端点(提交申请 → `auto` 直接发放并返回结果;`manual` 落 KV 队列返回 pending);
  新增管理员审批端点(批准 → 发放;拒绝 → 标记);申请状态查询端点。
  队列复用现有 KV 命名空间,不引入新依赖。
- **明确不做**:不做用户账号/登录;不做邮件通知;不引入数据库。
- **依赖**:无
- **交付物**:端点 + KV schema + 新增 `test/unit/approval.test.ts`
- **验收命令**:`pnpm vitest run test/unit/approval.test.ts && pnpm typecheck`
  (该文件当前不存在 → 今天 exit 1;须覆盖:auto 模式直接发放、manual 模式落队列、
  重复申请、**未授权者不能批准**、批准后状态流转)
- **风险/回滚**:`APPROVAL_MODE` 默认 `auto` 等价于当前行为,**向后兼容**,不影响线上。
- **涉及文件**:`workers/api/src/index.ts`、`test/unit/`
- **证据**:

### T1.6.2 register.html 改造为申请入口  `READY`
- **优先级**:mid
- **目标**:页面语义从"自己注册"改为"提交申请",并如实显示当前审批模式。
- **开发范围**:用设计系统重做;`auto` 模式下体验仍是即时拿到名字,
  `manual` 模式下提交后显示"已提交,等待审批"并可用申请号查询状态;四态反馈。
- **明确不做**:不做登录;不做账号体系。
- **依赖**:T1.1.1、T1.6.1
- **交付物**:改造后的 `register.html` + `src/register.ts`
- **验收命令**:`pnpm build && pnpm typecheck && grep -q '申请' register.html`
  (原来的 alert 判据是**空的** —— `src/register.ts` 现在就有 0 处 `alert(`,永远为真;
  换成正向锚:`register.html` 现在 0 处"申请" → 今天 exit 1。
  注:同一条 alert 判据在 T1.1.4 里**是有效的**,因为 `src/admin.ts` 现有 1 处)
- **涉及文件**:`register.html`、`src/register.ts`
- **证据**:

### T1.6.3 admin 审批队列页面  `READY`
- **优先级**:mid
- **目标**:管理员能看到待审列表,逐条批准/拒绝。
- **开发范围**:在管理控制台增加"待审批"分区:列表、批准、拒绝、空状态、四态反馈。
- **明确不做**:不做角色权限系统(沿用现有 EIP-712 管理员鉴权)。
- **依赖**:T1.1.4、T1.6.1
- **交付物**:admin 审批区 + 新增 `test/unit/admin-queue.test.ts`
- **验收命令**:`pnpm vitest run test/unit/admin-queue.test.ts && pnpm build && pnpm typecheck`
  (该文件当前不存在 → 今天 exit 1)
- **涉及文件**:`admin.html`、`src/admin.ts`
- **证据**:

---

## BLOCKED — 需要用户拍板,夜间不得自行决定

### TB.1 主网部署(D4)  `BLOCKED`
- **阻塞原因**:用户 2026-09 明确当前阶段只做测试网。主网属 M2。
- **解除条件**:M1 验收通过 + 用户明确指示上主网。

### TB.3 托管模式信任模型 / 密钥架构  ✅ **已决策(2026-09-03)**
- **原问题**:线上 `owner`、写入 EOA、CCIP-Read 网关签名者是同一把私钥(`0xb5600060…`),
  且 owner 无条件绕过 registrar/quota/expiry。
- **决策**:
  1. **密钥保管走 KMS(TEE 内保存私钥)**,CometENS 通过 RPC/HTTPS 调用其签名。
  2. **三角色密钥分离**:`OWNER_KEY` / `WRITER_KEY` / `GATEWAY_SIGNER_KEY` 各自独立,
     并各自绑定签名策略 —— **网关签名钥匙只允许签 EIP-3668 应答,永不允许签交易**。
  3. **owner 密钥冷存(或 KMS 严格策略),不用于日常写入**;日常发放用被授予 registrar
     权限的热钥。
  4. **签名器必须抽象**:自部署者不得被迫依赖 KMS/TEE(违反 research.md 的自部署零依赖边界)。
     接口两实现:`env-key`(默认,自部署)与 `kms`(我们托管运营)。
- **仍需注意**:KMS/TEE 解决的是**密钥保管**,不改变 owner 在链上**被允许做什么**。
  托管模式下仍须在 `DELEGATED-HOSTING.md` 如实披露 owner 的能力边界。
- **⚡ 无需等待本决策即可先做的一半**:网关签名钥与写入钥本就是两个 Worker 里的
  两个不同变量(`PRIVATE_KEY_SUPPLIER` vs `WORKER_EOA_PRIVATE_KEY`),复用属**配置**而非架构;
  两个 Resolver 都有 `addSigner`/`removeSigner`,可热轮换。见 T1.5.0。
- **落地任务**:F1.5(T1.5.0 / T1.5.1 / T1.5.2 夜间可做;
  T1.5.3 KMS 实现需基础设施,不在夜间范围)。

### TB.4 自助注册流的处置  ✅ **已决策(2026-09-03)**
- **原问题**:`register.html` 是已上线、从首页直链的开放自助注册(零审批),
  与"用户不登录、由 API/管理员授予"的定位冲突。
- **决策:改造成「申请 → 审批 → 授予」,且审批是可配置的**,两种模式都必须支持:
  - `APPROVAL_MODE=auto` —— 自动批准。等价于当前的开放自助领取,
    适用于运营方主动放弃门槛、免费为所有人服务的场景。
  - `APPROVAL_MODE=manual` —— 进审批队列,由管理员(多签成员或专职审核人)
    在 admin 页面逐条批准后才发放。
- **要点**:`auto` 模式与当前线上行为等价,因此该改造**向后兼容**,不破坏已上线服务。
- **落地任务**:F1.6(T1.6.1 / T1.6.2 / T1.6.3,均夜间可做)。

### TB.2 DNSSEC → ENS 导入验证  `BLOCKED`
- **阻塞原因**:需要用户在域名注册商侧启用 DNSSEC 并配置 `_ens` TXT,
  且需用户指定该域名的链上 owner 地址。见 `docs/DNSSEC-VERIFY-RUNBOOK.md`。
- **解除条件**:用户完成注册商侧操作并给出 owner 地址。
