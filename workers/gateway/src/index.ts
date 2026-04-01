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
 *
 * Required vars (wrangler.toml [env.*].vars):
 *   NETWORK                  — "op-sepolia" | "op-mainnet"
 *   L2_RECORDS_ADDRESS       — deployed L2Records contract address
 *   ROOT_DOMAIN              — Root domain (e.g., "aastar.eth") [informational only]
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
import { optimismSepolia, optimism } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { namehash, labelhash } from 'viem/ens'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Env {
  OP_RPC_URL: string
  PRIVATE_KEY_SUPPLIER: string
  L2_RECORDS_ADDRESS: string
  NETWORK: 'op-sepolia' | 'op-mainnet'
  ROOT_DOMAIN?: string
  /**
   * CF KV namespace for ENS record cache (Phase 2).
   * Keys:  addr60:{node}     → ETH address hex (20 bytes, "0x..." or absent)
   *        text:{node}:{key} → text record value string
   *        ch:{node}         → contenthash hex bytes
   * Shared with the API Worker (same namespace ID in wrangler.toml).
   */
  RECORD_CACHE?: KVNamespace
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

// ─── Core resolution logic ────────────────────────────────────────────────────

// ─── KV cache helpers ─────────────────────────────────────────────────────────

/** Read ETH addr from KV; returns null on miss or if KV not bound. */
async function kvGetAddr(kv: KVNamespace | undefined, node: Hex): Promise<`0x${string}` | null> {
  if (!kv) return null
  const val = await kv.get(`addr60:${node}`)
  if (!val || val === '0x0000000000000000000000000000000000000000') return null
  return val as `0x${string}`
}

/** Read text record from KV; returns null on miss. */
async function kvGetText(kv: KVNamespace | undefined, node: Hex, key: string): Promise<string | null> {
  if (!kv) return null
  return kv.get(`text:${node}:${key}`)
}

/** Read contenthash from KV; returns null on miss. */
async function kvGetContenthash(kv: KVNamespace | undefined, node: Hex): Promise<Hex | null> {
  if (!kv) return null
  const val = await kv.get(`ch:${node}`)
  if (!val || val === '0x') return null
  return val as Hex
}

// ─── Core resolution logic ────────────────────────────────────────────────────

async function handleResolve(calldata: Hex, env: Env): Promise<Hex> {
  const chain = env.NETWORK === 'op-mainnet' ? optimism : optimismSepolia
  const contractAddress = env.L2_RECORDS_ADDRESS as Hex
  const kv = env.RECORD_CACHE

  const { functionName, args } = decodeFunctionData({ abi: RESOLVE_ABI, data: calldata })

  if (functionName === 'addr') {
    if (args.length === 2) {
      // Multi-coin addr — bypass KV (less common; only cache ETH addr)
      const [node, coinType] = args as [Hex, bigint]
      const client = createPublicClient({ chain, transport: http(env.OP_RPC_URL) })
      const value = await client.readContract({
        address: contractAddress, abi: ADDR_MULTI_ABI, functionName: 'addr', args: [node, coinType],
      })
      return encodeFunctionResult({ abi: ADDR_MULTI_ABI, functionName: 'addr', result: value as Hex })
    }

    // ETH addr — KV first
    const [node] = args as [Hex]
    const cached = await kvGetAddr(kv, node)
    if (cached) {
      return encodeFunctionResult({ abi: ADDR_SINGLE_ABI, functionName: 'addr', result: cached })
    }
    const client = createPublicClient({ chain, transport: http(env.OP_RPC_URL) })
    const value = await client.readContract({
      address: contractAddress, abi: ADDR_SINGLE_ABI, functionName: 'addr', args: [node],
    })
    return encodeFunctionResult({ abi: ADDR_SINGLE_ABI, functionName: 'addr', result: value as `0x${string}` })
  }

  if (functionName === 'text') {
    const [node, key] = args as [Hex, string]
    const cached = await kvGetText(kv, node, key)
    if (cached !== null) {
      return encodeFunctionResult({ abi: TEXT_ABI, functionName: 'text', result: cached })
    }
    const client = createPublicClient({ chain, transport: http(env.OP_RPC_URL) })
    const value = await client.readContract({
      address: contractAddress, abi: TEXT_ABI, functionName: 'text', args: [node, key],
    })
    return encodeFunctionResult({ abi: TEXT_ABI, functionName: 'text', result: value as string })
  }

  if (functionName === 'contenthash') {
    const [node] = args as [Hex]
    const cached = await kvGetContenthash(kv, node)
    if (cached) {
      return encodeFunctionResult({ abi: CONTENTHASH_ABI, functionName: 'contenthash', result: cached })
    }
    const client = createPublicClient({ chain, transport: http(env.OP_RPC_URL) })
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
    // Handles both root '/' (EIP-3668 standard, used by ENS app) and '/api/ccip'
    if (path === '/' || path === '/api/ccip') {
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

      return new Response(JSON.stringify({ error: 'Registration is not implemented on the worker yet.' }), {
        status: 501,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    // ─── Health check ─────────────────────────────────────────────────────────
    if (path === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        network: env.NETWORK,
        rootDomain: env.ROOT_DOMAIN || 'not configured',
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
