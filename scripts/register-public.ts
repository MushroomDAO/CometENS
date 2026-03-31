#!/usr/bin/env tsx
/**
 * 公开注册脚本：基于任意父域名注册子域名
 * 
 * 用法：
 *   tsx scripts/register-public.ts <label> [parent-domain] [owner-address]
 * 
 * 示例：
 *   # 基于 forest.aastar.eth 注册
 *   tsx scripts/register-public.ts bike forest.aastar.eth
 * 
 *   # 基于任意父域名注册给指定地址
 *   tsx scripts/register-public.ts myname mydomain.eth 0x1234...
 * 
 * 安全模式（环境变量）：
 *   REGISTRATION_MODE=open      - 完全开放（默认）
 *   REGISTRATION_MODE=whitelist - 需要白名单
 *   REGISTRATION_FEE=1000000000 - 注册费用（wei）
 * 
 * 白名单管理：
 *   tsx scripts/register-public.ts --add-whitelist 0x1234... [max-count]
 *   tsx scripts/register-public.ts --list-whitelist
 */

import { createWalletClient, createPublicClient, http, parseAbi, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { optimismSepolia, optimism } from 'viem/chains'
import { namehash, labelhash } from 'viem/ens'
import { existsSync, readFileSync, writeFileSync } from 'fs'

const L2_ABI = parseAbi([
  'function registerSubnode(bytes32 parentNode, bytes32 labelhash, address newOwner, string calldata label, bytes calldata addrBytes) external',
  'function addr(bytes32 node) external view returns (address)',
])

const WHITELIST_FILE = '.registration-whitelist.json'

interface WhitelistEntry {
  address: string
  addedAt: string
  maxRegistrations: number
  used: number
}

// 白名单管理函数
function loadWhitelist(): Record<string, WhitelistEntry> {
  if (!existsSync(WHITELIST_FILE)) return {}
  try {
    return JSON.parse(readFileSync(WHITELIST_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function saveWhitelist(list: Record<string, WhitelistEntry>) {
  writeFileSync(WHITELIST_FILE, JSON.stringify(list, null, 2))
}

function checkWhitelist(address: string): { allowed: boolean; reason?: string } {
  const mode = process.env.REGISTRATION_MODE || 'open'
  
  if (mode === 'open') return { allowed: true }
  
  if (mode === 'whitelist') {
    const list = loadWhitelist()
    const entry = list[address.toLowerCase()]
    if (!entry) return { allowed: false, reason: '地址不在白名单中' }
    if (entry.used >= entry.maxRegistrations) {
      return { allowed: false, reason: `已用完 ${entry.maxRegistrations} 次注册额度` }
    }
    return { allowed: true }
  }
  
  return { allowed: false, reason: '未知的注册模式' }
}

function recordUsage(address: string) {
  if (process.env.REGISTRATION_MODE === 'whitelist') {
    const list = loadWhitelist()
    const entry = list[address.toLowerCase()]
    if (entry) {
      entry.used++
      saveWhitelist(list)
    }
  }
}

// 管理员命令
if (process.argv[2] === '--add-whitelist') {
  const addr = process.argv[3]
  const max = parseInt(process.argv[4] || '1')
  if (!addr?.match(/^0x[a-fA-F0-9]{40}$/)) {
    console.error('用法: tsx scripts/register-public.ts --add-whitelist <address> [max-registrations]')
    process.exit(1)
  }
  const list = loadWhitelist()
  list[addr.toLowerCase()] = {
    address: addr.toLowerCase(),
    addedAt: new Date().toISOString(),
    maxRegistrations: max,
    used: 0,
  }
  saveWhitelist(list)
  console.log(`✅ 已添加 ${addr} 到白名单（最多 ${max} 次注册）`)
  process.exit(0)
}

if (process.argv[2] === '--list-whitelist') {
  const list = loadWhitelist()
  console.log('\n📋 注册白名单')
  console.log('==============')
  const entries = Object.values(list)
  if (entries.length === 0) {
    console.log('(白名单为空)')
  } else {
    entries.forEach((e: WhitelistEntry) => {
      console.log(`${e.address}: ${e.used}/${e.maxRegistrations}`)
    })
  }
  console.log('')
  process.exit(0)
}

// 主注册流程
async function main() {
  const label = process.argv[2]
  const parentDomain = process.argv[3] || process.env.ROOT_DOMAIN || 'aastar.eth'
  const explicitOwner = process.argv[4]

  if (!label) {
    console.log('\n🌐 CometENS - 公开注册脚本')
    console.log('==========================\n')
    console.log('用法: tsx scripts/register-public.ts <label> [parent-domain] [owner]\n')
    console.log('示例:')
    console.log('  tsx scripts/register-public.ts myname              # myname.aastar.eth')
    console.log('  tsx scripts/register-public.ts bike forest.aastar.eth')
    console.log('  tsx scripts/register-public.ts car my.eth 0x123... # 指定所有者\n')
    console.log('白名单管理:')
    console.log('  tsx scripts/register-public.ts --add-whitelist 0x123... 5')
    console.log('  tsx scripts/register-public.ts --list-whitelist\n')
    process.exit(1)
  }

  // 验证 label
  if (!/^[a-z0-9-]{1,63}$/.test(label)) {
    console.error('❌ 错误: 标签必须是 1-63 个小写字母、数字或连字符')
    process.exit(1)
  }

  // 加载配置
  const privateKey = (process.env.WORKER_EOA_PRIVATE_KEY || process.env.PRIVATE_KEY) as Hex
  if (!privateKey) {
    console.error('❌ 错误: 请设置 WORKER_EOA_PRIVATE_KEY 或 PRIVATE_KEY 环境变量')
    process.exit(1)
  }

  const l2RecordsAddress = (process.env.L2_RECORDS_ADDRESS || process.env.VITE_L2_RECORDS_ADDRESS) as Hex
  if (!l2RecordsAddress) {
    console.error('❌ 错误: 请设置 L2_RECORDS_ADDRESS 环境变量')
    process.exit(1)
  }

  const network = process.env.NETWORK || process.env.VITE_NETWORK || 'op-sepolia'
  const l2RpcUrl = process.env.L2_RPC_URL || process.env.VITE_L2_RPC_URL || 
    (network === 'op-mainnet' ? 'https://mainnet.optimism.io' : 'https://sepolia.optimism.io')

  const chain = network === 'op-mainnet' ? optimism : optimismSepolia
  const workerAccount = privateKeyToAccount(privateKey)
  const fullName = `${label}.${parentDomain}`

  console.log('\n🌐 CometENS - 公开注册')
  console.log('======================\n')
  console.log(`父域名:    ${parentDomain}`)
  console.log(`标签:      ${label}`)
  console.log(`完整域名:  ${fullName}`)
  console.log(`网络:      ${chain.name}`)
  console.log(`注册模式:  ${process.env.REGISTRATION_MODE || 'open'}`)
  console.log('')

  // 读取用户输入
  const readline = require('readline')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r))

  // 获取所有者地址
  let ownerAddress = explicitOwner
  if (!ownerAddress) {
    ownerAddress = await ask('输入所有者钱包地址: ')
  }
  ownerAddress = ownerAddress.trim()

  if (!/^0x[a-fA-F0-9]{40}$/i.test(ownerAddress)) {
    console.error('❌ 错误: 无效的以太坊地址')
    process.exit(1)
  }
  ownerAddress = ownerAddress.toLowerCase()

  // 检查白名单
  const check = checkWhitelist(ownerAddress)
  if (!check.allowed) {
    console.error(`\n❌ 注册被拒绝: ${check.reason}`)
    console.log('请联系管理员添加到白名单')
    process.exit(1)
  }

  console.log(`所有者:    ${ownerAddress}`)
  console.log('')

  // 初始化客户端
  const publicClient = createPublicClient({ chain, transport: http(l2RpcUrl) })

  // 计算 namehash
  const parentNode = namehash(parentDomain)
  const lh = labelhash(label)
  const node = namehash(fullName)

  // 检查是否已注册
  try {
    const existing = await publicClient.readContract({
      address: l2RecordsAddress,
      abi: L2_ABI,
      functionName: 'addr',
      args: [node],
    })
    if (existing && existing !== '0x0000000000000000000000000000000000000000') {
      console.error(`❌ 错误: "${fullName}" 已被注册到 ${existing}`)
      process.exit(1)
    }
    console.log('✅ 域名可用\n')
  } catch (e) {
    console.log('⚠️  无法检查可用性，继续执行...\n')
  }

  // 确认
  const confirm = await ask('确认注册? (yes/no): ')
  if (confirm.toLowerCase() !== 'yes') {
    console.log('已取消')
    process.exit(0)
  }
  rl.close()

  // 执行注册
  console.log('\n🚀 提交交易...')

  const walletClient = createWalletClient({ 
    account: workerAccount, 
    chain, 
    transport: http(l2RpcUrl) 
  })

  const fee = BigInt(process.env.REGISTRATION_FEE || '0')

  try {
    const hash = await walletClient.writeContract({
      address: l2RecordsAddress,
      abi: L2_ABI,
      functionName: 'registerSubnode',
      args: [parentNode, lh, ownerAddress as Hex, label, ownerAddress as Hex],
      value: fee,
    })

    console.log(`⏳ 交易已提交: ${hash}`)
    console.log('等待确认...\n')

    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    console.log(`✅ 已确认 (区块 ${receipt.blockNumber})`)
    console.log(`\n🎉 成功注册: ${fullName}`)
    console.log(`   所有者: ${ownerAddress}`)

    recordUsage(ownerAddress)
    
  } catch (e: any) {
    console.error(`\n❌ 交易失败: ${e.message}`)
    process.exit(1)
  }
}

main().catch(console.error)
