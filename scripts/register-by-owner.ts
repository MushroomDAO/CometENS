#!/usr/bin/env tsx
/**
 * 管理员脚本：使用私钥直接注册子域名
 * 
 * 用法：
 *   tsx scripts/register-by-owner.ts <label> [parent-domain] [owner-address]
 * 
 * 示例：
 *   # 注册 aaa.aastar.eth（给自己）
 *   tsx scripts/register-by-owner.ts aaa aastar.eth
 * 
 *   # 注册 bike.forest.aastar.eth（给指定地址）
 *   tsx scripts/register-by-owner.ts bike forest.aastar.eth 0x1234...
 * 
 * 环境变量：
 *   PRIVATE_KEY          - 管理员私钥（用于签名和提交交易）
 *   L2_RECORDS_ADDRESS   - L2Records 合约地址
 *   L2_RPC_URL           - Optimism RPC URL（默认：sepolia）
 *   NETWORK              - op-sepolia | op-mainnet
 */

import { createWalletClient, createPublicClient, http, parseAbi, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { optimismSepolia, optimism } from 'viem/chains'
import { namehash, labelhash } from 'viem/ens'

const L2_ABI = parseAbi([
  'function registerSubnode(bytes32 parentNode, bytes32 labelhash, address newOwner, string calldata label, bytes calldata addrBytes) external',
  'function addr(bytes32 node) external view returns (address)',
])

async function main() {
  const label = process.argv[2]
  const parentDomain = process.argv[3] || process.env.ROOT_DOMAIN || 'aastar.eth'
  const explicitOwner = process.argv[4] as Hex | undefined

  if (!label) {
    console.log('
📝 CometENS - Owner Registration Script')
    console.log('=====================================\n')
    console.log('用法：tsx scripts/register-by-owner.ts <label> [parent-domain] [owner]\n')
    console.log('示例：')
    console.log('  tsx scripts/register-by-owner.ts alice          # 注册 alice.aastar.eth')
    console.log('  tsx scripts/register-by-owner.ts bob my.eth     # 注册 bob.my.eth')
    console.log('  tsx scripts/register-by-owner.ts car my.eth 0x.. # 注册 car.my.eth 给指定地址\n')
    process.exit(1)
  }

  // 加载配置
  const privateKey = process.env.PRIVATE_KEY as Hex
  if (!privateKey) {
    console.error('❌ 错误：请设置 PRIVATE_KEY 环境变量')
    process.exit(1)
  }

  const l2RecordsAddress = (process.env.L2_RECORDS_ADDRESS || process.env.VITE_L2_RECORDS_ADDRESS) as Hex
  if (!l2RecordsAddress) {
    console.error('❌ 错误：请设置 L2_RECORDS_ADDRESS 环境变量')
    process.exit(1)
  }

  const network = process.env.NETWORK || process.env.VITE_NETWORK || 'op-sepolia'
  const l2RpcUrl = process.env.L2_RPC_URL || process.env.VITE_L2_RPC_URL || 
    (network === 'op-mainnet' ? 'https://mainnet.optimism.io' : 'https://sepolia.optimism.io')

  const chain = network === 'op-mainnet' ? optimism : optimismSepolia
  const account = privateKeyToAccount(privateKey)
  const ownerAddress = explicitOwner || account.address

  const fullName = `${label}.${parentDomain}`

  console.log('\n📝 CometENS - Owner Registration')
  console.log('================================\n')
  console.log(`父域名:    ${parentDomain}`)
  console.log(`标签:      ${label}`)
  console.log(`完整域名:  ${fullName}`)
  console.log(`所有者:    ${ownerAddress}`)
  console.log(`操作账户:  ${account.address}`)
  console.log(`网络:      ${chain.name}`)
  console.log(`合约:      ${l2RecordsAddress}`)
  console.log('')

  // 初始化客户端
  const publicClient = createPublicClient({ chain, transport: http(l2RpcUrl) })
  const walletClient = createWalletClient({ account, chain, transport: http(l2RpcUrl) })

  // 计算 namehash
  const parentNode = namehash(parentDomain)
  const lh = labelhash(label)
  const node = namehash(fullName)

  console.log(`父节点:    ${parentNode}`)
  console.log(`标签哈希:  ${lh}`)
  console.log(`完整节点:  ${node}`)
  console.log('')

  // 检查是否已注册
  try {
    const existing = await publicClient.readContract({
      address: l2RecordsAddress,
      abi: L2_ABI,
      functionName: 'addr',
      args: [node],
    })
    if (existing && existing !== '0x0000000000000000000000000000000000000000') {
      console.error(`❌ 错误："${fullName}" 已被注册到 ${existing}`)
      process.exit(1)
    }
    console.log('✅ 域名可用\n')
  } catch (e) {
    console.log('⚠️  无法检查可用性，继续执行...\n')
  }

  // 确认
  if (process.env.SKIP_CONFIRM !== 'true') {
    const readline = require('readline')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    
    await new Promise<void>((resolve, reject) => {
      rl.question('确认注册? (yes/no): ', (answer: string) => {
        rl.close()
        if (answer.toLowerCase() !== 'yes') {
          console.log('已取消')
          process.exit(0)
        }
        resolve()
      })
    })
  }

  // 执行注册
  console.log('\n🚀 提交交易...')
  
  try {
    const hash = await walletClient.writeContract({
      address: l2RecordsAddress,
      abi: L2_ABI,
      functionName: 'registerSubnode',
      args: [parentNode, lh, ownerAddress, label, ownerAddress],
    })

    console.log(`⏳ 交易已提交: ${hash}`)
    console.log('等待确认...\n')

    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    console.log(`✅ 已确认 (区块 ${receipt.blockNumber})`)
    console.log(`\n🎉 成功注册: ${fullName}`)
    console.log(`   所有者: ${ownerAddress}`)
    
  } catch (e: any) {
    console.error(`\n❌ 交易失败: ${e.message}`)
    process.exit(1)
  }
}

main().catch(console.error)
