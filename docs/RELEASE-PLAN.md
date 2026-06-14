# CometENS 发布计划:Sepolia 验证 → 全量 E2E → 主网

> 目标:**先在 Sepolia 测试网完整跑通并通过 E2E,再上主网。** 主网部署绝不在测试网验证之前进行。
> 主网执行细节见 [DEPLOY-MAINNET.md](./DEPLOY-MAINNET.md);本文档是它前面的**测试闸门**。

> **解析策略**(见 [README · Resolution Modes](../README.md#resolution-modes--what-users-get-and-who-you-trust)):上线走**签名模式**(即时,覆盖所有记录);**终结证明模式**(`MIN_AGE_SEC=0`)作为 ≥7 天老记录的去信任层。**弃用乐观证明(`MIN_AGE_SEC>0`)**——它有冷启动性能坑。因此本计划的证明模式验证用 `MIN_AGE_SEC=0`;签名模式 E2E 是上线必过项。

---

## 总览(5 个阶段,逐阶段闸门)

```
Stage 1  本地测试(无需部署)          ─ 闸门:unit + e2e 全绿
   │
Stage 2  部署当前 main 到 Sepolia     ─ 用 main 最新代码全新部署(与将上主网的代码一致)
   │
Stage 3  Sepolia 集成 + 端到端验证    ─ 闸门:integration 全绿 + 证明模式解析人工 PASS
   │
Stage 4  发布决策闸门                  ─ 1/2/3 全通过 才放行
   │
Stage 5  主网部署                      ─ 走 DEPLOY-MAINNET.md
```

> **为什么要重新部署到 Sepolia 而不是直接用现有测试网?**
> 现有测试网(C3' 部署)是从 `feat/d6-multi-root` 分支部署的。之后 main 又收口合并了第二轮安全修复(nonce 加 chainId、label regex、合约 `gas:2300` 等)。为保证"测试网验证的代码 == 将上主网的代码",**Stage 2 用当前 main 全新部署**。现有地址仅作参考/回退。

---

## Stage 1 — 本地测试(无需上链)

最快、最先跑。不通过就不用往下走。

```bash
pnpm install
git submodule update --init
cd contracts && forge install && cd ..

# 1a. 合约单元测试(Foundry)
cd contracts && forge test && cd ..

# 1b. TS 单元测试(纯 mock,无网络)
pnpm vitest run test/unit/

# 1c. E2E(本地 Anvil 链,自动起链)
#     覆盖:注册、原子 register+addr、text、contenthash、权限、
#           多根(D6)、子域转让(NFT)、CCIP-Read 解析、上游 API 鉴权
pnpm vitest run test/e2e/

# 1d. 编译检查
pnpm typecheck
```

**✅ Stage 1 闸门**:`forge test`、`vitest unit`、`vitest e2e`、`typecheck` 全部通过。

---

## Stage 2 — 部署当前 main 到 Sepolia

> 与 [DEPLOY-MAINNET.md](./DEPLOY-MAINNET.md) 步骤一一对应,只是网络换成测试网、用测试网 ASR。

### 2.1 部署 L2RecordsV3 → OP Sepolia
```bash
cd contracts
export DEPLOYER_ADDRESS=0x...
export OP_SEPOLIA_RPC_URL=https://sepolia.optimism.io   # 或付费节点
forge script script/DeployL2RecordsV3.s.sol \
  --rpc-url $OP_SEPOLIA_RPC_URL --broadcast --verify \
  --chain-id 11155420 --private-key $DEPLOYER_KEY
# 记录 → L2_SEPOLIA
```

### 2.2 复核测试网 ASR + 部署 OPResolver → Ethereum Sepolia
```bash
# 复核(测试网 sepoliaConfig)
grep -A4 "sepoliaConfig" \
  workers/gateway/node_modules/@unruggable/gateways/dist/cjs/op/OPFaultRollup.cjs \
  | grep AnchorStateRegistry
# 当前值 0xa1Cec548926eb5d69aa3B7B57d371EdBdD03e64b

cd contracts
export GATEWAY_URL=https://cometens-gateway.jhfnetboy.workers.dev/{sender}/{data}
export L2_RECORDS_ADDRESS=$L2_SEPOLIA
export ANCHOR_STATE_REGISTRY=0xa1Cec548926eb5d69aa3B7B57d371EdBdD03e64b
export MIN_AGE_SEC=0          # 测试网用 0(OP Sepolia game 终结快,1天窗口内)
export WINDOW_SEC=86400
export ETH_RPC_URL=$SEPOLIA_RPC_URL
forge script script/DeployOPResolver.s.sol \
  --rpc-url $SEPOLIA_RPC_URL --broadcast --verify \
  --chain-id 11155111 --private-key $DEPLOYER_KEY
# 记录 → OP_RESOLVER_SEPOLIA
```

> 注意:测试网 `MIN_AGE_SEC=0`/`WINDOW_SEC=86400` 可用(见 DEPLOY-MAINNET 附录);主网才需改成 `3600`/`86400`。这正是测试网与主网必须分开验证的原因之一——同一套参数在两个网络行为不同。

### 2.3 授权 Worker EOA 为 registrar
```bash
export ROOT_NODE=$(cast namehash aastar.eth)   # 测试网根域名(Sepolia ENS 上你控制的)
cast send $L2_SEPOLIA "addRegistrar(bytes32,address,uint256,uint256)" \
  $ROOT_NODE $WORKER_EOA 1000000 0 \
  --rpc-url $OP_SEPOLIA_RPC_URL --private-key $OWNER_KEY
# 多根(forest.aastar.eth 等)各加一次
```

### 2.4 部署 workers(testnet env)+ 更新 wrangler.toml
```bash
# 把 L2_SEPOLIA 填入两个 wrangler.toml 的 [env.testnet],
# gateway 的 ALLOWED_SENDERS = OP_RESOLVER_SEPOLIA
cd workers/gateway && pnpm install && wrangler deploy --env testnet
wrangler secret put ETH_RPC_URL --env testnet
wrangler secret put OP_RPC_URL  --env testnet
cd ../api && wrangler deploy --env testnet
wrangler secret put WORKER_EOA_PRIVATE_KEY --env testnet
wrangler secret put UPSTREAM_ALLOWED_SIGNERS --env testnet
```

### 2.5 设 Sepolia ENS aastar.eth resolver → OP_RESOLVER_SEPOLIA
```bash
export ENS_REGISTRY=0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e   # Sepolia 同地址
cast send $ENS_REGISTRY "setResolver(bytes32,address)" \
  $ROOT_NODE $OP_RESOLVER_SEPOLIA \
  --rpc-url $SEPOLIA_RPC_URL --private-key $OWNER_KEY
```

**✅ Stage 2 闸门**:5 个合约/worker 全部部署成功,地址记录在案,`aastar.eth`(Sepolia)resolver 已指向新 OPResolver。

---

## Stage 3 — Sepolia 集成 + 端到端证明模式验证

### 3.1 填 `.env.local`(集成测试读取)
```
OP_SEPOLIA_RPC_URL=...
OP_L2_RECORDS_ADDRESS=<L2_SEPOLIA>
SEPOLIA_RPC_URL=...
L1_OFFCHAIN_RESOLVER_ADDRESS=<OP_RESOLVER_SEPOLIA>   # deployed.test.ts 用此名
L1_OP_RESOLVER_ADDRESS=<OP_RESOLVER_SEPOLIA>
PRIVATE_KEY_JASON=0x...            # 测试用钱包私钥(会发真实测试网交易)
PRIVATE_KEY_SUPPLIER=0x...         # 签名模式回退用(可选)
```

### 3.2 跑集成测试(打真实 Sepolia 部署)
```bash
pnpm vitest run test/integration/
# 覆盖:
#   - 读 L2Records owner
#   - 在 OP Sepolia 原子注册子域 + 设 ETH addr + 设 text(真实上链)
#   - 读 OPResolver owner / gateway URL
#   - resolveWithProof 验证
#   - aastar.eth resolver 已指向 OPResolver(C3)
```

### 3.3 人工端到端(证明模式全链路,对应 5df883c)
```bash
# 方式 A:用前端 register.html(连 testnet workers)注册一个名字,
#         等几秒,点 "Check Resolution on L2",再用 ENS 应用解析。
# 方式 B:命令行用 ENS Universal Resolver 解析 <test>.aastar.eth 的 addr,
#         确认走 CCIP-Read(OffchainLookup)→ gateway 出证明 → OPResolver 验证通过 → 返回地址。
```

**✅ Stage 3 闸门**:`vitest integration` 全绿 + 至少一个新注册名字通过**证明模式**在 L1 成功解析(end-to-end PASS)。

---

## Stage 4 — 发布决策闸门

只有当 **Stage 1 / 2 / 3 全部通过** 时,才放行主网。逐项打勾:

- [ ] Stage 1:`forge test` + `vitest unit/e2e` + `typecheck` 全绿
- [ ] Stage 2:Sepolia 全套合约/worker 部署成功,resolver 已设
- [ ] Stage 3:`vitest integration` 全绿
- [ ] Stage 3:证明模式 end-to-end 人工 PASS
- [ ] 前端在 testnet 上手动走通"注册 → 等待 → 解析 → 设记录"完整旅程
- [ ] (确认主网前置)主网拥有 `aastar.eth` 控制权 + owner 多签方案已定

任一未通过 → 修复 → 回到对应 Stage 重跑。**不跳闸门。**

---

## Stage 5 — 主网部署

闸门全过后,执行 [DEPLOY-MAINNET.md](./DEPLOY-MAINNET.md)(已选定 `MIN_AGE_SEC=3600`/`WINDOW_SEC=86400`)。
部署后用同样的 Stage 3 方法在主网做一次证明模式 end-to-end 验证(新名字约 1h 后可解析)。

---

## 现有测试网部署(参考 / 回退)

| 项 | 地址 |
|----|------|
| L2RecordsV3 (OP Sepolia) | `0x8836E89D654141a858f680e995CA86f6644A29a5` |
| OPResolver (Eth Sepolia) | `0x9070d42C9C12333053565e7ee8c4BdDE9Ca73083` |
| Gateway | `https://cometens-gateway.jhfnetboy.workers.dev` |
| API | `https://cometens-api.jhfnetboy.workers.dev` |
| ASR (Sepolia) | `0xa1Cec548926eb5d69aa3B7B57d371EdBdD03e64b` |

> 若决定**复用**现有测试网而非全新部署:必须先确认其合约字节码/worker 代码 == 当前 main(尤其第二轮安全修复是否已包含),否则 Stage 3 通过也不能代表主网代码。保险起见推荐 Stage 2 全新部署。
