# 身份主页方案 + 开发计划(社区层 → 个人层)

> 状态:**待 review**。本文是计划,经核心路径评审后再开分支执行。
> 依赖:[DNS-DOMAIN-INTEGRATION.md](./DNS-DOMAIN-INTEGRATION.md)(DNSSEC→ENS + 双解析原理)。

---

## 一、愿景:一个名字 = 链上身份 + 可定制主页

### 两层
| 层 | 域名示例 | 面向 | 上线顺序 |
|----|---------|------|---------|
| **社区层** | `alice.mushroom.cv` | 社区/组织给成员发 | 先做,跑通 |
| **个人层** | `alice.xiaoheishu.xyz` | 给个人发免费域名+主页 | 社区层验证后复用同机制 |

### 用户拿到什么
注册 `alice.mushroom.cv`(免费、只签名)后**自动获得**:
1. **一个网页** `https://alice.mushroom.cv` — 默认模板主页,内容由链上记录驱动,用户可定制
2. **链上身份** — 该名字解析到用户/社区的**多签钱包地址** + 一组 ENS 标准记录(头像、简介、社交链接等)
3. **集成好的工具** — 主页默认带一组工具(复制地址、收款二维码、区块浏览器链接、分享卡片等),开箱即用

---

## 二、技术方案(方案 A:通配主页 Worker)

```
DNS:  *.mushroom.cv  ──通配──▶  cometens-profile Worker(Cloudflare)
                                    │ 读 Host = alice.mushroom.cv
                                    │ namehash → 查 L2Records 的记录
                                    │   addr(多签) + text: avatar/description/url/com.twitter…
                                    ▼
                            渲染个人主页(默认模板 + 用户记录 + 工具)

ENS:  alice.mushroom.cv ──namehash──▶ HybridResolver ──CCIP-Read──▶ L2Records
                                    ▼  返回多签钱包地址(签名即时/证明去信任)
```

- **定制 = 设链上 text 记录**:用户在 admin 页设 `avatar`/`description`/`com.twitter` 等(ENSIP-5 标准 key),主页**自动反映**。页面无需单独存储,全由链上记录驱动。
- **零 per-user DNS 调用**:只配一条 `*.mushroom.cv` 通配 + 一个 Worker;新用户即时生效(Worker 按 Host 实时渲染)。
- **多签**:社区层名字默认解析到社区**多签钱包**(可配置:统一多签 / 每用户自有钱包)。

---

## 三、开发计划

### Phase 0 — 计划评审(现在)
你 review 核心路径(见第五节)→ 给 go → 我开分支执行。

### Phase 1 — 社区层(`mushroom.cv`)· 测试网先跑通

| # | 任务 | Owner | 依赖 | 阻塞? |
|---|------|-------|------|------|
| 1.1 | **通配主页 Worker**(`cometens-profile`):按 Host 渲染链上记录 + 默认模板 + 工具集 | **我** | — | 不阻塞,可先用 `aastar.eth` 测试根验证渲染 |
| 1.2 | admin/register 扩展:设 `avatar`/`description`/`url`/social text 记录(定制主页) | **我** | — | 否 |
| 1.3 | `ROOT_DOMAINS` 加 `mushroom.cv` + 注册流程支持 | **我** | 1.4 | 否(配置) |
| 1.4 | `mushroom.cv` **DNSSEC 导入 Sepolia ENS** + 设 resolver=HybridResolver | **你**(域名 owner 链上操作;我备 tx) | 域名支持 DNSSEC | **是,关键路径** |
| 1.5 | DNS 配 `*.mushroom.cv` → profile Worker | **你**(Cloudflare;或给我 scope 到该 zone 的 API token) | 1.1 部署 | 是 |
| 1.6 | 端到端验证:注册 `alice.mushroom.cv` → 主页渲染 + 钱包解析 | 我 + 你 | 全部 | — |

### Phase 2 — 社区层主网
- 主网 DNSSEC 导入 + resolver=HybridResolver(owner 用多签)+ 部署,按 [DEPLOY-MAINNET.md](./DEPLOY-MAINNET.md)。

### Phase 3 — 个人层(`xiaoheishu.xyz`)
- 完全复用同机制,新增一个根域名。你提供 `xiaoheishu.xyz` 控制权 + DNSSEC。

---

## 四、需要你配合的事项(关键路径,我做不了)

| 项 | 说明 |
|----|------|
| **A. 域名控制权 + DNSSEC** | `mushroom.cv`(及后续 `xiaoheishu.xyz`)在支持 DNSSEC 的 registrar,开启 DNSSEC |
| **B. proveAndClaim 上链** | 把 `mushroom.cv` 经 DNSSEC 导入 ENS(我准备好交易/步骤,你用**域名 owner 钱包**签名执行) |
| **C. Cloudflare 通配** | `*.mushroom.cv` 指向 profile Worker(你在 CF dashboard 配,或给我一个 **scope 到该 zone** 的 API token) |
| **D. 多签地址策略** | 社区名字默认指向哪个**多签钱包**?(统一多签 vs 每用户各自钱包) |
| **E. Cloudflare 账号** | 确认 `mushroom.cv` 是否托管在你 CF 账号(jhfnetboy@gmail.com)下 |

## 五、核心路径(请你重点 review 这条链)

```
你:mushroom.cv 开 DNSSEC + proveAndClaim 导入 ENS + 设 resolver=HybridResolver
            │  (这是整个方案成立的链上信任锚 — 你的动作 B)
            ▼
我:ROOT_DOMAINS 加 mushroom.cv + profile Worker 部署 + 通配 DNS(你的动作 C)
            ▼
用户:注册 alice.mushroom.cv(免费签名)→ 链上落 addr+text 记录
            ▼
结果:https://alice.mushroom.cv 出主页(链下) + 钱包解析 alice.mushroom.cv 出多签地址(链上)
```

> 关键风险点:`.cv` 这个 TLD 与你的 registrar 是否完整支持 DNSSEC(决定动作 B 能否成立)。建议 Phase 1 先用一个**确定支持 DNSSEC 的测试域名**验证整链,再正式用 `mushroom.cv`。

## 六、我可独立先做(经你 go 后,不阻塞、不需配合)

- 1.1 profile Worker + 默认模板 + 工具集(先用 `aastar.eth` 测试根跑通"访问 `alice.aastar.eth` → 渲染链上主页")
- 1.2 admin 主页记录定制(text records)
- 配套测试 + 文档

待你 review 第五节核心路径后,我从 1.1 / 1.2 开始,在新分支执行;完成后自审 + review,再提 PR。
