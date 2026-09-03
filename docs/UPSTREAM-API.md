# 上游接入:API 自动授予子域名

> 面向**调用方**:一个已经有自己用户体系的系统,想在用户加入社区时自动给他一个子域名。
> 当前仅测试网。

## 这个 API 解决什么

CometENS 是组件,不管你的用户是谁、怎么登录。你的系统知道"这个人是谁、他的地址是什么",
调一次这个端点,他就有了 `alice.你的社区.eth`,并且**这个名字归他所有**(ERC-721,可转让,
你之后不能凭这次调用把它要回来)。

## 端点

```
POST /register        ← 面向浏览器,EIP-712 签名,用户自己签
POST /v1/register     ← 面向服务端,personal_sign,你的系统签  ← 本文讲这个
```

`/v1/register` 是**机器对机器**的:签名来自你的服务,不是终端用户。用户不需要有钱包,
不需要登录 CometENS,甚至不需要知道 CometENS 存在。

## 鉴权

你的服务持有一个密钥对,把它的地址交给运营方加进 `UPSTREAM_ALLOWED_SIGNERS`(逗号分隔)。
之后每次调用,对这个字符串做 `personal_sign`:

```
CometENS:register:{label}:{owner}:{timestamp}
```

- `label` 先 `trim()` 再转小写,再拼进消息 —— 你签的和服务端重算的必须逐字节一致
- `owner` 按原样(不改大小写)
- `timestamp` 是**秒**级 Unix 时间

服务端 `recoverMessageAddress` 出来的地址必须在白名单里。**移除白名单里的地址即刻吊销该接入方**,
不需要重新部署。

## 请求

```http
POST /v1/register
Content-Type: application/json
```

```json
{
  "label": "alice",
  "owner": "0xAbC…",
  "addr": "0xDeF…",
  "timestamp": 1757000000,
  "signature": "0x…"
}
```

| 字段 | 必需 | 说明 |
|---|---|---|
| `label` | 是 | 子域名标签。`^[a-z0-9-]{1,63}$`,服务端会先 trim + 小写 |
| `owner` | 是 | 名字归谁。ERC-721 会 mint 给这个地址 |
| `addr` | 否 | 该名字解析到的地址。**省略时等于 `owner`** |
| `timestamp` | 是 | Unix 秒。与服务器时间相差 **超过 60 秒**会被拒 |
| `signature` | 是 | 上面那条消息的 `personal_sign` |

> ⚠️ **没有 `parent` 字段。** 父域名恒取服务端配置的 `ROOT_DOMAIN`,请求里传 `parent` 会被忽略。
> 一个部署服务一个根域名;要发多个根域名下的子域,需要多个部署或由运营方调整配置。
> (`spec.md` §7.1 早先写成入参含 `parent`,与实现不符,已更正。)

## 成功响应

```json
{
  "ok": true,
  "name": "alice.community.eth",
  "node": "0x…",
  "txHash": "0x…",
  "challengePeriodSeconds": 302400
}
```

- `node` 是 namehash,也是 ERC-721 的 tokenId(`uint256(node)`)
- `txHash` 可能是 `undefined` —— 服务端未配置写入密钥时不会报错,但也没有上链。
  **要确认真的写成功,就检查 `txHash` 存在**,别只看 `ok: true`
- `challengePeriodSeconds` 是 OP 的挑战期,用于估算"这条记录多久后能走去信任的证明路径解析"

## 失败语义

全部来自实现,不是约定俗成:

| HTTP | 消息 | 触发条件 | 你该怎么办 |
|---|---|---|---|
| 401 | `Missing signature` | 无 `signature` 或不以 `0x` 开头 | 检查签名有没有传 |
| 400 | `Missing or invalid timestamp` | 无 `timestamp` 或不是 number | 传**秒**级数字,不是毫秒、不是字符串 |
| 401 | `Timestamp drift too large (Ns)` | 与服务器时间差 > 60 秒 | 校准时钟;不要复用旧签名 |
| 400 | `Invalid label: must be 1-63 lowercase alphanumeric or hyphen chars` | 标签不匹配 `^[a-z0-9-]{1,63}$` | 先在你侧规范化并校验 |
| 400 | `Invalid owner: must be a valid Ethereum address` | `owner` 不是合法地址 | 检查地址 |
| 401 | `Signer 0x… is not in the allowed list` | 恢复出的签名者不在白名单 | 让运营方把你的地址加进 `UPSTREAM_ALLOWED_SIGNERS`;**消息拼错也会走到这里**(恢复出别的地址) |
| 503 | `UPSTREAM_ALLOWED_SIGNERS not configured on server` | 服务端没配白名单 | 运营方问题,不是你的 |
| 503 | `ROOT_DOMAIN not configured on server` | 服务端没配根域名 | 同上 |
| 503 | `Writer not configured on server` | 服务端没有写入密钥 | 同上 |
| 5xx | 合约 revert 透出 | 如标签已被注册 | 先查可用性,见下 |

> **401 `not in the allowed list` 有两种成因**,值得单独说:一是你确实没被授权;
> 二是**消息拼错了**(比如 label 没转小写、timestamp 用了毫秒),这会恢复出一个完全不同的
> 地址,表现和"未授权"一模一样。排查时先自己本地 recover 一次,对比是不是你的地址。

## 先查可用性(可选但推荐)

```
GET /check-label?label=alice&parent=community.eth
```

避免用一次会失败的注册去试探。

## 调用范例(Node / TypeScript)

```ts
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const account = privateKeyToAccount(process.env.UPSTREAM_SIGNER_KEY as `0x${string}`)
const client = createWalletClient({ account, transport: http() })

export async function grantSubdomain(label: string, owner: string) {
  // Normalise EXACTLY as the server does before signing, or the recovered address differs
  // and the call comes back as "not in the allowed list".
  const normalised = label.trim().toLowerCase()
  const timestamp = Math.floor(Date.now() / 1000)

  const signature = await client.signMessage({
    account,
    message: `CometENS:register:${normalised}:${owner}:${timestamp}`,
  })

  const res = await fetch(`${process.env.COMETENS_API}/v1/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: normalised, owner, timestamp, signature }),
  })

  const json = await res.json()
  if (!res.ok) throw new Error(`${res.status} ${json.error}`)
  // ok:true with no txHash means nothing was written on-chain — treat it as a failure.
  if (!json.txHash) throw new Error('server accepted the request but did not write on-chain')
  return json as { name: string; node: string; txHash: string }
}
```

## 幂等性

**这个端点不是幂等的。** 同一个 label 重复注册会走到合约的 `AlreadyRegistered` 并 revert。
重试前先 `GET /check-label`,或者把"已注册"当成成功来处理 —— 名字已经在目标地址手里了。

## 运营方要给你什么

1. API 基址(测试网:`https://cometens-api.jhfnetboy.workers.dev`)
2. 把你的签名地址加进 `UPSTREAM_ALLOWED_SIGNERS`
3. 告诉你 `ROOT_DOMAIN` 是什么(决定了发出来的名字长什么样)

## 你要知道的一件事

发出去的名字归用户所有(ERC-721)。但**运营方作为合约 owner,在技术上仍能覆写记录、
转移这个 NFT** —— 这是链上事实,不是本 API 的限制。如果你的用户需要这条保证,
看 [DELEGATED-HOSTING.md](DELEGATED-HOSTING.md) 的"运营方能做什么"一节,
以及自部署选项 `docs/SELF-HOSTING.md`(T1.2.3 编写中)。
