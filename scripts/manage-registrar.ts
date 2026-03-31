#!/usr/bin/env tsx
/**
 * 注册商管理脚本
 * 
 * 用法：
 *   # 添加注册商
 *   tsx scripts/manage-registrar.ts add <parent-domain> <registrar-address> [quota] [expiry]
 *   
 *   # 移除注册商
 *   tsx scripts/manage-registrar.ts remove <parent-domain> <registrar-address>
 *   
 *   # 查询注册商信息
 *   tsx scripts/manage-registrar.ts info <parent-domain> <registrar-address>
 * 
 * 示例：
 *   tsx scripts/manage-registrar.ts add forest.aastar.eth 0x1234... 1000 0
 *   tsx scripts/manage-registrar.ts remove forest.aastar.eth 0x1234...
 *   tsx scripts/manage-registrar.ts info forest.aastar.eth 0x1234...
 */

import { createWalletClient, createPublicClient, http, parseAbi, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { optimismSepolia, optimism } from 'viem/chains'
import { namehash } from 'viem/ens'
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(process.cwd(), '.env.local') })

const L2_RECORDS_V2_ABI = parseAbi([
  'function owner() view returns (address)',
  'function addRegistrar(bytes32 parentNode, address registrar, uint256 quota, uint256 expiry) external',
  'function removeRegistrar(bytes32 parentNode, address registrar) external',
  'function updateRegistrarQuota(bytes32 parentNode, address registrar, uint256 newQuota) external',
  'function isRegistrar(bytes32 parentNode, address addr) view returns (bool)',
  'function registrars(bytes32 parentNode, address registrar) view returns (bool)',
  'function registrarQuota(bytes32 parentNode, address registrar) view returns (uint256)',
  'function registrarExpiry(bytes32 parentNode, address registrar) view returns (uint256)',
  'function getRegistrarInfo(bytes32 parentNode, address registrar) view returns (bool isActive, uint256 quota, uint256 remainingQuota, uint256 expiry)',
  'event RegistrarAdded(bytes32 indexed parentNode, address indexed registrar, uint256 quota, uint256 expiry)',
  'event RegistrarRemoved(bytes32 indexed parentNode, address indexed registrar)',
])

async function main() {
  const command = process.argv[2]
  
  if (!command || !['add', 'remove', 'info'].includes(command)) {
    console.log('\n🔧 CometENS - Registrar Management')
    console.log('==================================\n')
    console.log('用法：')
    console.log('  tsx scripts/manage-registrar.ts <command> <parent-domain> <registrar-address> [options]\n')
    console.log('命令：')
    console.log('  add <parent> <address> [quota] [expiry]  - 添加注册商')
    console.log('  remove <parent> <address>                - 移除注册商')
    console.log('  info <parent> <address>                  - 查询注册商信息\n')
    console.log('示例：')
    console.log('  tsx scripts/manage-registrar.ts add forest.aastar.eth 0x1234... 1000 0')
    console.log('  tsx scripts/manage-registrar.ts remove forest.aastar.eth 0x1234...')
    console.log('  tsx scripts/manage-registrar.ts info forest.aastar.eth 0x1234...\n')
    process.exit(1)
  }

  // 加载配置
  const privateKey = process.env.PRIVATE_KEY as Hex
  const l2RecordsAddress = (process.env.L2_RECORDS_ADDRESS || process.env.VITE_L2_RECORDS_ADDRESS) as Hex
  const network = process.env.NETWORK || process.env.VITE_NETWORK || 'op-sepolia'
  const l2RpcUrl = process.env.L2_RPC_URL || process.env.VITE_L2_RPC_URL || 
    (network === 'op-mainnet' ? 'https://mainnet.optimism.io' : 'https://sepolia.optimism.io')

  if (!privateKey) {
    console.error('❌ 错误: 请设置 PRIVATE_KEY 环境变量')
    process.exit(1)
  }
  if (!l2RecordsAddress) {
    console.error('❌ 错误: 请设置 L2_RECORDS_ADDRESS 环境变量')
    process.exit(1)
  }

  const chain = network === 'op-mainnet' ? optimism : optimismSepolia
  const account = privateKeyToAccount(privateKey)

  console.log('\n🔧 CometENS - Registrar Management')
  console.log('==================================')
  console.log(`网络:      ${chain.name}`)
  console.log(`合约:      ${l2RecordsAddress}`)
  console.log(`操作账户:  ${account.address}`)
  console.log('')

  const publicClient = createPublicClient({ chain, transport: http(l2RpcUrl) })
  const walletClient = createWalletClient({ account, chain, transport: http(l2RpcUrl) })

  // 检查是否为合约 owner
  try {
    const owner = await publicClient.readContract({
      address: l2RecordsAddress,
      abi: L2_RECORDS_V2_ABI,
      functionName: 'owner',
    })
    
    if (owner.toLowerCase() !== account.address.toLowerCase()) {
      console.error(`❌ 错误: 当前账户不是合约 owner`)
      console.error(`   Owner:  ${owner}`)
      console.error(`   你的地址: ${account.address}`)
      process.exit(1)
    }
    console.log(`✅ 已验证 owner 权限\n`)
  } catch (e: any) {
    console.error(`❌ 无法验证 owner: ${e.message}`)
    // 继续尝试
  }

  const parentDomain = process.argv[3]
  const registrarAddress = process.argv[4] as Hex

  if (!parentDomain || !registrarAddress) {
    console.error('❌ 错误: 请提供 parent-domain 和 registrar-address')
    process.exit(1)
  }

  const parentNode = namehash(parentDomain)
  console.log(`父域名:    ${parentDomain}`)
  console.log(`父节点:    ${parentNode}`)
  console.log(`注册商:    ${registrarAddress}`)
  console.log('')

  // 执行命令
  switch (command) {
    case 'add': {
      const quota = parseInt(process.argv[5] || '1000')
      const expiry = parseInt(process.argv[6] || '0')

      console.log(`配额:      ${quota === 0 ? '无限' : quota}`)
      console.log(`过期:      ${expiry === 0 ? '永不' : new Date(expiry * 1000).toISOString()}`)
      console.log('')

      // 确认
      if (process.env.SKIP_CONFIRM !== 'true') {
        const readline = require('readline')
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
        await new Promise<void>((resolve) => {
          rl.question('确认添加注册商? (yes/no): ', (answer: string) => {
            rl.close()
            if (answer.toLowerCase() !== 'yes') {
              console.log('已取消')
              process.exit(0)
            }
            resolve()
          })
        })
      }

      console.log('\n📝 提交交易...')
      try {
        const hash = await walletClient.writeContract({
          address: l2RecordsAddress,
          abi: L2_RECORDS_V2_ABI,
          functionName: 'addRegistrar',
          args: [parentNode, registrarAddress, BigInt(quota), BigInt(expiry)],
        })

        console.log(`⏳ 交易已提交: ${hash}`)
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        console.log(`✅ 已确认 (区块 ${receipt.blockNumber})`)
        console.log(`\n🎉 成功添加注册商`)
      } catch (e: any) {
        console.error(`\n❌ 交易失败: ${e.message}`)
        process.exit(1)
      }
      break
    }

    case 'remove': {
      console.log('⚠️  即将移除注册商')
      
      if (process.env.SKIP_CONFIRM !== 'true') {
        const readline = require('readline')
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
        await new Promise<void>((resolve) => {
          rl.question('确认移除注册商? (yes/no): ', (answer: string) => {
            rl.close()
            if (answer.toLowerCase() !== 'yes') {
              console.log('已取消')
              process.exit(0)
            }
            resolve()
          })
        })
      }

      console.log('\n📝 提交交易...')
      try {
        const hash = await walletClient.writeContract({
          address: l2RecordsAddress,
          abi: L2_RECORDS_V2_ABI,
          functionName: 'removeRegistrar',
          args: [parentNode, registrarAddress],
        })

        console.log(`⏳ 交易已提交: ${hash}`)
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        console.log(`✅ 已确认 (区块 ${receipt.blockNumber})`)
        console.log(`\n🎉 成功移除注册商`)
      } catch (e: any) {
        console.error(`\n❌ 交易失败: ${e.message}`)
        process.exit(1)
      }
      break
    }

    case 'info': {
      try {
        const info = await publicClient.readContract({
          address: l2RecordsAddress,
          abi: L2_RECORDS_V2_ABI,
          functionName: 'getRegistrarInfo',
          args: [parentNode, registrarAddress],
        })

        console.log('\n📋 注册商信息')
        console.log('=============')
        console.log(`是否有效:    ${info.isActive ? '✅ 是' : '❌ 否'}`)
        console.log(`配额:        ${info.quota === 0n ? '无限' : info.quota.toString()}`)
        console.log(`剩余配额:    ${info.remainingQuota === 0n ? '无限' : info.remainingQuota.toString()}`)
        console.log(`过期时间:    ${info.expiry === 0n ? '永不' : new Date(Number(info.expiry) * 1000).toISOString()}`)
        
        // 检查是否过期
        if (info.expiry !== 0n && Date.now() / 1000 > Number(info.expiry)) {
          console.log(`⚠️  注意: 注册商已过期`)
        }
      } catch (e: any) {
        console.error(`❌ 查询失败: ${e.message}`)
        process.exit(1)
      }
      break
    }
  }
}

main().catch(console.error)
