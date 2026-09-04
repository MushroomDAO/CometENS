# Follow-ups ledger（append-only · 永不删行 · 提交进仓库）

> pilot 的 review triage 把「真问题但不阻塞（B）」和延后项记在这里。
> 主线 task 全部完成后，由 `pilot run` 批量合成一个 cleanup PR 做掉，逐条标 [x] done=PR#n。
> `- [ ]`=OPEN，`- [x]`=DONE。GitHub PR comment 是永久兜底。

- [x] FU-1 · B · src=PR#21 · 2026-09-04 · progress.md 的「11 个 READY / 2 个 BLOCKED」计数已过期(现为 19 READY / 3 BLOCKED),该行是历史记录,补个日期标注即可。**已完成**
- [x] FU-2 · B · src=PR#23 · 2026-09-04 · design-system.test.ts 的「显式 color 声明」守卫只硬编码了 .btn-primary 与 .btn-primary:hover 两条,.btn:hover 与 .btn-ghost:hover 没被覆盖。**已完成(2026-09-04)**:改为从样式表推导,覆盖 9 条规则;顺带修掉两个锚点 bug 与注释吞选择器的 bug。原文续:.btn:hover 与 .btn-ghost:hover 删掉 color 不会被抓到(评审已变异验证:两者均 23 passed)。改成数组遍历五条选择器
- [x] FU-3 · B · src=PR#23 · 2026-09-04 · 变异测试规程补一条:每组变异都要配一格「不该失败的对照」(如只动间距 token),否则「变异全红」与「该套测试恒红」分不开。**已完成**:写进 practices.md「变异测试规程」
- [x] FU-4 · B · src=PR#26 · 2026-09-04 · package.json 的 scripts 段已连撞四次冲突,且全部发生在新增行、顺序无语义。**已完成(2026-09-04)**:scripts 段已按字母排序。预占脚本名那半条没做 —— 排序之后新增行会散落到不同位置,已经解决了大部分冲突
- [x] FU-5 · B · src=T1.6.1 · 2026-09-04 · pnpm typecheck 的 tsconfig 只 include src/,workers/ 完全不在类型检查范围内——包括 #30 那个安全修复改的 workers/api/src/index.ts。唯一会编译 worker 的是 wrangler deploy。建议把 wrangler --dry-run 加进 preflight 检查链,或给 workers 单独配 tsconfig。**2026-09-04 补:test/ 同样不在 include 里** —— T1.6.2 里我写了个引用未定义符号的测试文件,`pnpm typecheck` 照样绿,红的是 vitest。也就是说「typecheck 通过」目前只覆盖 src/。
  **2026-09-04 量过成本**:扩 include 到 [src,test,server,sdk] → **113 个错误**。按目录二分:
  `src`=0 · `+sdk`=1 · `+server`=10 · `+test`=109。按错误码分布,大头是**缺类型定义**:
  `TS2591 process 未定义`+`TS2307 找不到模块`+`TS2304 找不到名称` 合计约 75 条 ——
  **根因是 `@types/node` 根本没装**(`node_modules/@types/` 下只有 chai/deep-eql/estree)。
  剩下约 34 条(TS7006 隐式 any 12 · TS2554 参数个数 7 · TS2339 5 · TS2345 4 · TS2322 2)才是真的类型问题。
  **注:这些数字会随新增测试文件变化。2026-09-04 晚间重量为 TS2307 40 · TS2304 32 · TS7006 18 ——
  结论(根因是 @types/node)不变,但引用具体数字之前请重新量一次。**
  **2026-09-04 已提升为 T1.7.1**(§2.5:真 feature 规模的不塞进批量)。做的过程中查出并修掉一个生产 bug(PR #72)。原记录:**下一步**:`pnpm add -D @types/node`
  ⚠️ **2026-09-04 实测**:这条命令会让 pnpm 提示「The modules directory at
  `/Users/jason/Dev/mycelium/CometENS/node_modules` will be removed and reinstalled from scratch」——
  那是 **6 个 checkout(主仓库 + 5 个 worktree)共享**的目录,worktree 的 node_modules 全是指向它的符号链接。
  重装期间所有 worktree 的依赖同时失效,而当时有分支正在跑测试,所以我在无人值守下没有执行。
  **建议在没有并行工作时手工跑一次**,然后把 tsconfig 的 `types` 加 `"node"`、`include` 扩到 `["src","test","server","sdk"]`,修剩下那 ~34 条。
  **验证**:`npx tsc -p tsconfig.json --noEmit` 的错误数应从 113 掉到 ~34。
  ⚠️ 我第一次看到首条错误是 `TS2719 Two different types with this name exist` 就断言"根因是 viem 重复安装" ——
  **那只是 sdk 贡献的唯一 1 条**。读了第一条证据就推广成结论,和 T1.3.3 里那次是同一个形状
- [x] FU-6 · B · src=T1.6.1 · 2026-09-04 · 所有写端点(/register /set-addr /set-text /set-contenthash /add-registrar /remove-registrar /transfer-subnode)都用裸 verifyTypedData + if(!ok) throw 401 的模式,而畸形签名会让 viem 抛异常、绕过那行 → 返回 500 而不是 401。把签名判断说成服务端故障。**已完成(2026-09-04)**:九处全部收编到 requireValidSignature 单一入口,端点清单从源码推导。**判据(pr-daemon 给的,比「逐个加 try/catch」强)**:给每个写端点各喂一个畸形签名,断言拿到 401 而不是 5xx —— 前者能证明覆盖完整,后者只能证明改过
- [x] FU-7 · C · src=T1.6.2 · 2026-09-04 · /apply 与 /approval-mode 在线上 testnet API worker 上是 404(实测),即前端可以先于 worker 上线。已在前端 fail-closed(canSubmit),但**部署顺序本身没有任何机械约束** —— **已完成(2026-09-04)**:新增 pnpm check:deploy-order —— 从前端源码推导所需端点、逐个探活,三态(存在/缺失/查不了)且带必然不存在路径的自检对照。实跑当场抓出线上缺的那 4 个
- [x] FU-8 · B · src=T1.6.3-nit · 2026-09-04 · **仓库没有 DOM 测试环境**(`vitest.config.ts` 是 `environment: 'node'`,jsdom/happy-dom 都没装),所以 `renderQueue`、`OpPanel`、`lookup` 的**所有 DOM 接线都没有守卫** —— 只有被抽出来的纯逻辑有。这次想验的「每张卡片带自己的理由」正是纯 DOM 性质,自己写 stub 等于测 stub。加 happy-dom 是对的方向,但 worktree 的 `node_modules` 是指向主 checkout 的**符号链接**,在 worktree 里装会改动所有 checkout 共享的安装状态 —— 要在主 checkout 上做,并单独一个 PR。**2026-09-04 部分完成**:按 pr-daemon 的建议改为瞄准会破坏那条性质的重构形状(断言 admin.html 无 id 含 reason + admin-queue.ts 用 createElement 而非 byId),见 test/unit/admin-reason-scope.test.ts。DOM 环境本身仍未装
- [x] FU-9 · B · src=PR#73 · 2026-09-04 · **已完成(2026-09-04,PR#75)**:新增 `scripts/check-approval-sha.mjs` + 10 格单测(三格对照),写进 practices.md〈合并前协议〉。实跑三个真实 PR:#74 无 review 时拒 · #73 已合并放行不拦 · #62 通过。**第一次真实使用就是用在 #74 自己身上:`approved at b31d05e` == head,核对后才合。** 原文:**我合并了一个没被正式 APPROVE 的 sha。**
  评审的 APPROVE 落在 `39c49cf`,我合进 preview 的是 `e7c5393`,差三个文件。
  我读的是 `gh pr view --json reviewDecision` 返回的 `APPROVED` —— **那是仓库级摘要,
  不带 sha**,把它读成"这个 sha 已通过"是把作用域比问题小的证据当成了答案(取证规程)。
  而我在同一个会话里【早些时候就看见过】"review 落在 39c49cfe"这行字,信息在手上没用。
  没出问题的唯一原因是评审恰好在合并前把那三个文件验完了 —— **下次未必这么巧**。
  做法:新增 `scripts/check-approval-sha.mjs`(**尚不存在,所以这里不写成可跑的命令** ——
  文档里凡是 `pnpm` 后面跟脚本名的写法都会被 `docs-commands.test.ts` 当成真命令核对 ——
  它抓住了我两次:第一次是这条提案本身,第二次是我用来解释这条守卫的那句话),
  比对最后一条 APPROVE 的 commit 与当前 head,
  不一致就退出非零;合并前跑它。放在本仓库,不动 pilot 的 git-guard(那是 skill 的文件)。
  (评审说他自己在 #62 上反复提醒的正是这条,这次轮到他撞上 —— 所以更该做成机械检查。)
- [x] FU-10 · B · src=PR#74 · 2026-09-04 · **已完成(2026-09-04)**:在 DELEGATED-HOSTING.md 加了〈还有一条性质不同的:失败原因你看不到,运营方看得到〉。**没有并进那份编号列表** —— 那四条是「能对你做什么」(链上 owner 能力,有合约测试钉住),这条是「能看见你看不见的」(不对称);混在一起会同时说错两边。不透明 id 方案写进去了但**没实现**,理由写在文档里:该由第一个真实委托方定形状。原文:**`docs/DELEGATED-HOSTING.md` 那份"运营方技术上能做什么"的枚举里,「日志」出现 0 次。**
  #74 把证明模式的失败原因从"丢掉"改成了"写进 worker 日志",方向对(不进响应体,#30 就是从那儿漏的),
  但评审指出委托托管下「运营方」有歧义:**worker 日志落在 host 的账户里,而 host ≠ 委托方**。
  于是三方是:调用方拿通用错误 · host 拿完整原因 · **委托方什么都没有 —— 而他才是在排查自己解析的人**。
  不是缺陷(泄露必须先堵),但它给信任面加了一条,而那份文档整个设计就是枚举这类能力。
  做法:在 DELEGATED-HOSTING.md 的枚举里加一行。
  若委托方确实需要原因:响应体带**不透明 id**、日志写 id + 原因 —— 委托方拿到的是可向 host 引用的凭据
  而非原因本身,代价一行,**且把"要不要给你看"从技术问题变回运营问题**。
- [ ] FU-11 · B · src=集成测试 · 2026-09-04 · **4 格集成测试断言的是一个更早的部署形态,而链上已经换了。**
  维护者换 Alchemy key 之后集成测试从 9 红降到 4 红(剩下的不是配置能修的)。逐个探测链上字节码,
  三个地址正好是三种合约:

  | 地址 | `gatewayUrl()` | `verifier()` | `resolveWithProof` 选择器 | 类型 |
  |---|---|---|---|---|
  | `0xA54D63a6…` | ✓ | ✓ | ✗ | **HybridResolver** ← `aastar.eth` 与 `forest.aastar.eth` 现在都指向它 |
  | `0x17D4d74d…` | ✗ | ✓ | ✗ | OPResolver ← `L1_OP_RESOLVER_ADDRESS`,测试断言的那个 |
  | `0xe138Ec90…` | ✓ | ✗ | ✓ | OffchainResolver ← 旧的 `VITE_L1_OFFCHAIN_RESOLVER_ADDRESS` |

  证据是**链上的**,不是文档:直接查 ENS 注册表得到 `aastar.eth → 0xA54D63a6…`,
  再用函数选择器逐个探测那三个地址的字节码。

  失败的四格分两类:两格断言「域名的 resolver == OPResolver」,两格调 `resolveWithProof`
  ——**而部署的 Hybrid 两样都不满足**(它不是 OPResolver,也没有 `resolveWithProof`)。

  **2026-09-04 补:解析路径是活的,所以问题的性质降级了。**
  评审指出按选择器搜字节码只证明「函数在不在」,**不证明「解析路径能不能工作」** ——
  CCIP-read 的入口是 `resolve(bytes,bytes)` + revert `OffchainLookup`,`resolveWithProof` 只是回调。
  对线上 Hybrid 打一次真实的 `resolve(DNS-encoded aastar.eth, addr(node))`:

      Hybrid(0xA54D63a6…)     → **直接返回数据,没有 revert**
      OPResolver(0x17D4d74d…) → revert(无 data)

  而 `HybridResolver.sol:151` 里确实有 `revert OffchainLookup(...)`,即 CCIP 路径存在。
  所以「Hybrid 没有 `resolveWithProof`」**不意味着解析坏了** ——
  那两格测试记录的是**过期的回调形状**,不是线上故障。
  **对维护者的意义**:问题从「线上可能坏了」降到「测试记录了旧形态」,这对排优先级有用。

  ⚠️ 这一步我又踩了一次选择器:`toFunctionSelector` 对 error 签名给出 `0x7376d14c`,
  而 `keccak("OffchainLookup(address,string[],bytes,bytes4,bytes)")[:4]` = **`0x556f1830`**(正确)。
  今天第三次「错的选择器产生真实但无关的读数」,而评审在给判据时**特意提醒过这一条**。
  这次不影响结论(根本没 revert),但它说明**这个坑不会因为被写下来就消失**。

  **需要维护者拍板的是一句话:HybridResolver 是不是当前预期的线上形态?**
  - 是 → 这四格测试过期,应改成断言 Hybrid 及其验证路径(它有 `verifier`,走证明模式)
  - 否 → 是线上配置错了,域名该指回 OPResolver

  ⚠️ **我没有为了让它变绿去改 `L1_OP_RESOLVER_ADDRESS`** —— 那会把不一致藏起来。
  README 把 `0xA54D63a6…` 记为 HybridResolver 且两个域名一致指向它(不像一次误操作),
  所以「是」的可能性大;但**这是部署事实,不是我能判的**。

