// ENSv2 迁到 L1 到底多少钱 —— 用现价算,不用假设。
//
// Usage: node scripts/ensv2-cost-probe.mjs [--names 10000] [--budget 200] [--json]
//
// 为什么存在:迁移方案 §3.2 曾经用「每名 50,000 gas @ 10 gwei」算了一整节账,
// 结论是「免费子域的 L1 gas 扛不住」。两个前提都错:
//
//     每名 gas        假设 50,000     实测 120,588      2.4× 贵
//     主网 gas price  假设 10 gwei    实测 ~0.079 gwei  126× 便宜
//
// 净效果是那个结论反过来。**而 ENS 砍掉 Namechain 的公开理由正是
// 「注册 gas 成本一年降了 99%」—— 那条新闻在同一份文档第 0 节就引过。**
// 读到了,没有拿它去检查自己的假设。
//
// 所以这个数不该再靠记忆或估算。每次要用就跑一遍。
import { createPublicClient, http, parseAbi, formatGwei } from 'viem'
import { mainnet } from 'viem/chains'

const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : Number(argv[i + 1]) }
const NAMES = flag('names', 10000)
const BUDGET = flag('budget', 200)
const asJson = argv.includes('--json')

// 实测值,来自 scripts/ensv2-eac-revocation-probe.mjs 的真实交易(Sepolia)。
// gas **用量**与链无关,所以 Sepolia 测得的数用于主网估价是成立的;
// 变的只有 gas price。取上界:5 次实测范围 97,865–122,743,前两笔便宜、之后稳定在 ~120k。
const GAS_PER_REGISTER = 120588
const GAS_ONE_TIME = 175853 + 63239   // deployProxy + grantRootRoles

const RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org']
let client, lastErr
for (const url of RPCS) {
  try {
    const c = createPublicClient({ chain: mainnet, transport: http(url) })
    await c.getBlockNumber()
    client = c; break
  } catch (e) { lastErr = e }
}
if (!client) { console.error('COST: 所有主网 RPC 都不可用:', String(lastErr).slice(0, 120)); process.exit(2) }

// 取样最近 1024 个区块的 baseFee —— 单个区块可能是瞬时低点,
// 而这个数要拿去支撑一个预算决定。
const hist = await client.request({ method: 'eth_feeHistory', params: ['0x400', 'latest', [50]] })
const base = hist.baseFeePerGas.map((x) => Number(BigInt(x)) / 1e9).sort((a, b) => a - b)
const pct = (p) => base[Math.floor(base.length * p)]

// ETH/USD 走 Chainlink 链上预言机,不用第三方 API —— 后者要 key,而且会静默返回陈旧价。
const FEED = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419'
const AGG = parseAbi([
  'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)',
  'function decimals() view returns (uint8)',
])
const [, answer, , updatedAt] = await client.readContract({ address: FEED, abi: AGG, functionName: 'latestRoundData' })
const dec = await client.readContract({ address: FEED, abi: AGG, functionName: 'decimals' })
const ethUsd = Number(answer) / 10 ** Number(dec)
const ageMin = (Date.now() / 1000 - Number(updatedAt)) / 60

const cost = (gwei, gas) => gas * gwei * 1e-9 * ethUsd
const rows = [['最低', base[0]], ['p25', pct(0.25)], ['中位', pct(0.5)], ['p75', pct(0.75)], ['p95', pct(0.95)], ['最高', base[base.length - 1]]]

if (asJson) {
  console.log(JSON.stringify({
    ethUsd, feedAgeMinutes: Math.round(ageMin), blocks: base.length,
    baseFeeGwei: Object.fromEntries(rows), gasPerRegister: GAS_PER_REGISTER,
    names: NAMES, budget: BUDGET,
    perName: Object.fromEntries(rows.map(([k, g]) => [k, +cost(g, GAS_PER_REGISTER).toFixed(5)])),
    total: Object.fromEntries(rows.map(([k, g]) => [k, +(cost(g, GAS_PER_REGISTER) * NAMES).toFixed(2)])),
  }, null, 2))
} else {
  console.log(`ENSv2 迁 L1 成本 —— 主网现价,取样 ${base.length} 个区块(≈${(base.length * 12 / 3600).toFixed(1)} 小时)`)
  console.log(`  ETH/USD $${ethUsd.toFixed(2)}  (Chainlink,${Math.round(ageMin)} 分钟前更新)`)
  console.log(`  每名 gas ${GAS_PER_REGISTER.toLocaleString()}(实测上界) · 一次性 ${GAS_ONE_TIME.toLocaleString()}\n`)
  console.log(`  ${'档位'.padEnd(6)} ${'baseFee'.padStart(9)} ${'每个子名'.padStart(11)} ${(NAMES.toLocaleString() + ' 个').padStart(12)} ${('$' + BUDGET + ' 能发').padStart(12)}`)
  for (const [k, g] of rows) {
    const per = cost(g, GAS_PER_REGISTER)
    console.log(`  ${k.padEnd(6)} ${g.toFixed(3).padStart(6)} gwei ${('$' + per.toFixed(4)).padStart(11)} ${('$' + (per * NAMES).toFixed(0)).padStart(12)} ${Math.floor(BUDGET / per).toLocaleString().padStart(12)}`)
  }
  const med = cost(pct(0.5), GAS_PER_REGISTER)
  console.log(`\n  一次性开销(部署 registry + 授权)按中位价 $${cost(pct(0.5), GAS_ONE_TIME).toFixed(3)}`)
  console.log(`\n  ⚠️ 真正的风险是波动,不是基准。主网历史上到过 50–100 gwei ——`)
  console.log(`     那时 ${NAMES.toLocaleString()} 个子名 = $${(cost(50, GAS_PER_REGISTER) * NAMES).toFixed(0)}–$${(cost(100, GAS_PER_REGISTER) * NAMES).toFixed(0)}。`)
  console.log(`     若采纳整体迁 L1,「gas 超过阈值暂停发放」是硬需求,不是可选项。`)
  if (med * NAMES > BUDGET) console.log(`\n  ✗ 按中位价,${NAMES.toLocaleString()} 个需 $${(med * NAMES).toFixed(0)},超出 $${BUDGET} 上限。`)
  else console.log(`\n  ✓ 按中位价,${NAMES.toLocaleString()} 个需 $${(med * NAMES).toFixed(0)},在 $${BUDGET} 上限内。`)
}
