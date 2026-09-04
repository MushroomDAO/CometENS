// T4.1.1 / B2 —— 在 ENSv2 的真实 Sepolia 部署上,证明「撤销可验证」。
//
// Usage: node scripts/ensv2-eac-revocation-probe.mjs [--execute] [--json]
//        默认 --dry-run(只读、不发交易)。加 --execute 才真的上链。
//
// 这个脚本存在的理由,是 M1 验收项 B2 卡了一整个里程碑:
//
//   「撤销可验证 —— 社区能验证它随时可以收回我们发子名的权限」
//
// 在 CometENS 现有结构里**这一条给不出证据**:`L2RecordsV3.removeRegistrar()` 是
// `onlyOwner`,而 owner 是我们。社区只能拿到一句承诺 —— 没有任何链上凭据能让他们
// 自己验证「我们撤不掉他」。B2 不是没做,是**那个结构里做不出来**。
//
// ENSv2 的 EAC 把它变成一笔交易。本脚本跑完整生命周期:
//
//   1. 部署一个 UserRegistry 代理(VerifiableFactory,社区自己拥有 ROOT)
//   2. grantRootRoles(ROLE_REGISTRAR) 给「CometENS」这个委托方
//   3. 委托方 register() 一个子名                    → 应当成功
//   4. 社区 revokeRootRoles(ROLE_REGISTRAR)          ← 这一步就是 B2
//   5. 委托方再 register()                           → 应当 revert EACUnauthorizedAccountRoles
//
// 第 5 步的 revert 就是那份「可验证」的证据:任何人拿这几个 tx hash 就能自己复核,
// 不需要相信我们说了什么。
//
// ⚠️ 只跑 Sepolia。上游明写合约未定稿(F10),所以这里证明的是**机制成立**,
//    不是「这些地址将来还在」。
import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData, parseEther, formatEther } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const EXECUTE = argv.includes('--execute')
const asJson = argv.includes('--json')

// ENSv2 @ Sepolia — contracts-v2@97a5729,见 docs/reference/ensv2-deployments-sepolia.md
const VERIFIABLE_FACTORY = '0x10dc6333cdfe1fcef624c6e0a8221b91804cd7ef'
const USER_REGISTRY_IMPL = '0x624a25d67b59d587752ebec8dded8827dae52050'

// contracts/src/registry/libraries/RegistryRolesLib.sol —— nybble 布局,不是位标志
const ROLE_REGISTRAR = 1n << 0n
const ROLE_SET_SUBREGISTRY = 1n << 20n
const ROLE_SET_RESOLVER = 1n << 24n
const ROLE_REGISTRAR_ADMIN = ROLE_REGISTRAR << 128n

function readEnvFile(p) {
  if (!existsSync(p)) return {}
  return Object.fromEntries(readFileSync(p, 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]))
}
const local = readEnvFile(join(REPO_ROOT, '.env.local'))
const home = readEnvFile(join(process.env.HOME ?? '', 'Dev/.env'))
const RPC = process.env.SEPOLIA_RPC || local.SEPOLIA_RPC_URL || home.SEPOLIA_RPC || local.VITE_L1_SEPOLIA_RPC_URL
const OWNER_KEY = local.PRIVATE_KEY_JASON

if (!RPC) { console.error('EAC_PROBE: no Sepolia RPC'); process.exit(2) }
if (!OWNER_KEY) { console.error('EAC_PROBE: no PRIVATE_KEY_JASON in .env.local'); process.exit(2) }

const FACTORY_ABI = parseAbi([
  'function deployProxy(address implementation, uint256 salt, bytes data) returns (address)',
  'event ProxyDeployed(address indexed deployer, address indexed proxyAddress, uint256 salt, address implementation)',
])
const REGISTRY_ABI = parseAbi([
  'function initialize(address rootAccount, uint256 roleBitmap)',
  'function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)',
  'function grantRootRoles(uint256 roleBitmap, address account) returns (bool)',
  'function revokeRootRoles(uint256 roleBitmap, address account) returns (bool)',
  'function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)',
  'function findOwner(string label) view returns (address)',
])

const owner = privateKeyToAccount(OWNER_KEY)
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) })
const ownerWallet = createWalletClient({ account: owner, chain: sepolia, transport: http(RPC) })

const log = (...a) => { if (!asJson) console.log(...a) }
const out = { execute: EXECUTE, steps: [] }
const step = (name, data) => { out.steps.push({ name, ...data }); }

log(`EAC_PROBE: ENSv2 @ Sepolia  ${EXECUTE ? '*** EXECUTE (会发交易) ***' : 'dry-run(只读)'}`)
log(`  社区 owner   ${owner.address}`)

const bal = await pub.getBalance({ address: owner.address })
log(`  余额         ${Number(formatEther(bal)).toFixed(4)} ETH`)
if (EXECUTE && bal < parseEther('0.02')) {
  console.error('EAC_PROBE: 余额低于 0.02 ETH,不足以跑完 5 步。先领水。')
  process.exit(2)
}

// 「CometENS」这一方用一把一次性钥匙,而不是复用 owner —— 否则第 5 步的 revert
// 可能是因为 owner 恰好还有别的 role,而不是因为撤销生效了。**判据要求两个身份真的不同。**
const delegateKey = process.env.EAC_DELEGATE_KEY || generatePrivateKey()
const delegate = privateKeyToAccount(delegateKey)
const delegateWallet = createWalletClient({ account: delegate, chain: sepolia, transport: http(RPC) })
log(`  委托方       ${delegate.address}  (一次性钥匙)`)

if (!EXECUTE) {
  log('\n  dry-run:不发交易。以下是将要执行的 5 步:')
  log('    1. VerifiableFactory.deployProxy(UserRegistryImpl, salt, initialize(owner, ROOT_ROLES))')
  log(`    2. registry.grantRootRoles(ROLE_REGISTRAR=${ROLE_REGISTRAR}, ${delegate.address})`)
  log('    3. [委托方] registry.register("delegated", delegate, 0, 0, 0, expiry)      → 期望成功')
  log(`    4. registry.revokeRootRoles(ROLE_REGISTRAR, ${delegate.address})            ← B2`)
  log('    5. [委托方] registry.register("after-revoke", …)                            → 期望 revert')
  log('\n  加 --execute 真的跑。Sepolia,不花钱。')
  process.exit(0)
}

const wait = (hash) => pub.waitForTransactionReceipt({ hash, timeout: 180_000 })
const ROOT_ROLES = ROLE_REGISTRAR | ROLE_SET_SUBREGISTRY | ROLE_SET_RESOLVER | ROLE_REGISTRAR_ADMIN

// ── 1. 部署社区自己的 registry ────────────────────────────────────────────────
const salt = BigInt(Date.now())
const initData = encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'initialize', args: [owner.address, ROOT_ROLES] })
log('\n[1] deployProxy …')
let hash = await ownerWallet.writeContract({
  address: VERIFIABLE_FACTORY, abi: FACTORY_ABI, functionName: 'deployProxy',
  args: [USER_REGISTRY_IMPL, salt, initData],
})
let rcpt = await wait(hash)
// ProxyDeployed 的 proxyAddress 是第二个 indexed 参数 → topics[2]
const deployLog = rcpt.logs.find((l) => l.address.toLowerCase() === VERIFIABLE_FACTORY.toLowerCase())
const REGISTRY = deployLog ? `0x${deployLog.topics[2].slice(-40)}` : null
if (!REGISTRY) { console.error('EAC_PROBE: 没能从收据里取到 proxy 地址'); process.exit(1) }
log(`    registry = ${REGISTRY}   tx ${hash}`)
step('deployProxy', { tx: hash, registry: REGISTRY })

// ── 2. 授权委托方 ────────────────────────────────────────────────────────────
log('[2] grantRootRoles(ROLE_REGISTRAR → 委托方) …')
hash = await ownerWallet.writeContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'grantRootRoles', args: [ROLE_REGISTRAR, delegate.address] })
await wait(hash)
const hasBefore = await pub.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'hasRootRoles', args: [ROLE_REGISTRAR, delegate.address] })
log(`    hasRootRoles = ${hasBefore}   tx ${hash}`)
step('grant', { tx: hash, hasRole: hasBefore })

// 委托方需要一点 gas 才能自己发交易
log('    给委托方打 0.005 ETH 作 gas …')
hash = await ownerWallet.sendTransaction({ to: delegate.address, value: parseEther('0.005') })
await wait(hash)

// ── 3. 委托方注册 —— 应当成功 ────────────────────────────────────────────────
const expiry = BigInt(Math.floor(Date.now() / 1000) + 365 * 24 * 3600)
log('[3] [委托方] register("delegated") …')
let step3 = { ok: false }
try {
  hash = await delegateWallet.writeContract({
    address: REGISTRY, abi: REGISTRY_ABI, functionName: 'register',
    args: ['delegated', delegate.address, '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', 0n, expiry],
  })
  const r = await wait(hash)
  step3 = { ok: r.status === 'success', tx: hash }
  log(`    ${r.status}   tx ${hash}`)
} catch (e) {
  step3 = { ok: false, error: String(e.shortMessage ?? e.message).split('\n')[0].slice(0, 160) }
  log(`    FAILED: ${step3.error}`)
}
step('register-while-authorized', step3)

// ── 4. 撤销 —— 这一步就是 B2 ─────────────────────────────────────────────────
log('[4] revokeRootRoles(ROLE_REGISTRAR ← 委托方)   ← B2 ')
hash = await ownerWallet.writeContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'revokeRootRoles', args: [ROLE_REGISTRAR, delegate.address] })
await wait(hash)
const hasAfter = await pub.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: 'hasRootRoles', args: [ROLE_REGISTRAR, delegate.address] })
log(`    hasRootRoles = ${hasAfter}   tx ${hash}`)
step('revoke', { tx: hash, hasRole: hasAfter })

// ── 5. 撤销后再注册 —— 必须失败 ──────────────────────────────────────────────
log('[5] [委托方] register("after-revoke") —— 期望 revert …')
let step5 = { reverted: false }
try {
  // 先用 simulate:失败的交易不必真的上链烧 gas,而 revert 数据一样拿得到。
  await pub.simulateContract({
    account: delegate, address: REGISTRY, abi: REGISTRY_ABI, functionName: 'register',
    args: ['after-revoke', delegate.address, '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', 0n, expiry],
  })
  step5 = { reverted: false, note: '没有 revert —— 撤销没有生效' }
  log('    ⚠️ 没有 revert')
} catch (e) {
  // viem 解码 custom error 后,名字未必出现在 String(e) 里 —— 要从 message 全文找。
  // 第一版只搜 String(e) 的短消息,结果 revert 认出来了、原因没认出来,
  // 打出来是一个没有 ✅ 的 "reverted",看着像判据勉强通过。**分不清「撤销生效」和「别的原因失败」的
  // 通过,不算通过。** 对照组(从未授权的地址)在同一个 registry 上 revert 的正是
  // EACUnauthorizedAccountRoles,所以这里必须能认出同一个名字。
  const s = [String(e), e?.message, e?.details, e?.cause?.message, e?.metaMessages?.join(' ')].filter(Boolean).join(' ')
  step5 = { reverted: true, eacError: s.includes('EACUnauthorizedAccountRoles'), detail: String(e.shortMessage ?? e.message).split('\n')[0].slice(0, 160) }
  log(`    reverted${step5.eacError ? ' — EACUnauthorizedAccountRoles ✅' : ''}`)
}
step('register-after-revoke', step5)

const PASS = step3.ok && hasBefore === true && hasAfter === false && step5.reverted
if (asJson) console.log(JSON.stringify({ ...out, registry: REGISTRY, pass: PASS }, null, 2))
else {
  log('\n' + '─'.repeat(70))
  log(`  registry            ${REGISTRY}`)
  log(`  授权前可注册         ${step3.ok ? 'yes' : 'NO'}`)
  log(`  撤销前 hasRootRoles  ${hasBefore}`)
  log(`  撤销后 hasRootRoles  ${hasAfter}`)
  log(`  撤销后可注册         ${step5.reverted ? 'no (revert)' : 'YES ⚠️'}`)
  log('─'.repeat(70))
  log(PASS
    ? '\nEAC_PROBE: PASS — B2「撤销可验证」在 ENSv2 上成立,且证据是链上的 tx,不是我们的承诺。'
    : '\nEAC_PROBE: FAIL — 生命周期没有走通,见上面各步。')
}
process.exit(PASS ? 0 : 1)
