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
  encodeFunctionData,
  encodeFunctionResult,
  encodeAbiParameters,
  decodeAbiParameters,
  keccak256,
  encodePacked,
  type Hex,
} from 'viem'
import { optimismSepolia, optimism } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { L2RecordsV2ABI } from '../../../server/gateway/abi'

// ─── Types ────────────────────────────────────────────────────────────────────

/** Challenge period by network (seconds). Used to estimate when proofs become available. */
const CHALLENGE_PERIOD: Record<string, number> = {
  'op-mainnet': 302_400,   // 3.5 days (post-Granite)
  'op-sepolia': 302_400,   // same parameter on testnet
}

/** Approximate OP block time in seconds */
const OP_BLOCK_TIME = 2

/**
 * 503 guard staleness threshold (blocks).
 *
 * On OP Mainnet, dispute games are submitted continuously so the anchor
 * stays within a few hours of head — use strict 1800-block (1-hour) threshold.
 *
 * On OP Sepolia, there are very few dispute game participants so a new game
 * is only finalized once per challenge period (~151,200 blocks = 3.5 days).
 * The anchor is therefore always ~1 challenge period behind current head,
 * which is expected testnet behaviour — not a stale-state error.
 * Use a threshold that allows proof generation for historical records that
 * ARE covered by the anchor: 1.5× challenge-period blocks gives headroom.
 */
const ANCHOR_STALE_THRESHOLD: Record<string, bigint> = {
  'op-mainnet': 1_800n,           // ~1 hour
  'op-sepolia': 230_000n,         // ~1.5× challenge period — covers normal testnet lag
}

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
  // Gateway is read-only — no nonce tracking needed (no write endpoints)
  /**
   * Enable Bedrock storage proof mode.
   * When "true", GET /{sender}/{data} serves OPFaultRollup storage proofs.
   * Requires ETH_RPC_URL (L1 provider).
   */
  PROOF_MODE?: string
  /**
   * Enable the hybrid PROOF branch (finalized Bedrock proof for aged/unchanged records).
   * When unset, /hybrid serves signatures only. The proof/sign decision is pure-viem
   * (fast); proof generation (ethers + unruggable, verified ~1-4s in Node) only runs
   * for records whose value is unchanged across the finality-lag window.
   * Full proof-path E2E is pending records older than the finalized anchor (~7d).
   */
  HYBRID_PROOF_ENABLED?: string
  /**
   * Optional comma-separated list of allowed sender (resolver) addresses for proof mode.
   * When set, requests from any other sender are rejected with 403.
   * In EIP-3668, sender = the L1 resolver contract address that emitted OffchainLookup.
   * Example: "0xABC...123,0xDEF...456"
   */
  ALLOWED_SENDERS?: string
  /**
   * Minimum dispute-game age (seconds) the gateway proves against.
   * MUST match the on-chain OPFaultVerifier's MIN_AGE_SEC, otherwise the gateway
   * proves against a different game than the verifier accepts:
   *   - "0"  → gateway proves against the latest FINALIZED game (~3.5–7 days old);
   *            records newer than that game resolve as empty.
   *   - ">0" → gateway proves against the latest game aged ≥ this many seconds and
   *            unchallenged (even if not finalized) — lets fresh records resolve.
   * Defaults to 0 (finalized-only) when unset.
   */
  MIN_AGE_SEC?: string
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
  const key = `${env.ETH_RPC_URL}|${env.OP_RPC_URL}|${env.NETWORK}|${env.MIN_AGE_SEC ?? '0'}`
  if (_gatewayInstance && _gatewayKey === key) return _gatewayInstance

  const { JsonRpcProvider } = await import('ethers')
  const { OPFaultRollup, Gateway } = await import('@unruggable/gateways')

  const provider1 = new JsonRpcProvider(env.ETH_RPC_URL!)  // L1 (Sepolia / Mainnet)
  const provider2 = new JsonRpcProvider(env.OP_RPC_URL)     // L2 (OP Sepolia / Mainnet)

  const config =
    env.NETWORK === 'op-mainnet'
      ? OPFaultRollup.mainnetConfig
      : OPFaultRollup.sepoliaConfig

  const rollup = new OPFaultRollup({ provider1, provider2 }, config)
  // Align the gateway's game selection with the on-chain OPFaultVerifier's MIN_AGE_SEC.
  // Without this the rollup defaults to minAgeSec=0 (finalized games only) and fresh
  // records resolve as empty even though the verifier would accept a newer aged game.
  const minAgeSec = Number(env.MIN_AGE_SEC ?? '0')
  if (env.MIN_AGE_SEC !== undefined && (!Number.isFinite(minAgeSec) || minAgeSec < 0)) {
    // Don't silently swallow a misconfiguration — falling back to finalized-only (0)
    // would mismatch a verifier expecting >0 and make fresh records resolve empty.
    console.warn(`[gateway] invalid MIN_AGE_SEC="${env.MIN_AGE_SEC}" — falling back to finalized-only (0)`)
  }
  if (Number.isFinite(minAgeSec) && minAgeSec > 0) rollup.minAgeSec = minAgeSec

  _gatewayInstance = new Gateway(rollup)
  _gatewayKey = key
  return _gatewayInstance
}

/**
 * Query the rollup's latest finalized commit (anchor state).
 * Returns the L2 block number that proofs are generated against.
 */
async function getAnchorL2Block(env: Env): Promise<{ l2Block: bigint; index: bigint } | null> {
  try {
    const gateway = await getGateway(env)
    const commit = await gateway.rollup.fetchLatestCommit()
    // OPFaultCommit has game.l2BlockNumber — the L2 block covered by the finalized dispute game
    const l2Block = (commit as any).game?.l2BlockNumber as bigint | undefined
    if (l2Block === undefined) return null
    return { l2Block, index: commit.index }
  } catch {
    return null
  }
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

  // Pre-check: is the anchor state recent enough to cover L2 data?
  // If the latest finalized L2 block is far behind the current L2 head,
  // proofs will verify against stale state where records may not exist yet.
  const anchor = await getAnchorL2Block(env)
  if (anchor) {
    // Query current L2 block to calculate staleness
    try {
      const { JsonRpcProvider } = await import('ethers')
      const l2Provider = new JsonRpcProvider(env.OP_RPC_URL)
      const currentL2Block = BigInt(await l2Provider.getBlockNumber())
      const blocksBehind = currentL2Block - anchor.l2Block

      // If anchor is too far behind, proofs for recent state changes will fail.
      // Threshold is network-dependent: mainnet uses 1800 blocks (~1 hour);
      // OP Sepolia uses 230,000 blocks (~1.5× challenge period) because
      // the testnet only produces one dispute game per challenge period,
      // so the anchor is always ~151,200 blocks behind current head by design.
      const staleThreshold = ANCHOR_STALE_THRESHOLD[env.NETWORK] ?? 1_800n
      if (blocksBehind > staleThreshold) {
        const challengePeriod = CHALLENGE_PERIOD[env.NETWORK] ?? 302_400
        const estimatedCatchUpSec = Number(blocksBehind) * OP_BLOCK_TIME
        const retryAfter = Math.min(estimatedCatchUpSec, challengePeriod)

        return new Response(JSON.stringify({
          error: 'Proof not yet available — anchor state is behind',
          anchorL2Block: anchor.l2Block.toString(),
          currentL2Block: currentL2Block.toString(),
          blocksBehind: blocksBehind.toString(),
          estimatedRetrySeconds: retryAfter,
          detail: `The L1 anchor covers L2 block ${anchor.l2Block}. Current L2 head is ${currentL2Block}. Records written after block ${anchor.l2Block} cannot be proven yet.`,
        }), {
          status: 503,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(retryAfter),
            ...corsHeaders,
          },
        })
      }
    } catch {
      // L2 RPC unreachable — proceed with proof generation (let it fail naturally if stale)
    }
  }

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

// ─── Hybrid mode (auto: signature for fresh / finalized proof for aged) ─────────

/** Read the raw record value on-chain (no KV) at an optional block. */
async function readRecordRaw(
  env: Env,
  functionName: string,
  args: readonly unknown[],
  blockNumber?: bigint,
): Promise<unknown> {
  const chain = env.NETWORK === 'op-mainnet' ? optimism : optimismSepolia
  const client = createPublicClient({ chain, transport: http(env.OP_RPC_URL) })
  const base = { address: env.L2_RECORDS_ADDRESS as Hex, abi: L2RecordsV2ABI } as const
  const opts = blockNumber !== undefined ? { blockNumber } : {}
  return client.readContract({ ...base, functionName: functionName as any, args: args as any, ...opts })
}

function isEmptyRaw(functionName: string, v: unknown): boolean {
  if (functionName === 'addr') {
    if (typeof v === 'string') return v.toLowerCase() === '0x0000000000000000000000000000000000000000' || v === '0x'
  }
  if (functionName === 'text') return v === ''
  return v === '0x' || v === undefined || v === null
}

function rawEqual(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase()
  return a === b
}

/** Hot-path budget for the proof/sign decision; exceeding it falls back to signature. */
const PROOF_DECISION_BUDGET_MS = 8000

/**
 * Conservative finalized-state lag (L2 blocks) used for the proof/sign DECISION.
 * We compare the record at `currentBlock - lag` vs latest using pure viem (no
 * ethers/unruggable game-finding, which hangs in CF Workers). The lag must be
 * ≥ the real finalized-anchor lag so that "unchanged over the lag window" implies
 * "unchanged through the real anchor" (conservative — the on-chain proof, generated
 * against the real anchor, then proves the correct current value).
 */
const FINALITY_LAG_BLOCKS: Record<string, bigint> = {
  'op-mainnet': 350_000n,  // ~8 days @ 2s — covers the ~7d finalization window + margin
  'op-sepolia': 400_000n,  // testnet finalizes slowly; anchor observed ~302k behind
}

/** True iff the record's value `lag` blocks ago equals its current value (aged & unchanged). Pure viem. */
async function _decideUseProof(
  env: Env,
  functionName: string,
  args: readonly unknown[],
): Promise<boolean> {
  try {
    const latest = await readRecordRaw(env, functionName, args)
    if (isEmptyRaw(functionName, latest)) return false
    const chain = env.NETWORK === 'op-mainnet' ? optimism : optimismSepolia
    const client = createPublicClient({ chain, transport: http(env.OP_RPC_URL) })
    const current = await client.getBlockNumber()
    const lag = FINALITY_LAG_BLOCKS[env.NETWORK] ?? 400_000n
    if (current <= lag) return false
    const finalized = await readRecordRaw(env, functionName, args, current - lag)
    return rawEqual(finalized, latest)
  } catch {
    return false // any failure (e.g. record didn't exist that far back) → signature
  }
}

/**
 * Hybrid: decide per record whether to serve a finalized proof (trustless) or a
 * signature (instant). Proof is used ONLY when the finalized L2 state equals the
 * current value (record is aged & unchanged); otherwise (fresh / recently changed)
 * we sign the current value. Never serves an optimistic (un-finalized) proof.
 *
 * Request blob (from HybridResolver.resolve): abi.encode(bytes context, GatewayRequest req, bytes data)
 * Response: abi.encode(uint8 mode, bytes payload)  — mode 0 = signature, 1 = proof
 */
async function handleHybrid(requestHex: Hex, sender: Hex, env: Env): Promise<Response> {
  // HybridResolver.resolve sends abi.encode(bytes context, GatewayRequest req, bytes data).
  // GatewayRequest is the struct { bytes ops }.
  const [context, reqStruct, recordData] = decodeAbiParameters(
    [
      { type: 'bytes' },
      { type: 'tuple', components: [{ name: 'ops', type: 'bytes' }] },
      { type: 'bytes' },
    ],
    requestHex,
  ) as [Hex, { ops: Hex }, Hex]

  const { functionName, args } = decodeFunctionData({ abi: L2RecordsV2ABI, data: recordData })
  if (!args) throw new Error('Unsupported selector')

  // Proof branch gated by HYBRID_PROOF_ENABLED. Decision is pure-viem (fast) and
  // bounded by PROOF_DECISION_BUDGET_MS; any failure / timeout → signature
  // (instant, always correct). Proof is used ONLY for aged & unchanged records.
  let useProof = false
  if (env.ETH_RPC_URL && env.HYBRID_PROOF_ENABLED === 'true') {
    useProof = await Promise.race<boolean>([
      _decideUseProof(env, functionName, args),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), PROOF_DECISION_BUDGET_MS)),
    ]).catch(() => false)
  }

  let mode: number
  let payload: Hex
  if (useProof) {
    // Reconstruct the unruggable proveRequest(context, req) calldata the proof
    // gateway expects (same as OPResolver's OffchainLookup request).
    const proveCalldata = encodeFunctionData({
      abi: [{
        type: 'function', name: 'proveRequest', stateMutability: 'pure',
        inputs: [
          { name: 'context', type: 'bytes' },
          { name: 'req', type: 'tuple', components: [{ name: 'ops', type: 'bytes' }] },
        ],
        outputs: [{ type: 'bytes' }],
      }] as const,
      functionName: 'proveRequest',
      args: [context, reqStruct],
    })
    const gateway = await getGateway(env)
    const { data } = await gateway.handleRead(sender, proveCalldata, { protocol: 'raw' })
    mode = 1
    payload = data as Hex
  } else {
    const signed = await handleResolveSigned(recordData, sender, env)
    mode = 0
    payload = signed.data
  }

  const out = encodeAbiParameters([{ type: 'uint8' }, { type: 'bytes' }], [mode, payload])
  return new Response(JSON.stringify({ data: out }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  })
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

    // ─── Hybrid mode: POST /hybrid ────────────────────────────────────────────
    // HybridResolver emits OffchainLookup with a non-templated URL → CCIP client
    // POSTs { sender, data }. data = abi.encode(proveCalldata, recordData).
    // We reply { data: abi.encode(uint8 mode, bytes payload) }.
    if (path === '/hybrid') {
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
          status: 405, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      }
      try {
        const payload = (await request.json()) as { sender?: Hex; data?: Hex }
        if (!payload.data || !payload.data.startsWith('0x')) {
          return new Response(JSON.stringify({ error: 'Missing data' }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
          })
        }
        if (!payload.sender || !payload.sender.startsWith('0x')) {
          return new Response(JSON.stringify({ error: 'Missing or invalid sender' }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
          })
        }
        if (env.ALLOWED_SENDERS) {
          const allowed = env.ALLOWED_SENDERS.split(',').map((s) => s.trim().toLowerCase())
          if (!allowed.includes(payload.sender.toLowerCase())) {
            return new Response(JSON.stringify({ error: 'Sender not allowed' }), {
              status: 403, headers: { 'Content-Type': 'application/json', ...corsHeaders },
            })
          }
        }
        return await handleHybrid(payload.data, payload.sender, env)
      } catch {
        return new Response(JSON.stringify({ error: 'Hybrid resolution failed' }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
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

    // ─── Proof status: GET /proof-status ─────────────────────────────────────
    // Returns the current anchor L2 block and estimated proof availability.
    // Frontend uses this to show "ENS App will resolve in ~X hours" countdown.
    if (path === '/proof-status' && request.method === 'GET') {
      if (env.PROOF_MODE !== 'true' || !env.ETH_RPC_URL) {
        return new Response(JSON.stringify({
          proofMode: false,
          detail: 'Proof mode is not enabled on this gateway',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      }

      try {
        const anchor = await getAnchorL2Block(env)
        const { JsonRpcProvider } = await import('ethers')
        const l2Provider = new JsonRpcProvider(env.OP_RPC_URL)
        const currentL2Block = BigInt(await l2Provider.getBlockNumber())
        const challengePeriod = CHALLENGE_PERIOD[env.NETWORK] ?? 302_400

        if (!anchor) {
          return new Response(JSON.stringify({
            proofMode: true,
            error: 'Could not fetch anchor state',
            currentL2Block: currentL2Block.toString(),
            challengePeriodSeconds: challengePeriod,
          }), {
            status: 503,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          })
        }

        const blocksBehind = currentL2Block - anchor.l2Block
        const estimatedDelaySec = Number(blocksBehind) * OP_BLOCK_TIME

        return new Response(JSON.stringify({
          proofMode: true,
          network: env.NETWORK,
          anchorL2Block: anchor.l2Block.toString(),
          currentL2Block: currentL2Block.toString(),
          blocksBehind: blocksBehind.toString(),
          challengePeriodSeconds: challengePeriod,
          estimatedProofDelaySec: Math.max(0, estimatedDelaySec),
          // For a record just written at currentL2Block, this is when it becomes provable:
          // challengePeriod covers the dispute window for the next game that includes currentL2Block.
          estimatedNewRecordDelaySec: challengePeriod,
          timestamp: Math.floor(Date.now() / 1000),
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      } catch (e) {
        return new Response(JSON.stringify({
          proofMode: true,
          error: 'Failed to query proof status',
        }), {
          status: 500,
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
