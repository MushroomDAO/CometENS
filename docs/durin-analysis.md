# Durin 深度分析报告

**仓库**: `eval/durin` → `https://github.com/namestonehq/durin`
**作者**: NameStone
**ENS 官方推荐**：是，ENS 官方文档和 app.ens.domains 均推荐此工具
**最后更新**: 2025-01（仓库截至 2026-03 仍活跃）
**本报告更新**: 2026-03-30

---

## 一、Durin 是什么

Durin 是专门解决"ENS L2 子域名发行"问题的全套工具箱，定位与 CometENS 高度重叠。

其核心设计目标：
- 任何持有 `.eth` 名称的人，无需联系任何人，通过 `durin.dev` 前端即可在 8 条主网 L2 上发行子域名
- 子域名是真正的 **ERC-721 NFT**，可转让、可在 OpenSea 交易
- L1 解析完全透明，标准 ENS API 无需任何修改

**已生产部署（非测试网）**：
- L1Resolver: `0x8A968aB9eb8C084FBC44c531058Fc9ef945c3D61`（Ethereum Mainnet）
- L2RegistryFactory: `0xDddddDdDDD8Aa1f237b4fa0669cb46892346d22d`（Arbitrum/Base/Celo/Linea/Optimism/Polygon/Scroll/Worldchain 均已部署）

---

## 二、四组件架构详解

### 组件 1：L1Resolver（最有价值）

**核心创新：Stuffed Calldata 技术**

标准 CCIP-Read 的问题：Gateway 需要知道去哪条链、哪个合约读数据，通常靠环境变量解决，一个 Gateway 只能服务一条配置。

Durin 的解法：把 `targetChainId` 和 `targetRegistryAddress` 直接塞进 `OffchainLookup` 的 calldata 里：

```solidity
// L1Resolver.sol L225-249
function stuffedResolveCall(...) internal view returns (bytes memory) {
    bytes memory callData = abi.encodeWithSelector(
        IResolverService.stuffedResolveCall.selector,
        name,
        data,
        targetChainId,         // ← 塞进去
        targetRegistryAddress  // ← 塞进去
    );
    revert OffchainLookup(address(this), urls, callData, ...);
}
```

Gateway 收到请求后直接从 calldata 解析出链 ID 和合约地址，**完全无状态**。一个 Gateway 实例可以服务任意数量的根域名 × 任意数量的 L2。

**链上路由注册：setL2Registry()**

```solidity
// L1Resolver.sol L123-139
function setL2Registry(bytes32 node, uint64 targetChainId, address targetRegistryAddress) external {
    address owner = ens.owner(node);
    if (owner == address(nameWrapper)) owner = nameWrapper.ownerOf(uint256(node)); // NameWrapper 兼容
    if (owner != msg.sender) revert Unauthorized();
    l2Registry[node] = L2Registry(targetChainId, targetRegistryAddress);
}
```

ENS 域名所有者直接在 L1 合约上登记自己的 L2 registry，不依赖任何中心化配置。这是真正的**无需许可（permissionless）**发行。

**对比 CometENS 当前实现**：我们的 `OffchainResolver.sol` 靠 `OP_L2_RECORDS_ADDRESS` 环境变量路由，扩展到多链需要改配置重启服务。

---

### 组件 2：L2Registry（ERC-721 子域名 NFT）

每个子域名的 `namehash` 直接作为 ERC-721 tokenId：

```solidity
// L2Registry.sol L138-160
function createSubnode(bytes32 node, string calldata label, address _owner, bytes[] calldata data)
    external onlyOwnerOrRegistrar(node) returns (bytes32) {
    bytes32 subnode = makeNode(node, label);     // keccak256(node ++ labelhash(label))
    _safeMint(_owner, uint256(subnode));         // namehash 即 tokenId
    _multicall(subnode, data);                   // 原子性设置 addr/text/contenthash
    totalSupply++;
    emit NewOwner(node, labelhash, _owner);
}
```

关键设计：
- 转移 NFT = 转移子域名所有权，所有 ERC-721 工具（OpenSea、钱包、市场）自动兼容
- `onlyOwnerOrRegistrar` 修饰符：只有子域名所有者或白名单 Registrar 可操作
- `data[]` 参数支持原子性注册 + 设置记录，一笔交易完成

**Registrar 白名单架构**：

```solidity
mapping(address registrar => bool approved) public registrars;

function addRegistrar(address registrar) external onlyOwner { ... }
function removeRegistrar(address registrar) external onlyOwner { ... }
```

Registry 是**核心协议层**，永不修改；Registrar 是**业务逻辑层**，可随时升级（定价、白名单、Token Gating 等），互不干扰。

**对比 CometENS 当前实现**：`L2Records.sol` 无所有权模型，任何人均可写入，Worker EOA 是唯一访问控制层。

---

### 组件 3：L2Registrar（可定制注册模板）

```solidity
// L2Registrar.sol
constructor(address _registry) {
    assembly { sstore(chainId.slot, chainid()) }
    coinType = (0x80000000 | chainId) >> 0;  // ENSIP-11 跨链 coinType
    registry = IL2Registry(_registry);
}

function register(string calldata label, address owner) external {
    registry.setAddr(node, coinType, addr);  // 设置链原生地址（跨链解析）
    registry.setAddr(node, 60, addr);        // 设置 ETH 地址（方便调试）
    registry.createSubnode(registry.baseNode(), label, owner, new bytes[](0));
}
```

`coinType = (0x80000000 | chainId)` 是 ENSIP-11 标准。注册时同时写链原生地址和 ETH 地址，确保反向解析（reverse resolution）在跨链场景下正确工作。

---

### 组件 4：Gateway（真正无状态多链）

```typescript
// gateway/src/ccip-read/query.ts
const supportedChains = [
  arbitrum, arbitrumSepolia, base, baseSepolia, // 16 条链
  ...
]

export async function handleQuery({ targetChainId, targetRegistryAddress, ... }) {
    const chain = supportedChains.find(c => BigInt(c.id) === targetChainId)
    // 直接读，无状态
    return l2Client.readContract({
        address: targetRegistryAddress,  // 从 calldata 解析，不查配置
        functionName: 'resolve',
        args: [dnsEncodedName, encodedResolveCall],
    })
}
```

加新链 = 往 `supportedChains` 加一行 + 重新部署 Worker，5 分钟完成。

---

## 三、与 CometENS 的详细对比

| 维度 | Durin | CometENS（当前） |
|---|---|---|
| **L1 Resolver 路由** | 链上 `setL2Registry()` 映射，无需许可 | 环境变量硬编码，需运维介入 |
| **Stuffed calldata** | ✅ 无状态网关 | ❌ 网关依赖配置 |
| **子域名所有权** | ERC-721 NFT，可转让交易 | 无链上所有权 |
| **注册原子性** | `createSubnode()` 含 multicall，一笔 tx | 3 笔 tx（setSubnodeOwner + setAddr + ...） |
| **Registrar 插件** | ✅ 定价/白名单/Token Gate 独立合约 | ❌ 无 |
| **多链支持** | 16 条链，开箱即用 | 仅 OP Sepolia |
| **注册鉴权** | 原始 keccak256 签名（无 nonce） | **EIP-712 typed data + nonce + deadline** ✅ |
| **多签名者** | 单 signer，需短暂停机轮换 | **mapping 多签名者，零停机轮换** ✅ |
| **IERC7996** | ❌ 未实现 | ✅ 已添加 supportsFeature stub |
| **NameWrapper 兼容** | ✅ ownerOf(uint256 node) | ❌ 未实现 |
| **网关状态** | 完全无状态 | 依赖 env 变量 |
| **部署难度** | 需自定义 Registrar + 跑部署脚本 | `npm run dev` 一键启动 |
| **前端集成** | 独立 gateway 进程 | 集成在 Vite dev server |

---

## 四、战略建议：借鉴 vs 使用 vs 跟踪

### 建议：分层策略，**不重复建设，但也不全盘使用**

**不能直接用 Durin 的组件替换 CometENS 的原因**：
1. Durin 的 L1Resolver 是单签名者，我们已经实现了更好的多签名者版本
2. Durin 没有 EIP-712（MetaMask 友好的结构化签名），我们的注册体验更好
3. Durin 的 Gateway 依赖 dRPC（需要 API Key），我们可以用任意 RPC
4. CometENS 的 Worker EOA 代理执行模式（用户无 Gas）是 Durin 没有的

**分阶段借鉴路线**：

#### 现在（CometENS 当前 → 里程碑 A+）

借鉴 **Stuffed Calldata 模式**：在 `OffchainResolver.sol` 中把 `L2_CHAIN_ID` 和 `L2Records` 地址塞进 CCIP-Read calldata，Gateway 从请求解析而非读 env。

改动量：~15 行 Solidity + ~5 行 TypeScript
收益：支持多根域名无需改配置

#### 里程碑 B（Name Wrapper + NFT 子域）

**直接参考** Durin 的 `L2Registry.sol`，不使用 Durin 已部署合约。原因：
- 我们需要保留 EIP-712 注册鉴权
- 我们需要 Worker EOA 代理执行
- Durin 的合约可以作为 Solidity 实现的参考（`createSubnode` + `onlyOwnerOrRegistrar` + ERC-721 tokenId 设计）

**不参考** `L2RegistryFactory`——CometENS 不是多租户平台，不需要工厂。

#### 里程碑 C/D（多链 + 无需许可）

**参考** `setL2Registry()` 模式，在我们的 `OffchainResolver.sol` 上实现 `node → (chainId, registryAddress)` 链上映射，让任何人都可以自己注册，变成真正的开放协议。

Gateway 多链扩展参考 Durin 的 `supportedChains` 数组结构，但用我们自己的 RPC 配置体系。

---

## 五、长期跟踪建议

**建议维护本文档**，以下情况触发更新：
1. Durin 发布新版本（关注 `namestonehq/durin` release）
2. CometENS 进入里程碑 B/C 时重新评估对齐度
3. ENS 官方推荐的 Resolver 发生变化

**关键跟踪点**：
- Durin 是否实现 IERC7996（我们已实现）
- Durin 是否升级到多签名者（我们已实现）
- ENS v2 对 L2Registry 标准是否收敛（影响我们里程碑 B 的合约设计）
- NameWrapper 在 L2 的部署进展（影响里程碑 D 的 Fuse 烧断方案）

---

## 六、核心结论

> **Durin 是 CometENS 未来的参考标准，而不是替代品。**
>
> 现在：CometENS 在鉴权（EIP-712 + nonce）和签名管理（多签名者）上优于 Durin。
> 未来：Durin 的 ERC-721 所有权、stuffed calldata、链上路由注册是 CometENS 路线图 B/C 的实现方向。
> 策略：借鉴设计思路和 Solidity 实现，保留 CometENS 自己的优势（EIP-712、Worker EOA、集成开发体验）。
