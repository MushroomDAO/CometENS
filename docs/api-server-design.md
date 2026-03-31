# CometENS API Server — V2 设计文档

## 背景

当前 dev server（`vite.config.ts` 中间件）将前端构建和 API 逻辑混在一起，无法用于生产。
本文档规划将 API 逻辑独立为一个新的 Cloudflare Worker（`cometens-api`），
与现有的 CCIP Gateway Worker（`cometens-gateway`）分开部署。

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
  ├─ 1. 验证 timestamp 在 N 秒内（防重放）
  ├─ 2. 从签名恢复 recovered_address
  ├─ 3. 按端点类型做链上查询：
  │      - Name Owner：L2Records.subnodeOwner(node) == recovered_address ?
  │      - Contract Owner：L2Records.owner() == recovered_address ?
  │      - Registrar：L2Records.isRegistrar(parentNode, recovered_address) ?
  │      - Upstream App：recovered_address ∈ ALLOWED_SIGNERS env ?
  └─ 4. 通过 → 执行 L2 写入
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
│  (已有，全球分发)      │   │    (新建，单部署)          │
│                       │   │                           │
│  cometens-gateway     │   │  cometens-api             │
│  .jhfnetboy.workers   │   │  .jhfnetboy.workers.dev   │
│  .dev                 │   │                           │
│                       │   │  POST /register           │
│  POST / (EIP-3668)    │   │  POST /set-text           │
│  读 CF KV cache ──┐   │   │  POST /set-addr           │
│  miss → L2 RPC    │   │   │  POST /set-contenthash    │
│                   │   │   │  POST /add-registrar      │
└───────────────────│───┘   │  POST /remove-registrar   │
                    │       │  POST /v1/register        │
                    │       │  GET  /check-label        │
                    │       │  GET  /lookup             │
                    │       └────────────┬──────────────┘
                    │                    │ 写入成功后
                    │                    │ 同步写 CF KV
                    ▼                    ▼
              ┌─────────────────────────────┐
              │      Cloudflare KV          │
              │  (全球复制，~60s 同步)        │
              │                             │
              │  addr:{node} → address      │
              │  text:{node}:{key} → value  │
              └──────────────┬──────────────┘
                             │
                             ▼
                   ┌─────────────────┐
                   │  L2RecordsV2    │
                   │  (OP Sepolia /  │
                   │   OP Mainnet)   │
                   └─────────────────┘
```

### CF KV 的作用

注册/写入后同步到 KV → 全球所有 CCIP Worker 边缘节点优先读 KV（<5ms），
不需要每次跨洋查 OP Sepolia RPC（100-300ms）。中国节点同样受益。

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

### Phase 1 — API Worker（核心功能）
分支：`feat/production-api-server`

- [ ] 新建 `workers/api/src/index.ts`
- [ ] 迁移 `vite.config.ts` 所有 `/api/manage` + `/api/v1` 逻辑到 Worker
- [ ] 实现完整权限验证（Name Owner / Contract Owner / Registrar 链上查询）
- [ ] 补充 `set-contenthash`、`remove-registrar` 端点
- [ ] 新建 `workers/api/wrangler.toml`
- [ ] 本地 miniflare 测试
- [ ] 部署 `cometens-api` Worker（testnet）

### Phase 2 — CF KV 缓存（解析提速）

- [ ] 创建 CF KV namespace
- [ ] API Worker 写入成功后同步写 KV
- [ ] CCIP Gateway Worker 读 KV（miss 再查链）
- [ ] 全球解析延迟：~200ms → ~10ms（边缘命中）

### Phase 3 — Dev server 瘦身

- [ ] `vite.config.ts` 里的 API 逻辑全部移除，只保留 Vite 前端构建
- [ ] 本地开发 proxy 到已部署的 API Worker 或本地 miniflare 实例

---

## 六、安全注意事项

1. **WORKER_EOA_PRIVATE_KEY** 通过 `wrangler secret put` 注入，不进代码库
2. **ALLOWED_SIGNERS** 白名单通过环境变量配置，支持多地址逗号分隔
3. **Replay protection**：所有写操作验证 `timestamp` 在 60s 内
4. **Ownable2Step**：合约 owner 转移建议采用两步确认（提名+接受），防止误操作永久丢失控制权（待 V3 实现）

---

## 七、当前已实现 API（dev server，待迁移）

| 端点 | 状态 | 备注 |
|------|------|------|
| `POST /api/manage/register` | ✅ 已实现 | EIP-712，Name Owner 注册 |
| `POST /api/manage/set-addr` | ✅ 已实现 | EIP-712，Name Owner |
| `POST /api/manage/set-text` | ✅ 已实现 | EIP-712，Name Owner |
| `POST /api/manage/add-registrar` | ✅ 已实现 | EIP-712，Contract Owner only |
| `POST /api/v1/register` | ✅ 已实现 | personal_sign，Upstream App |
| `GET /api/manage/check-label` | ✅ 已实现 | Public |
| `GET /api/manage/lookup` | ✅ 已实现 | Public |
| `POST /api/manage/set-contenthash` | ❌ 缺失 | 待 Phase 1 补充 |
| `POST /api/manage/remove-registrar` | ❌ 缺失 | 待 Phase 1 补充 |
