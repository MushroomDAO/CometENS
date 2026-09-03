# Follow-ups ledger（append-only · 永不删行 · 提交进仓库）

> pilot 的 review triage 把「真问题但不阻塞（B）」和延后项记在这里。
> 主线 task 全部完成后，由 `pilot run` 批量合成一个 cleanup PR 做掉，逐条标 [x] done=PR#n。
> `- [ ]`=OPEN，`- [x]`=DONE。GitHub PR comment 是永久兜底。

- [x] FU-1 · B · src=PR#21 · 2026-09-04 · progress.md 的「11 个 READY / 2 个 BLOCKED」计数已过期(现为 19 READY / 3 BLOCKED),该行是历史记录,补个日期标注即可。**已完成**
- [x] FU-2 · B · src=PR#23 · 2026-09-04 · design-system.test.ts 的「显式 color 声明」守卫只硬编码了 .btn-primary 与 .btn-primary:hover 两条,.btn:hover 与 .btn-ghost:hover 没被覆盖。**已完成(2026-09-04)**:改为从样式表推导,覆盖 9 条规则;顺带修掉两个锚点 bug 与注释吞选择器的 bug。原文续:.btn:hover 与 .btn-ghost:hover 删掉 color 不会被抓到(评审已变异验证:两者均 23 passed)。改成数组遍历五条选择器
- [x] FU-3 · B · src=PR#23 · 2026-09-04 · 变异测试规程补一条:每组变异都要配一格「不该失败的对照」(如只动间距 token),否则「变异全红」与「该套测试恒红」分不开。**已完成**:写进 tasks.md「变异测试规程」
- [ ] FU-4 · B · src=PR#26 · 2026-09-04 · package.json 的 scripts 段已连撞四次冲突,且全部发生在新增行、顺序无语义。建议按字母排序并在规划里给每个任务预占脚本名,让 git 行级合并大多数时候能自动处理
- [ ] FU-5 · B · src=T1.6.1 · 2026-09-04 · pnpm typecheck 的 tsconfig 只 include src/,workers/ 完全不在类型检查范围内——包括 #30 那个安全修复改的 workers/api/src/index.ts。唯一会编译 worker 的是 wrangler deploy。建议把 wrangler --dry-run 加进 preflight 检查链,或给 workers 单独配 tsconfig。**2026-09-04 补:test/ 同样不在 include 里** —— T1.6.2 里我写了个引用未定义符号的测试文件,`pnpm typecheck` 照样绿,红的是 vitest。也就是说「typecheck 通过」目前只覆盖 src/。
  **2026-09-04 量过成本**:扩 include 到 [src,test,server,sdk] → **113 个错误**。按目录二分:
  `src`=0 · `+sdk`=1 · `+server`=10 · `+test`=109。按错误码分布,大头是**缺类型定义**:
  `TS2591 process 未定义`+`TS2307 找不到模块`+`TS2304 找不到名称` 合计约 75 条 ——
  **根因是 `@types/node` 根本没装**(`node_modules/@types/` 下只有 chai/deep-eql/estree)。
  剩下约 34 条(TS7006 隐式 any 12 · TS2554 参数个数 7 · TS2339 5 · TS2345 4 · TS2322 2)才是真的类型问题。
  **下一步**:在**主 checkout** 执行 `pnpm add -D @types/node`(worktree 的 node_modules 是指向主 checkout 的
  符号链接,在 worktree 里装会改动共享安装状态),再把 `types` 加 `"node"`、include 扩到 test/server/sdk,修剩下那 ~34 条。
  ⚠️ 我第一次看到首条错误是 `TS2719 Two different types with this name exist` 就断言"根因是 viem 重复安装" ——
  **那只是 sdk 贡献的唯一 1 条**。读了第一条证据就推广成结论,和 T1.3.3 里那次是同一个形状
- [x] FU-6 · B · src=T1.6.1 · 2026-09-04 · 所有写端点(/register /set-addr /set-text /set-contenthash /add-registrar /remove-registrar /transfer-subnode)都用裸 verifyTypedData + if(!ok) throw 401 的模式,而畸形签名会让 viem 抛异常、绕过那行 → 返回 500 而不是 401。把签名判断说成服务端故障。**已完成(2026-09-04)**:九处全部收编到 requireValidSignature 单一入口,端点清单从源码推导。**判据(pr-daemon 给的,比「逐个加 try/catch」强)**:给每个写端点各喂一个畸形签名,断言拿到 401 而不是 5xx —— 前者能证明覆盖完整,后者只能证明改过
- [ ] FU-7 · C · src=T1.6.2 · 2026-09-04 · /apply 与 /approval-mode 在线上 testnet API worker 上是 404(实测),即前端可以先于 worker 上线。已在前端 fail-closed(canSubmit),但**部署顺序本身没有任何机械约束** —— 应在 SELF-HOSTING/部署脚本里加一道「先部署 api worker 再发前端」的检查,或让前端构建时探测
- [x] FU-8 · B · src=T1.6.3-nit · 2026-09-04 · **仓库没有 DOM 测试环境**(`vitest.config.ts` 是 `environment: 'node'`,jsdom/happy-dom 都没装),所以 `renderQueue`、`OpPanel`、`lookup` 的**所有 DOM 接线都没有守卫** —— 只有被抽出来的纯逻辑有。这次想验的「每张卡片带自己的理由」正是纯 DOM 性质,自己写 stub 等于测 stub。加 happy-dom 是对的方向,但 worktree 的 `node_modules` 是指向主 checkout 的**符号链接**,在 worktree 里装会改动所有 checkout 共享的安装状态 —— 要在主 checkout 上做,并单独一个 PR。**2026-09-04 部分完成**:按 pr-daemon 的建议改为瞄准会破坏那条性质的重构形状(断言 admin.html 无 id 含 reason + admin-queue.ts 用 createElement 而非 byId),见 test/unit/admin-reason-scope.test.ts。DOM 环境本身仍未装
