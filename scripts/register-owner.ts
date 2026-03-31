#!/usr/bin/env tsx
/**
 * 管理员脚本：使用私钥直接注册二级域名
 * 用途：root domain 持有者为自己注册特定二级域名
 * 
 * 示例：注册 aaa.aastar.eth
 * $ tsx scripts/register-owner.ts aaa
 * 
 * 环境变量：
 * - PRIVATE_KEY: 管理员私钥（用于签名）
 * - ROOT_DOMAIN: 根域名（如 aastar.eth）
 * - L2_RECORDS_ADDRESS: L2Records 合约地址
 * - L2_RPC_URL: Optimism RPC URL
 */

import { createWalletClient, createPublicClient, http, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { optimismSepolia, optimism } from 'viem/chains'
import { namehash, labelhash } from 'viem/ens'

const L2_ABI = parseAbi([
  'function registerSubnode(bytes32 parentNode, bytes32 labelhash, address newOwner, string calldata label, bytes calldata addrBytes) external',
  'function setSubnodeOwner(bytes32 parentNode, bytes32 labelhash, address newOwner, string calldata label) external',
  'function addr(bytes32 node) external view returns (address)',
])

async function main() {
  const label = process.argv[2]
  if (!label) {
    console.error('Usage: tsx scripts/register-owner.ts <label> [owner-address]')
    console.error('Example: tsx scripts/register-owner.ts aaa')
    console.error('Example: tsx scripts/register-owner.ts aaa 0x1234...')
    process.exit(1)
  }

  // 配置
  const privateKey = process.env.PRIVATE_KEY as `0x${string}`
  if (!privateKey) {
    console.error('Error: PRIVATE_KEY env var required')
    process.exit(1)
  }

  const rootDomain = process.env.ROOT_DOMAIN || 'aastar.eth'
  const l2RecordsAddress = process.env.L2_RECORDS_ADDRESS as `0x${string}`
  const l2RpcUrl = process.env.L2_RPC_URL || 'https://sepolia.optimism.io'
  const network = process.env.NETWORK || 'op-sepolia'

  if (!l2RecordsAddress) {
    console.error('Error: L2_RECORDS_ADDRESS env var required')
    process.exit(1)
  }

  const chain = network === 'op-mainnet' ? optimism : optimismSepolia
  const account = privateKeyToAccount(privateKey)
  const ownerAddress = (process.argv[3] as `0x${string}`) || account.address

  console.log('========================================')
  console.log('CometENS - Owner Registration Script')
  console.log('========================================')
  console.log(`Root Domain: ${rootDomain}`)
  console.log(`Label: ${label}`)
  console.log(`Full Name: ${label}.${rootDomain}`)
  console.log(`Owner: ${ownerAddress}`)
  console.log(`From: ${account.address}`)
  console.log(`Network: ${chain.name}`)
  console.log(`L2Records: ${l2RecordsAddress}`)
  console.log('----------------------------------------')

  const client = createPublicClient({ chain, transport: http(l2RpcUrl) })
  const wallet = createWalletClient({ 
    account, 
    chain, 
    transport: http(l2RpcUrl) 
  })

  // 计算 namehash
  const parentNode = namehash(rootDomain)
  const lh = labelhash(label)
  const fullName = `${label}.${rootDomain}`
  const node = namehash(fullName)

  console.log(`Parent Node: ${parentNode}`)
  console.log(`Label Hash: ${lh}`)
  console.log(`Full Node: ${node}`)

  // 检查是否已注册
  try {
    const existing = await client.readContract({
      address: l2RecordsAddress,
      abi: L2_ABI,
      functionName: 'addr',
      args: [node],
    })
    if (existing && existing !== '0x0000000000000000000000000000000000000000') {
      console.error(`\n❌ ERROR: "${fullName}" is already registered to ${existing}`)
      process.exit(1)
    }
    console.log('\n✅ Domain is available')
  } catch (e) {
    console.log('\n⚠️ Could not check availability, proceeding anyway...')
  }

  // 确认
  if (process.env.SKIP_CONFIRM !== 'true') {
    const readline = require('readline')
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    })
    
    await new Promise<void>((resolve) => {
      rl.question('\nProceed with registration? (yes/no): ', (answer: string) => {
        if (answer.toLowerCase() !== 'yes') {
          console.log('Cancelled')
          process.exit(0)
        }
        rl.close()
        resolve()
      })
    })
  }

  // 执行注册
  console.log('\n📝 Submitting transaction...')
  
  try {
    const txHash = await wallet.writeContract({
      address: l2RecordsAddress,
      abi: L2_ABI,
      functionName: 'registerSubnode',
      args: [
        parentNode,
        lh,
        ownerAddress,
        label,
        ownerAddress, // addrBytes = owner address
      ],
    })

    console.log(`\n✅ Transaction submitted: ${txHash}`)
    console.log(`Waiting for confirmation...`)

    const receipt = await client.waitForTransactionReceipt({ hash: txHash })
    console.log(`\n✅ Confirmed in block ${receipt.blockNumber}`)
    console.log(`\n🎉 Successfully registered: ${fullName}`)
    console.log(`   Owner: ${ownerAddress}`)
    console.log(`   Node: ${node}`)
    
  } catch (e: any) {
    console.error(`\n❌ Transaction failed: ${e.message}`)
    process.exit(1)
  }
}

main().catch(console.error)
