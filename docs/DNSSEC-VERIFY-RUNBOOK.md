# DNSSEC 验证 Runbook(Phase 1 前置闸门)

> **目标**:确认你的域名 DNSSEC 配好、且能被 ENS 接受。这是整个"自带域名"方案的**链上信任锚**,验证通过后才启动开发。
> **方式**:每步你操作 → 告诉我 → 我用 DNS 查询验证是否生效 → 过了再下一步。**不跳步。**
> 参考:[ENS 官方导入指南](https://support.ens.domains/en/articles/7882690-import-your-dns-domain) · [DNSSEC 要求](https://support.ens.domains/en/articles/8834820-offchain-gasless-dnssec-in-ens)

---

## 0. 准备

- **域名**:建议先用 **`xiaoheishu.xyz`** 验证(`.xyz` 的 DNSSEC 支持成熟);`.cv` 留到这条流程跑通后再照做(`.cv` 的 DNSSEC 是最大不确定点,先不冒险)
- **DNS 管理后台**:你买域名的 registrar,或托管 DNS 的地方(如 Cloudflare)
- **一个以太坊地址**:先记下(Step 2 和后续 import 要用)。建议用你的常用钱包地址

---

## Step 1 — 开启 DNSSEC

在你的 DNS 托管处开启 DNSSEC:
- **若 DNS 托管在 Cloudflare**:CF 控制台 → 选域名 → **DNS → Settings → DNSSEC → Enable DNSSEC** → 它给你一段 **DS 记录**(含 KeyTag/Algorithm/DigestType/Digest)
- 把这段 **DS 记录填到你购买域名的 registrar**(让顶级域 `.xyz` 发布它),建立信任链
  - 若 DNS 和域名在同一家(很多 registrar 一键开启,自动发布 DS),则无需手动填
- ⚠️ **算法必须是 RSA/SHA-256 或 ECDSA**(ENS 只认这两种;Cloudflare 默认 ECDSA,OK)

✅ **我来验证**:你做完告诉我,我查 `xiaoheishu.xyz` 的 DNSKEY/DS 是否存在、AD(已验证)标志是否为真。

---

## Step 2 — 加 `_ens` TXT 记录

在 DNS 加一条 TXT 记录:
| 字段 | 值 |
|------|----|
| Name / Host | `_ens`(即完整名 `_ens.xiaoheishu.xyz`) |
| Type | `TXT` |
| Value / Content | `a=0xYourEthAddress`(替换成你的以太坊地址) |

> 这条告诉 ENS:"这个域名的链上 owner 是这个地址"。

✅ **我来验证**:我查 `_ens.xiaoheishu.xyz` 的 TXT 是否 = 你的地址,且**带 DNSSEC 签名(RRSIG)**。

---

## Step 3 — 等传播 + 整链确认

- 等 **10–30 分钟**(DNS 传播 + DS 在顶级域生效较慢)
- ✅ **我来验证**:我跑 DNSSEC 分析,确认 **根 → .xyz → xiaoheishu.xyz → _ens** 整条签名链有效(AD=true)

---

## Step 4 — ENS 端确认可导入(关键验证,**不必付费完成**)

- 打开 **app.ens.domains**,连接钱包,搜索 `xiaoheishu.xyz`
- 看结果:
  - 显示 **「可导入 / Claim」**(没有 DNSSEC 报错)→ ✅ **DNSSEC OK,ENS 接受 —— 本 runbook 通过!**
  - 显示 DNSSEC 错误 → 回 Step 1 检查算法/DS

> 验证到这一步就够了:确认了"ENS 能基于 DNSSEC 接管这个域名"。**真正的 import(付 gas)+ 设 resolver=HybridResolver 放到开发集成阶段**(我会给 Sepolia 的脚本/步骤)。

---

## ✅ 验证通过后 → 启动开发(我执行)

1. (Sepolia)把域名 import 到 Sepolia ENS + 设 resolver = `HybridResolver (0xA54D…)`(我备脚本;你用域名 owner 钱包签一次)
2. 我:`ROOT_DOMAINS` 加该域名 → 注册一个测试子名 `test.xiaoheishu.xyz`
3. 我:验证双解析 —— `test.xiaoheishu.xyz` 链上解析出地址 + 通配 Worker 出主页

---

## 卡住了怎么办

| 现象 | 可能原因 | 处理 |
|------|---------|------|
| 分析器说 DNSSEC 无效 | DS 没在顶级域发布 / 算法不对(非 RSA-SHA256/ECDSA) | 换 ECDSA;确认 DS 已填到 registrar |
| `_ens` TXT 查不到 | 没传播 / Name 写成了 `_ens.xiaoheishu.xyz.xiaoheishu.xyz`(重复后缀) | 等 30 分钟;Name 只填 `_ens` |
| ENS app 报 DNSSEC error | 同上 | 跑 dnsviz.net 看哪一环断了 |
