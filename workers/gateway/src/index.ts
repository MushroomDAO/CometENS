/**
 * CometENS CCIP-Read Gateway — Cloudflare Worker
 *
 * Two operating modes:
 *
 * **Signature mode** (default, C2-era OffchainResolver)
 *   POST /  or  POST /api/ccip  with JSON body { sender, data }
 *   Reads records from L2Records on OP via viem, signs response with PRIVATE_KEY_SUPPLIER.
 *
 * **Proof mode** (C3/C4, OPResolver + OPFaultVerifier)
 *   GET  /{sender}/{data}  — EIP-3668 standard URL template format
 *   Uses @unruggable/gateways OPFaultRollup + Gateway to generate Bedrock storage proofs.
 *   Requires: PROOF_MODE=true, ETH_RPC_URL (L1 Sepolia/Mainnet), OP_RPC_URL (L2).
 *   No signing key needed — OPFaultVerifier on L1 verifies proofs trustlessly.
 *
 * Required secrets (wrangler secret put <NAME> --env <testnet|production>):
 *   OP_RPC_URL               — Optimism RPC endpoint (Sepolia or Mainnet)
 *   PRIVATE_KEY_SUPPLIER     — 0x-prefixed key that signs CCIP responses (signature mode)
 *   ETH_RPC_URL              — Ethereum L1 RPC (Sepolia or Mainnet) — proof mode only
 *
 * Required vars (wrangler.toml [env.*].vars):
 *   NETWORK                  — "op-sepolia" | "op-mainnet"
 *   L2_RECORDS_ADDRESS       — deployed L2Records contract address
 *   ROOT_DOMAIN              — Root domain (e.g., "aastar.eth") [informational only]
 *   PROOF_MODE               — "true" to enable Bedrock proof mode (GET /{sender}/{data})
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
import { L2RecordsV2ABI } from '../../../server/gateway/abi'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Env {
  OP_RPC_URL: string
  ETH_RPC_URL?: string        // L1 Sepolia/Mainnet — required for proof mode
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
  /**
   * Enable Bedrock storage proof mode.
   * When "true", GET /{sender}/{data} serves OPFaultRollup storage proofs.
   * Requires ETH_RPC_URL (L1 provider).
   */
  PROOF_MODE?: string
  /**
   * Optional comma-separated list of allowed sender (resolver) addresses for proof mode.
   * When set, requests from any other sender are rejected with 403.
   * In EIP-3668, sender = the L1 resolver contract address that emitted OffchainLookup.
   * Example: "0xABC...123,0xDEF...456"
   */
  ALLOWED_SENDERS?: string
  /** CF Analytics Engine dataset (optional — metrics emitted if bound). */
  ANALYTICS?: AnalyticsEngineDataset
}

// L2RecordsV2ABI imported from server/gateway/abi.ts — single source of truth

// ─── Proof mode (C4) ──────────────────────────────────────────────────────────

/**
 * Module-level lazy singleton for the proof Gateway.
 *
 * CF Workers reuse the same isolate (and module scope) across many requests.
 * Creating a new OPFaultRollup + Gateway per request would re-instantiate
 * ethers providers and discard the latestCache / commitCacheMap on every call.
 * The singleton is keyed on (eth_rpc, op_rpc, network) so if env vars differ
 * between deployments, a new instance is created automatically.
 */
let _gatewayKey = ''
let _gatewayInstance: import('@unruggable/gateways').Gateway<import('@unruggable/gateways').OPFaultRollup> | null = null

async function getGateway(env: Env): Promise<import('@unruggable/gateways').Gateway<import('@unruggable/gateways').OPFaultRollup>> {
  const key = `${env.ETH_RPC_URL}|${env.OP_RPC_URL}|${env.NETWORK}`
  if (_gatewayInstance && _gatewayKey === key) return _gatewayInstance

  const { JsonRpcProvider } = await import('ethers')
  const { OPFaultRollup, Gateway } = await import('@unruggable/gateways')

  const provider1 = new JsonRpcProvider(env.ETH_RPC_URL!)  // L1 (Sepolia / Mainnet)
  const provider2 = new JsonRpcProvider(env.OP_RPC_URL)     // L2 (OP Sepolia / Mainnet)

  const config =
    env.NETWORK === 'op-mainnet'
      ? OPFaultRollup.mainnetConfig
      : OPFaultRollup.sepoliaConfig

  _gatewayInstance = new Gateway(new OPFaultRollup({ provider1, provider2 }, config))
  _gatewayKey = key
  return _gatewayInstance
}

/**
 * Serve an EIP-3668 CCIP-Read proof request using @unruggable/gateways.
 *
 * Called when PROOF_MODE=true and the request matches GET /{sender}/{data}.
 * Uses OPFaultRollup to fetch a Bedrock storage proof from the OP node, then
 * encodes it as the witness expected by OPFaultVerifier on L1.
 *
 * Protocol "raw" means no additional CCIP signing layer — the OPFaultVerifier
 * contract itself verifies the proof against the L1 rootClaim trustlessly.
 *
 * Note: nonzero GatewayVM exitCode is treated as "record not found" and
 * returned to the client as empty data.  This matches ENS resolver conventions
 * where unregistered names return zero/empty rather than reverting.
 */
async function handleProofMode(
  calldata: Hex,
  sender: Hex,
  env: Env,
): Promise<Response> {
  if (!env.ETH_RPC_URL) {
    return new Response(
      JSON.stringify({ error: 'ETH_RPC_URL not configured — required for proof mode' }),
      { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
    )
  }

  const gateway = await getGateway(env)

  // "raw" protocol: return proof bytes directly — no CCIP signing wrapper.
  const { data } = await gateway.handleRead(sender, calldata, { protocol: 'raw' })

  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  })
}

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

// ─── Signature mode (C2-era) ──────────────────────────────────────────────────

async function handleResolve(calldata: Hex, env: Env): Promise<Hex> {
  const chain = env.NETWORK === 'op-mainnet' ? optimism : optimismSepolia
  const contractAddress = env.L2_RECORDS_ADDRESS as Hex
  const kv = env.RECORD_CACHE

  const { functionName, args } = decodeFunctionData({ abi: L2RecordsV2ABI, data: calldata })
  if (!args) throw new Error('Unsupported selector')

  if (functionName === 'addr') {
    if (args.length === 2) {
      // Multi-coin addr — bypass KV (less common; only cache ETH addr)
      const [node, coinType] = args as [Hex, bigint]
      const client = createPublicClient({ chain, transport: http(env.OP_RPC_URL) })
      const value = await client.readContract({
        address: contractAddress, abi: L2RecordsV2ABI, functionName: 'addr', args: [node, coinType],
      })
      return encodeFunctionResult({ abi: L2RecordsV2ABI, functionName: 'addr', result: value as Hex })
    }

    // ETH addr — KV first
    const [node] = args as [Hex]
    const cached = await kvGetAddr(kv, node)
    if (cached) {
      return encodeFunctionResult({ abi: L2RecordsV2ABI, functionName: 'addr', result: cached })
    }
    const client = createPublicClient({ chain, transport: http(env.OP_RPC_URL) })
    const value = await client.readContract({
      address: contractAddress, abi: L2RecordsV2ABI, functionName: 'addr', args: [node],
    })
    return encodeFunctionResult({ abi: L2RecordsV2ABI, functionName: 'addr', result: value as `0x${string}` })
  }

  if (functionName === 'text') {
    const [node, key] = args as [Hex, string]
    const cached = await kvGetText(kv, node, key)
    if (cached !== null) {
      return encodeFunctionResult({ abi: L2RecordsV2ABI, functionName: 'text', result: cached })
    }
    const client = createPublicClient({ chain, transport: http(env.OP_RPC_URL) })
    const value = await client.readContract({
      address: contractAddress, abi: L2RecordsV2ABI, functionName: 'text', args: [node, key],
    })
    return encodeFunctionResult({ abi: L2RecordsV2ABI, functionName: 'text', result: value as string })
  }

  if (functionName === 'contenthash') {
    const [node] = args as [Hex]
    const cached = await kvGetContenthash(kv, node)
    if (cached) {
      return encodeFunctionResult({ abi: L2RecordsV2ABI, functionName: 'contenthash', result: cached })
    }
    const client = createPublicClient({ chain, transport: http(env.OP_RPC_URL) })
    const value = await client.readContract({
      address: contractAddress, abi: L2RecordsV2ABI, functionName: 'contenthash', args: [node],
    })
    return encodeFunctionResult({ abi: L2RecordsV2ABI, functionName: 'contenthash', result: value as Hex })
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
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

// Matches EIP-3668 GET URL template: /{sender}/{data}
// sender: 0x + 40 hex chars (address)
// data:   0x + any hex (calldata)
const PROOF_PATH_RE = /^\/(0x[0-9a-fA-F]{40})\/(0x[0-9a-fA-F]+)(?:\.json)?$/

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }

    // ─── Proof mode: GET /{sender}/{data} (EIP-3668 URL template) ────────────
    // OPResolver emits OffchainLookup with gateway URLs containing {sender}/{data}
    // placeholders.  The CCIP-Read client substitutes them and does a GET request.
    if (request.method === 'GET' && env.PROOF_MODE === 'true') {
      const m = path.match(PROOF_PATH_RE)
      if (m) {
        const [, sender, calldata] = m
        // Validate sender against allowlist (if configured).
        // sender = L1 resolver address that emitted OffchainLookup.
        if (env.ALLOWED_SENDERS) {
          const allowed = env.ALLOWED_SENDERS.split(',').map((s) => s.trim().toLowerCase())
          if (!allowed.includes(sender.toLowerCase())) {
            return new Response(JSON.stringify({ error: 'Sender not allowed' }), {
              status: 403,
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
            })
          }
        }

        // Validate calldata format: must be valid hex, 4+ bytes (selector), ≤ 8KB.
        const dataHex = calldata.slice(2) // strip 0x
        if (dataHex.length % 2 !== 0) {
          return new Response(JSON.stringify({ error: 'Invalid calldata: odd-length hex' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          })
        }
        if (dataHex.length < 8) { // minimum 4 bytes = function selector
          return new Response(JSON.stringify({ error: 'Calldata too short' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          })
        }
        if (dataHex.length > 16384) { // 8KB max
          return new Response(JSON.stringify({ error: 'Calldata too large' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          })
        }
        try {
          return await handleProofMode(calldata as Hex, sender as Hex, env)
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          return new Response(JSON.stringify({ error: 'Proof generation failed' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          })
        }
      }
    }

    // ─── Signature mode: POST /  or  POST /api/ccip ───────────────────────────
    // Legacy C2-era OffchainResolver path.  Reads from L2 via viem and signs
    // the response with PRIVATE_KEY_SUPPLIER.
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

        if (!payload.sender || !payload.sender.startsWith('0x')) {
          return new Response(JSON.stringify({ error: 'Missing or invalid sender (resolver address)' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          })
        }
        const resolverAddress: Hex = payload.sender

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

    // ─── Health check ─────────────────────────────────────────────────────────
    if (path === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        network: env.NETWORK,
        rootDomain: env.ROOT_DOMAIN || 'not configured',
        proofMode: env.PROOF_MODE === 'true',
        timestamp: Math.floor(Date.now() / 1000),
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
