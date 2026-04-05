/**
 * CometENS API Worker — Production API Server
 *
 * Handles all write operations (register, set-addr, set-text, set-contenthash,
 * add-registrar, remove-registrar) and public read helpers (check-label, lookup).
 *
 * Auth model:
 *   - Public endpoints: no signature required
 *   - Name Owner endpoints: EIP-712 signed by the subdomain owner (verified on-chain)
 *   - Contract Owner endpoints: EIP-712 signed, recovered == L2Records.owner()
 *   - Upstream App endpoints: personal_sign, recovered ∈ UPSTREAM_ALLOWED_SIGNERS
 *
 * CF KV (REGISTRY binding) is used for the address → label registry.
 * Gateway Worker reads KV for edge-cached resolution (Phase 2).
 */

import {
  createPublicClient,
  http,
  verifyTypedData,
  recoverMessageAddress,
  isAddress,
  isHex,
  namehash,
  labelhash,
  toHex,
  toBytes,
  type Hex,
  type Address,
} from 'viem'
import { optimismSepolia, optimism } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { L2RecordsWriterV2 } from '../../../server/gateway/writer/L2RecordsWriterV2'
import { L2RecordsV2ABI } from '../../../server/gateway/abi'
import {
  buildDomain,
  RegisterTypes,
  SetAddrTypes,
  SetTextTypes,
  SetContenthashTypes,
  AddRegistrarTypes,
  RemoveRegistrarTypes,
  TransferSubnodeTypes,
} from '../../../server/gateway/manage/schemas'
import { handleV1Register } from '../../../server/gateway/v1/register'

// ─── CF Worker Env ────────────────────────────────────────────────────────────

/**
 * TTL for KV record cache entries (seconds).
 * Records expire and get refreshed from L2 on the next gateway read.
 * 300s = 5 minutes — balances edge performance with data freshness.
 * CF KV minimum expirationTtl is 60s.
 */
const RECORD_CACHE_TTL = 300

/** Challenge period by network (seconds). */
const CHALLENGE_PERIOD: Record<string, number> = {
  'op-mainnet': 302_400,   // 3.5 days (post-Granite)
  'op-sepolia': 302_400,   // same parameter on testnet
}

export interface Env {
  /** 'op-sepolia' | 'op-mainnet' */
  NETWORK: string
  /** L2RecordsV2 contract address */
  L2_RECORDS_ADDRESS: string
  /** Primary root domain, e.g. 'forest.aastar.eth' */
  ROOT_DOMAIN: string
  /** Comma-separated list of all supported root domains, e.g. 'forest.aastar.eth,game.aastar.eth' */
  ROOT_DOMAINS?: string
  /** Optimism RPC URL */
  OP_RPC_URL: string
  /** EOA private key that submits L2 transactions (wrangler secret) */
  WORKER_EOA_PRIVATE_KEY?: string
  /** Comma-separated addresses allowed to call /v1/register */
  UPSTREAM_ALLOWED_SIGNERS?: string
  /** Gateway Worker URL (used by /resolve-status to query proof status) */
  GATEWAY_URL?: string
  /** CF KV namespace for address→label registry */
  REGISTRY?: KVNamespace
  /**
   * CF KV namespace for ENS record cache (Phase 2).
   * Keys:  addr60:{node}     → ETH address hex
   *        text:{node}:{key} → text record value
   *        ch:{node}         → contenthash hex bytes
   * Must bind to the same KV namespace ID as the Gateway Worker's RECORD_CACHE.
   */
  RECORD_CACHE?: KVNamespace
  /** CF Analytics Engine dataset (optional — metrics emitted if bound). */
  ANALYTICS?: AnalyticsEngineDataset
}

// L2RecordsV2ABI imported from server/gateway/abi.ts — single source of truth

// ─── Analytics helper ─────────────────────────────────────────────────────────

function trackEvent(analytics: AnalyticsEngineDataset | undefined, event: string, status: number, labels: string[] = []): void {
  if (!analytics) return
  analytics.writeDataPoint({
    blobs: [event, String(status), ...labels],
    doubles: [Date.now()],
    indexes: [event],
  })
}

// ─── Main fetch handler ───────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }

    try {
      let response: Response

      // ── Health check ──────────────────────────────────────────────────────
      if (path === '/health' && request.method === 'GET') {
        response = json({
          status: 'ok',
          network: env.NETWORK,
          rootDomain: env.ROOT_DOMAIN,
          rootDomains: getRootDomains(env),
          version: 'v0.6.1',
          timestamp: Math.floor(Date.now() / 1000),
        })
        trackEvent(env.ANALYTICS, path, response.status)
        return response
      }

      // ── Public GET endpoints ──────────────────────────────────────────────
      if (request.method === 'GET') {
        if (path === '/check-label')    { response = await handleCheckLabel(url, env); trackEvent(env.ANALYTICS, path, response.status); return response }
        if (path === '/check-owner')    { response = await handleCheckOwner(url, env); trackEvent(env.ANALYTICS, path, response.status); return response }
        if (path === '/lookup')         { response = await handleLookup(url, env); trackEvent(env.ANALYTICS, path, response.status); return response }
        if (path === '/resolve-status') { response = await handleResolveStatus(url, env); trackEvent(env.ANALYTICS, path, response.status); return response }
        if (path === '/root-domains')   { response = json({ domains: getRootDomains(env) }); trackEvent(env.ANALYTICS, path, response.status); return response }
      }

      // ── POST endpoints ────────────────────────────────────────────────────
      if (request.method === 'POST') {
        if (path === '/v1/register')     { response = await handleV1RegisterEndpoint(request, env); trackEvent(env.ANALYTICS, path, response.status); return response }
        if (path === '/register')        { response = await handleManage(request, env, path); trackEvent(env.ANALYTICS, path, response.status); return response }
        if (path === '/set-addr')        { response = await handleManage(request, env, path); trackEvent(env.ANALYTICS, path, response.status); return response }
        if (path === '/set-text')        { response = await handleManage(request, env, path); trackEvent(env.ANALYTICS, path, response.status); return response }
        if (path === '/set-contenthash') { response = await handleManage(request, env, path); trackEvent(env.ANALYTICS, path, response.status); return response }
        if (path === '/add-registrar')   { response = await handleManage(request, env, path); trackEvent(env.ANALYTICS, path, response.status); return response }
        if (path === '/remove-registrar'){ response = await handleManage(request, env, path); trackEvent(env.ANALYTICS, path, response.status); return response }
        if (path === '/transfer-subnode'){ response = await handleManage(request, env, path); trackEvent(env.ANALYTICS, path, response.status); return response }
      }

      trackEvent(env.ANALYTICS, path, 404)
      return jsonError('Not Found', 404)
    } catch (e: any) {
      const status = e?.status ?? 500
      trackEvent(env.ANALYTICS, path, status)
      if (status === 429) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'Retry-After': '60', ...corsHeaders() },
        })
      }
      return jsonError(e?.message ?? String(e), status)
    }
  },
}

// ─── GET /check-label?label=alice&parent=aastar.eth ──────────────────────────

async function handleCheckLabel(url: URL, env: Env): Promise<Response> {
  const label = url.searchParams.get('label')?.trim().toLowerCase()
  const parent = url.searchParams.get('parent')?.trim()
  if (!label || !parent) return jsonError('Missing label or parent param', 400)

  const node = namehash(`${label}.${parent}`) as Hex
  const pub = makePublicClient(env)
  const l2Addr = env.L2_RECORDS_ADDRESS as Address

  const owner = await pub.readContract({
    address: l2Addr, abi: L2RecordsV2ABI, functionName: 'subnodeOwner', args: [node],
  })
  const taken = owner !== '0x0000000000000000000000000000000000000000'
  return json({ available: !taken, owner: taken ? owner : null })
}

// ─── GET /check-owner?contract=0x... ─────────────────────────────────────────

async function handleCheckOwner(url: URL, env: Env): Promise<Response> {
  const contract = url.searchParams.get('contract')?.trim() as Address | undefined
  if (!contract || !isAddress(contract)) return jsonError('Missing or invalid contract param', 400)

  const pub = makePublicClient(env)
  const owner = await pub.readContract({ address: contract, abi: L2RecordsV2ABI, functionName: 'owner' })
  return json({ owner })
}

// ─── GET /lookup?address=0x... ───────────────────────────────────────────────
// Returns all registered names for a given address across all root domains.
// KV stores: reg:{address} → JSON array of full names (e.g. ["alice.forest.aastar.eth","alice.game.aastar.eth"])
// Legacy entries (single string) are auto-migrated on read.

async function handleLookup(url: URL, env: Env): Promise<Response> {
  const address = url.searchParams.get('address')?.toLowerCase()
  if (!address || !isAddress(address)) return jsonError('Missing or invalid address param', 400)

  const kvKey = `reg:${address}`
  const stored = env.REGISTRY ? await env.REGISTRY.get(kvKey) : null

  if (!stored) return json({ found: false, names: [] })

  // Parse stored value: JSON array (new format) or plain string (legacy format)
  let names: string[]
  try {
    const parsed = JSON.parse(stored)
    names = Array.isArray(parsed) ? parsed : [stored]
  } catch {
    // Legacy: plain string — either "alice.forest.aastar.eth" or just "alice"
    const fullName = stored.includes('.') ? stored : `${stored}.${env.ROOT_DOMAIN}`
    names = [fullName]
  }

  // Verify each name on-chain; remove stale entries
  const pub = makePublicClient(env)
  const l2Addr = env.L2_RECORDS_ADDRESS as Address
  const verified: string[] = []

  for (const name of names) {
    try {
      const node = namehash(name) as Hex
      const owner = await pub.readContract({
        address: l2Addr, abi: L2RecordsV2ABI, functionName: 'subnodeOwner', args: [node],
      })
      if ((owner as string) !== '0x0000000000000000000000000000000000000000') {
        verified.push(name)
      }
    } catch {
      // Chain unreachable — keep cached entry
      verified.push(name)
    }
  }

  // Update KV if stale entries were removed
  if (verified.length !== names.length && env.REGISTRY) {
    if (verified.length === 0) {
      await env.REGISTRY.delete(kvKey)
    } else {
      await env.REGISTRY.put(kvKey, JSON.stringify(verified))
    }
  }

  if (verified.length === 0) return json({ found: false, names: [] })

  // Backward compatible: `name` = first entry, `names` = all entries
  return json({ found: true, name: verified[0], names: verified })
}

// ─── GET /resolve-status?name=alice.forest.aastar.eth ────────────────────
// Returns whether the name is currently resolvable via ENS App (L1 proof mode)
// and an estimated countdown if not.

async function handleResolveStatus(url: URL, env: Env): Promise<Response> {
  const name = url.searchParams.get('name')?.trim()
  if (!name) return jsonError('Missing name param', 400)

  const challengePeriod = CHALLENGE_PERIOD[env.NETWORK] ?? 302_400

  // 1. Check if the name exists on L2
  const pub = makePublicClient(env)
  const l2Addr = env.L2_RECORDS_ADDRESS as Address
  const node = namehash(name) as Hex

  let l2Registered = false
  try {
    const owner = await pub.readContract({
      address: l2Addr, abi: L2RecordsV2ABI, functionName: 'subnodeOwner', args: [node],
    })
    l2Registered = (owner as string) !== '0x0000000000000000000000000000000000000000'
  } catch {
    return jsonError('L2 RPC unreachable', 503)
  }

  if (!l2Registered) {
    return json({ name, registered: false, l1Resolvable: false })
  }

  // 2. Query gateway /proof-status for anchor state
  const gatewayUrl = env.GATEWAY_URL
  if (!gatewayUrl) {
    // No gateway configured — return basic info with default estimate
    const nowSec = Math.floor(Date.now() / 1000)
    return json({
      name,
      registered: true,
      l1Resolvable: 'unknown',
      challengePeriodSeconds: challengePeriod,
      estimatedResolvableAt: nowSec + challengePeriod,
      detail: 'GATEWAY_URL not configured — cannot query anchor state',
    })
  }

  try {
    const proofRes = await fetch(`${gatewayUrl.replace(/\/$/, '')}/proof-status`)
    if (!proofRes.ok) {
      const nowSec = Math.floor(Date.now() / 1000)
      return json({
        name,
        registered: true,
        l1Resolvable: false,
        challengePeriodSeconds: challengePeriod,
        estimatedResolvableAt: nowSec + challengePeriod,
        detail: 'Gateway proof status unavailable',
      })
    }

    const proof = await proofRes.json() as {
      anchorL2Block?: string
      currentL2Block?: string
      blocksBehind?: string
      challengePeriodSeconds?: number
      proofMode?: boolean
    }

    if (!proof.proofMode) {
      // Signature mode — always resolvable (no proof delay)
      return json({ name, registered: true, l1Resolvable: true, mode: 'signature' })
    }

    const anchorBlock = BigInt(proof.anchorL2Block ?? '0')
    const currentBlock = BigInt(proof.currentL2Block ?? '0')
    const blocksBehind = currentBlock - anchorBlock

    // If anchor is reasonably current (within ~1 hour / 1800 blocks), proofs work
    const nowSec = Math.floor(Date.now() / 1000)
    if (blocksBehind <= 1800n) {
      return json({
        name,
        registered: true,
        l1Resolvable: true,
        mode: 'proof',
        anchorL2Block: anchorBlock.toString(),
      })
    }

    // Anchor is stale — estimate when it will catch up
    // For new records: challengePeriod from now (next game needs to include current block)
    // For stale anchor: could be dispute game infrastructure issues
    const estimatedDelaySec = Math.min(Number(blocksBehind) * 2, challengePeriod)

    return json({
      name,
      registered: true,
      l1Resolvable: false,
      mode: 'proof',
      anchorL2Block: anchorBlock.toString(),
      currentL2Block: currentBlock.toString(),
      blocksBehind: blocksBehind.toString(),
      challengePeriodSeconds: challengePeriod,
      estimatedResolvableAt: nowSec + estimatedDelaySec,
      estimatedDelaySeconds: estimatedDelaySec,
      detail: `Anchor covers L2 block ${anchorBlock}; current head is ${currentBlock}. Records written after block ${anchorBlock} are not yet provable on L1.`,
    })
  } catch {
    const nowSec = Math.floor(Date.now() / 1000)
    return json({
      name,
      registered: true,
      l1Resolvable: 'unknown',
      challengePeriodSeconds: challengePeriod,
      estimatedResolvableAt: nowSec + challengePeriod,
      detail: 'Could not reach gateway for proof status',
    })
  }
}

/**
 * Build resolve time estimate for write operation responses.
 * Returns partial JSON to merge into the response body.
 */
async function buildResolveEstimate(env: Env): Promise<Record<string, unknown>> {
  const challengePeriod = CHALLENGE_PERIOD[env.NETWORK] ?? 302_400
  const nowSec = Math.floor(Date.now() / 1000)

  // Default: challengePeriod from now
  const base = {
    challengePeriodSeconds: challengePeriod,
    estimatedL1ResolvableAt: nowSec + challengePeriod,
  }

  const gatewayUrl = env.GATEWAY_URL
  if (!gatewayUrl) return base

  try {
    const res = await fetch(`${gatewayUrl.replace(/\/$/, '')}/proof-status`)
    if (!res.ok) return base
    const proof = await res.json() as { proofMode?: boolean; anchorL2Block?: string; currentL2Block?: string }
    if (!proof.proofMode) return { estimatedL1ResolvableAt: nowSec, l1Mode: 'signature' }

    const blocksBehind = BigInt(proof.currentL2Block ?? '0') - BigInt(proof.anchorL2Block ?? '0')
    const delaySec = blocksBehind > 1800n
      ? Math.min(Number(blocksBehind) * 2, challengePeriod)
      : challengePeriod

    return {
      challengePeriodSeconds: challengePeriod,
      estimatedL1ResolvableAt: nowSec + delaySec,
      anchorL2Block: proof.anchorL2Block,
    }
  } catch {
    return base
  }
}

// ─── POST /v1/register — Upstream App (personal_sign) ────────────────────────

async function handleV1RegisterEndpoint(request: Request, env: Env): Promise<Response> {
  const allowedRaw = env.UPSTREAM_ALLOWED_SIGNERS ?? ''
  if (!allowedRaw) return jsonError('UPSTREAM_ALLOWED_SIGNERS not configured on server', 503)
  if (!env.ROOT_DOMAIN) return jsonError('ROOT_DOMAIN not configured on server', 503)

  const payload = await parseJson(request)
  const allowedSigners = allowedRaw.split(',').map((a: string) => a.trim())

  // Recover the signer early so we can rate-limit before doing any writes.
  // handleV1Register() will re-verify and check the allowedSigners list.
  if (payload.signature && payload.label && payload.owner && payload.timestamp) {
    const message = `CometENS:register:${String(payload.label).trim().toLowerCase()}:${payload.owner}:${payload.timestamp}`
    const signerAddress = await recoverMessageAddress({ message, signature: payload.signature as Hex })
      // await checkRateLimit(env.RECORD_CACHE, `rl:v1:${signerAddress.toLowerCase()}`, 60, 60)  // D7: disabled — auth chain provides sufficient protection
  }

  const writer = buildWriter(env)

  const result = await handleV1Register(payload, allowedSigners, env.ROOT_DOMAIN, writer)

  // Persist full qualified name to KV registry on success
  if (result.ok && result.name && env.REGISTRY) {
    const ownerAddr = (payload.owner as string ?? '').toLowerCase()
    if (ownerAddr) await registryAppendName(env.REGISTRY, ownerAddr, result.name)
  }

  if (result.ok) {
    const resolveEstimate = await buildResolveEstimate(env)
    return json({ ...result, ...resolveEstimate })
  }
  return json(result)
}

// ─── POST /register, /set-addr, /set-text, /set-contenthash,
//         /add-registrar, /remove-registrar — EIP-712 signed ─────────────────

async function handleManage(request: Request, env: Env, path: string): Promise<Response> {
  const payload = await parseJson(request)

  const from = payload.from as string | undefined
  if (!from || !isAddress(from)) throw badReq('Invalid from address')

  // await checkRateLimit(env.RECORD_CACHE, `rl:write:${from.toLowerCase()}`, 10, 60)  // D7: disabled — EIP-712 auth is the gate

  const signature = payload.signature as Hex | undefined
  if (!signature || !isHex(signature)) throw badReq('Missing or invalid signature')

  // Always use the server-side contract address — never trust the client's verifyingContract.
  const verifyingContract = env.L2_RECORDS_ADDRESS as Address

  const chainId = getChainId(env)
  const domain = buildDomain(chainId, verifyingContract)
  const pub = makePublicClient(env)
  const l2Addr = env.L2_RECORDS_ADDRESS as Address

  // ── /set-addr ─────────────────────────────────────────────────────────────
  if (path === '/set-addr') {
    const msg = payload.message ?? {}
    if (!isBytes32(msg.node)) throw badReq('Invalid node: must be 32-byte hex (0x + 64 chars)')
    const isClearing = !msg.addr || msg.addr === '0x0000000000000000000000000000000000000000'
    if (!isClearing && !isAddress(msg.addr)) throw badReq('Invalid addr')

    const message = {
      node: msg.node as Hex,
      coinType: asBigInt(msg.coinType, 'coinType'),
      addr: (msg.addr ?? '0x0000000000000000000000000000000000000000') as Address,
      nonce: asBigInt(msg.nonce, 'nonce'),
      deadline: asBigInt(msg.deadline, 'deadline'),
    }
    checkDeadline(message.deadline)

    const ok = await verifyTypedData({ address: from, domain, primaryType: 'SetAddr', types: SetAddrTypes as any, message: message as any, signature })
    if (!ok) throw Object.assign(new Error('Invalid signature'), { status: 401 })

    // Authorization: recovered signer must be subdomain owner (check BEFORE consuming nonce)
    const subnodeOwner = await pub.readContract({ address: l2Addr, abi: L2RecordsV2ABI, functionName: 'subnodeOwner', args: [message.node] })
    if ((subnodeOwner as string).toLowerCase() !== from.toLowerCase()) {
      throw Object.assign(new Error('Signer is not the subdomain owner'), { status: 403 })
    }
    await consumeNonce(env.REGISTRY ?? env.RECORD_CACHE, from, message.nonce, message.deadline)

    const writer = requireWriter(env)
    const addrBytes = isClearing ? ('0x' as Hex) : (toHex(toBytes(message.addr), { size: 20 }) as Hex)
    const txHash = await writer.setAddr(message.node, message.coinType, addrBytes)

    // Sync to KV record cache (coinType=60 only)
    if (env.RECORD_CACHE && message.coinType === 60n) {
      if (isClearing) {
        await env.RECORD_CACHE.delete(`addr60:${message.node}`)
      } else {
        await env.RECORD_CACHE.put(`addr60:${message.node}`, message.addr, { expirationTtl: RECORD_CACHE_TTL })
      }
    }

    return json({ ok, action: 'set-addr', txHash })
  }

  // ── /register ─────────────────────────────────────────────────────────────
  if (path === '/register') {
    const msg = payload.message ?? {}
    if (typeof msg.parent !== 'string' || !msg.parent) throw badReq('Invalid parent')
    if (typeof msg.label !== 'string' || !msg.label) throw badReq('Invalid label')
    if (!isAddress(msg.owner)) throw badReq('Invalid owner')

    // Validate parent is a well-formed ENS name: dot-separated lowercase labels, each 1–63 chars.
    // Required because parent is stored in KV and returned verbatim by /lookup — unvalidated input
    // could store XSS/injection payloads that are returned to clients.
    const parent = msg.parent as string
    if (parent.length > 253) throw badReq('parent too long')
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(parent)) throw badReq('parent must be a valid ENS name (e.g. forest.aastar.eth)')

    // Require client to send a pre-normalized label (lowercase, trimmed, non-empty, ≤63 chars).
    // Reject if not normalized — prevents signature mismatch from server-side normalization.
    const label = msg.label as string
    const normalizedLabel = label.trim().toLowerCase()
    if (label !== normalizedLabel) throw badReq('Label must be lowercase and trimmed')
    if (!normalizedLabel || normalizedLabel.length > 63) throw badReq('Label must be 1–63 characters')
    if (!/^[a-z0-9-]+$/.test(normalizedLabel)) throw badReq('Label must contain only a-z, 0-9, and hyphens')

    const message = {
      parent,
      label: normalizedLabel,
      owner: msg.owner as Address,
      nonce: asBigInt(msg.nonce, 'nonce'),
      deadline: asBigInt(msg.deadline, 'deadline'),
    }
    checkDeadline(message.deadline)

    const ok = await verifyTypedData({ address: from, domain, primaryType: 'Register', types: RegisterTypes as any, message: message as any, signature })
    if (!ok) throw Object.assign(new Error('Invalid signature'), { status: 401 })

    // Self-service model: any wallet can register their own subdomain.
    // The Worker EOA (WORKER_EOA_PRIVATE_KEY) is the on-chain registrar and
    // submits the L2 tx — the signer just proves intent via EIP-712.
    const parentNode = namehash(message.parent) as Hex

    const lh = labelhash(message.label) as Hex
    const node = namehash(`${message.label}.${message.parent}`) as Hex

    const existingOwner = await pub.readContract({ address: l2Addr, abi: L2RecordsV2ABI, functionName: 'subnodeOwner', args: [node] })
    if ((existingOwner as string) !== '0x0000000000000000000000000000000000000000') {
      return jsonError(`Label "${message.label}" is already registered`, 409, 'LABEL_TAKEN')
    }

    // D6: No per-wallet primaryNode limit — a wallet may hold subdomains under
    // multiple parent domains (forest.aastar.eth, game.aastar.eth, etc.).
    // Chain-level uniqueness (subnodeOwner check above) is the real guard.

    await consumeNonce(env.REGISTRY ?? env.RECORD_CACHE, from, message.nonce, message.deadline)

    const addrBytes = toHex(toBytes(message.owner), { size: 20 }) as Hex
    const writer = requireWriter(env)
    const txHash = await writer.registerSubnode(parentNode, lh, message.owner, message.label, addrBytes)

    // Persist to KV caches (fire-and-forget; don't block response).
    // Store the full qualified name so /lookup works across multi-root domains.
    const ownerLower = message.owner.toLowerCase()
    const fullName = `${message.label}.${message.parent}`
    const kvWrites: Promise<void>[] = []
    if (env.REGISTRY) kvWrites.push(registryAppendName(env.REGISTRY, ownerLower, fullName))
    if (env.RECORD_CACHE) kvWrites.push(env.RECORD_CACHE.put(`addr60:${node}`, message.owner, { expirationTtl: RECORD_CACHE_TTL }))
    await Promise.all(kvWrites)

    // Include estimated L1 resolve time so frontend can show countdown
    const resolveEstimate = await buildResolveEstimate(env)
    return json({ ok, action: 'register', txHash, ...resolveEstimate })
  }

  // ── /set-text ─────────────────────────────────────────────────────────────
  if (path === '/set-text') {
    const msg = payload.message ?? {}
    if (!isBytes32(msg.node)) throw badReq('Invalid node: must be 32-byte hex (0x + 64 chars)')
    if (typeof msg.key !== 'string' || !msg.key) throw badReq('Invalid key')
    if (typeof msg.value !== 'string') throw badReq('Invalid value')

    const message = {
      node: msg.node as Hex,
      key: msg.key as string,
      value: msg.value as string,
      nonce: asBigInt(msg.nonce, 'nonce'),
      deadline: asBigInt(msg.deadline, 'deadline'),
    }
    checkDeadline(message.deadline)

    const ok = await verifyTypedData({ address: from, domain, primaryType: 'SetText', types: SetTextTypes as any, message: message as any, signature })
    if (!ok) throw Object.assign(new Error('Invalid signature'), { status: 401 })

    // Authorization: check BEFORE consuming nonce
    const subnodeOwner = await pub.readContract({ address: l2Addr, abi: L2RecordsV2ABI, functionName: 'subnodeOwner', args: [message.node] })
    if ((subnodeOwner as string).toLowerCase() !== from.toLowerCase()) {
      throw Object.assign(new Error('Signer is not the subdomain owner'), { status: 403 })
    }
    await consumeNonce(env.REGISTRY ?? env.RECORD_CACHE, from, message.nonce, message.deadline)

    const writer = requireWriter(env)
    const txHash = await writer.setText(message.node, message.key, message.value)

    // Sync to KV record cache
    if (env.RECORD_CACHE) {
      const kvKey = `text:${message.node}:${message.key}`
      if (message.value === '') {
        await env.RECORD_CACHE.delete(kvKey)
      } else {
        await env.RECORD_CACHE.put(kvKey, message.value, { expirationTtl: RECORD_CACHE_TTL })
      }
    }

    return json({ ok, action: 'set-text', txHash })
  }

  // ── /set-contenthash ──────────────────────────────────────────────────────
  if (path === '/set-contenthash') {
    const msg = payload.message ?? {}
    if (!isBytes32(msg.node)) throw badReq('Invalid node: must be 32-byte hex (0x + 64 chars)')
    if (!isHex(msg.hash)) throw badReq('Invalid hash')

    const message = {
      node: msg.node as Hex,
      hash: msg.hash as Hex,
      nonce: asBigInt(msg.nonce, 'nonce'),
      deadline: asBigInt(msg.deadline, 'deadline'),
    }
    checkDeadline(message.deadline)

    const ok = await verifyTypedData({ address: from, domain, primaryType: 'SetContenthash', types: SetContenthashTypes as any, message: message as any, signature })
    if (!ok) throw Object.assign(new Error('Invalid signature'), { status: 401 })

    // Authorization: check BEFORE consuming nonce
    const subnodeOwner = await pub.readContract({ address: l2Addr, abi: L2RecordsV2ABI, functionName: 'subnodeOwner', args: [message.node] })
    if ((subnodeOwner as string).toLowerCase() !== from.toLowerCase()) {
      throw Object.assign(new Error('Signer is not the subdomain owner'), { status: 403 })
    }
    await consumeNonce(env.REGISTRY ?? env.RECORD_CACHE, from, message.nonce, message.deadline)

    const writer = requireWriter(env)
    const txHash = await writer.setContenthash(message.node, message.hash)

    // Sync to KV record cache
    if (env.RECORD_CACHE) {
      const kvKey = `ch:${message.node}`
      if (message.hash === '0x') {
        await env.RECORD_CACHE.delete(kvKey)
      } else {
        await env.RECORD_CACHE.put(kvKey, message.hash, { expirationTtl: RECORD_CACHE_TTL })
      }
    }

    return json({ ok, action: 'set-contenthash', txHash })
  }

  // ── /add-registrar ────────────────────────────────────────────────────────
  if (path === '/add-registrar') {
    const msg = payload.message ?? {}
    if (!isHex(msg.parentNode)) throw badReq('Invalid parentNode')
    if (!isAddress(msg.registrar)) throw badReq('Invalid registrar')

    const message = {
      parentNode: msg.parentNode as Hex,
      registrar: msg.registrar as Address,
      quota: asBigInt(msg.quota, 'quota'),
      expiry: asBigInt(msg.expiry, 'expiry'),
      nonce: asBigInt(msg.nonce, 'nonce'),
      deadline: asBigInt(msg.deadline, 'deadline'),
    }
    checkDeadline(message.deadline)

    const ok = await verifyTypedData({ address: from, domain, primaryType: 'AddRegistrar', types: AddRegistrarTypes as any, message: message as any, signature })
    if (!ok) throw Object.assign(new Error('Invalid signature'), { status: 401 })

    const contractOwner = await pub.readContract({ address: l2Addr, abi: L2RecordsV2ABI, functionName: 'owner' })
    if ((contractOwner as string).toLowerCase() !== from.toLowerCase()) {
      throw Object.assign(new Error('Only contract owner can add registrars'), { status: 403 })
    }
    await consumeNonce(env.REGISTRY ?? env.RECORD_CACHE, from, message.nonce, message.deadline)

    const writer = requireWriter(env)
    const txHash = await writer.addRegistrar(message.parentNode, message.registrar, message.quota, message.expiry)
    return json({ ok, action: 'add-registrar', txHash })
  }

  // ── /remove-registrar ─────────────────────────────────────────────────────
  if (path === '/remove-registrar') {
    const msg = payload.message ?? {}
    if (!isHex(msg.parentNode)) throw badReq('Invalid parentNode')
    if (!isAddress(msg.registrar)) throw badReq('Invalid registrar')

    const message = {
      parentNode: msg.parentNode as Hex,
      registrar: msg.registrar as Address,
      nonce: asBigInt(msg.nonce, 'nonce'),
      deadline: asBigInt(msg.deadline, 'deadline'),
    }
    checkDeadline(message.deadline)

    const ok = await verifyTypedData({ address: from, domain, primaryType: 'RemoveRegistrar', types: RemoveRegistrarTypes as any, message: message as any, signature })
    if (!ok) throw Object.assign(new Error('Invalid signature'), { status: 401 })

    const contractOwner = await pub.readContract({ address: l2Addr, abi: L2RecordsV2ABI, functionName: 'owner' })
    if ((contractOwner as string).toLowerCase() !== from.toLowerCase()) {
      throw Object.assign(new Error('Only contract owner can remove registrars'), { status: 403 })
    }
    await consumeNonce(env.REGISTRY ?? env.RECORD_CACHE, from, message.nonce, message.deadline)

    const writer = requireWriter(env)
    const txHash = await writer.removeRegistrar(message.parentNode, message.registrar)
    return json({ ok, action: 'remove-registrar', txHash })
  }

  // ── /transfer-subnode ─────────────────────────────────────────────────────
  if (path === '/transfer-subnode') {
    const msg = payload.message ?? {}
    if (!isBytes32(msg.node)) throw badReq('Invalid node: must be 32-byte hex (0x + 64 chars)')
    if (!isAddress(msg.to)) throw badReq('Invalid to address')
    if ((msg.to as string).toLowerCase() === '0x0000000000000000000000000000000000000000') {
      throw badReq('Cannot transfer to zero address')
    }

    const message = {
      node: msg.node as Hex,
      to: msg.to as Address,
      nonce: asBigInt(msg.nonce, 'nonce'),
      deadline: asBigInt(msg.deadline, 'deadline'),
    }
    checkDeadline(message.deadline)

    // Self-transfer is a no-op that wastes gas and burns the nonce — reject early.
    if (message.to.toLowerCase() === from.toLowerCase()) {
      throw badReq('Cannot transfer to self')
    }

    const ok = await verifyTypedData({ address: from, domain, primaryType: 'TransferSubnode', types: TransferSubnodeTypes as any, message: message as any, signature })
    if (!ok) throw Object.assign(new Error('Invalid signature'), { status: 401 })

    // Authorization: verify on-chain ownership BEFORE consuming nonce.
    // Uses subnodeOwner() which in V3 maps directly to ownerOf(uint256(node)).
    const subnodeOwner = await pub.readContract({ address: l2Addr, abi: L2RecordsV2ABI, functionName: 'subnodeOwner', args: [message.node] })
    if ((subnodeOwner as string).toLowerCase() !== from.toLowerCase()) {
      throw Object.assign(new Error('Signer is not the subdomain owner'), { status: 403 })
    }

    // Verify writer is configured before consuming nonce — avoids burning nonce
    // when WORKER_EOA_PRIVATE_KEY is missing (misconfiguration fail-fast).
    const writer = requireWriter(env)

    await consumeNonce(env.REGISTRY ?? env.RECORD_CACHE, from, message.nonce, message.deadline)

    const txHash = await writer.transferSubnode(message.node, from as Address, message.to)

    // Invalidate KV record cache for this node — owner changed
    if (env.RECORD_CACHE) {
      await env.RECORD_CACHE.delete(`addr60:${message.node}`)
    }

    return json({ ok, action: 'transfer-subnode', txHash })
  }

  return jsonError('Unknown endpoint', 404)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Append a registered name to the KV registry for a given address.
 * Stores as JSON array to support multiple names per address.
 */
async function registryAppendName(kv: KVNamespace, address: string, fullName: string): Promise<void> {
  const key = `reg:${address.toLowerCase()}`
  const existing = await kv.get(key)

  let names: string[]
  if (!existing) {
    names = []
  } else {
    try {
      const parsed = JSON.parse(existing)
      names = Array.isArray(parsed) ? parsed : [existing]
    } catch {
      // Legacy plain string
      names = [existing]
    }
  }

  // Don't add duplicates
  if (!names.includes(fullName)) {
    names.push(fullName)
  }

  await kv.put(key, JSON.stringify(names))
}

/** Returns all configured root domains. Falls back to ROOT_DOMAIN if ROOT_DOMAINS is not set. */
function getRootDomains(env: Env): string[] {
  if (env.ROOT_DOMAINS) {
    return env.ROOT_DOMAINS.split(',').map(d => d.trim()).filter(Boolean)
  }
  return env.ROOT_DOMAIN ? [env.ROOT_DOMAIN] : []
}

function getChain(env: Env) {
  return env.NETWORK === 'op-mainnet' ? optimism : optimismSepolia
}

function getChainId(env: Env): number {
  return getChain(env).id
}

function makePublicClient(env: Env) {
  return createPublicClient({ chain: getChain(env), transport: http(env.OP_RPC_URL) })
}

function buildWriter(env: Env): L2RecordsWriterV2 | undefined {
  const pk = env.WORKER_EOA_PRIVATE_KEY as Hex | undefined
  if (!pk) return undefined
  const account = privateKeyToAccount(pk)
  return new L2RecordsWriterV2(account, getChain(env), env.OP_RPC_URL, env.L2_RECORDS_ADDRESS as Hex)
}

function requireWriter(env: Env): L2RecordsWriterV2 {
  const writer = buildWriter(env)
  if (!writer) throw Object.assign(new Error('WORKER_EOA_PRIVATE_KEY not configured on server'), { status: 503 })
  return writer
}

function asBigInt(value: unknown, fieldName = 'field'): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(value)
  if (typeof value === 'string' && value !== '') return BigInt(value)
  throw badReq(`Invalid or missing bigint ${fieldName}`)
}

function checkDeadline(deadline: bigint): void {
  const now = BigInt(Math.floor(Date.now() / 1000))
  if (deadline < now) throw badReq('Request deadline expired')
  if (deadline > now + BigInt(MAX_NONCE_TTL)) throw badReq('Deadline too far in future (max 24h)')
}

/**
 * Prevent signature replay: store nonce in KV with TTL = remaining deadline.
 *
 * KV is eventually consistent across CF PoPs (~1-2s window).
 * This is acceptable because: chain-level uniqueness (AlreadyRegistered) provides
 * the hard guarantee for registration; for set-addr/text/contenthash, the worst
 * case of a replayed mutation is a redundant write with no net state change.
 *
 * Throws 409 if the nonce was already used within its validity window.
 * No-op when KV is not bound (local dev without KV).
 */
const MAX_NONCE_TTL = 86_400 // 24 hours hard cap

async function consumeNonce(
  kv: KVNamespace | undefined,
  from: string,
  nonce: bigint,
  deadline: bigint,
): Promise<void> {
  if (!kv) return  // local dev without KV — skip replay protection

  const key = `nonce:${from.toLowerCase()}:${nonce}`
  const nowSecs = BigInt(Math.floor(Date.now() / 1000))
  const remaining = deadline > nowSecs ? deadline - nowSecs : 0n
  const ttl = Math.min(MAX_NONCE_TTL, Math.max(60, Number(remaining)))

  const existing = await kv.get(key)
  if (existing !== null) throw Object.assign(new Error('Nonce already used'), { status: 409 })
  await kv.put(key, '1', { expirationTtl: ttl })
}

// D7 (TODO): Rate limiting — deferred. EIP-712 auth is the primary gate.
// If needed in future, implement at CF infrastructure level (not per-worker).

function badReq(msg: string): Error {
  return Object.assign(new Error(msg), { status: 400 })
}

/** Validates that a value is a hex string of exactly 32 bytes (0x + 64 hex chars). */
function isBytes32(v: unknown): v is Hex {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v)
}

async function parseJson(request: Request): Promise<any> {
  try {
    return await request.json()
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 })
  }
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders() },
  })
}

function jsonError(message: string, status: number, code?: string): Response {
  return json(code ? { error: message, code } : { error: message }, status)
}
