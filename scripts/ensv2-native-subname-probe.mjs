// T4.1.5 —— 方案 B 的最小闭环:在 ENSv2 里注册一个**全新**名字,挂自己的 registry,
// 发一个子名,然后用**标准 ENS 客户端**(viem getEnsAddress,不走我们的网关)解析它。
//
// Usage: node scripts/ensv2-native-subname-probe.mjs [--execute] [--json]
//
// 为什么最后那一步才是判据:
//   方案 B 相对现状的核心卖点是「原生可读 —— 所有钱包/合约直接能解析,不需要懂 CCIP-Read」。
//   **那件事只能用别人的客户端验,不能用我们自己的。** 用我们的网关去查我们发的名字,
//   无论结果如何都证明不了第三方能不能查到。
//
// 为什么注册新名字而不是迁移 aastar.eth:
//   migration.mdx 写明迁移后 v1 的注册/续费路径会被停用,而我们整套测试网建立在 v1 指针上。
//   而同一份文档也写明「new registrations happen exclusively in ENSv2」——
//   **所以新名字天然就在 v2 里,绕开了迁移这一步。**
import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData,
         namehash, keccak256, toHex, formatUnits, parseAbiItem } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const EXECUTE = argv.includes('--execute')
const asJson = argv.includes('--json')

// ENSv2 @ Sepolia — contracts-v2@97a5729
const REGISTRAR = '0xa88553f454b77203b0d036a05c894d555eaaa2cc'
const USDC      = '0x768f42455a2d082e23ceef7d51e5787c82d67a39'
const FACTORY   = '0x10dc6333cdfe1fcef624c6e0a8221b91804cd7ef'
const REG_IMPL  = '0x624a25d67b59d587752ebec8dded8827dae52050'
const RES_IMPL  = '0x9eae5c2730a7dd16bdd1dee6421a1b91e3b0365e'
const ZERO      = '0x0000000000000000000000000000000000000000'

const readEnv = (p) => existsSync(p) ? Object.fromEntries(readFileSync(p,'utf8').split('\n')
  .filter(l=>l.includes('=')&&!l.trim().startsWith('#'))
  .map(l=>[l.slice(0,l.indexOf('=')).trim(), l.slice(l.indexOf('=')+1).trim().replace(/^["']|["']$/g,'')])) : {}
const local = readEnv(join(ROOT,'.env.local'))
const home  = readEnv(join(process.env.HOME ?? '','Dev/.env'))
const RPC = process.env.SEPOLIA_RPC || local.SEPOLIA_RPC_URL || home.SEPOLIA_RPC
if (!RPC || !local.PRIVATE_KEY_JASON) { console.error('PROBE: 缺 RPC 或 PRIVATE_KEY_JASON'); process.exit(2) }

const acct = privateKeyToAccount(local.PRIVATE_KEY_JASON)
const pub  = createPublicClient({ chain: sepolia, transport: http(RPC) })
const w    = createWalletClient({ account: acct, chain: sepolia, transport: http(RPC) })
const wait = (h) => pub.waitForTransactionReceipt({ hash: h, timeout: 240_000 })

const REGISTRAR_ABI = parseAbi([
  'function isAvailable(string label) view returns (bool)',
  'function getRegisterPrice(string label, uint64 duration, address paymentToken) view returns (uint256,uint256)',
  'function makeCommitment(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, bytes32 referrer) view returns (bytes32)',
  'function commit(bytes32 commitment)',
  'function register(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 referrer) returns (uint256)',
])
const ERC20 = parseAbi(['function mint(address to, uint256 amount)','function approve(address,uint256) returns (bool)','function balanceOf(address) view returns (uint256)','function decimals() view returns (uint8)'])
const FAB   = parseAbi(['function deployProxy(address,uint256,bytes) returns (address)'])
const REG   = parseAbi([
  'function initialize(address rootAccount, uint256 roleBitmap)',
  'function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)',
])
const RES   = parseAbi([
  'function initialize(address admin, uint256 roleBitmap, bytes[] setters)',
  'function setAddr(bytes32 node, address addr_)',
])

const LABEL = `cometens-probe-${Date.now().toString(36)}`
const NAME  = `${LABEL}.eth`
const SUB   = `alice.${NAME}`
const DUR   = BigInt(365*24*3600)
const ROLES = (1n<<0n)|(1n<<20n)|(1n<<24n)|((1n<<0n)<<128n)

const log = (...a) => { if (!asJson) console.log(...a) }
log(`ENSv2 原生子名闭环 —— ${EXECUTE ? '*** EXECUTE ***' : 'dry-run'}`)
log(`  账户 ${acct.address}`)
log(`  将注册 ${NAME},子名 ${SUB}`)

const avail = await pub.readContract({address:REGISTRAR,abi:REGISTRAR_ABI,functionName:'isAvailable',args:[LABEL]})
const [base,prem] = await pub.readContract({address:REGISTRAR,abi:REGISTRAR_ABI,functionName:'getRegisterPrice',args:[LABEL,DUR,USDC]})
const dec = await pub.readContract({address:USDC,abi:ERC20,functionName:'decimals'})
log(`  可注册=${avail}  1 年 ${formatUnits(base+prem,dec)} MockUSDC`)
if (!EXECUTE) { log('\n  --execute 才真跑。6 步:mint+approve → commit → 等 60s → register → 挂 registry+resolver → 发子名 → 标准客户端解析'); process.exit(0) }

const out = {}
// 1) 钱
log('\n[1] mint + approve MockUSDC …')
await wait(await w.writeContract({address:USDC,abi:ERC20,functionName:'mint',args:[acct.address,(base+prem)*10n]}))
await wait(await w.writeContract({address:USDC,abi:ERC20,functionName:'approve',args:[REGISTRAR,(base+prem)*10n]}))

// 2) 先把 registry 和 resolver 部好,注册时直接挂上,省一步交易
log('[2] 部署我们自己的 registry 与 resolver(VerifiableFactory)…')
const regInit = encodeFunctionData({abi:REG,functionName:'initialize',args:[acct.address,ROLES]})
let r = await wait(await w.writeContract({address:FACTORY,abi:FAB,functionName:'deployProxy',args:[REG_IMPL,BigInt(Date.now()),regInit]}))
const REGISTRY = '0x'+r.logs.find(l=>l.address.toLowerCase()===FACTORY.toLowerCase()).topics[2].slice(-40)
const resInit = encodeFunctionData({abi:RES,functionName:'initialize',args:[acct.address, (1n<<0n)|((1n<<0n)<<128n), []]})
r = await wait(await w.writeContract({address:FACTORY,abi:FAB,functionName:'deployProxy',args:[RES_IMPL,BigInt(Date.now()+1),resInit]}))
const RESOLVER = '0x'+r.logs.find(l=>l.address.toLowerCase()===FACTORY.toLowerCase()).topics[2].slice(-40)
log(`    registry=${REGISTRY}`); log(`    resolver=${RESOLVER}`)
out.registry=REGISTRY; out.resolver=RESOLVER

// 3) commit-reveal
const secret = keccak256(toHex(`cometens-${Date.now()}`))
log('[3] commit …')
const commitment = await pub.readContract({address:REGISTRAR,abi:REGISTRAR_ABI,functionName:'makeCommitment',
  args:[LABEL,acct.address,secret,REGISTRY,RESOLVER,DUR,'0x'+'0'.repeat(64)]})
await wait(await w.writeContract({address:REGISTRAR,abi:REGISTRAR_ABI,functionName:'commit',args:[commitment]}))
log('    等 65 秒(MIN_COMMITMENT_AGE=60)…')
await new Promise(r=>setTimeout(r,65_000))

log('[4] register …')
const regTx = await w.writeContract({address:REGISTRAR,abi:REGISTRAR_ABI,functionName:'register',
  args:[LABEL,acct.address,secret,REGISTRY,RESOLVER,DUR,USDC,'0x'+'0'.repeat(64)]})
await wait(regTx); log(`    ${NAME} 注册成功  tx ${regTx}`); out.registerTx=regTx

// 4) 在自己的 registry 里发子名,并设 addr
log('[5] 在自己的 registry 里发子名 alice,并设 addr …')
const exp = BigInt(Math.floor(Date.now()/1000)+300*24*3600)
await wait(await w.writeContract({address:REGISTRY,abi:REG,functionName:'register',
  args:['alice',acct.address,ZERO,RESOLVER,0n,exp]}))
const TARGET='0x000000000000000000000000000000000000dEaD'
await wait(await w.writeContract({address:RESOLVER,abi:RES,functionName:'setAddr',args:[namehash(SUB),TARGET]}))
log(`    ${SUB} → ${TARGET}`)

// 5) 判据:标准 ENS 客户端
log('[6] 用标准 ENS 客户端解析(viem getEnsAddress,不走我们的网关)…')
const client = createPublicClient({chain:sepolia,transport:http(RPC)})
let resolved=null, err=null
try { resolved = await client.getEnsAddress({name:SUB}) } catch(e){ err=String(e.shortMessage??e.message).split('\n')[0].slice(0,140) }
log(`    getEnsAddress("${SUB}") → ${resolved ?? 'null'}${err?`  (${err})`:''}`)
out.resolved=resolved; out.expected=TARGET

const PASS = resolved && resolved.toLowerCase()===TARGET.toLowerCase()
if (asJson) console.log(JSON.stringify({...out,name:NAME,sub:SUB,pass:PASS},null,2))
else log(PASS
  ? `\nPROBE: PASS — 一个标准 ENS 客户端,不知道我们的网关存在,解析出了正确地址。方案 B 的「原生可读」成立。`
  : `\nPROBE: FAIL — 标准客户端没解析出来(得到 ${resolved ?? 'null'},期望 ${TARGET})。`)
process.exit(PASS?0:1)
