# CometENS 架构总览

本文档从不同视角描述 CometENS 的架构，每张图对应一个关注维度。

---

## 图 1：系统全景（组件关系）

所有角色与组件在一张图中的位置关系。

```mermaid
graph TB
    subgraph 用户端
        EU[普通用户<br/>浏览器钱包]
        UA[上游应用<br/>server-to-server]
        DA[外部 DApp/钱包<br/>viem/ethers]
    end

    subgraph "CometENS 服务层（Gateway）"
        CCIP["/api/ccip<br/>CCIP-Read 网关"]
        REG["/api/manage/register<br/>用户注册 EIP-712"]
        MGMT["/api/manage/set-addr<br/>/api/manage/set-text"]
        V1["/api/v1/register<br/>上游应用 签名鉴权"]
        WORKER[Worker EOA<br/>L2 执行账户]
    end

    subgraph "L1：以太坊 Sepolia/Mainnet"
        ENSREG[ENS Registry]
        OFFCHAIN["OffchainResolver<br/>0x87d97a2e..."]
    end

    subgraph "L2：Optimism Sepolia/Mainnet"
        L2R["L2Records<br/>0x9Ed5d10..."]
    end

    EU -->|EIP-712 签名| REG
    EU -->|EIP-712 签名| MGMT
    UA -->|secp256k1 签名| V1
    DA -->|resolve name| ENSREG

    REG --> WORKER
    MGMT --> WORKER
    V1 --> WORKER
    WORKER -->|setSubnodeOwner/setAddr/setText| L2R

    ENSREG --> OFFCHAIN
    OFFCHAIN -->|OffchainLookup| CCIP
    CCIP -->|读取记录| L2R
    CCIP -->|签名返回| OFFCHAIN
    OFFCHAIN -->|resolveWithProof| DA
```

---

## 图 2：ENS 解析流程（外部 DApp/钱包视角）

任何使用 viem/ethers 的应用解析 `alice.aastar.eth` 时发生的完整流程。

```mermaid
sequenceDiagram
    autonumber
    participant App as 外部 DApp/钱包
    participant L1 as ENS Registry (L1)
    participant Res as OffchainResolver (L1)
    participant GW as CometENS Gateway
    participant L2 as L2Records (OP)

    App->>L1: resolve("alice.aastar.eth")
    L1-->>App: resolver = OffchainResolver
    App->>Res: addr(node) 或 text(node, key)
    Res-->>App: revert OffchainLookup(gatewayUrl, calldata)
    Note over App: viem/ethers 自动处理 CCIP-Read
    App->>GW: POST /api/ccip { sender, data }
    GW->>L2: readContract(node, key)
    L2-->>GW: record value
    GW-->>App: { result, signature }
    App->>Res: resolveWithProof(response, extraData)
    Res->>Res: 验证 Gateway 签名
    Res-->>App: 返回解析结果
```

> 对 DApp 开发者完全透明，标准 `publicClient.getEnsAddress("alice.aastar.eth")` 即可。

---

## 图 3：普通用户注册流程（前端 EIP-712）

用户通过 `/register.html` 注册子域名的完整流程。

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户 (MetaMask)
    participant FE as register.html
    participant GW as Gateway /api/manage/register
    participant W as Worker EOA
    participant L2 as L2Records (OP)

    U->>FE: 输入 label（如 "alice"）
    FE->>FE: 预览 alice.aastar.eth
    U->>FE: 点击 Register
    FE->>U: 弹出 EIP-712 签名请求
    Note over U,FE: 签名内容：{parent, label, owner, nonce, deadline}
    U-->>FE: 确认签名（无 Gas）
    FE->>GW: POST { msg, sig }
    GW->>GW: 验证 EIP-712 签名<br/>检查 nonce/deadline
    GW->>W: 指令：注册 alice.aastar.eth → owner
    W->>L2: setSubnodeOwner(parentNode, labelhash, owner)
    L2-->>W: tx receipt
    W->>L2: setAddr(node, 60, ownerAddr)
    L2-->>W: tx receipt
    W-->>GW: txHash
    GW-->>FE: { ok: true, name, node, txHash }
    FE-->>U: 注册成功，显示 txHash
```

---

## 图 4：上游应用自动注册流程（机器间 API）

上游应用（如用户注册系统）在用户创建账号时自动分配 ENS 子域名。

```mermaid
sequenceDiagram
    autonumber
    participant App as 上游应用<br/>（持有 secp256k1 私钥）
    participant GW as Gateway /api/v1/register
    participant W as Worker EOA
    participant L2 as L2Records (OP)

    Note over App: 运维已将 App 地址加入 UPSTREAM_ALLOWED_SIGNERS
    App->>App: timestamp = Date.now() / 1000
    App->>App: message = "CometENS:register:{label}:{owner}:{timestamp}"
    App->>App: signature = signMessage(privateKey, message)
    App->>GW: POST { label, owner, timestamp, signature }
    GW->>GW: 验证 timestamp 偏差 ≤ 60s（防重放）
    GW->>GW: recoverMessageAddress(message, signature)
    GW->>GW: 检查 recovered ∈ UPSTREAM_ALLOWED_SIGNERS
    GW->>W: 指令：注册 {label}.aastar.eth → owner
    W->>L2: setSubnodeOwner(parentNode, labelhash, owner)
    W->>L2: setAddr(node, 60, owner)
    L2-->>W: receipts
    W-->>GW: txHash
    GW-->>App: { ok: true, name, node, txHash }
```

---

## 图 5：运维/部署者操作流程

从零开始搭建 CometENS 实例的操作序列。

```mermaid
flowchart TD
    A[开始] --> B[1. 部署 L2Records\nfoundry → OP Sepolia/Mainnet]
    B --> C[2. 部署 OffchainResolver\nfoundry → Ethereum Sepolia/Mainnet\n填入 Gateway URL + Signer 地址]
    C --> D[3. 在 ENS 设置 Resolver\napp.ens.domains → yourname.eth\n→ Edit Resolver → 填入 OffchainResolver 地址]
    D --> E[4. 配置 .env.local\nL2Records 地址 / OffchainResolver 地址\nPRIVATE_KEY_SUPPLIER / WORKER_EOA_PRIVATE_KEY\nUPSTREAM_ALLOWED_SIGNERS]
    E --> F[5. 启动 Gateway\nnpm run dev / 部署 Cloudflare Worker]
    F --> G[6. 验证解析\nviem getEnsAddress 返回正确地址]
    G --> H{生产加固？}
    H -->|是| I[7. L1 包裹根域\n烧断 CANNOT_SET_RESOLVER\n⚠️ 不可逆]
    H -->|否| J[完成]
    I --> J
```

---

## 图 6：部署拓扑

各组件的部署位置与运行环境。

```mermaid
graph LR
    subgraph "Ethereum L1"
        ENS[ENS Registry<br/>官方合约]
        OR["OffchainResolver<br/>我方部署<br/>Sepolia: 0x87d97a2e..."]
    end

    subgraph "Optimism L2"
        L2R["L2Records<br/>我方部署<br/>OP-Sepolia: 0x9Ed5d10..."]
    end

    subgraph "服务层（可选 Cloudflare Workers）"
        GW["CometENS Gateway<br/>dev: localhost:4173<br/>prod: ens.aastar.io"]
        SIGNER["PRIVATE_KEY_SUPPLIER<br/>Gateway 签名密钥"]
        EOA["WORKER_EOA_PRIVATE_KEY<br/>L2 写入执行账户"]
    end

    subgraph "前端（静态托管）"
        FE["register.html / admin.html<br/>Cloudflare Pages / Vercel"]
    end

    OR -->|CCIP-Read 回调| GW
    GW -->|读取| L2R
    GW -->|签名| SIGNER
    GW -->|写入 tx| EOA
    EOA -->|发送 tx| L2R
    FE -->|API 调用| GW
```

---

## 各角色快速入口

| 角色 | 关注的图 | 操作文档 |
|------|----------|----------|
| 外部 DApp / 钱包 | 图2：解析流程 | 直接使用标准 ENS API，无需任何配置 |
| 普通用户 | 图3：前端注册 | [MANUAL.md Part 2](../MANUAL.md) |
| 上游应用开发者 | 图4：API 接入 | [MANUAL.md Part 3](../MANUAL.md) |
| 运维/部署者 | 图5+6：部署 | [DEPLOY.md](../DEPLOY.md) |
