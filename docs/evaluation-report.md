# CometENS 历史仓库评估报告

> 评估日期：2026-03-30
> 评估范围：`eval/CometENS-old`、`eval/CometENS`、`eval/ENS-offchain-resolver`
> 评估目的：提取有价值内容后删除三个历史仓库

---

## 一、仓库概览

| 仓库 | 分支 | 定位 | 状态 |
|------|------|------|------|
| `CometENS-old` | main | 早期 PostgreSQL 版网关 + React 前端 | 已被明确废弃（README 中标注 deprecated） |
| `CometENS` | main + aastar-dev | 引入 unruggable-gateways 的多链版本 | aastar-dev 是当前项目前身 |
| `ENS-offchain-resolver` | main + mongo | ENS 官方参考实现（Chainlink CCIP-Read） | 是当前 OffchainResolver 合约的设计基础 |

---

## 二、技术栈对比与借鉴点

### 2.1 签名格式：重要差异 ⚠️

**当前项目的签名（`server/gateway/index.ts`）：**
```typescript
// EIP-191 + Ethereum Message Prefix（双重包装）
const ethHash = keccak256(concat([
  toBytes('\x19Ethereum Signed Message:\n32'),
  messageHash,
]))
```

**ENS 官方参考实现的签名（标准 EIP-3668）：**
```typescript
// 纯 EIP-191，无 Ethereum Message 前缀
const messageHash = solidityKeccak256(
  ['bytes', 'address', 'uint64', 'bytes32', 'bytes32'],
  ['0x1900', resolverAddress, validUntil, keccak256(requestData), keccak256(result)]
)
const sig = signer.signDigest(messageHash)  // 原始 ECDSA，非 personal_sign
```

**影响**：当前签名格式与 ENS 标准不兼容。viem 的 `publicClient.getEnsAddress()` 通过 Universal Resolver 调用，会做 `resolveWithProof`，如果合约里验签逻辑与网关签名方式不对齐，线上解析会失败。

**建议**：对齐到标准 EIP-3668 签名（移除 Ethereum message prefix），与 Universal Resolver 生态完全兼容。

---

### 2.2 多签名者支持（Multi-signer）

**ENS 官方实现：**
```solidity
mapping(address => bool) public signers;  // 白名单式多签名者

constructor(string memory url, address[] memory _signers) {
    for(uint i = 0; i < _signers.length; i++) {
        signers[_signers[i]] = true;
    }
}
```

**当前项目：**
```solidity
address public signerAddress;  // 单一签名者
```

**影响**：单签名者意味着：
1. 密钥无法轮换（换一个就要重新部署合约）
2. 无法灾难恢复（密钥泄露只能重新部署）
3. 无法热/冷密钥分离

**建议**：在 OffchainResolver 升级时加入 `mapping(address => bool) signers`，成本很低，安全性大幅提升。

---

### 2.3 Cloudflare Workers 网关部署模式

**ENS 官方参考实现提供了两套部署方案：**
```
packages/gateway/        → Node.js 版（本地开发 / 自托管）
packages/gateway-worker/ → Cloudflare Workers 版（生产）
```

Workers 版的核心差异：
```typescript
// 使用 @ensdomains/ccip-read-cf-worker
// 数据来自 Cloudflare KV Store（而非数据库或链）
const db = JSONDatabase.fromKVStore(OFFCHAIN_STORE_DEV, TTL)

// 模块导出格式
module.exports = {
  fetch: (request, env, context) => router.handle(request)
}
```

**当前项目**：网关作为 Vite dev server 中间件运行，生产部署方式未定。

**建议**：`vite.config.ts` 中的 API 中间件提取为独立的 Cloudflare Worker，实现全球分布、边缘低延迟、Serverless，无需运维服务器。Workers 版适配成本较低（主要是 KV 存储适配，对当前项目来说是 L2 读取逻辑）。

---

### 2.4 多链 Provider 架构（来自 CometENS aastar-dev）

**`providers.ts` 支持 40+ 条链：**
```typescript
export const RPC_INFO = new Map<Chain, RPCInfo>([
  [CHAINS.OP, { publicHTTP: 'https://mainnet.optimism.io', ... }],
  [CHAINS.BASE, { publicHTTP: 'https://mainnet.base.org', ... }],
  [CHAINS.ARB1, { publicHTTP: 'https://arb1.arbitrum.io/rpc', ... }],
  // + Sepolia, Base Sepolia, Arbitrum Nova, Linea, Mode, Blast, ...
])

// 智能降级：Alchemy → Infura → Ankr → dRPC → public
function providerOrder(chain?: Chain): string[] { ... }
```

**当前项目**：RPC URL 硬编码在 `.env.local`，单链（OP Sepolia）。

**价值**：当未来支持 Mode、Base、Blast 等 OP-stack L2 时，直接用这套 Provider 配置而非重新硬编码。

---

### 2.5 OPResolver 状态证明（来自 CometENS 合约）

```solidity
// 不依赖签名，直接用 Bedrock 状态根验证 L2 数据
contract OPResolver is IERC165, IExtendedResolver, GatewayFetchTarget {
    IGatewayVerifier immutable _verifier;  // unruggable 验证合约

    // GatewayFetcher DSL：按链上 Merkle 树构造多步证明
    GatewayRequest memory req = GatewayFetcher.newCommand()
        .setTarget(STORAGE_CONTRACT_ADDRESS)
        .setSlot(slot).follow()
        .read().setOutput(0);
}
```

**这就是路线图里里程碑 C 的实现参考**：无需信任网关密钥，用 L1 上的状态根验证 L2 存储。

**当前项目**：签名模式（里程碑 A），OPResolver 是里程碑 C 的升级路径。

---

### 2.6 可插拔 Database 接口（ENS-offchain-resolver 架构）

```typescript
interface Database {
  addr(name: string, coinType: number): PromiseOrResult<{addr: string; ttl: number}>;
  text(name: string, key: string): PromiseOrResult<{value: string; ttl: number}>;
  contenthash(name: string): PromiseOrResult<{contenthash: string; ttl: number}>;
}
```

实现包括：JSON、MongoDB、Cloudflare KV，均可无缝替换。

**当前项目**：L2RecordsReader 直接读链，不抽象为 Database 接口，未来扩展时需改动更多层。

**建议**：如果将来要支持多数据源（链上 + 缓存 + 回退），可引入这个接口模式。

---

### 2.7 Wildcard 解析（通配符子域名）

**ENS 官方 findName() 算法：**
```typescript
private findName(name: string): ZoneData | null {
  if (this.data[name]) return this.data[name];         // 精确匹配
  const labels = name.split('.');
  for (let i = 1; i < labels.length + 1; i++) {
    const wildcard = ['*', ...labels.slice(i)].join('.');
    if (this.data[wildcard]) return this.data[wildcard]; // *.aastar.eth
  }
  return null;
}
```

**当前项目**：L2Records 上的节点是精确存储的，但 OffchainResolver 的 CCIP-Read 路径有通配符空间（`resolve(bytes name, bytes calldata)` 的 IExtendedResolver 语义本身支持通配符）。如果 l2Records 上存的是 `*.aastar.eth` 的记录，通配符解析不需要额外工作，只需 gateway 层传递正确的 name 字符串。

---

## 三、历史仓库中有我们未实现的功能吗？

### 3.1 已在当前项目实现的功能（✅）

| 功能 | 来源 | 当前状态 |
|------|------|----------|
| L2Records 合约（含所有权 + 多链 + 事件） | CometENS + 大量改进 | ✅ 已部署 OP Sepolia |
| CCIP-Read 网关 | ENS-offchain-resolver（重写） | ✅ 运行中 |
| EIP-712 用户注册 + 管理 | 自研 | ✅ register.html / admin.html |
| 上游应用 API（签名鉴权） | 自研（历史仓库均无） | ✅ /api/v1/register |
| text record 写入 | CometENS-old 有前端展示 | ✅ /api/manage/set-text |
| SetText / SetContenthash EIP-712 类型 | CometENS 无 | ✅ manage/schemas.ts |
| 多链地址（ENSIP-11 coinType） | 三个仓库均有雏形 | ✅ addr(node, coinType) |

### 3.2 历史仓库有、当前项目缺少的功能（⚠️）

| 功能 | 来源仓库 | 优先级 | 说明 |
|------|----------|--------|------|
| **OffchainResolver 多签名者支持** | ENS-offchain-resolver | 🔴 高 | 单签名者限制密钥轮换和灾难恢复 |
| **签名格式标准化**（移除 Ethereum prefix） | ENS-offchain-resolver | 🔴 高 | 影响与标准 Universal Resolver 的兼容性 |
| **Contenthash 完整读链路** | ENS-offchain-resolver | 🟡 中 | Gateway 能否正确 serve IPFS hash？需验证 |
| **通配符子域名解析** | ENS-offchain-resolver | 🟡 中 | `*.aastar.eth` 的 fallback 解析 |
| **Content hash / IPFS 前端设置** | CometENS-old | 🟡 中 | admin.html 缺少 setContenthash 操作 |
| **TTL 可配置** | ENS-offchain-resolver | 🟢 低 | 当前 TTL 硬编码，无法按域名差异化 |
| **Cloudflare Worker 网关** | ENS-offchain-resolver | 🟢 低 | 生产部署更优解，但非阻塞 |
| **多链 Provider 配置** | CometENS（aastar-dev） | 🟢 低 | 扩展到其他 OP-stack L2 时需要 |
| **MongoDB / 可插拔数据源** | ENS-offchain-resolver（mongo 分支） | 🟢 低 | 对纯链上场景意义不大 |

---

## 四、其他有价值的内容

### 4.1 测试模式（来自 ENS-offchain-resolver）

```typescript
// 完整 CCIP-Read 单测模式：直接调用 server.call()
async function makeCall(fragment: string, name: string, ...args: any[]) {
  const innerData = Resolver.encodeFunctionData(fragment, [node, ...args]);
  const outerData = IResolverService.encodeFunctionData('resolve', [dnsName(name), innerData]);
  const { status, body } = await server.call({ to: TEST_ADDRESS, data: outerData });
  // + 签名验证
  expect(recoverAddress(messageHash, expandSignature(sigData))).toBe(signingAddress);
}

// 合约测试：验证 resolveWithProof 的合法/非法签名
it('resolves an address given a valid signature', async () => { ... });
it('reverts given an invalid signature', async () => { ... });
it('reverts given an expired signature', async () => { ... });
```

**当前项目测试缺口**：没有对 `resolveWithProof` 合约函数的集成测试（验证签名→合约验签→返回结果这条完整链路）。

### 4.2 DNS 名称处理工具

```typescript
// ENS-offchain-resolver 的 decodeDnsName（DNS wire format → string）
function decodeDnsName(dnsname: Buffer) {
  const labels = [];
  let idx = 0;
  while (true) {
    const len = dnsname.readUInt8(idx);
    if (len === 0) break;
    labels.push(dnsname.slice(idx + 1, idx + len + 1).toString('utf8'));
    idx += len + 1;
  }
  return labels.join('.');
}
```

当前网关在解码 `resolve(bytes name, ...)` 中的 DNS 编码名称时需要这个函数，确认当前实现是否正确处理了 DNS wire format。

### 4.3 CometENS-old 的前端功能集（9 项操作）

React + Wagmi 版本实现了完整的 ENS 管理界面：
1. `resolveENSName()` — 解析地址
2. `registerSubdomain()` — 注册子域
3. `setSubdomainResolution()` — 设置解析地址
4. `resolveSubdomainOnLayer2()` — 直接查 L2
5. `setTextRecord()` — 设置文本记录
6. `setContentHash()` — 设置 IPFS 内容哈希
7. `setAvatar()` — 设置头像
8. `setContractName()` — 合约命名
9. `setMultichainAddress()` — 多链地址（SLIP-44）

**当前 admin.html 对比**：有查询、setAddr、setText，但缺少 setContenthash 和 Avatar 专项操作入口。

### 4.4 架构决策验证

历史仓库的演变轨迹印证了当前项目的架构选择是正确的：

```
CometENS-old（PostgreSQL 中心化数据库）
    ↓ 废弃，原因：链下存储不可信、DB 同步麻烦
CometENS（L2Records + CCIP-Read + 可信签名）
    ↓ 当前 MVP 路线
ens-tool（精炼版，加入 EIP-712、上游 API、完整测试）
    ↓ 下一步：多签名者、Cloudflare Workers、状态证明
```

---

## 五、优先行动建议

### 立即修复（影响生产正确性）

**① 签名格式标准化**
```typescript
// 当前（需修改）：
const sig = await account.signMessage({ message: { raw: messageHash } })

// 应改为（标准 EIP-3668）：
const sig = account.sign({ hash: messageHash })  // 原始 signDigest，无 Ethereum prefix
```
同时更新 `OffchainResolver.sol` 的 `makeSignatureHash()` 去掉 `\x19Ethereum Signed Message` 包装。

**② 给 OffchainResolver 加多签名者支持**
```solidity
// OffchainResolver.sol 改动（约 15 行）
mapping(address => bool) public signers;
event SignerAdded(address indexed signer);
event SignerRemoved(address indexed signer);
function addSigner(address signer) external onlyOwner { signers[signer] = true; }
function removeSigner(address signer) external onlyOwner { signers[signer] = false; }
// 验签时改为：require(signers[recovered], "Unauthorized signer")
```

### 短期补充（完善功能）

**③ 补全 Contenthash 链路**
- Gateway `server/gateway/index.ts` 确认支持 `contenthash(bytes32)` 的解码和返回
- admin.html 增加 setContenthash 操作入口（EIP-712 类型已存在于 schemas.ts）

**④ 补全 resolveWithProof 集成测试**
参考 ENS-offchain-resolver 的 `server.test.ts` 模式，增加：
- 合法签名的 resolveWithProof 成功用例
- 过期签名被 revert 的用例
- 签名被篡改被 revert 的用例

### 中期规划

**⑤ Cloudflare Workers 网关**
将 `vite.config.ts` 中的三类中间件提取为独立 Worker（CCIP-Read、manage、v1），参考 `packages/gateway-worker/src/` 结构。

**⑥ 多链 Provider 配置**
当扩展到 Base、Mode、Blast 等 OP-stack L2 时，参考 `providers.ts` 的 Provider 配置模式。

---

## 六、总结

### 三个仓库的核心价值

| 仓库 | 核心价值 | 可直接复用的内容 |
|------|----------|-----------------|
| **CometENS-old** | 证明了"数据库方案"的局限，验证了迁移到链上的正确性 | 前端功能列表参考（setContenthash/avatar 缺口） |
| **CometENS** | 多链 Provider 架构 + OPResolver 状态证明（里程碑C原型） | `providers.ts` 40+ 链配置；`OPResolver.sol` 作为里程碑C实现参考 |
| **ENS-offchain-resolver** | 官方 EIP-3668 参考实现，暴露两个重要问题（签名格式 + 多签名者） | 签名格式标准、多签名者合约模式、Cloudflare Workers 部署模式、测试套件模式 |

### 当前项目的优势（不需要改变的部分）

- ✅ L2Records 合约（所有权 + 多链 + 事件 — 远超历史版本）
- ✅ 上游应用 secp256k1 签名 API（三个历史仓库均无此功能）
- ✅ EIP-712 用户注册流程（安全且用户体验好）
- ✅ 配置驱动架构（VITE_NETWORK / VITE_ROOT_DOMAIN 等）
- ✅ 测试覆盖（unit + e2e + integration，历史仓库均较薄弱）

### 最重要的两个修复

1. **签名格式** — 不改可能导致与 ENS Universal Resolver 不兼容
2. **多签名者** — 不改会在密钥轮换时需要重新部署合约

这两项改动代码量都不大，但对生产稳定性影响最大。
