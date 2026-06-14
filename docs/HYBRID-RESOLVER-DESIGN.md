# HybridResolver 设计(自动按记录年龄路由:签名 ↔ 终结证明)

> 目标:**一个 ENS 名字、一个 resolver**,对同一次 `resolve()` 自动选择:
> - **新记录(未终结)** → gateway 返回**签名**响应(即时,信任 gateway 私钥)
> - **老记录(已终结且未变更)** → gateway 返回 **Bedrock 终结证明**(去信任)
>
> 刻意绕开乐观证明(`MIN_AGE_SEC>0`,~15s 冷启动 + 弱信任)。

## 为什么需要一个新合约

`OffchainResolver`(签名)和 `OPResolver`(证明)是两个独立 resolver,各自的 CCIP 请求/响应格式不同,一个名字只能指向一个。要"自动二选一",必须有一个 resolver 的 callback **同时能验签名、也能验证明**,由 gateway 在响应里用 1 字节 `mode` 告知用哪条。

## 链上流程(EIP-3668)

```
resolve(name, data)
  → 构造 unruggable GatewayRequest(描述要证明的 L2RecordsV3 slot,复用 OPResolver 逻辑)
  → context = verifier.getLatestContext()
  → revert OffchainLookup(
        this, [hybridGatewayUrl],
        request  = abi.encode(context, req, data),   // gateway 解析:证明用 context+req,签名用 data
        callback = hybridCallback.selector,
        carry    = abi.encode(context, req, data) )   // callback 验证时需要

gateway 返回 abi.encode(uint8 mode, bytes payload):
  mode = 0 (SIG)   → payload = abi.encode(bytes result, uint64 expires, bytes sig)
  mode = 1 (PROOF) → payload = unruggable proof bytes(喂给 getStorageValues)

hybridCallback(response, carry):
  decode (context, req, data) ← carry
  decode (mode, payload)      ← response
  if SIG:
     校验 EIP-3668 签名:keccak(0x1900 ++ this ++ expires ++ keccak(data) ++ keccak(result)),
     recover ∈ signers[] 且未过期 → 返回 result
  if PROOF:
     (values, exitCode) = verifier.getStorageValues(context, req, payload)
     按 data 的 selector 解码 values → 返回 result(复用 OPResolver 解码逻辑)
```

## gateway 的 mode 决策(关键正确性)

```
latest      = 读 L2RecordsV3 最新值(用于签名)
provenFinal = 对终结状态(minAgeSec=0)生成证明得到的值
if provenFinal == latest 且非空:   # 记录自终结以来未变更 → 可去信任
    return (PROOF, proof)
else:                               # 新记录 / 终结后被改过 → 终结证明会是旧值/空
    return (SIG, sign(latest))
```

- 只有当**终结状态的值 == 当前值**时才出证明,杜绝"证明返回已终结的旧值导致解析陈旧"。
- 新记录、刚改过的记录一律走签名(即时、正确)。

## 信任模型

| 路径 | 触发 | 信任 |
|---|---|---|
| SIG | 新记录 / 变更未终结 | gateway 签名私钥(社区组织运营);签名绑定 resolver 地址 + data + result + expiry,防重放 |
| PROOF | 老记录,终结且未变更 | 完全去信任,OPFaultVerifier 在 L1 验证 Merkle 证明(minAgeSec=0) |

两条路径都**绝不接受未终结的乐观证明**。SIG 的信任面与现状一致;PROOF 是纯增强。

## 安全要点(供 review)

1. **SIG 分支**与 `OffchainResolver.resolveWithProof` 等价:1900 前缀、绑定 `address(this)`/`expires`/`keccak(data)`/`keccak(result)`、`signers[]` 白名单、过期检查、ecrecover 65 字节校验。
2. **PROOF 分支**委托 `verifier.getStorageValues`,验证由 OPFaultVerifier 强制(独立于 gateway)。callback 仅解码已验证的 `values`。
3. `mode` 仅 0/1,其余 revert。
4. `context`/`req`/`data` 经 `carry` 往返;callback 用 carry 里的 `req`(而非响应里的)做验证,gateway 无法替换被证明的请求。
5. 与 OPResolver 一致:`verifier` 可 `setVerifier` 升级;owner 管理 `signers`。

## 部署后路由表

| 名字状态 | 用户解析体验 | 谁验证 |
|---|---|---|
| 刚注册(<~7天) | 即时 | gateway 签名 |
| ≥~7天且未改 | 即时 | OPFaultVerifier(去信任) |
| 刚改过(<~7天) | 即时 | gateway 签名 |
