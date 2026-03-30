/**
 * CometENS CCIP-Read Gateway — Cloudflare Worker
 *
 * Implements the EIP-3668 off-chain resolver gateway.
 * Receives calldata from the L1 OffchainResolver, reads records from
 * L2Records on OP Sepolia, signs the response, and returns it.
 *
 * Required secrets (set via `wrangler secret put <NAME>`):
 *   OP_SEPOLIA_RPC_URL       — Optimism Sepolia JSON-RPC endpoint
 *   PRIVATE_KEY_SUPPLIER     — 0x-prefixed private key that signs CCIP responses
 *
 * Required vars (wrangler.toml [vars]):
 *   L2_RECORDS_ADDRESS       — deployed L2Records contract address
 */

import {
  createPublicClient,
  http,
  decodeFunctionData,
  encodeFunctionResult,
  encodeAbiParameters,
  keccak256,
  encodePacked,
  type Hex,
} from 'viem'
import { optimismSepolia } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Env {
  OP_SEPOLIA_RPC_URL: string
  PRIVATE_KEY_SUPPLIER: string
  L2_RECORDS_ADDRESS: string
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
] as const

// ─── Core resolution logic ────────────────────────────────────────────────────

async function handleResolve(calldata: Hex, env: Env): Promise<Hex> {
  const client = createPublicClient({
    chain: optimismSepolia,
    transport: http(env.OP_SEPOLIA_RPC_URL),
  })
  const contractAddress = env.L2_RECORDS_ADDRESS as Hex

  const { functionName, args } = decodeFunctionData({ abi: RESOLVE_ABI, data: calldata })

  if (functionName === 'addr') {
    if (args.length === 2) {
      const [node, coinType] = args as [Hex, bigint]
      const value = await client.readContract({
        address: contractAddress,
        abi: L2_RECORDS_ABI,
        functionName: 'addr',
        args: [node, coinType],
      })
      return encodeFunctionResult({ abi: RESOLVE_ABI, functionName: 'addr', result: value as Hex })
    }
    const [node] = args as [Hex]
    const value = await client.readContract({
      address: contractAddress,
      abi: L2_RECORDS_ABI,
      functionName: 'addr',
      args: [node],
    })
    return encodeFunctionResult({ abi: RESOLVE_ABI, functionName: 'addr', result: value as Hex })
  }

  if (functionName === 'text') {
    const [node, key] = args as [Hex, string]
    const value = await client.readContract({
      address: contractAddress,
      abi: L2_RECORDS_ABI,
      functionName: 'text',
      args: [node, key],
    })
    return encodeFunctionResult({ abi: RESOLVE_ABI, functionName: 'text', result: value as string })
  }

  if (functionName === 'contenthash') {
    const [node] = args as [Hex]
    const value = await client.readContract({
      address: contractAddress,
      abi: L2_RECORDS_ABI,
      functionName: 'contenthash',
      args: [node],
    })
    return encodeFunctionResult({ abi: RESOLVE_ABI, functionName: 'contenthash', result: value as Hex })
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

  // EIP-3668: sign keccak256(0x1900 ++ resolver ++ expires ++ keccak256(calldata) ++ keccak256(result))
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

// ─── Worker entry point ───────────────────────────────────────────────────────

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }

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
  },
}
