# CometENS — 服务配置、社区所有权与可验证交权设计（G0 修订）

> 2026-10-20 G0 讨论稿。**所有以下新合约、交权功能和安全等级均为设计目标，尚未实现或完成审计。** 现有实现和风险见 [ARCHITECTURE.md](ARCHITECTURE.md)，交付与证据要求见 [MILESTONES.md](MILESTONES.md)。不得将“L2 NFT 已发行”“运营方承诺不收回”宣传成 ENS 链上不可收回。

## 1. 产品与部署决定

1. **默认：AAStar 托管服务**。SDK 提供 AAStar 官方网络 profile（测试网和生产网独立），包括 API、CCIP gateway、网络、合约地址及版本。社区选择连接 AAStar 多签治理的服务配置，享有有限免费额度；免费额度是调用配额与中继/网关资源补贴，**不是**买断名称所有权或永久保证。收费与配额政策须公开版本化。
2. **自部署与混合部署**。社区可以只换 API、只换 gateway、只换 L2 records，或自部署完整的 L1 resolver + L2 contract + gateway。SDK 保持读取自由，不依赖 AAStar 账号。所有部署 profile 可导出、校验和导入，不应隐式退回到官方地址。
3. **社区是真正的根 owner**。假设社区多签控制 communityxxx.eth，其可以在 ENSv1/ENSv2 相应原生机制里批准 registrar 创建 jason.communityxxx.eth；社区也可以对 team.communityxxx.eth 委派其**下一层**名字（例如 jason.team.communityxxx.eth）的发行。授权链必须逐层验证，不得把一个三级域名的管理权解释成整个 communityxxx.eth 的写权限。
4. **可撤销工作 EOA**。受限 operator 负责被授权 parent 下的“尚未最终交权的发行与管理”，包含 parent、权限、配额、到期时间、nonce/epoch；所有状态写操作以链上权限为最终仲裁。撤销的生效基准是交易所在链达到所选确认程度；已先确认的操作不可倒退。
5. **AAStar 多签的边界**。仅管理 AAStar 自有服务 profile、部署和运营资金；不可保留已交权社区/成员名字的超级管理员路径。共享不可升级核心应按 parent 隔离；运维层（API、限流、网关、索引器）可升级，不能授予自己管理已交权产权或修改不可变记录的权限。严禁共享 owner、代理管理员、任意 delegatecall、角色管理员、桥接守护人或 emergency owner 形成同等后门。

### 1.1 SDK 与后端配置契约（拟定，G1 锁定）

~~~typescript
type CometENSProfile = {
  profileId: string;                   // aastar-sepolia / aastar-mainnet / community-*
  protocol: 'ens-v1' | 'ens-v2-beta';  // 主网 v2 尚需正式部署核实
  parentName: string;                  // 例如 communityxxx.eth
  chains: {
    l1: { chainId: 11155111 | 1; rpcUrl: string };
    l2: { chainId: 11155420 | 10; rpcUrl: string };
  };
  contracts: {
    l1Resolver: `0x${string}`;
    l2Records: `0x${string}`;
    controller?: `0x${string}`;
    ensRegistry?: `0x${string}`;
    nameWrapper?: `0x${string}`; // ENSv1，需记录标准部署地址/链
    verifier?: `0x${string}`;
  };
  services: {
    apiBaseUrl?: string;               // 管理/中继，独立于 CCIP gateway
    gatewayUrls: string[];             // 解析网关（可配置多个）
    projectId?: string;                // 可公开、限额、按站点约束的标识符
  };
  deploymentManifest: {
    schemaVersion: string;
    contractVersion: string;
    chainCodeHashes: Record<string, `0x${string}`>;
  };
};

// 秘密 API key 只在后端的 server-side client 注入，禁止放进公开 profile。
createCometENSClient({ profile, walletClient });
createCometENSServerClient({ profile, getApiKey: () => serverSecret });
~~~

部署 manifest 需附链 ID、源代码版本、地址、codehash、合约不可变/代理情况、角色管理员清单、proof/signer mode。链与地址必须读 RPC 验证；profile 错链、合约无代码、关键 codehash 不符一律停止写入。SDK 应提供 **AAStar 默认 preset（显式选择 testnet/mainnet）** 和 **self-host preset**；不允许通过 RPC URL 字符串猜链或从 CCIP gateway URL 拼写入 API。

**API key 与签名用途完全不同**：前端只能使用可撤销且受 origin/限速约束的公开 project ID（不能当作安全凭证）；服务端 API key 用于限额、账单、租户身份、服务防滥用。它**不能授权链上写操作**；创建、签名、撤销和最终交权必须由社区 owner、成员 owner 或受限 operator 在链上接受验证。SDK 不保存任何 owner 私钥。免费层不能控制社区的解锁/退出。

## 2. 现有合约与将来 ENSv1/ENSv2 的三张架构图

### 图 A — 当前 V3 / HybridResolver：仍存在平台集中信任

~~~mermaid
flowchart LR
  C["communityxxx.eth<br/>L1 ENS owner"] --> R["ENSv1 Resolver 指针"]
  R --> H["HybridResolver<br/>可选择签名或证明"]
  H --> G["AAStar Gateway<br/>签名 / proof"]
  G --> L["OP L2RecordsV3<br/>ERC721 + records"]
  P["V3 全局 owner"] -->|"可覆写记录 / 收回 NFT / 管 registrar"| L
  P -->|"可换 signer / verifier / gateway / L2 地址"| H
  W["Worker / registrar"] -->|"被限制的部分发行权限"| L
  M["成员持有 OP ERC721"] --> L
~~~

**已实现事实**：V3 的 owner 可以绕过 registrar 限额并更改记录/转移 ERC721；HybridResolver owner 能替换 verifier、signers、L2 records 地址和 gateway URL。签名模式只证明“受信 signer 同意答案”，不能证明“答案符合 OP 链上状态”。**现阶段不可发布“平台跑路、合约被攻破仍无法篡改解析”的承诺。**

### 图 B — 目标 ENSv1：运营发行和 L1 原生产权交接分离

~~~mermaid
flowchart TB
  C["社区多签持有 communityxxx.eth<br/>维持续费和 L1 控制权"] --> NW["ENSv1 NameWrapper / ENS Registry"]
  C --> D["受限 parent operator<br/>grant / revoke"]
  D -->|"阶段 1：发放、设置记录"| L2["OP scoped records / registry<br/>无全局夺权权限"]
  NW -->|"阶段 2：创建 L1 原生子名<br/>指定成员为 owner"| U["jason.communityxxx.eth<br/>成员可独立验证的 owner"]
  NW -->|"PCC + CU；期限/续费约束"| U
  U -->|"解析器选择权由成员掌握"| Res["L1 原生记录 Resolver<br/>或强制 proof 的 L2 Resolver"]
  Res --> G["多节点开源 Gateway / 自托管"]
  G -->|"仅取有验证依据的数据"| L2
  S["AAStar 运营多签"] -->|"仅服务部署/资金/用量"| G
~~~

**重要**：OP ERC721 是 CometENS 应用凭证，不等于 ENS Registry/NameWrapper 承认的 jason.communityxxx.eth 所有权。最终交权必须创建/登记 **L1 ENS 名称** 并确认 NameWrapper（或等价原生 Registry）上的真实 owner。仅修改 OP NFT owner 或撤销服务 API key 不够。

对适用的 ENSv1 NameWrapper 路径：父名先满足 Locked 条件；给子名烧 **PARENT_CANNOT_CONTROL (PCC)** 与 **CANNOT_UNWRAP (CU)**，指定成员 owner、适当 expiry 和续期能力。PCC 防父名通过正常 Wrapper API 替换/收回；但在 expiry 到达、父名过期或上级名字被释放后不能给出永久产权承诺。**还须披露 ENS NameWrapper 的上游治理**：在当前实现里 Wrapper owner 有设置 upgrade contract 以及由其获得 ENS Registry / registrar operator 的路径；平台即使销毁了自己的超级管理员，也不能证明 ENS 协议级治理或协议被攻击时永远安全。是否烧 **CANNOT_SET_RESOLVER** 是另一项不可逆选择：可固定解析器，但若该 resolver / gateway 未来失效，也可能锁死恢复；默认“成员可换 resolver”，仅对不变记录单独采用经审计的不可升级链上 resolver。要防止**记录**被平台篡改，必须做到记录权限也由成员掌握，或用不可变链上记录/强制证明解析。

### 图 C — 目标 ENSv2 适配：EAC 角色和每名独立 registry

~~~mermaid
flowchart TB
  M["communityxxx.eth owner / 多签"] --> V2["ENSv2 Permissioned Registry<br/>communityxxx.eth"]
  V2 --> SUB["Community Subregistry<br/>管理子名"]
  SUB --> N["jason.communityxxx.eth<br/>原生 ENSv2 NFT"]
  M -->|"特定资源角色授权/撤销"| O["Registrar 工作 EOA"]
  O -->|"仅发行前被授予的权限"| SUB
  N --> RE["Member-controlled Resolver<br/>per-record EAC roles"]
  RE --> GW["可选 CCIP 网关 / OP 证明服务"]
  GW --> OP["OP records（可选数据层）"]
  X["AAStar 多签"] -->|"仅自有实例服务配置"| GW
~~~

**ENSv2 不等于 ENSv1 fuse**：v2 EAC 可以对 name/resource 授权、撤销及重新授予；持有 admin 权限者、ROOT_RESOURCE 权限、registry admin、resolver admin 或可升级代理仍可能重新获得控制。要宣称“不可回收”，必须对选定 ENSv2 版本及每个用户的 registry/resolver **证明不存在可重新授予的权力路径**，并复验到期、迁移和再次注册的行为；不能只执行一次 revoke 就宣称永久。ENSv2 Sepolia Beta 需逐版本验证；未确认主网部署前不得生产切换。V1 到 V2 的迁移由实际 ENS owner 明确签署，生成迁移前后等价保证的测试报告。

## 3. 两阶段交权 + 状态机

~~~mermaid
stateDiagram-v2
  [*] --> DISCOVERED
  DISCOVERED --> OWNER_VERIFIED: 验证父名 L1 多签/持有人
  OWNER_VERIFIED --> MANAGED: 配置 operator / 限额 / 期限
  MANAGED --> ISSUED_L2: 可运营期分配/修改
  ISSUED_L2 --> ANCHORED_L1: 创建 ENS 原生子名/指定 owner
  ANCHORED_L1 --> HANDOFF_PENDING: 设置 resolver/权限/expiry
  HANDOFF_PENDING --> SOVEREIGN: 证实 PCC+CU、无夺权路径、成员可独立解析
  SOVEREIGN --> LOCKED_RECORD: 可选记录不变合约+不可逆锁定
  HANDOFF_PENDING --> NEEDS_REPAIR: 任一验证失败
  ISSUED_L2 --> NEEDS_REPAIR: 中继失效/授权错配
  SOVEREIGN --> AT_RISK: 父名/子名临期或解析故障
  LOCKED_RECORD --> AT_RISK: 到期/解析底层不可用
  AT_RISK --> SOVEREIGN: 续费和用户控制的恢复验证
  NEEDS_REPAIR --> HANDOFF_PENDING: 修复后完整重验
~~~

**第一阶段：完成解析**。运营方协助初始化、创建 L2 token、发行/绑定记录；UI 显示 MANAGED/ISSUED_L2 与“可由运营方/社区覆写”的真实风险，允许 community owner 即时撤销 operator。**第二阶段：交接权限**。社区在 L1 给成员发行原生子名、设定 owner/expiry/fuses/roles，成员配置可控 resolver，清理剩余 operator/角色管理员路径，再由独立 verifier 验证链上状态。只有所有安全断言通过，才生成可展示的 **SOVEREIGN（有效期内不可被平台收回）** 凭据。LOCKED_RECORD 只适用于经审计且可验证没有管理员修改通道的特定解析记录。

交权是逐个名字、逐条记录的操作；不能以一次全局合约 renounceOwnership 代替全部安全证明。部署后的临时 bootstrap admin 必须在初始化完成后转移/销毁，**同时**验证 proxy admin、upgrade keys、EAC root admin、timelock、trusted signer、bridge 及 emergency 路径。生产环境未完成上述检查则不得提供 SOVEREIGN 功能。

## 4. 三类保障及不能保证的边界

| 产品状态 | 成员获得什么 | 必须公开的残余风险 |
|---|---|---|
| Managed（原型/测试或知情选择） | L2 ERC721 / 管理 API / CCIP 解析 | 平台或父域持有人可改变解析；L2 NFT 不构成 ENS L1 原生产权 |
| Sovereign（默认正式发行目标） | 成员 L1 ENSv1 NameWrapper 或经审计 ENSv2 registry 真正拥有名字；平台无夺权/覆写角色 | 父 .eth/子名到期、ENS 协议和底层链风险；成员自己仍可授权其他人；解析器被成员替换时记录可变 |
| Locked Record（可选且不可逆） | 对特定记录，成员自愿采用不可升级的不可变链上记录及锁定解析指向；可独立验证 | 无法改写锁定记录；父/子名仍可能到期；特定 Resolver 的兼容性和链层风险 |

“**不可篡改**”针对**已锁定的记录**；“**不可收回**”针对**未过期且已交权的原生 ENS 名字**；“**解析持续有效**”针对**有未失效的 ENS 名称 + 可用且被客户端支持的解析依赖**。三者不能由同一个 NFT、单次 revoke 或 SLA 混为一谈。

### 故障路径与技术兜底

~~~mermaid
flowchart TD
  Q["正常 ENS 查询"] --> L1["校验 L1 原生 ENS owner、有效期与 resolver"]
  L1 --> T{"解析模式"}
  T -->|"独立链上 records"| ON["L1 Resolver 读取最终记录"]
  T -->|"L2 proof-only"| G{"公共网关 A 可用？"}
  G -->|"是"| PROOF["网关 A 提供 OP 状态证明"]
  G -->|"否"| G2{"第三方网关 B 可用？"}
  G2 -->|"是"| PROOF2["网关 B 提供同协议证明"]
  G2 -->|"否"| FAIL["返回不可用；成员可通过独立 resolver 恢复"]
  PROOF --> V["L1 callback 验证 finality、proof 与固定状态目标"]
  PROOF2 --> V
  V -->|"通过"| RESULT["返回与 OP 状态相符的记录"]
  V -->|"失败"| FAIL
  ON --> RESULT
~~~

图中网关冗余的前提是 resolver 确实支持两个独立的网络入口或成员有权替换 resolver；若地址写死在不可升级的 resolver 且没有可工作的备用路由，用户可能失去解析服务。实际证据必须包括不同 DNS 域名、不同运维方及 proof 验证，而非两条 URL 指向同一个依赖。

| 故障场景 | 期望结果/必要约束 |
|---|---|
| AAStar 公司退出、API/网关全停 | 用户仍控制 L1 ENS 原生名字；可更换 resolver/自部署网关。**固定旧网关的 resolver 无法保证自动恢复**，故要提供用户自控恢复能力、可替换 gateway URL 或协议兼容的多源路由 |
| AAStar 多签或 worker key 被盗 | 无权改 SOVEREIGN 原生 owner 和持有人锁定记录；Managed 会暴露风险。强制 proof 的 CCIP callback 验证 L2 真值，防止签名服务伪造记录 |
| V3 合约被黑/管理员夺权 | V3 已发的 L2 NFT/记录不具备最终保障；迁移至新的 L1 名称后，最终产权不依赖 V3 控制权 |
| OP 无法读取、gateway 被封锁 | 多运营者/域名网关冗余；返回明确的不可用状态，不返回旧的“正确”答案冒充当前链上值；关键名称可选择 L1 resolver 的链上 records |
| 父 communityxxx.eth 到期或被出售 | 部分保障可能消失，即使之前 PCC/CU；无法绝对保证永久，应透明披露和自动续费。子名 expiry 还需独立延长，父名续费通常不会自动延长子名期限 |
| 社区多签或成员私钥泄露 | 不能由 AAStar 拦截合法链上 owner 操作；提醒钱包安全、恢复/继承/多签策略，锁定记录需显式二次签名 |
| ENSv2 迁移、重新注册、版本变化 | 对比迁移前后 owner/roles/admin/resolver/expiry，未通过安全矩阵则拒绝迁移/安全徽章，不从失效的 v2 默默退回 v1 |

**实现建议**：主线为独立不可升级的 Core/Factory + per-parent controller/registrar + 可替换的服务适配层 + per-name ownership proof + 独立核验器。共享服务只能拥有发行期有限范围的 operator 角色；如果 L2 records 只是可替换缓存/映射，应在产品中与权威 ENS 名称所有权分开展示。

## 5. 续费/公共安全基金：需要，但不能承诺无限期

ENSv1 中任何人通常可以给 .eth 二级域名续费，成员的三/多级 wrapped 子名 expiry 不会随二级名自动延长；NameWrapper 子名的最高期限受父名约束，允许子名自助延长要配置 CAN_EXTEND_EXPIRY 或经锁定的续期批准路径。社区仍需承担父名和子名的生命周期责任。ENSv2 的续费权限应以当时部署的 EAC/registry 语义另行验证。

建议 AAStar **公共续费安全基金**作为 opt-in 配套：由透明合约/多签专款管理（与核心产权合约分离），社区订阅或预存续费款、第三方可赞助；至少两个独立守护人执行续费，提供 180/90/30/7 天预警、账本与余额证明、续费交易回执及自动失败升级。基金可为无资金的社区提供经公开规则审批的临时补助，但不得收取域名 NFT 控制权、强制使用 AAStar resolver 或保持管理员权限。备用方案是成员/社区自行直接续费，且能导出到期信息。

基金只有余额、规则和执行者仍可用时才能续费。**无任何技术机制可以在母域名无人续费、余额耗尽、链不可用的情况下无条件保证“永久有效”。** 产品承诺应写为“在域名持续有效、权限交接正确并且解析链可用的期间，AAStar 无法收回已交权名称；提供可独立核验的续费和解析恢复机制”。

## 6. 验收证据：任何第三方都能独立重跑

每个已交权名字生成公开（不含私钥/凭据）的 machine-readable **handoff receipt**，含：规范化 ENS name/namehash、父/子所有者 L1 地址及多签验证、L1/L2 chainId、链上确认区块、合约地址/codehash/源码 commit、版本/代理管理员、ENSv1 NameWrapper fuse bitmap、expiry、renewal path、实际 resolver 与记录 writer 权限、所有 EAC ROOT_RESOURCE/admin 角色、operators、撤销哈希、L2 NFT 链接（仅用于溯源）、最终解析 proof 和第三方客户端解析样本。任何字段无法在链上独立验证即停在 HANDOFF_PENDING。

G2/G5 必须形成**可复跑**的 Foundry + Sepolia 证据矩阵：

1. 社区 A/B、两套多签、非 owner 攻击者；跨 parent 发行/覆写/撤销与过期/配额/nonce/重放均验证拒绝。
2. 从已发行 OP ERC721 到 L1 NameWrapper 真正持有人的产权对照；运营者调用转移/改 addr/text/contenthash、改 root、重配角色、旧 operator 重放均必须失败。
3. 社区/成员独立签名完成双阶段交权，fuse/expiry/admin 逐项核验；模拟父名未锁定、缺 PCC/CU、角色未撤完、代理可升级、管理员后门和虚假 gateway 答案，**不得产生 Sovereign receipt**。
4. 强制 proof 对 OP 状态改写的签名回答作负例；resolver gateway 停机、数据过时、L2 reorg、部署版本错配应阻断虚假成功。
5. 不依赖 AAStar 域名、API key、KMS、Worker 及运营钱包，在两台独立机器上用源码自建 resolver/gateway（或成员自行替换）恢复解析，并以标准 ENS 客户端核对。
6. 父 .eth/子名续费、父名转移、grace、到期、可替代账户续费；费用不足、续费 bot 故障报警与可执行的自救流程。
7. ENSv2 Sepolia 的按资源 EAC 和 ROOT_RESOURCE 管理权负例、子 registry owner、resolver writer role 及迁移前后保证差异；不满足则停留 v1。
8. 审计发布版 bytecode 与 receiver/source commit、部署 hash、链地址、临时 owner renounce/transfer、多签权限、不可升级性；公开第三方的重跑命令、失败日志和证据链接。

## 7. 文档与外部规范

- [ENS NameWrapper Fuses](https://docs.ens.domains/wrapper/fuses/)、[Expiry](https://docs.ens.domains/wrapper/expiry/)、[Creating a Subname Registrar](https://docs.ens.domains/wrapper/creating-subname-registrar/)
- [ENS Offchain/L2 Resolvers — Trust Assumptions](https://docs.ens.domains/resolvers/ccip-read/)：签名应答与 L1 验证 L2 storage proof 是两种不同信任模型
- [ENSv2 Enhanced Access Control](https://docs.ens.domains/ensv2/enhanced-access-control/)、[Permissioned Registry](https://docs.ens.domains/ensv2/permissioned-registry/)、[Migration](https://docs.ens.domains/ensv2/migration/)
- [ENSv2 Readiness](https://docs.ens.domains/web/ensv2-readiness/)：resolver/registry 不能硬编码；[ENSv2 Sepolia Beta](https://ens.domains/blog/post/ensv2-beta-public-testing)（2026-08-12）
