# 网关签名钥轮换 Runbook

> 适用对象:运行 CometENS 网关的运营者(自部署或托管)。
> 当前阶段仅覆盖**测试网**;主网轮换在 M2 之前不要执行。

## 为什么要轮换这把钥匙

CCIP-Read 网关用 `PRIVATE_KEY_SUPPLIER` 给**每一次解析应答**签名。它 7×24 在线跑在
Cloudflare Worker 里,是整个系统里暴露面最大的一把钥匙。

更要紧的是当前部署的现状:**它派生出的地址与合约 owner、写入 EOA 是同一个**。
也就是说这把钥匙一旦泄露,攻击者既能伪造全网解析应答,又能覆写记录、转移任意子域 NFT。

好消息是**这把钥匙可以单独轮换,不需要任何架构决策**:两个 Resolver
(`HybridResolver`、`OffchainResolver`)都维护一个 `signers` 允许列表,带
`addSigner` / `removeSigner`。因此可以让新钥匙先与旧钥匙并存、切换、再吊销旧的
——不用重新部署合约,不用多签,不用等 TB.3 定案。

## 顺序为什么不能乱

四个步骤里**只有第 4 步会移除东西**,而且必须在确认线上解析已由新钥匙正常服务之后。

如果先吊销旧签名者再切 Worker,那段时间里网关签出来的应答**不在允许列表内**,
L1 合约会拒绝——**全网解析中断**,而且不会有告警,只会有人来问"域名怎么解析不了了"。

```
步骤 1-3:两把钥匙都在允许列表里  → 任何一步失败都能原地回退
步骤 4  :移除旧钥匙              → 不可无损回退(能加回去,但中间有中断)
```

## 先看计划(不发任何交易)

```bash
pnpm rotate:gateway-signer --dry-run
```

它会打印四个步骤、每步的**验证点**和**回滚方式**,并显示当前读到的 resolver 地址
(取自 `workers/gateway/wrangler.toml` 的 `ALLOWED_SENDERS`——那是部署的 Worker 真正认的那个)。

> **dry-run 是默认行为。** 不加 `--execute` 永远不会发交易。这是刻意的:
> 这些步骤作用于线上基础设施,一次误调用的代价是全网解析中断。

## 执行

### 前置

1. 生成一把**全新的**私钥,派生出地址。新私钥不要写进仓库任何文件。
2. 确认你手上有 resolver 的 owner 私钥(`addSigner`/`removeSigner` 是 `onlyOwner`)。
3. 设好 `SEPOLIA_RPC_URL`。

### 第 1 步 — 授权新签名者

```bash
pnpm rotate:gateway-signer --execute --new-signer 0x<新地址>
```

脚本会先核对你的 key 确实是 resolver owner(不是就直接停,避免发一笔必然 revert 的交易),
发出 `addSigner`,等回执,然后**读回 `signers(新地址)` 确认为 true 才继续**。

到这里两把钥匙都在允许列表里,线上没有任何变化。

### 第 2 步 — 把 Worker 切到新钥匙

```bash
cd workers/gateway
wrangler secret put PRIVATE_KEY_SUPPLIER --env testnet
# 粘贴新私钥
```

> 脚本**故意不自动做这一步**:它是 wrangler 的动作,发生在本进程之外。

### 第 3 步 — 确认线上解析仍然正常

```bash
node scripts/proof-e2e.mjs <一个已知名字> <期望地址>
```

必须 exit 0。**此时两把钥匙都还被授权**,所以这一步失败说明 Worker 配错了
(secret 没生效、粘贴少了字符等),而不是允许列表的问题——可以安心排查。

排查不通就把旧 secret 放回去,系统回到第 1 步之前的状态。

### 第 4 步 — 吊销旧签名者

**只有第 3 步 exit 0 才做这一步。**

```bash
pnpm rotate:gateway-signer --execute --revoke-old --old-signer 0x<旧地址> --new-signer 0x<新地址>
```

**为什么吊销也要传 `--new-signer`**:脚本在发交易之前会读链上确认新签名者**确实还在允许列表里**。不传的话这个守卫无从检查、会静默放行,而吊销掉最后一个签名者就是全网解析中断。

之后读回 `signers(旧地址)` 应为 false,再解析一次确认没坏。

## 回滚

| 卡在哪一步 | 怎么回退 |
|---|---|
| 第 1 步之后 | `removeSigner(新地址)`,无影响 |
| 第 2 步之后 | 把旧 secret 放回 Worker;旧签名者仍被授权,解析不会断 |
| 第 3 步失败 | 同上。**不要往下走第 4 步** |
| 第 4 步之后发现问题 | `addSigner(旧地址)` 加回去;但从吊销到加回的这段时间解析是断的 |

## 做完之后

- 把旧私钥当作**待销毁**处理,不要留在任何 `.env` 里。
- 跑一次 `pnpm preflight`,确认「密钥角色复用」那条检查的读数变了
  ——如果新钥匙只用于网关签名,那条 WARN 应该从「3 个角色共用」降下来。
- 在 `docs/agent/progress.md` 记一笔轮换时间与新地址(地址是公开信息,可以记)。

## 自动化的边界

无人值守的流程**只应该跑 `--dry-run`**。真正的轮换涉及三处线上状态
(链上允许列表、Worker secret、解析可用性),其中第 2 步在本进程之外,
而第 4 步不可无损回退——这三条加起来意味着它需要一个人在场做判断。
