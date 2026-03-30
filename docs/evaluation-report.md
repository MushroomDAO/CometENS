# CometENS 历史仓库评估报告（修订版 v2）

> 评估日期：2026-03-30（v2 修订）
> 评估范围：
> - `eval/CometENS-old`（AAStarCommunity 废弃版）
> - `eval/CometENS`（AAStarCommunity aastar-dev）
> - `eval/ENS-offchain-resolver`（ENS 官方参考实现）
> - `eval/ens-contracts`（ensdomains/ens-contracts，最新版）
> - `eval/ens-docs`（ensdomains/docs，最新版）
> - `eval/ensjs`（ensdomains/ensjs，最新版）
> 评估目的：提取有价值内容 + 深度核实签名格式与多签名问题

---

## 一、重点核查：两个被标记问题的重新评估

### 问题 1：签名格式是否与标准不兼容？

**结论：❌ 原报告误判 — 当前实现正确，无需修改**

**完整链路追踪：**

**网关签名（`server/gateway/index.ts`）：**
```typescript
const messageHash = keccak256(encodePacked(
  ['bytes2', 'address', 'uint64', 'bytes32', 'bytes32'],
  ['0x1900', resolverAddress, expires, keccak256(calldata), keccak256(result)]
))
const sig = await signer.signMessage({ message: { raw: messageHash } })
// signMessage({ raw: X }) = personal_sign(X) = sign(keccak256("\x19Ethereum Signed Message:\n32" || X))
```

**合约验证（`contracts/src/OffchainResolver.sol`）：**
```solidity
bytes32 messageHash = keccak256(abi.encodePacked(
    hex"1900", address(this), expires,
    keccak256(callData), keccak256(result)
));
bytes32 ethHash = keccak256(abi.encodePacked(
    "\x19Ethereum Signed Message:\n32", messageHash
));
address recovered = _recover(ethHash, sig);
```

**两者使用完全相同的哈希过程。** 网关和合约都在 EIP-3668 的基础消息上叠加了 Ethereum personal_sign 前缀，`ecrecover` 一定成功。

**ENS 参考实现的差异**（ENS-offchain-resolver）：
- 参考实现用 `signer.signDigest(hash)` — 原始 ECDSA，无 Ethereum 前缀
- 我们用 `signMessage({ raw: hash })` — 有 Ethereum 前缀
- 两者各自内部一致，**但彼此签名不可互换**

**对 CometENS 的影响**：
- 我们控制自己的网关 + 自己的 OffchainResolver 合约
- 两者始终是配对的，没有任何第三方合约会尝试验证我们的签名
- 兼容性问题不存在

**与新版 Universal Resolver 的兼容性（AbstractUniversalResolver.sol）：**
新版 UniversalResolver **不做任何签名验证**，它只是把网关响应转发给我们的 `resolveWithProof` 回调：
```solidity
// ccipBatchCallback 中：
(ok, v) = p.sender.staticcall(
    abi.encodeWithSelector(p.callbackFunction, v, p.extraData)
    // = resolveWithProof(gatewayResponse, extraData)
);
```
签名验证由我们自己的 `resolveWithProof` 完成，与 Universal Resolver 无关。

**✅ 当前签名格式完全正确，与 ENS v2 架构兼容，无需更改。**

---

### 问题 2：OffchainResolver 只支持单签名者是否是问题？

**结论：⚠️ 是真实限制，但比原报告所述的影响要小**

**现状：**
```solidity
address public signerAddress;  // 单一签名者

function setSigner(address newSigner) external onlyOwner {
    signerAddress = newSigner;  // 即时切换，有短暂空档
}
```

**ENS 参考实现（ENS-offchain-resolver）：**
```solidity
mapping(address => bool) public signers;  // 多签名者白名单

constructor(string memory url, address[] memory _signers) {
    for (uint i = 0; i < _signers.length; i++) signers[_signers[i]] = true;
}
```

**实际影响分析：**

| 场景 | 单签名者（当前） | 多签名者（参考） |
|------|--------------|--------------|
| 密钥轮换 | `setSigner(new)` 即时切换，旧签名立即失效 | 先 addSigner(new)，等所有旧 TTL 过期，再 removeSigner(old) — 零停机 |
| 密钥泄露 | `setSigner(new)` 1 笔 tx 即可响应 | 同，无优势 |
| 多网关部署（高可用） | 多个网关必须共享同一密钥 | 每个网关有独立密钥 |
| 热/冷密钥分离 | 不支持 | 支持 |
| 紧急恢复 | 单点故障（owner 密钥 + signer 密钥都需要） | 更灵活 |

**结论：**
- 对 Sepolia 测试网 MVP：单签名者完全够用
- 对生产主网：建议升级为多签名者，原因是**零停机密钥轮换**和**多网关部署安全性**
- 改动成本极低（约 20 行 Solidity），建议在主网部署前完成

**升级方案：**
```solidity
// OffchainResolver.sol 改动
mapping(address => bool) public signers;

event SignerAdded(address indexed signer);
event SignerRemoved(address indexed signer);

constructor(address _owner, address _initialSigner, string memory _gatewayUrl) {
    owner = _owner;
    signers[_initialSigner] = true;
    emit SignerAdded(_initialSigner);
    gatewayUrl = _gatewayUrl;
}

function addSigner(address signer) external onlyOwner {
    signers[signer] = true;
    emit SignerAdded(signer);
}

function removeSigner(address signer) external onlyOwner {
    signers[signer] = false;
    emit SignerRemoved(signer);
}

// resolveWithProof 中改验证逻辑
if (!signers[recovered]) revert InvalidSigner();
```

---

## 二、新 ENS v2 架构深度分析

### 2.1 新 UniversalResolver 架构（AbstractUniversalResolver.sol）

ENS v2 完全重构了 UniversalResolver，采用**批量网关 (Batch Gateway)** 架构：

```
旧架构（v1）：
Client → UniversalResolver.resolve()
  → OffchainLookup (resolver URL)
  → Client 调用我们的 gateway
  → Client 调用 resolver.resolveWithProof()

新架构（v2）：
Client → UniversalResolver.resolveWithGateways()
  → ccipBatch() → OffchainLookup (ENS Batch Gateway URL)
  → ensjs 拦截批量请求 → 并行调用各个子 resolver 的 gateway
  → 批量响应返回给 ccipBatchCallback
  → ccipBatchCallback 调用各 resolver 的 resolveWithProof()
```

**对 CometENS 的影响**：

1. **完全兼容** — 我们的 OffchainResolver 实现了 `IExtendedResolver` (0x9061b923)，UniversalResolver 正确检测并路由到 batch gateway 路径
2. **resolveWithProof 仍被调用** — 在 ccipBatchCallback 中，通过 staticcall 调用我们的回调
3. **无需任何代码修改** — 现有合约和网关完全适配新 UniversalResolver

**代码证据（AbstractUniversalResolver.sol）：**
```solidity
_checkResolver(info):  // 检测 IExtendedResolver，若有则走 extended 路径
ccipBatch(...)         // 将我们的 OffchainLookup 打包为批量请求
ccipBatchCallback():
  (ok, v) = p.sender.staticcall(
      abi.encodeWithSelector(p.callbackFunction, v, p.extraData)
  );  // = resolveWithProof(response, extraData)
```

### 2.2 IERC7996 "直接解析" 优化（可选）

新 UniversalResolver 支持两条路径：

| 路径 | 条件 | 特点 |
|------|------|------|
| **批量网关路径**（当前） | 默认（我们现在走这条） | 通过 ENS 批量网关中转，稍有延迟 |
| **直接解析路径** | 实现 IERC7996 + supportsFeature() | 直接调用 resolver，更快 |

```solidity
// 直接路径入口（AbstractUniversalResolver._callResolver）：
if (ERC165Checker.supportsERC165InterfaceUnchecked(info.resolver, type(IERC7996).interfaceId)) {
    ccipRead(address(info.resolver), ...);  // 直接调
} else {
    ccipRead(address(this), ccipBatch(...));  // 批量网关中转
}
```

实现直接路径：
```solidity
// 在 OffchainResolver 中添加
interface IERC7996 {
    function supportsFeature(bytes4 featureId) external view returns (bool);
}

contract OffchainResolver is IERC7996, ... {
    function supportsFeature(bytes4) external pure returns (bool) { return false; }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7   // EIP-165
            || interfaceId == 0x9061b923  // IExtendedResolver
            || interfaceId == 0x582de3e7; // IERC7996 ← 新增
    }
}
```

**建议**：实现直接路径可减少一次网络往返（不经过批量网关），但收益对 Sepolia 测试网不明显。主网部署时可考虑。

### 2.3 ENSIP-21 批量网关协议

新 UniversalResolver 使用的批量网关接口（IBatchGateway）：
```solidity
interface IBatchGateway {
    struct Request { address sender; string[] urls; bytes data; }
    function query(Request[] memory requests)
        external view returns (bool[] memory failures, bytes[] memory responses);
}
```

ensjs 实现了这个接口（`ccipBatchRequest.ts`）——它**不调用外部批量网关**，而是直接并行调用每个 resolver 的独立 gateway URL。这意味着：
- 我们的 `/api/ccip` 端点会被 ensjs 直接调用
- `sender` 字段 = 我们的 OffchainResolver 地址（正确用于签名绑定）

### 2.4 ENS v2 合规度自检

| 检查项 | 状态 | 说明 |
|--------|------|------|
| viem >= 2.35.0 | ✅ | ENS v2 客户端必需，已满足 |
| IExtendedResolver (0x9061b923) | ✅ | supportsInterface 已返回 true |
| EIP-165 (0x01ffc9a7) | ✅ | 已支持 |
| OffchainLookup 格式正确 | ✅ | sender/urls/callData/callback/extraData 全部正确 |
| resolveWithProof 回调 | ✅ | 与 ccipBatchCallback 的 staticcall 完全对应 |
| 签名格式（内部一致性） | ✅ | 网关和合约使用相同哈希方案 |
| CCIP-Read calldata 绑定 | ✅ | 签名包含 keccak256(calldata) 防篡改 |
| 过期时间绑定 | ✅ | 签名包含 expires，合约检查 `block.timestamp > expires` |
| 解析器地址绑定 | ✅ | 签名包含 address(this)，防跨解析器重放 |
| DNS 名称格式 | ✅ | resolve(bytes name, bytes data) 接受 DNS-encoded name |
| IERC7996 直接路径 | ❌ | 可选优化，建议主网部署前实现 |
| 多签名者支持 | ❌ | 功能可用但零停机轮换受限 |

---

## 三、现有代码与 ENS 官方标准的对比

### 3.1 AddrResolver 接口合规

**ENS 官方（AddrResolver.sol + IAddressResolver.sol）：**
```solidity
function addr(bytes32 node) public view virtual returns (address payable)  // ENSIP-1 (coinType 60)
function addr(bytes32 node, uint256 coinType) public view virtual returns (bytes memory)  // ENSIP-9/11
```

**我们的 L2Records.sol：**
```solidity
function addr(bytes32 node) external view returns (address)            // ✅
function addr(bytes32 node, uint256 coinType) external view returns (bytes memory)  // ✅
```

**✅ 完全符合 ENSIP-1 和 ENSIP-9/11。**

### 3.2 TextResolver 接口合规

**ENS 官方（TextResolver.sol）：**
```solidity
function text(bytes32 node, string calldata key) public view virtual returns (string memory)
```

**我们的 L2Records.sol：**
```solidity
function text(bytes32 node, string calldata key) external view returns (string memory)  // ✅
```

**✅ 完全符合。**

### 3.3 ContenthashResolver 接口合规

**ENS 官方（ContentHashResolver.sol）：**
```solidity
function contenthash(bytes32 node) public view virtual returns (bytes memory)
```

**我们的 L2Records.sol：**
```solidity
function contenthash(bytes32 node) external view returns (bytes memory)  // ✅
```

**✅ 完全符合。**

### 3.4 网关签名方案对比（EIP-3668 §4.1）

**EIP-3668 规范：**
```
sig = sign(keccak256(hex"1900" ++ request.to ++ expires ++ keccak256(callData) ++ keccak256(result)))
```

规范中 "sign" 未指定是否加 Ethereum 前缀，各实现可自由选择，**只要 resolver 合约和 gateway 一致**。

| 实现 | 网关 | 合约 | 兼容性 |
|------|------|------|--------|
| ENS 参考实现 | `signDigest(hash)` (无前缀) | `ecrecover(hash, sig)` | 内部一致 ✅ |
| **CometENS（我们）** | `signMessage({raw: hash})` (有前缀) | `ecrecover(ethHash, sig)` | 内部一致 ✅ |
| 跨实现兼容 | — | — | ❌ 不需要，各管各的 |

### 3.5 新发现：Durin — ENS 官方推荐的 L2 子域名工具

ENS 官方文档在 "L2 Subnames" 章节**明确推荐 Durin**：
> "[Durin](https://durin.dev/) is an opinionated approach to issuing ENS subnames on L2. It takes care of the L1 Resolver and offchain gateway parts of the CCIP Read stack for you."

Durin 的定位与 CometENS 完全重叠，是 ENS 官方背书的解决方案。建议：
- 关注 Durin 的演进，避免重复造轮子
- CometENS 的差异化在于**与 AAStar 生态的集成** + **上游应用 API**

---

## 四、历史仓库有价值内容总结（更新）

### 仍然有效的建议

| 内容 | 来源 | 优先级 | 说明 |
|------|------|--------|------|
| OffchainResolver 升级为多签名者 | ENS-offchain-resolver | 🟡 中 | 生产上线前做，成本低（20行） |
| IERC7996 直接解析路径 | ens-contracts | 🟢 低 | 主网可选优化 |
| Cloudflare Workers 网关部署 | ENS-offchain-resolver | 🟢 低 | 生产部署更优解 |
| multi-chain Provider 配置 | CometENS (aastar-dev) | 🟢 低 | 扩展到其他 OP-stack L2 时参考 |
| OPResolver 状态证明 | CometENS (aastar-dev) | 🟢 低 | 里程碑 C 的实现参考 |
| Contenthash 前端入口 | CometENS-old | 🟢 低 | admin.html 可补充 setContenthash |
| resolveWithProof 集成测试 | ENS-offchain-resolver | 🟢 低 | 补充合法/过期/篡改签名测试用例 |

### 已撤销的错误建议

- ~~签名格式修改（移除 Ethereum prefix）~~ — **不需要**，当前实现正确
- ~~立即修复签名兼容性~~ — **误判**，无需修复

---

## 五、对当前实现的最终评估

### 与 ENS v2 的兼容性

**当前 CometENS 与 ENS v2 的兼容性：高**

- ✅ 使用 viem >= 2.35.0（ENS v2 客户端库要求）
- ✅ OffchainResolver 实现 IExtendedResolver（0x9061b923），被新 UniversalResolver 正确识别
- ✅ resolveWithProof 回调与 ccipBatchCallback 完全适配
- ✅ 签名绑定了解析器地址 + 过期时间 + calldata + result（完整防重放）
- ✅ L2Records 的 addr/text/contenthash 接口符合 ENS resolver profile 规范
- ✅ ENSIP-11 多链地址（coinType = 0x80000000 | chainId）已支持

### 当前实现的优势

1. **自研 CCIP-Read 实现优于直接用 @chainlink/ccip-read-server**：无外部依赖，逻辑完全可控
2. **L2Records 合约超越历史版本**：加入所有权（onlyOwner）、多链 coinType、事件（可索引）
3. **上游应用 API 是独创功能**：所有历史仓库和 ENS 官方均无此功能
4. **签名方案内部自洽**：网关和合约一致，实际运行正确

### 唯一需要在主网前修复的问题

**OffchainResolver 多签名者支持**（约 20 行改动）：
- 不影响测试网运行
- 主网上线前必须完成
- 原因：生产环境需要零停机密钥轮换能力

---

## 六、附录：新 ENS 技术栈快照

| 组件 | 当前状态 | 我们的对应实现 |
|------|----------|--------------|
| UniversalResolver（新） | `CCIPBatcher` + 批量网关 | 兼容，无需改动 |
| 批量网关协议 | ENSIP-21 (IBatchGateway) | ensjs 客户端侧处理，无需服务端改动 |
| 直接解析路径 | IERC7996 (0x582de3e7) | 可选实现，建议主网前添加 |
| PublicResolver 授权 | operator 映射 + delegate 映射 | 我们用 onlyOwner + Worker EOA，满足 MVP |
| Name Wrapper (ERC-1155) | L2 官方合约 | 里程碑 B 升级目标 |
| 状态证明 (OPFault) | unruggable-gateways / OPResolver | 里程碑 C 升级目标 |
| viem 客户端 | >= 2.35.0 | ✅ 已满足 |
