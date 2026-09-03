# Follow-ups ledger（append-only · 永不删行 · 提交进仓库）

> pilot 的 review triage 把「真问题但不阻塞（B）」和延后项记在这里。
> 主线 task 全部完成后，由 `pilot run` 批量合成一个 cleanup PR 做掉，逐条标 [x] done=PR#n。
> `- [ ]`=OPEN，`- [x]`=DONE。GitHub PR comment 是永久兜底。

- [ ] FU-1 · B · src=PR#21 · 2026-09-04 · progress.md 的「11 个 READY / 2 个 BLOCKED」计数已过期(现为 19 READY / 3 BLOCKED),该行是历史记录,补个日期标注即可
- [ ] FU-2 · B · src=PR#23 · 2026-09-04 · design-system.test.ts 的「显式 color 声明」守卫只硬编码了 .btn-primary 与 .btn-primary:hover 两条,.btn:hover 与 .btn-ghost:hover 删掉 color 不会被抓到(评审已变异验证:两者均 23 passed)。改成数组遍历五条选择器
- [ ] FU-3 · B · src=PR#23 · 2026-09-04 · 变异测试规程补一条:每组变异都要配一格「不该失败的对照」(如只动间距 token),否则「变异全红」与「该套测试恒红」分不开
