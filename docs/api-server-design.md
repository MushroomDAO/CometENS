# CometENS API Server — V2 设计文档

## 背景

原 dev server（`vite.config.ts` 中间件）将前端构建和 API 逻辑混在一起，无法用于生产。
本文档规划将 API 逻辑独立为一个新的 Cloudflare Worker（`cometens-api`），
与现有的 CCIP Gateway Worker（`cometens-gateway`）分开部署。

**当前状态（Phase 1-3 全部完成）：**
- `cometens-api` 已部署：https://cometens-api.jhfnetboy.workers.dev
- `cometens-gateway` 已部署：https://cometens-gateway.jhfnetboy.workers.dev
- `vite.config.ts` 已瘦身为纯前端构建配置，API 逻辑全部移除

---

## 一、权限角色表

| 角色 | 是谁 | 如何证明身份 |
|------|------|------------|
| **Contract Owner** | 部署者（`0xb560...`） | EIP-712 签名 → 链上验证 `L2RecordsV2.owner()` |
| **Registrar** | 被授权的注册商地址 | EIP-712 签名 → 链上验证 `L2RecordsV2.isRegistrar()` |
| **Name Owner** | 子域名持有人 | EIP-712 签名 → 链上验证 `L2RecordsV2.subnodeOwner(node)` |
| **Upstream App** | 机器间调用方 | `personal_sign` → 服务端验证白名单 `ALLOWED_SIGNERS` |
| **Public** | 任何人 | 无需签名 |

---

## 二、API 权限矩阵

| 端点 | Public | Upstream App | Name Owner | Registrar | Contract Owner |
|------|--------|-------------|------------|-----------|----------------|
| `GET /check-label` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `GET /check-owner` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `GET /lookup` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `POST /v1/register` | ❌ | ✅ whitelist | ❌ | ❌ | ✅ |
| `POST /register` | ❌ | ❌ | ❌ | ✅ quota内 | ✅ |
| `POST /set-addr` | ❌ | ❌ | ✅ 仅自己node | ❌ | ✅ |
| `POST /set-text` | ❌ | ❌ | ✅ 仅自己node | ❌ | ✅ |
| `POST /set-contenthash` | ❌ | ❌ | ✅ 仅自己node | ❌ | ✅ |
| `POST /add-registrar` | ❌ | ❌ | ❌ | ❌ | ✅ |
| `POST /remove-registrar` | ❌ | ❌ | ❌ | ❌ | ✅ |

### 验证链（每次写操作）

```
收到请求
  │
  ├─ 1. 验证 deadline 未过期（防重放）
  ├─ 2. 验证 EIP-712 / personal_sign 签名，恢复 recovered_address
  ├─ 3. 按端点类型做链上查询：
  │      - Name Owner：L2RecordsV2.subnodeOwner(node) == recovered_address ?
  │      - Contract Owner：L2RecordsV2.owner() == recovered_address ?
  │      - Registrar：L2RecordsV2.isRegistrar(parentNode, recovered_address) ?
  │      - Upstream App：recovered_address ∈ UPSTREAM_ALLOWED_SIGNERS env ?
  └─ 4. 通过 → 执行 L2 写入 → 同步写 CF KV
```

---

## 三、部署架构

```
┌─────────────────────────────────────────────────────┐
│                   用户 / DApp / 钱包                  │
└──────────────┬──────────────────────┬───────────────┘
               │ ENS 解析              │ 注册/管理记录
               ▼                      ▼
┌──────────────────────┐   ┌──────────────────────────┐
│  CCIP Gateway Worker  │   │    API Server Worker      │
│  (全球分发，read-only) │   │    (单部署，writes)        │
│                       │   │                           │
│  cometens-gateway     │   │  cometens-api             │
│  .jhfnetboy.workers   │   │  .jhfnetboy.workers.dev   │
│  .dev                 │   │                           │
│                       │   │  POST /register           │
│  POST / (EIP-3668)    │   │  POST /set-addr           │
│  读 RECORD_CACHE ──┐  │   │  POST /set-text           │
│  miss → L2 RPC     │  │   │  POST /set-contenthash    │
│                    │  │   │  POST /add-registrar      │
└────────────────────│──┘   │  POST /remove-registrar   │
                     │      │  POST /v1/register        │
                     │      │  GET  /check-label        │
                     │      │  GET  /check-owner        │
                     │      │  GET  /lookup             │
                     │      └────────────┬──────────────┘
                     │                   │ 写入成功后同步写 KV
                     ▼                   ▼
        ┌────────────────────────────────────────────┐
        │              Cloudflare KV                  │
        │          (全球复制，~60s 同步)               │
        │                                             │
        │  RECORD_CACHE (id: 6147f1fe...)             │
        │    addr60:{node}     → ETH address           │
        │    text:{node}:{key} → value string          │
        │    ch:{node}         → contenthash hex       │
        │                                             │
        │  REGISTRY (id: a8ec4846...)  [API only]     │
        │    reg:{address}     → label string          │
        └──────────────────────┬──────────────────────┘
                               │
                               ▼
                     ┌─────────────────┐
                     │  L2RecordsV2    │
                     │  (OP Sepolia /  │
                     │   OP Mainnet)   │
                     └─────────────────┘
```

### CF KV 的作用

- **RECORD_CACHE**：API Worker 写入后同步，Gateway Worker 读 KV 优先（<5ms），miss 再查链（200ms）。两个 Worker 绑定同一 namespace ID。
- **REGISTRY**：仅 API Worker 使用。`GET /lookup?address=0x...` 反查地址对应的 label，避免前端扫链上事件日志。

---

## 四、ENS 标准文本记录键（ENSIP-5）

ENS 域名主人可通过 `POST /set-text` 设置的所有字段：

| 键 | 内容 | 示例值 |
|----|------|--------|
| `avatar` | 头像（URL 或 NFT） | `https://...` / `eip155:1/erc721:0x.../1` |
| `url` | 个人网站 | `https://alice.xyz` |
| `email` | 邮箱 | `alice@example.com` |
| `description` | 简介 | `Building on ENS` |
| `com.twitter` | Twitter | `@alice` |
| `com.github` | GitHub | `alice` |
| `com.discord` | Discord | `alice#1234` |
| `com.telegram` | Telegram | `@alice` |
| `snapshot` | Snapshot 投票 | `https://...` |
| `keywords` | 标签 | `defi,dao` |
| `notice` | 声明/公告 | 任意文本 |
| 自定义 | 任意 key | 任意 value |

`set-text` 支持任意 key，以上字段无需额外开发。

---

## 五、开发阶段

### Phase 1 — API Worker（核心功能）✅ 已完成
分支：`feat/production-api-server`

- [x] 新建 `workers/api/src/index.ts`
- [x] 迁移 `vite.config.ts` 所有 `/api/manage` + `/api/v1` 逻辑到 Worker
- [x] 实现完整权限验证（Name Owner / Contract Owner / Registrar 链上查询）
- [x] 补充 `set-contenthash`、`remove-registrar` 端点
- [x] 新建 `workers/api/wrangler.toml`
- [x] 部署 `cometens-api` Worker（testnet）— https://cometens-api.jhfnetboy.workers.dev

### Phase 2 — CF KV 缓存（解析提速）✅ 已完成

- [x] 创建 CF KV namespace（RECORD_CACHE: `6147f1fe...`，REGISTRY: `a8ec4846...`）
- [x] API Worker 写入成功后同步写 RECORD_CACHE（addr60/text/ch）
- [x] CCIP Gateway Worker 读 RECORD_CACHE（miss 再查链）
- [x] 全球解析延迟：~200ms → <5ms（边缘命中）

### Phase 3 — Dev server 瘦身 ✅ 已完成

- [x] `vite.config.ts` 里的 API 逻辑全部移除，只保留 Vite 前端构建
- [x] 前端 `src/config.ts` 增加 `apiUrl`（`VITE_API_URL`），所有 fetch 调用更新为 API Worker 路径
- [x] `.env.local` 更新：`VITE_GATEWAY_URL` 和 `VITE_API_URL` 指向已部署的 testnet workers

---

## 六、安全注意事项

1. **WORKER_EOA_PRIVATE_KEY** 通过 `wrangler secret put` 注入，不进代码库
2. **UPSTREAM_ALLOWED_SIGNERS** 白名单通过环境变量配置，支持多地址逗号分隔
3. **Replay protection**：所有写操作验证 `deadline`（EIP-712）或 `timestamp`（personal_sign）
4. **Ownable2Step**：主网部署前合约 owner 必须换为 Gnosis Safe 多签（≥3/5），EOA 单点风险不可接受
5. **多 parent domain**：`POST /register` 的 `message.parent` 字段支持任意父域（如 `forest.aastar.eth`），由链上 `isRegistrar(parentNode, signer)` 验证权限，无需修改 API

---

## 七、已实现 API 端点（API Worker，生产就绪）

| 端点 | 状态 | 认证方式 |
|------|------|---------|
| `GET /check-label` | ✅ | Public |
| `GET /check-owner` | ✅ | Public |
| `GET /lookup` | ✅ | Public，KV + 链上校验 |
| `POST /register` | ✅ | EIP-712，Registrar/Owner |
| `POST /set-addr` | ✅ | EIP-712，Name Owner（支持清零） |
| `POST /set-text` | ✅ | EIP-712，Name Owner |
| `POST /set-contenthash` | ✅ | EIP-712，Name Owner |
| `POST /add-registrar` | ✅ | EIP-712，Contract Owner |
| `POST /remove-registrar` | ✅ | EIP-712，Contract Owner |
| `POST /v1/register` | ✅ | personal_sign，Upstream App whitelist |
