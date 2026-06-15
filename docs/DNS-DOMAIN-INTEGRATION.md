# 自带域名 + 双解析(DNS 链下 ↔ ENS 链上)

> 让一个社区把它**已有的普通域名**(如 `mushroom.cv`)接进来,给成员**免费发链上子域名**;
> 同一个名字 `alice.mushroom.cv` 既能当**网站**(HTTP/DNS),又能当**链上身份**(ENS → 钱包地址)。

---

## 一、原理:ENS 也能解析普通 DNS 域名(不只 `.eth`)

关键桥梁是 **DNSSEC**——DNS 的密码学扩展,给每条 DNS 记录加签名,形成一条从 **DNS 根 → `.cv` → `mushroom.cv`** 的可验证信任链。

ENS 在链上部署了 **DNSSEC 预言机**(`DNSRegistrar` + `DNSSECImpl`),能在以太坊上验证这条签名链。于是:

> 只要你能用 DNSSEC 证明"我是 `mushroom.cv` 的 DNS 拥有者",ENS 就在链上承认你对 `namehash(mushroom.cv)` 的所有权,允许你给它设 resolver。

### 接线四步

| 步骤 | 原理 |
|------|------|
| ① DNSSEC 导入 ENS | 在 `mushroom.cv` DNS 加 `_ens` TXT + 开 DNSSEC,调 `DNSRegistrar.proveAndClaim()` 把签名链上链;预言机验签 → ENS 注册表里 `mushroom.cv` 归你 |
| ② resolver = HybridResolver | HybridResolver 是**通配解析器**(ENSIP-10 / IExtendedResolver),接管 `mushroom.cv` 及其所有子名的解析 |
| ③ 加进 `ROOT_DOMAINS` | 告诉 cometens-api:`mushroom.cv` 是合法根,允许其下发子域名 |
| ④ Worker EOA 注册子节点 | 在 L2Records(OP)写 `namehash(forest.mushroom.cv) → 记录` |

### 信任 & 解析链

```
DNS 根 → .cv → mushroom.cv         (DNSSEC 签名,链下)
                  │ proveAndClaim 上链,ENS 预言机验签(一次性)
                  ▼
ENS 注册表: mushroom.cv.resolver = HybridResolver   (L1)
                  │ 查 forest.mushroom.cv → 向上命中通配解析器
                  ▼
HybridResolver.resolve() → CCIP-Read → gateway → L2Records 记录
                  ▼  新记录签名(即时) / 老记录终结证明(去信任)
              返回钱包地址
```

**一句话**:DNSSEC 是"一次性链上信任锚",证明域名是你的;之后子域名解析交给混合解析(签名/证明)。

---

## 二、双解析:同一个名字,DNS(网站)+ ENS(钱包)并存

DNS 和 ENS 是**两套独立的解析系统**,同一个 `alice.mushroom.cv` 可以两边各有记录、互不冲突:

| 访问方式 | 走哪套 | 解析到 |
|---------|--------|--------|
| 浏览器 `https://alice.mushroom.cv` | **DNS**(Cloudflare 权威 DNS) | 真实网站 / 个人主页 |
| 钱包 / DApp 解析 `alice.mushroom.cv` | **ENS**(namehash → HybridResolver → CCIP-Read) | 钱包地址 / 记录 |
| (可选)AT Protocol / Bluesky handle | **DNS TXT** `_atproto.alice.mushroom.cv` | 去中心化社交身份 DID |

> 同名不冲突的根本原因:DNS 客户端查 A/AAAA/CNAME/TXT 记录,ENS 客户端查以太坊 ENS 注册表,**两条路径毫不相干**。

### 怎么实现 DNS 那一侧——两个方案

**方案 A:通配 Worker(推荐,零 per-user API 调用)**

```
DNS: *.mushroom.cv  → 由一个 Cloudflare Worker 路由接管(orange-cloud 代理)
Worker route: *.mushroom.cv/*  → 读 Host 头取 label(alice)
                                → 查 L2Records / KV 里 alice 的记录
                                → 动态渲染个人主页(显示钱包地址、社交链接、头像等)
```
- 优点:**只配一条通配 DNS + 一个 Worker**,新用户注册时**不需要**再调 Cloudflare API;访问 `alice.mushroom.cv` 时 Worker 实时按 label 出页面。
- 适合"每个子域名都是一张动态生成的个人主页"。

**方案 B:每个子域名调 Cloudflare DNS API 写真实记录**

```
用户注册 alice →  cometens-api:
   (a) 链上:registerSubnode → L2Records(钱包地址)        ← 已有
   (b) 链下:POST Cloudflare /zones/{zone}/dns_records      ← 新增
            创建 alice.mushroom.cv 的 A/CNAME(指向某站点)
            和/或 _atproto.alice.mushroom.cv TXT(ATProto DID)
```
- 需要一个 **Cloudflare API Token**(域名 owner 授权,scope 限定 `mushroom.cv` 这个 zone 的 DNS 编辑权),存为 Worker secret。
- 优点:每个子域名可指向**不同的真实目标**(用户自定义网站、ATProto DID 等)。
- 代价:每次注册多一次 CF API 调用;Token 权限较大,要严格 scope + 轮换。

**推荐组合**:默认用**方案 A 通配 Worker**(所有人有一张统一风格的链上主页,零运维);需要"每人指向不同真实网站"或"ATProto handle"时,对那部分用户走**方案 B** 的 CF API。

### 授权模型(回答"经过授权之后由我来注册生效")

1. 域名 owner(MushroomDAO)在 Cloudflare 把 `mushroom.cv` 托管,**一次性**:
   - 配 `*.mushroom.cv` 通配(方案 A),或
   - 生成一个 scope 到 `mushroom.cv` zone 的 **API Token** 交给后端(方案 B)
2. 之后**子域名的注册/定制/生效完全由 CometENS 后端自动完成**——用户在前端签名,后端同时落 ENS(链上)+ DNS(链下)。用户全程免费、只签名。

---

## 三、对用户/社区的特征

- **用户**:免费领 `alice.mushroom.cv`——既是**钱包地址的链上身份**(转账、DApp 登录),又是**一个能打开的网页**(个人主页),还能当社交 handle。一个名字,多重身份,全归用户自己。
- **社区**:零基础设施成本,用**自己已有的品牌域名**给成员发"带品牌、全网可用、用户免费"的身份;链上链下统一。

呼应 Mycelium 使命:**普通人掌握数字身份主权,不依赖中心化平台。**

---

## 四、落地 TODO(按依赖排序)

```
1. (owner) mushroom.cv 开 DNSSEC + proveAndClaim 导入 ENS + 设 resolver=HybridResolver   ← 链上,owner 操作
2. ROOT_DOMAINS 加入 mushroom.cv                                                          ← 改 wrangler.toml
3. DNS 侧:配 *.mushroom.cv 通配 Worker(方案A) 或 接 Cloudflare DNS API(方案B)        ← 新增
4. 前端注册流程:落 ENS 的同时(可选)落 DNS                                              ← 改 cometens-api
5. 通配 Worker:按 Host label 渲染个人主页(读 L2Records/KV)                              ← 新 worker
```
> Sepolia 先用一个测试域名跑通整链(DNSSEC 导入需域名真实支持 DNSSEC)。
