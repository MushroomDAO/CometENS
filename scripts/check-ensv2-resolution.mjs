// T4.1.2 — CometENS 的名字在 ENSv2 的 UniversalResolverV2 下还解析得动吗?
//
// Usage: node scripts/check-ensv2-resolution.mjs [--name <fqdn>] [--json]
//
// 为什么存在:
//
// `docs/ENSV2-MIGRATION-PLAN.md` 的整个可行性压在一条断言上 ——「CCIP-Read / ERC-3668 /
// IExtendedResolver 在 V2 下完全不变,所以 OffchainResolver + Gateway 一行不用改」。
// 那条断言原本**只有一句文档引文撑着**。而这份方案自己定的标准是每条判断都要写「凭什么这么判」,
// 一句上游散文撑不起「不用改」这种级别的结论 —— 尤其上游同一批文档还写着接口 not yet final。
//
// 这个脚本把它变成实测:拿 ENSv2 在 Sepolia 真实部署的 UniversalResolverV2,
// 去解析我们自己的名字,看三件事:
//
//   1. 关掉 CCIP-Read 时,URv2 是否以 OffchainLookup(0x556f1830) revert
//      —— 证明它**认得**我们的离线解析器,而不是当作空记录跳过
//   2. 打开 CCIP-Read 时,是否能跟到我们的网关并拿回结果
//      —— 证明整条链路(URv2 → v1 镜像 → 我们的 OffchainResolver → 网关)是通的
//   3. URv2 报出的 resolver 是谁 —— 现在应当是 ENSV1Resolver 镜像,因为根域名还在 v1
//
// ⚠️ **这个脚本区分不了「没触发 CCIP-Read」和「触发了、跟完了、记录本来就是空的」**,
// 除非同时看第 1 步。viem 的 readContract **默认自动跟随 CCIP-Read**,所以只看返回值
// 会把「一切正常但该名字没设地址」误读成「CCIP-Read 没工作」—— 第一次跑这个探针时
// 正是这么误判的,零地址看起来像协议断了。第 1 步(ccipRead:false)才是判据,
// 第 2 步只是补全画面。
//
// 地址来源:docs/reference/ensv2-deployments-sepolia.md(由 pnpm docs:ens --addresses 生成)。
// 上游换部署时先跑那条命令,再改这里 —— 别手抄。
import { createPublicClient, http, namehash, encodeFunctionData, parseAbi } from 'viem'
import { sepolia } from 'viem/chains'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ENSv2 on Ethereum Sepolia — contracts-v2@97a5729, deployed 2026-07-30.
const URV2 = '0x4a1817d13e9cf196f471725176355c1234b63c70'
// OffchainLookup(address,string[],bytes,bytes4,bytes)
const OFFCHAIN_LOOKUP_SELECTOR = '0x556f1830'

const argv = process.argv.slice(2)
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i === -1 ? undefined : argv[i + 1] }
const asJson = argv.includes('--json')
const NAME = flag('name') ?? 'forest.aastar.eth'

// .env 读取:值可能带引号(~/Dev/.env 里的 SEPOLIA_RPC 就带),不剥掉会拼出非法 URL,
// 而报错是 "HTTP request failed" —— 看起来像网络问题,实际是解析问题。
function readEnvFile(p) {
  if (!existsSync(p)) return {}
  return Object.fromEntries(
    readFileSync(p, 'utf8').split('\n')
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => [
        l.slice(0, l.indexOf('=')).trim(),
        l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, ''),
      ]))
}

const home = readEnvFile(join(process.env.HOME ?? '', 'Dev/.env'))
const local = readEnvFile(join(REPO_ROOT, '.env.local'))
const RPC = process.env.SEPOLIA_RPC || home.SEPOLIA_RPC || local.VITE_L1_SEPOLIA_RPC_URL

if (!RPC) {
  console.error('ENSV2_CHECK: no L1 Sepolia RPC. Set SEPOLIA_RPC, or VITE_L1_SEPOLIA_RPC_URL in .env.local.')
  process.exit(2)
}

const dnsEncode = (name) => {
  let out = '0x'
  for (const part of name.split('.')) {
    const b = Buffer.from(part, 'utf8')
    if (b.length > 255) throw new Error(`label too long: ${part}`)
    out += b.length.toString(16).padStart(2, '0') + b.toString('hex')
  }
  return out + '00'
}

const ADDR_ABI = parseAbi(['function addr(bytes32 node) view returns (address)'])
const UR_ABI = parseAbi(['function resolve(bytes name, bytes data) view returns (bytes, address)'])

const calldata = encodeFunctionData({ abi: ADDR_ABI, functionName: 'addr', args: [namehash(NAME)] })
const dnsName = dnsEncode(NAME)

// failureMode 把两种「offchainLookup=false」分开 —— 它们的 exit code 和文案本来一样,
// 而含义天差地别(见文件末尾 FAIL 分支)。这正是本脚本注释里那个坑的同族:
// **值**那一层我用 ccipRead:false 拆开了「协议断了」和「记录是空的」,
// 但**失败**那一层原来又把两种合上了 —— 读输出的人分得开,读 exit code 的 CI 分不开。
//   'answered-directly' = 没 revert,URv2 当场给了答案 → 我们的离线路径没被使用(配置问题)
//   'other-revert'      = revert 了,但不是 OffchainLookup → 有东西真的坏了
const result = { name: NAME, urv2: URV2, offchainLookup: false, followed: false, resolver: null, value: null, failureMode: null }

// ── 1. ccipRead 关闭:必须看到 OffchainLookup ─────────────────────────────────
const noCcip = createPublicClient({ chain: sepolia, transport: http(RPC), ccipRead: false })
try {
  await noCcip.readContract({ address: URV2, abi: UR_ABI, functionName: 'resolve', args: [dnsName, calldata] })
  // 没 revert = URv2 当场就有答案 = 它**没有**走我们的离线路径。
  result.offchainLookup = false
  result.failureMode = 'answered-directly'
} catch (e) {
  result.offchainLookup = String(e).includes(OFFCHAIN_LOOKUP_SELECTOR)
  if (!result.offchainLookup) {
    result.failureMode = 'other-revert'
    // shortMessage 常常是「reverted with the following signature:」这种半句,
    // 而**下一个人真正需要的是那个 selector** —— 拿它去 4byte 一查就知道是什么错。
    // 只打半句等于把他送回来重跑一遍脚本。
    const raw = String(e)
    const sel = raw.match(/reverted with the following signature:\s*(0x[0-9a-fA-F]{8})/)?.[1]
              ?? raw.match(/0x[0-9a-fA-F]{8}/)?.[0]
    result.error = [String(e.shortMessage ?? e.message ?? e).split('\n')[0].slice(0, 120),
                    sel ? `selector=${sel}` : null].filter(Boolean).join('  ')
  }
}

// ── 2. ccipRead 打开:应当跟到网关并返回 ──────────────────────────────────────
const withCcip = createPublicClient({ chain: sepolia, transport: http(RPC) })
try {
  const [value, resolver] = await withCcip.readContract({
    address: URV2, abi: UR_ABI, functionName: 'resolve', args: [dnsName, calldata],
  })
  result.followed = true
  result.value = value
  result.resolver = resolver
} catch (e) {
  result.followed = false
  result.followError = String(e.shortMessage ?? e.message ?? e).split('\n')[0].slice(0, 200)
}

if (asJson) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(`ENSV2_CHECK: ${NAME} via UniversalResolverV2 (Sepolia ${URV2})`)
  console.log(`  OffchainLookup raised   ${result.offchainLookup ? 'yes' : 'NO'}${result.error ? `  (${result.error})` : ''}`)
  console.log(`  CCIP-Read followed      ${result.followed ? 'yes' : 'NO'}${result.followError ? `  (${result.followError})` : ''}`)
  console.log(`  resolver reported       ${result.resolver ?? '-'}`)
  console.log(`  addr() value            ${result.value ?? '-'}`)
  if (result.value && /^0x0+$/.test(result.value)) {
    console.log('  note: 零值只说明这个名字没设 addr 记录,**不说明解析链路有问题** —— 判据是上面两行。')
  }
}

// 判据只有两条,都必须为真。返回值是不是零地址**不是**判据:
// 那取决于该名字有没有设记录,是数据问题,不是协议问题。
if (!result.offchainLookup || !result.followed) {
  console.error('\nENSV2_CHECK: FAIL')
  // 三种失败,该查的地方完全不同 —— 只打一句通用文案等于把分诊工作推给下一个人。
  if (result.failureMode === 'answered-directly') {
    console.error('  原因:URv2 直接作答,没有触发 OffchainLookup —— 我们的离线路径根本没被使用。')
    console.error('  先查配置,不是查代码:这个名字在 ENS 上的 resolver 是不是还指向我们的 OffchainResolver?')
    console.error(`  (对照:\`--name vitalik.eth\` 这类纯链上名字本来就会走到这里,它不是故障。)`)
  } else if (result.failureMode === 'other-revert') {
    console.error(`  原因:URv2 以非 OffchainLookup 的错误 revert —— 有东西真的坏了。`)
    console.error(`  revert: ${result.error}`)
  } else if (!result.followed) {
    console.error('  原因:OffchainLookup 触发了,但跟随失败 —— 链路前半段是好的,断在网关那一跳。')
    console.error(`  error: ${result.followError}`)
    console.error('  先查网关是否在线、URL 是否可达,再查 L1 合约。')
  }
  console.error('\n  前两种会推翻 docs/ENSV2-MIGRATION-PLAN.md §2「不变的部分」第一条,')
  console.error('  进而推翻整个迁移方案的可行性前提;第三种是我们自己这侧的运维问题,不影响那条断言。')
  process.exit(1)
}
console.log('\nENSV2_CHECK: ok — CCIP-Read 在 ENSv2 的 UniversalResolverV2 下按原样工作。')
