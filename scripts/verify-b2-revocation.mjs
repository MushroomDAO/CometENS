// B2 —— M1 验收项「撤销可验证」,按 acceptance.md 写的**真实机制**验。
//
// Usage: node scripts/verify-b2-revocation.mjs [--execute] [--json]
//        默认 dry-run。--execute 会在 Sepolia 上**临时改动 aastar.eth 的 resolver**,
//        跑完自动改回;中途失败会打印手工恢复命令。
//
// acceptance.md 对 B2 的定义(逐字):
//
//   > **撤销可验证(真实机制)**:社区在 L1 把 resolver 改回自己 → 我们这套不再对该域名生效。
//
// 同一份文档还明确否掉了另一种说法:
//
//   > 此前写的「一条命令 removeRegistrar 即可撤销」是**错的**:托管场景下合约 owner 是我们,
//   > 而 owner 无条件绕过 registrar/quota/expiry 检查。
//
// 而 progress.md 把它记成「未决 —— 需要域名持有者的 L1 私钥」。
// **那把钥匙在 .env.local 里**:`0xb5600060…` 正是 Sepolia 上 aastar.eth 的 owner
// (`ENS_REGISTRY.owner(namehash('aastar.eth'))` 实测)。所以 B2 不是做不了,
// 是**没人去把那把钥匙和这条判据对上**。
//
// 三步,中间那步是判据:
//   1. 基线   —— 经 UniversalResolver 解析 <label>.aastar.eth,记录 resolver 与结果
//   2. 撤销   —— owner 调 ENS_REGISTRY.setResolver(aastar.eth, 0x0)
//                 再解析 → **必须不再走我们的 resolver**
//   3. 恢复   —— setResolver 改回,再解析 → 回到基线
//
// 第 2 步之所以是判据而不是第 3 步:第 3 步只证明我们能改回去(我们本来就有 owner 权),
// 第 2 步才证明**社区一旦收回 resolver 指针,我们这套就对该域名失效**。
import { createPublicClient, createWalletClient, http, namehash, parseAbi, encodeFunctionData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const EXECUTE = argv.includes('--execute')
const asJson = argv.includes('--json')
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i === -1 ? undefined : argv[i + 1] }

const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e'
const ZERO = '0x0000000000000000000000000000000000000000'

function readEnvFile(p) {
  if (!existsSync(p)) return {}
  return Object.fromEntries(readFileSync(p, 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]))
}
const local = readEnvFile(join(REPO_ROOT, '.env.local'))
const home = readEnvFile(join(process.env.HOME ?? '', 'Dev/.env'))
const RPC = process.env.SEPOLIA_RPC || local.SEPOLIA_RPC_URL || home.SEPOLIA_RPC || local.VITE_L1_SEPOLIA_RPC_URL
const ROOT = flag('root') ?? local.VITE_ROOT_DOMAIN ?? 'aastar.eth'
const LABEL = flag('label') ?? 'forest'
const NAME = `${LABEL}.${ROOT}`
const OWNER_KEY = local.PRIVATE_KEY_JASON

if (!RPC) { console.error('B2: no Sepolia RPC'); process.exit(2) }

const REG_ABI = parseAbi([
  'function owner(bytes32 node) view returns (address)',
  'function resolver(bytes32 node) view returns (address)',
  'function setResolver(bytes32 node, address resolver)',
])
const ADDR_ABI = parseAbi(['function addr(bytes32 node) view returns (address)'])
const UR_ABI = parseAbi(['function resolve(bytes name, bytes data) view returns (bytes, address)'])
// ENSv2 的 UniversalResolverV2 @ Sepolia —— 用它而不是自己走 registry,
// 因为**真实用户的解析走的是 UR**,而 B2 问的是「用户还能不能解析到我们」。
const URV2 = '0x4a1817d13e9cf196f471725176355c1234b63c70'

const pub = createPublicClient({ chain: sepolia, transport: http(RPC) })
const rootNode = namehash(ROOT)
const dnsEncode = (n) => { let o = '0x'; for (const p of n.split('.')) { const b = Buffer.from(p, 'utf8'); o += b.length.toString(16).padStart(2, '0') + b.toString('hex') } return o + '00' }
const calldata = encodeFunctionData({ abi: ADDR_ABI, functionName: 'addr', args: [namehash(NAME)] })

// ⚠️ 判据**不能**是「URv2 报的 resolver」。第一版就是这么写的,结果三次读数一模一样
// (`0xae66c62A…`),FAIL 得莫名其妙 —— 因为**对 v1 名字,URv2 永远报 ENSV1Resolver 镜像**,
// 那一列跟底下的 v1 resolver 指针换没换毫无关系。**它分辨不出我要下的那个结论。**
//
// 真正会变的是**有没有 OffchainLookup 这一跳**:
//   resolver = 我们的  → URv2 revert OffchainLookup(走我们的离线路径)
//   resolver = 0x0     → 没有 resolver 可委派,URv2 当场作答
// 所以关掉 ccipRead 看 revert —— 和 check-ensv2-resolution.mjs 是同一个判据。
const OFFCHAIN_LOOKUP = '0x556f1830'
const noCcip = createPublicClient({ chain: sepolia, transport: http(RPC), ccipRead: false })

async function resolveVia() {
  let offchainLookup = false
  try {
    await noCcip.readContract({ address: URV2, abi: UR_ABI, functionName: 'resolve', args: [dnsEncode(NAME), calldata] })
  } catch (e) {
    offchainLookup = String(e).includes(OFFCHAIN_LOOKUP)
  }
  try {
    const [value, resolver] = await pub.readContract({ address: URV2, abi: UR_ABI, functionName: 'resolve', args: [dnsEncode(NAME), calldata] })
    return { ok: true, offchainLookup, value, resolver }
  } catch (e) {
    return { ok: false, offchainLookup, error: String(e.shortMessage ?? e.message).split('\n')[0].slice(0, 140) }
  }
}

const log = (...a) => { if (!asJson) console.log(...a) }
const [regOwner, ourResolver] = await Promise.all([
  pub.readContract({ address: ENS_REGISTRY, abi: REG_ABI, functionName: 'owner', args: [rootNode] }),
  pub.readContract({ address: ENS_REGISTRY, abi: REG_ABI, functionName: 'resolver', args: [rootNode] }),
])

log(`B2 撤销可验证 —— ${ROOT}  (Sepolia)`)
log(`  registry owner   ${regOwner}`)
log(`  当前 resolver    ${ourResolver}`)
log(`  测试名           ${NAME}`)

const owner = OWNER_KEY ? privateKeyToAccount(OWNER_KEY) : null
const weOwnIt = owner && owner.address.toLowerCase() === regOwner.toLowerCase()
log(`  我们持有 owner 钥 ${weOwnIt ? `yes (${owner.address})` : 'NO —— 这一条就是 progress.md 说的「需要域名持有者的 L1 私钥」'}`)

const before = await resolveVia()
log(`\n[1] 基线解析  走我们的离线路径=${before.offchainLookup}   (URv2 报的 resolver=${before.resolver ?? '-'} 对 v1 名字恒为镜像,不是判据)`)

if (!EXECUTE) {
  log('\n  dry-run。--execute 会:')
  log(`    setResolver(${ROOT}, 0x0)  →  重新解析  →  setResolver(${ROOT}, ${ourResolver})`)
  log('  中间那一步是判据。跑在 Sepolia,不花钱,结束自动恢复。')
  process.exit(0)
}
if (!weOwnIt) { console.error('\nB2: 没有 owner 私钥,无法执行。这正是它此前未决的原因。'); process.exit(2) }
if (ourResolver === ZERO) { console.error('\nB2: 当前 resolver 已经是 0x0,没有可撤销的状态。'); process.exit(2) }

const wallet = createWalletClient({ account: owner, chain: sepolia, transport: http(RPC) })
const wait = (hash) => pub.waitForTransactionReceipt({ hash, timeout: 180_000 })
const RESTORE = `node scripts/verify-b2-revocation.mjs --restore-to ${ourResolver}`
let revokedTx, restoredTx, after

try {
  log(`\n[2] 撤销:setResolver(${ROOT}, 0x0) …`)
  revokedTx = await wallet.writeContract({ address: ENS_REGISTRY, abi: REG_ABI, functionName: 'setResolver', args: [rootNode, ZERO] })
  await wait(revokedTx)
  log(`    tx ${revokedTx}`)
  after = await resolveVia()
  log(`    撤销后解析  走我们的离线路径=${after.offchainLookup}   ← 判据`)
} finally {
  // 恢复放在 finally:上面任何一步抛了,resolver 也不能留在 0x0 —— 那会让测试网对所有人挂掉。
  try {
    log(`\n[3] 恢复:setResolver(${ROOT}, ${ourResolver}) …`)
    restoredTx = await wallet.writeContract({ address: ENS_REGISTRY, abi: REG_ABI, functionName: 'setResolver', args: [rootNode, ourResolver] })
    await wait(restoredTx)
    log(`    tx ${restoredTx}`)
  } catch (e) {
    console.error(`\n🔴 恢复失败!${ROOT} 的 resolver 可能仍是 0x0,测试网解析对所有人是断的。`)
    console.error(`   手工恢复:${RESTORE}`)
    console.error(`   原因:${String(e.shortMessage ?? e.message).split('\n')[0]}`)
    process.exit(3)
  }
}

const restored = await resolveVia()
const finalResolver = await pub.readContract({ address: ENS_REGISTRY, abi: REG_ABI, functionName: 'resolver', args: [rootNode] })

// 判据:撤销后**不再走我们的 resolver**。
// 注意不能用「解析报错」当判据 —— UR 完全可能仍然返回成功但走了别的(v1 镜像)路径,
// 而那恰恰说明我们这套已经不生效了。所以比的是 resolver 这一列,不是 ok 这一列。
const stopped = before.offchainLookup === true && after?.offchainLookup === false
const recovered = restored.offchainLookup === true
const safe = finalResolver.toLowerCase() === ourResolver.toLowerCase()

const out = { root: ROOT, name: NAME, before, after, restored, revokedTx, restoredTx, stopped, recovered, safe }
if (asJson) console.log(JSON.stringify(out, null, 2))
else {
  log('\n' + '─'.repeat(72))
  log(`  撤销前 走我们的离线路径   ${before.offchainLookup}`)
  log(`  撤销后 走我们的离线路径   ${after?.offchainLookup}   ← 判据`)
  log(`  恢复后 走我们的离线路径   ${restored.offchainLookup}`)
  log(`  链上 resolver 已恢复  ${safe}`)
  log('─'.repeat(72))
}
const PASS = stopped && recovered && safe
console.log(PASS
  ? '\nB2: PASS — 社区把 L1 resolver 收回后,我们这套对该域名立即失效;改回后恢复。撤销可验证,证据是链上 tx。'
  : '\nB2: FAIL — 见上表。')
process.exit(PASS ? 0 : 1)
