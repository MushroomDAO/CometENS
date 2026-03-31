#!/usr/bin/env tsx
/**
 * 带签名认证的注册脚本
 * 
 * 安全机制:
 * 1. 从 .env.local 读取 REGISTRATION_SECRET
 * 2. 用私钥签名消息: "cometens:auth:{secret}:{timestamp}"
 * 3. 发送签名 + 地址 + 时间戳给服务端
 * 4. 服务端验证签名来自该地址且消息正确
 * 
 * 用法:
 *   tsx scripts/register-with-auth.ts <label> [parent-domain]
 * 
 * 示例:
 *   tsx scripts/register-with-auth.ts alice
 *   tsx scripts/register-with-auth.ts bike forest.aastar.eth
 * 
 * 环境变量 (.env.local):
 *   PRIVATE_KEY           - 你的私钥（用于签名和交易）
 *   REGISTRATION_SECRET   - 认证密钥（脚本读取用于签名）
 *   L2_RECORDS_ADDRESS    - L2Records 合约地址
 *   L2_RPC_URL            - Optimism RPC URL
 * 
 * 服务端需要 (.env.local):
 *   REGISTRATION_SECRET   - 相同的密钥（用于验证签名）
 *   ALLOWED_REGISTRANTS   - 可选: 白名单地址（逗号分隔）
 */

import { createWalletClient, createPublicClient, http, parseAbi, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { optimismSepolia, optimism } from 'viem/chains'
import { namehash, labelhash } from 'viem/ens'
import { config } from 'dotenv'
import { resolve } from 'path'

// 加载 .env.local
config({ path: resolve(process.cwd(), '.env.local') })

const L2_ABI = parseAbi([
  'function registerSubnode(bytes32 parentNode, bytes32 labelhash, address newOwner, string calldata label, bytes calldata addrBytes) external',
  'function addr(bytes32 node) external view returns (address)',
])

/**
 * 构建认证消息
 */
function buildAuthMessage(secret: string, timestamp: number): string {
  return `cometens:auth:${secret}:${timestamp}`
}

async function main() {
  const label = process.argv[2]
  const parentDomain = process.argv[3] || process.env.ROOT_DOMAIN || 'aastar.eth'

  if (!label) {
    console.log('\n🔐 CometENS - 签名认证注册')
    console.log('===========================\n')
    console.log('用法: tsx scripts/register-with-auth.ts <label> [parent-domain]\n')
    console.log('示例:')
    console.log('  tsx scripts/register-with-auth.ts alice')
    console.log('  tsx scripts/register-with-auth.ts bike forest.aastar.eth\n')
    console.log('环境变量 (.env.local):')
    console.log('  PRIVATE_KEY, REGISTRATION_SECRET, L2_RECORDS_ADDRESS\n')
    process.exit(1)
  }

  // 加载配置
  const privateKey = process.env.PRIVATE_KEY as Hex
  const secret = process.env.REGISTRATION_SECRET
  const l2RecordsAddress = (process.env.L2_RECORDS_ADDRESS || process.env.VITE_L2_RECORDS_ADDRESS) as Hex
  const network = process.env.NETWORK || process.env.VITE_NETWORK || 'op-sepolia'
  const l2RpcUrl = process.env.L2_RPC_URL || process.env.VITE_L2_RPC_URL || 
    (network === 'op-mainnet' ? 'https://mainnet.optimism.io' : 'https://sepolia.optimism.io')

  if (!privateKey) {
    console.error('❌ 错误: 请在 .env.local 中设置 PRIVATE_KEY')
    process.exit(1)
  }
  if (!secret) {
    console.error('❌ 错误: 请在 .env.local 中设置 REGISTRATION_SECRET')
    process.exit(1)
  }
  if (!l2RecordsAddress) {
    console.error('❌ 错误: 请在 .env.local 中设置 L2_RECORDS_ADDRESS')
    process.exit(1)
  }

  const chain = network === 'op-mainnet' ? optimism : optimismSepolia
  const account = privateKeyToAccount(privateKey)
  const fullName = `${label}.${parentDomain}`

  console.log('\n🔐 CometENS - 签名认证注册')
  console.log('===========================\n')
  console.log(`父域名:    ${parentDomain}`)
  console.log(`标签:      ${label}`)
  console.log(`完整域名:  ${fullName}`)
  console.log(`注册地址:  ${account.address}`)
  console.log(`网络:      ${chain.name}`)
  console.log('')

  // 步骤1: 生成认证签名
  console.log('📝 步骤 1: 生成认证签名...')
  const timestamp = Math.floor(Date.now() / 1000)
  const authMessage = buildAuthMessage(secret, timestamp)
  const authSignature = await account.signMessage({ message: authMessage })
  console.log(`   时间戳: ${timestamp}`)
  console.log(`   消息:   ${authMessage.slice(0, 50)}...`)
  console.log(`   签名:   ${authSignature.slice(0, 30)}...\n`)

  // 步骤2: 调用服务端验证（如果服务端有 API）
  // 这里简化：直接本地验证后上链
  // 实际生产环境应该先调用服务端验证签名

  // 步骤3: 检查域名可用性
  console.log('📝 步骤 2: 检查域名可用性...')
  const publicClient = createPublicClient({ chain, transport: http(l2RpcUrl) })
  const parentNode = namehash(parentDomain)
  const lh = labelhash(label)
  const node = namehash(fullName)

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
    console.log('   ✅ 域名可用\n')
  } catch (e) {
    console.log('   ⚠️  无法检查可用性，继续执行...\n')
  }

  // 步骤4: 确认
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

  // 步骤5: 提交注册交易（带认证数据）
  console.log('\n📝 步骤 3: 提交注册交易...')
  
  const walletClient = createWalletClient({ account, chain, transport: http(l2RpcUrl) })

  try {
    // 构建包含认证数据的交易
    // 实际生产环境应该调用服务端的 API，服务端验证后再上链
    // 这里演示直接上链，实际应该在服务端验证

    console.log('   注意: 此脚本直接上链，实际应调用服务端 API 进行签名验证\n')

    const hash = await walletClient.writeContract({
      address: l2RecordsAddress,
      abi: L2_ABI,
      functionName: 'registerSubnode',
      args: [
        parentNode,
        lh,
        account.address,
        label,
        account.address,
      ],
    })

    console.log(`⏳ 交易已提交: ${hash}`)
    console.log('等待确认...\n')

    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    console.log(`✅ 已确认 (区块 ${receipt.blockNumber})`)
    console.log(`\n🎉 成功注册: ${fullName}`)
    console.log(`   所有者: ${account.address}`)
    
    // 输出认证信息（用于验证）
    console.log(`\n📋 认证信息:`)
    console.log(`   时间戳: ${timestamp}`)
    console.log(`   签名: ${authSignature}`)
    console.log(`   可用于服务端验证`)
    
  } catch (e: any) {
    console.error(`\n❌ 交易失败: ${e.message}`)
    process.exit(1)
  }
}

main().catch(console.error)
