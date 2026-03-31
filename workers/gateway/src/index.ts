/**
 * CometENS CCIP-Read Gateway — Cloudflare Worker
 *
 * Implements the EIP-3668 off-chain resolver gateway.
 * Receives calldata from the L1 OffchainResolver, reads records from
 * L2Records on OP Sepolia or OP Mainnet, signs the response, and returns it.
 *
 * Required secrets (set via `wrangler secret put <NAME> --env <testnet|production>`):
 *   OP_RPC_URL               — Optimism RPC endpoint (Sepolia or Mainnet)
 *   PRIVATE_KEY_SUPPLIER     — 0x-prefixed private key that signs CCIP responses
 *   WORKER_EOA_PRIVATE_KEY   — 0x-prefixed private key that submits L2 transactions
 *   REGISTRATION_SECRET      — Secret string for registration auth (password)
 *
 * Required vars (wrangler.toml [env.*].vars):
 *   NETWORK                  — "op-sepolia" | "op-mainnet"
 *   L2_RECORDS_ADDRESS       — deployed L2Records contract address
 *   ROOT_DOMAIN              — Root domain (e.g., "aastar.eth")
 *   ALLOWED_REGISTRANTS      — Comma-separated addresses allowed to register (optional)
 */

import {
  createPublicClient,
  http,
  decodeFunctionData,
  encodeFunctionResult,
  encodeAbiParameters,
  keccak256,
  encodePacked,
  recoverMessageAddress,
  type Hex,
} from 'viem'
import { optimismSepolia, optimism } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { namehash, labelhash } from 'viem/ens'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Env {
  OP_RPC_URL: string
  PRIVATE_KEY_SUPPLIER: string
  WORKER_EOA_PRIVATE_KEY?: string
  REGISTRATION_SECRET?: string
  L2_RECORDS_ADDRESS: string
  NETWORK: 'op-sepolia' | 'op-mainnet'
  ROOT_DOMAIN?: string
  ALLOWED_REGISTRANTS?: string
}

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const RESOLVE_ABI = [
  {
    type: 'function',
    name: 'addr',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'addr',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }, { name: 'coinType', type: 'uint256' }],
    outputs: [{ name: '', type: 'bytes' }],
  },
  {
    type: 'function',
    name: 'text',
    stateMutability: 'view',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'key', type: 'string' },
    ],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'contenthash',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bytes' }],
  },
] as const

const L2_RECORDS_ABI = [
  {
    type: 'function',
    name: 'addr',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'addr',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }, { name: 'coinType', type: 'uint256' }],
    outputs: [{ name: '', type: 'bytes' }],
  },
  {
    type: 'function',
    name: 'text',
    stateMutability: 'view',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'key', type: 'string' },
    ],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'contenthash',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bytes' }],
  },
  {
    type: 'function',
    name: 'registerSubnode',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'parentNode', type: 'bytes32' },
      { name: 'labelhash', type: 'bytes32' },
      { name: 'newOwner', type: 'address' },
      { name: 'label', type: 'string' },
      { name: 'addrBytes', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'subnodeOwner',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ name: '', type: 'address' }],
  },
] as const

// Per-function ABIs
const ADDR_SINGLE_ABI = [{
  type: 'function', name: 'addr', stateMutability: 'view',
  inputs: [{ name: 'node', type: 'bytes32' }],
  outputs: [{ name: '', type: 'address' }],
}] as const

const ADDR_MULTI_ABI = [{
  type: 'function', name: 'addr', stateMutability: 'view',
  inputs: [{ name: 'node', type: 'bytes32' }, { name: 'coinType', type: 'uint256' }],
  outputs: [{ name: '', type: 'bytes' }],
}] as const

const TEXT_ABI = [{
  type: 'function', name: 'text', stateMutability: 'view',
  inputs: [{ name: 'node', type: 'bytes32' }, { name: 'key', type: 'string' }],
  outputs: [{ name: '', type: 'string' }],
}] as const

const CONTENTHASH_ABI = [{
  type: 'function', name: 'contenthash', stateMutability: 'view',
  inputs: [{ name: 'node', type: 'bytes32' }],
  outputs: [{ name: '', type: 'bytes' }],
}] as const

// ─── Auth utilities ───────────────────────────────────────────────────────────

function buildAuthMessage(secret: string, timestamp: number): string {
  return `cometens:auth:${secret}:${timestamp}`
}

interface AuthPayload {
  address: Hex
  timestamp: number
  signature: Hex
}

async function verifySignatureAuth(
  payload: AuthPayload,
  secret: string,
  allowedList: string[]
): Promise<{ valid: boolean; error?: string }> {
  const { address, timestamp, signature } = payload
  const TIME_WINDOW = 300 // 5 minutes

  // 1. 检查时间戳
  const now = Math.floor(Date.now() / 1000)
  const drift = Math.abs(now - timestamp)
  if (drift > TIME_WINDOW) {
    return { valid: false, error: `Timestamp expired (drift: ${drift}s)` }
  }

  // 2. 构建消息
  const message = buildAuthMessage(secret, timestamp)

  // 3. 恢复签名地址
  let recovered: Hex
  try {
    recovered = await recoverMessageAddress({ message, signature })
  } catch (e) {
    return { valid: false, error: 'Invalid signature format' }
  }

  // 4. 验证地址匹配
  if (recovered.toLowerCase() !== address.toLowerCase()) {
    return { valid: false, error: 'Signature mismatch' }
  }

  // 5. 验证白名单
  if (allowedList.length > 0 && !allowedList.includes(address.toLowerCase())) {
    return { valid: false, error: 'Address not in allowed list' }
  }

  return { valid: true }
}

// ─── Core resolution logic ────────────────────────────────────────────────────

async function handleResolve(calldata: Hex, env: Env): Promise<Hex> {
  const chain = env.NETWORK === 'op-mainnet' ? optimism : optimismSepolia
  const client = createPublicClient({
    chain,
    transport: http(env.OP_RPC_URL),
  })
  const contractAddress = env.L2_RECORDS_ADDRESS as Hex

  const { functionName, args } = decodeFunctionData({ abi: RESOLVE_ABI, data: calldata })

  if (functionName === 'addr') {
    if (args.length === 2) {
      const [node, coinType] = args as [Hex, bigint]
      const value = await client.readContract({
        address: contractAddress, abi: ADDR_MULTI_ABI, functionName: 'addr', args: [node, coinType],
      })
      return encodeFunctionResult({ abi: ADDR_MULTI_ABI, functionName: 'addr', result: value as Hex })
    }
    const [node] = args as [Hex]
    const value = await client.readContract({
      address: contractAddress, abi: ADDR_SINGLE_ABI, functionName: 'addr', args: [node],
    })
    return encodeFunctionResult({ abi: ADDR_SINGLE_ABI, functionName: 'addr', result: value as `0x${string}` })
  }

  if (functionName === 'text') {
    const [node, key] = args as [Hex, string]
    const value = await client.readContract({
      address: contractAddress, abi: TEXT_ABI, functionName: 'text', args: [node, key],
    })
    return encodeFunctionResult({ abi: TEXT_ABI, functionName: 'text', result: value as string })
  }

  if (functionName === 'contenthash') {
    const [node] = args as [Hex]
    const value = await client.readContract({
      address: contractAddress, abi: CONTENTHASH_ABI, functionName: 'contenthash', args: [node],
    })
    return encodeFunctionResult({ abi: CONTENTHASH_ABI, functionName: 'contenthash', result: value as Hex })
  }

  throw new Error('Unsupported selector')
}

async function handleResolveSigned(
  calldata: Hex,
  resolverAddress: Hex,
  env: Env,
): Promise<{ data: Hex }> {
  const result = await handleResolve(calldata, env)
  const expires = BigInt(Math.floor(Date.now() / 1000) + 3600)

  const signer = privateKeyToAccount(env.PRIVATE_KEY_SUPPLIER as Hex)

  const messageHash = keccak256(
    encodePacked(
      ['bytes2', 'address', 'uint64', 'bytes32', 'bytes32'],
      ['0x1900', resolverAddress, expires, keccak256(calldata), keccak256(result)],
    ),
  )
  const sig = await signer.signMessage({ message: { raw: messageHash } })

  const data = encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'uint64' }, { type: 'bytes' }],
    [result, expires, sig],
  )

  return { data }
}

// ─── Registration logic ───────────────────────────────────────────────────────

interface RegisterPayload {
  label: string
  owner?: Hex
  auth: AuthPayload
}

async function handleRegister(
  payload: RegisterPayload,
  env: Env
): Promise<{ ok: boolean; txHash: Hex; name: string }> {
  // 1. 验证配置
  if (!env.REGISTRATION_SECRET) {
    throw new Error('Registration not configured')
  }
  if (!env.WORKER_EOA_PRIVATE_KEY) {
    throw new Error('Worker key not configured')
  }
  if (!env.ROOT_DOMAIN) {
    throw new Error('Root domain not configured')
  }

  const allowedList = (env.ALLOWED_REGISTRANTS || '')
    .split(',')
    .filter(Boolean)
    .map(a => a.toLowerCase())

  // 2. 验证签名
  const authResult = await verifySignatureAuth(payload.auth, env.REGISTRATION_SECRET, allowedList)
  if (!authResult.valid) {
    throw new Error(`Auth failed: ${authResult.error}`)
  }

  // 3. 验证 label
  const label = payload.label?.trim().toLowerCase()
  if (!label || !/^[a-z0-9-]{1,63}$/.test(label)) {
    throw new Error('Invalid label')
  }

  // 4. 确定所有者
  const owner = payload.owner || payload.auth.address

  // 5. 检查是否已注册
  const chain = env.NETWORK === 'op-mainnet' ? optimism : optimismSepolia
  const client = createPublicClient({ chain, transport: http(env.OP_RPC_URL) })
  const contractAddress = env.L2_RECORDS_ADDRESS as Hex
  
  const fullName = `${label}.${env.ROOT_DOMAIN}`
  const parentNode = namehash(env.ROOT_DOMAIN)
  const node = namehash(fullName)

  const existing = await client.readContract({
    address: contractAddress,
    abi: L2_RECORDS_ABI,
    functionName: 'subnodeOwner',
    args: [node],
  })

  if (existing !== '0x0000000000000000000000000000000000000000') {
    throw new Error(`Domain already registered to ${existing}`)
  }

  // 6. 提交交易
  const workerAccount = privateKeyToAccount(env.WORKER_EOA_PRIVATE_KEY as Hex)
  const walletClient = createPublicClient({
    chain,
    transport: http(env.OP_RPC_URL),
    account: workerAccount,
  }) as any // Type workaround for viem

  // Note: Worker doesn't actually have a wallet client method in CF Workers
  // This would need to be done via an external relayer or the L2Records would need
  // to accept meta-transactions (EIP-2771) or use a relayer pattern
  
  // For now, just simulate success - in production this needs a relayer
  throw new Error('Registration via worker requires meta-transaction support or external relayer')
}

// ─── Worker entry point ───────────────────────────────────────────────────────

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }

    // ─── CCIP-Read endpoint ───────────────────────────────────────────────────
    if (path === '/api/ccip') {
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      }

      try {
        const payload = (await request.json()) as {
          data?: Hex
          calldata?: Hex
          sender?: Hex
        }

        const calldata = payload.calldata ?? payload.data
        if (!calldata || !calldata.startsWith('0x')) {
          return new Response(JSON.stringify({ error: 'Missing calldata' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          })
        }

        const resolverAddress: Hex = payload.sender ?? '0x0000000000000000000000000000000000000000'
        const result = await handleResolveSigned(calldata, resolverAddress, env)

        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return new Response(JSON.stringify({ error: message }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      }
    }

    // ─── Registration endpoint ────────────────────────────────────────────────
    if (path === '/api/register') {
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      }

      try {
        const payload = (await request.json()) as RegisterPayload
        const result = await handleRegister(payload, env)

        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return new Response(JSON.stringify({ error: message }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      }
    }

    // ─── Health check ─────────────────────────────────────────────────────────
    if (path === '/health') {
      return new Response(JSON.stringify({ 
        status: 'ok',
        network: env.NETWORK,
        rootDomain: env.ROOT_DOMAIN || 'not configured',
        registrationEnabled: !!env.REGISTRATION_SECRET,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    // 404 for unknown paths
    return new Response(JSON.stringify({ error: 'Not Found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    })
  },
}
