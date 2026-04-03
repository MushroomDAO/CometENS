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

export { NonceStore } from './NonceStore'

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

export interface Env {
  /** 'op-sepolia' | 'op-mainnet' */
  NETWORK: string
  /** L2RecordsV2 contract address */
  L2_RECORDS_ADDRESS: string
  /** e.g. 'aastar.eth' */
  ROOT_DOMAIN: string
  /** Optimism RPC URL */
  OP_RPC_URL: string
  /** EOA private key that submits L2 transactions (wrangler secret) */
  WORKER_EOA_PRIVATE_KEY?: string
  /** Comma-separated addresses allowed to call /v1/register */
  UPSTREAM_ALLOWED_SIGNERS?: string
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
  /**
   * Durable Object namespace for atomic nonce consumption (D1).
   * Eliminates the KV TOCTOU race in consumeNonce().
   * Optional: falls back to RECORD_CACHE KV when not bound (dev/test).
   */
  NONCE_STORE?: DurableObjectNamespace
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
          version: 'v0.5.0',
          timestamp: Math.floor(Date.now() / 1000),
        })
        trackEvent(env.ANALYTICS, path, response.status)
        return response
      }

      // ── Public GET endpoints ──────────────────────────────────────────────
      if (request.method === 'GET') {
        if (path === '/check-label')  { response = await handleCheckLabel(url, env); trackEvent(env.ANALYTICS, path, response.status); return response }
        if (path === '/check-owner')  { response = await handleCheckOwner(url, env); trackEvent(env.ANALYTICS, path, response.status); return response }
        if (path === '/lookup')       { response = await handleLookup(url, env); trackEvent(env.ANALYTICS, path, response.status); return response }
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

async function handleLookup(url: URL, env: Env): Promise<Response> {
  const address = url.searchParams.get('address')?.toLowerCase()
  if (!address || !isAddress(address)) return jsonError('Missing or invalid address param', 400)

  const kvKey = `reg:${address}`
  const label = env.REGISTRY ? await env.REGISTRY.get(kvKey) : null

  if (!label) return json({ found: false })

  // Verify the cached entry still exists on-chain (guards against stale cache)
  try {
    const pub = makePublicClient(env)
    const l2Addr = env.L2_RECORDS_ADDRESS as Address
    const existingNode = await pub.readContract({
      address: l2Addr, abi: L2RecordsV2ABI, functionName: 'primaryNode', args: [address as Address],
    })
    if (existingNode === '0x0000000000000000000000000000000000000000000000000000000000000000') {
      if (env.REGISTRY) await env.REGISTRY.delete(kvKey)
      return json({ found: false })
    }
  } catch { /* chain unreachable — fall through to return cached value */ }

  const fullName = `${label}.${env.ROOT_DOMAIN}`
  return json({ found: true, label, fullName })
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
    await checkRateLimit(env.RECORD_CACHE, `rl:v1:${signerAddress.toLowerCase()}`, 60, 60)
  }

  const writer = buildWriter(env)

  const result = await handleV1Register(payload, allowedSigners, env.ROOT_DOMAIN, writer)

  // Persist to KV registry on success
  if (result.ok && result.name && env.REGISTRY) {
    const label = result.name.split('.')[0]
    const ownerAddr = (payload.owner as string ?? '').toLowerCase()
    if (ownerAddr) await env.REGISTRY.put(`reg:${ownerAddr}`, label)
  }

  return json(result)
}

// ─── POST /register, /set-addr, /set-text, /set-contenthash,
//         /add-registrar, /remove-registrar — EIP-712 signed ─────────────────

async function handleManage(request: Request, env: Env, path: string): Promise<Response> {
  const payload = await parseJson(request)

  const from = payload.from as string | undefined
  if (!from || !isAddress(from)) throw badReq('Invalid from address')

  await checkRateLimit(env.RECORD_CACHE, `rl:write:${from.toLowerCase()}`, 10, 60)

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
    if (!isHex(msg.node)) throw badReq('Invalid node')
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
    await consumeNonce(env.REGISTRY ?? env.RECORD_CACHE, from, message.nonce, message.deadline, env.NONCE_STORE)

    const writer = requireWriter(env)
    const addrBytes = isClearing ? ('0x' as Hex) : (toHex(toBytes(message.addr), { size: 20 }) as Hex)
    const txHash = await writer.setAddr(message.node, message.coinType, addrBytes)

    // Sync to KV record cache (coinType=60 only)
    if (env.RECORD_CACHE && message.coinType === 60n) {
      if (isClearing) {
        await env.RECORD_CACHE.delete(`addr60:${message.node}`)
      } else {
        await env.RECORD_CACHE.put(`addr60:${message.node}`, message.addr)
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

    // Require client to send a pre-normalized label (lowercase, trimmed, non-empty, ≤64 chars).
    // Reject if not normalized — prevents signature mismatch from server-side normalization.
    const label = msg.label as string
    const normalizedLabel = label.trim().toLowerCase()
    if (label !== normalizedLabel) throw badReq('Label must be lowercase and trimmed')
    if (!normalizedLabel || normalizedLabel.length > 63) throw badReq('Label must be 1–63 characters')
    if (!/^[a-z0-9-]+$/.test(normalizedLabel)) throw badReq('Label must contain only a-z, 0-9, and hyphens')

    const message = {
      parent: msg.parent as string,
      label: normalizedLabel,
      owner: msg.owner as Address,
      nonce: asBigInt(msg.nonce, 'nonce'),
      deadline: asBigInt(msg.deadline, 'deadline'),
    }
    checkDeadline(message.deadline)

    const ok = await verifyTypedData({ address: from, domain, primaryType: 'Register', types: RegisterTypes as any, message: message as any, signature })
    if (!ok) throw Object.assign(new Error('Invalid signature'), { status: 401 })

    // Authorization: verify signer is a registrar or the contract owner (check BEFORE consuming nonce)
    const parentNode = namehash(message.parent) as Hex
    const [contractOwner, isReg] = await Promise.all([
      pub.readContract({ address: l2Addr, abi: L2RecordsV2ABI, functionName: 'owner' }),
      pub.readContract({ address: l2Addr, abi: L2RecordsV2ABI, functionName: 'isRegistrar', args: [parentNode, from as Address] }),
    ])
    if (
      (contractOwner as string).toLowerCase() !== from.toLowerCase() &&
      !isReg
    ) {
      throw Object.assign(new Error('Signer is not a registrar or contract owner'), { status: 403 })
    }

    const lh = labelhash(message.label) as Hex
    const node = namehash(`${message.label}.${message.parent}`) as Hex

    const existingOwner = await pub.readContract({ address: l2Addr, abi: L2RecordsV2ABI, functionName: 'subnodeOwner', args: [node] })
    if ((existingOwner as string) !== '0x0000000000000000000000000000000000000000') {
      return jsonError(`Label "${message.label}" is already registered`, 409, 'LABEL_TAKEN')
    }

    // Check the owner's primary node, not the registrar's (signer != owner in registrar flow)
    const existingPrimary = await pub.readContract({ address: l2Addr, abi: L2RecordsV2ABI, functionName: 'primaryNode', args: [message.owner] })
    if ((existingPrimary as string) !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
      return jsonError(`This wallet has already registered a subdomain`, 409, 'ALREADY_REGISTERED')
    }
    await consumeNonce(env.REGISTRY ?? env.RECORD_CACHE, from, message.nonce, message.deadline, env.NONCE_STORE)

    const addrBytes = toHex(toBytes(message.owner), { size: 20 }) as Hex
    const writer = requireWriter(env)
    const txHash = await writer.registerSubnode(parentNode, lh, message.owner, message.label, addrBytes)

    // Persist to KV caches (fire-and-forget; don't block response)
    const ownerLower = message.owner.toLowerCase()
    const kvWrites: Promise<void>[] = []
    if (env.REGISTRY) kvWrites.push(env.REGISTRY.put(`reg:${ownerLower}`, message.label))
    if (env.RECORD_CACHE) kvWrites.push(env.RECORD_CACHE.put(`addr60:${node}`, message.owner))
    await Promise.all(kvWrites)

    return json({ ok, action: 'register', txHash })
  }

  // ── /set-text ─────────────────────────────────────────────────────────────
  if (path === '/set-text') {
    const msg = payload.message ?? {}
    if (!isHex(msg.node)) throw badReq('Invalid node')
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
    await consumeNonce(env.REGISTRY ?? env.RECORD_CACHE, from, message.nonce, message.deadline, env.NONCE_STORE)

    const writer = requireWriter(env)
    const txHash = await writer.setText(message.node, message.key, message.value)

    // Sync to KV record cache
    if (env.RECORD_CACHE) {
      const kvKey = `text:${message.node}:${message.key}`
      if (message.value === '') {
        await env.RECORD_CACHE.delete(kvKey)
      } else {
        await env.RECORD_CACHE.put(kvKey, message.value)
      }
    }

    return json({ ok, action: 'set-text', txHash })
  }

  // ── /set-contenthash ──────────────────────────────────────────────────────
  if (path === '/set-contenthash') {
    const msg = payload.message ?? {}
    if (!isHex(msg.node)) throw badReq('Invalid node')
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
    await consumeNonce(env.REGISTRY ?? env.RECORD_CACHE, from, message.nonce, message.deadline, env.NONCE_STORE)

    const writer = requireWriter(env)
    const txHash = await writer.setContenthash(message.node, message.hash)

    // Sync to KV record cache
    if (env.RECORD_CACHE) {
      const kvKey = `ch:${message.node}`
      if (message.hash === '0x') {
        await env.RECORD_CACHE.delete(kvKey)
      } else {
        await env.RECORD_CACHE.put(kvKey, message.hash)
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
    await consumeNonce(env.REGISTRY ?? env.RECORD_CACHE, from, message.nonce, message.deadline, env.NONCE_STORE)

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
    await consumeNonce(env.REGISTRY ?? env.RECORD_CACHE, from, message.nonce, message.deadline, env.NONCE_STORE)

    const writer = requireWriter(env)
    const txHash = await writer.removeRegistrar(message.parentNode, message.registrar)
    return json({ ok, action: 'remove-registrar', txHash })
  }

  // ── /transfer-subnode ─────────────────────────────────────────────────────
  if (path === '/transfer-subnode') {
    const msg = payload.message ?? {}
    if (!isHex(msg.node)) throw badReq('Invalid node')
    if (!isAddress(msg.to)) throw badReq('Invalid to address')

    const message = {
      node: msg.node as Hex,
      to: msg.to as Address,
      nonce: asBigInt(msg.nonce, 'nonce'),
      deadline: asBigInt(msg.deadline, 'deadline'),
    }
    checkDeadline(message.deadline)

    const ok = await verifyTypedData({ address: from, domain, primaryType: 'TransferSubnode', types: TransferSubnodeTypes as any, message: message as any, signature })
    if (!ok) throw Object.assign(new Error('Invalid signature'), { status: 401 })

    // Authorization: signer must be current NFT owner (check BEFORE consuming nonce)
    const subnodeOwner = await pub.readContract({ address: l2Addr, abi: L2RecordsV2ABI, functionName: 'subnodeOwner', args: [message.node] })
    if ((subnodeOwner as string).toLowerCase() !== from.toLowerCase()) {
      throw Object.assign(new Error('Signer is not the subdomain owner'), { status: 403 })
    }
    await consumeNonce(env.REGISTRY ?? env.RECORD_CACHE, from, message.nonce, message.deadline, env.NONCE_STORE)

    const writer = requireWriter(env)
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
 * Prevent signature replay: atomically check+store the nonce.
 *
 * Priority:
 *   1. Durable Object (NONCE_STORE) — strongly consistent, no TOCTOU race
 *   2. KV (RECORD_CACHE) — eventually consistent fallback for dev/test
 *   3. Neither bound — no-op (existing behaviour for local dev)
 *
 * Throws 409 if the nonce was already used within its validity window.
 */
const MAX_NONCE_TTL = 86_400 // 24 hours hard cap

async function consumeNonce(
  kv: KVNamespace | undefined,
  from: string,
  nonce: bigint,
  deadline: bigint,
  doNamespace?: DurableObjectNamespace,
): Promise<void> {
  const key = `nonce:${from.toLowerCase()}:${nonce}`
  // Use BigInt arithmetic to avoid precision loss on large deadline values.
  const nowSecs = BigInt(Math.floor(Date.now() / 1000))
  const remaining = deadline > nowSecs ? deadline - nowSecs : 0n
  const ttl = Math.min(MAX_NONCE_TTL, Math.max(60, Number(remaining)))

  if (doNamespace) {
    // Strongly-consistent path: Durable Object guarantees atomicity.
    const id = doNamespace.idFromName('global')
    const stub = doNamespace.get(id)
    const res = await stub.fetch('https://do/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, ttl }),
    })
    const result = await res.json() as { ok: boolean }
    if (!result.ok) throw Object.assign(new Error('Nonce already used'), { status: 409 })
    return
  }

  // Eventually-consistent fallback: KV (dev/test without NONCE_STORE bound).
  // WARNING: KV is not atomic — use only in dev/test environments. Production
  // deployments must bind NONCE_STORE (Durable Object) to prevent TOCTOU replay.
  if (kv) {
    const existing = await kv.get(key)
    if (existing !== null) throw Object.assign(new Error('Nonce already used'), { status: 409 })
    await kv.put(key, '1', { expirationTtl: ttl })
    return
  }

  // Neither DO nor KV bound — fail closed. Allowing nonces to pass without
  // deduplication would make replay protection entirely ineffective.
  throw Object.assign(new Error('Nonce storage not configured on server'), { status: 503 })
}

/**
 * KV sliding-window rate limiter.
 *
 * Divides time into fixed windows of `windowSecs` seconds. Within each window,
 * counts requests per key. Throws 429 when the limit is exceeded.
 *
 * No-op when `kv` is undefined (dev/test without KV bound).
 * Key prefix `rl:` does not collide with any existing KV keys.
 */
async function checkRateLimit(
  kv: KVNamespace | undefined,
  key: string,
  limit: number,
  windowSecs: number,
): Promise<void> {
  if (!kv) return

  const now = Math.floor(Date.now() / 1000)
  const windowKey = `${key}:${Math.floor(now / windowSecs)}`

  const current = await kv.get(windowKey)
  const count = current ? parseInt(current, 10) : 0

  if (count >= limit) {
    throw Object.assign(new Error('Rate limit exceeded'), { status: 429 })
  }

  // expirationTtl must be ≥ 60s per CF KV minimum — use windowSecs * 2 so
  // the counter outlives the window (allows the window to drain naturally).
  await kv.put(windowKey, String(count + 1), { expirationTtl: Math.max(60, windowSecs * 2) })
}

function badReq(msg: string): Error {
  return Object.assign(new Error(msg), { status: 400 })
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
