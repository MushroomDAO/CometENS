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
import {
  buildDomain,
  RegisterTypes,
  SetAddrTypes,
  SetTextTypes,
  SetContenthashTypes,
  AddRegistrarTypes,
  RemoveRegistrarTypes,
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
}

// ─── ABI fragments (read-only calls) ─────────────────────────────────────────

const OWNER_ABI = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const

const READ_ABI = [
  { type: 'function', name: 'subnodeOwner', stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'primaryNode', stateMutability: 'view',
    inputs: [{ name: 'addr_', type: 'address' }], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'isRegistrar', stateMutability: 'view',
    inputs: [{ name: 'parentNode', type: 'bytes32' }, { name: 'addr', type: 'address' }],
    outputs: [{ type: 'bool' }] },
] as const

// ─── Main fetch handler ───────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }

    try {
      // ── Public GET endpoints ──────────────────────────────────────────────
      if (request.method === 'GET') {
        if (path === '/check-label')  return handleCheckLabel(url, env)
        if (path === '/check-owner')  return handleCheckOwner(url, env)
        if (path === '/lookup')       return handleLookup(url, env)
      }

      // ── POST endpoints ────────────────────────────────────────────────────
      if (request.method === 'POST') {
        if (path === '/v1/register')    return handleV1RegisterEndpoint(request, env)
        if (path === '/register')       return handleManage(request, env, path)
        if (path === '/set-addr')       return handleManage(request, env, path)
        if (path === '/set-text')       return handleManage(request, env, path)
        if (path === '/set-contenthash') return handleManage(request, env, path)
        if (path === '/add-registrar')  return handleManage(request, env, path)
        if (path === '/remove-registrar') return handleManage(request, env, path)
      }

      return jsonError('Not Found', 404)
    } catch (e: any) {
      return jsonError(e?.message ?? String(e), e?.status ?? 500)
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
    address: l2Addr, abi: READ_ABI, functionName: 'subnodeOwner', args: [node],
  })
  const taken = owner !== '0x0000000000000000000000000000000000000000'
  return json({ available: !taken, owner: taken ? owner : null })
}

// ─── GET /check-owner?contract=0x... ─────────────────────────────────────────

async function handleCheckOwner(url: URL, env: Env): Promise<Response> {
  const contract = url.searchParams.get('contract')?.trim() as Address | undefined
  if (!contract || !isAddress(contract)) return jsonError('Missing or invalid contract param', 400)

  const pub = makePublicClient(env)
  const owner = await pub.readContract({ address: contract, abi: OWNER_ABI, functionName: 'owner' })
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
      address: l2Addr, abi: READ_ABI, functionName: 'primaryNode', args: [address as Address],
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

  const signature = payload.signature as Hex | undefined
  if (!signature || !isHex(signature)) throw badReq('Missing or invalid signature')

  const verifyingContract = (
    payload.domain?.verifyingContract ??
    payload.verifyingContract ??
    env.L2_RECORDS_ADDRESS
  ) as Address
  if (!isAddress(verifyingContract)) throw badReq('Invalid verifyingContract')

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
      coinType: asBigInt(msg.coinType),
      addr: (msg.addr ?? '0x0000000000000000000000000000000000000000') as Address,
      nonce: asBigInt(msg.nonce),
      deadline: asBigInt(msg.deadline),
    }
    checkDeadline(message.deadline)

    const ok = await verifyTypedData({ address: from, domain, primaryType: 'SetAddr', types: SetAddrTypes as any, message: message as any, signature })
    if (!ok) throw Object.assign(new Error('Invalid signature'), { status: 401 })

    // Authorization: recovered signer must be subdomain owner
    const subnodeOwner = await pub.readContract({ address: l2Addr, abi: READ_ABI, functionName: 'subnodeOwner', args: [message.node] })
    if ((subnodeOwner as string).toLowerCase() !== from.toLowerCase()) {
      throw Object.assign(new Error('Signer is not the subdomain owner'), { status: 403 })
    }

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

    const message = {
      parent: msg.parent as string,
      label: msg.label as string,
      owner: msg.owner as Address,
      nonce: asBigInt(msg.nonce),
      deadline: asBigInt(msg.deadline),
    }
    checkDeadline(message.deadline)

    const ok = await verifyTypedData({ address: from, domain, primaryType: 'Register', types: RegisterTypes as any, message: message as any, signature })
    if (!ok) throw Object.assign(new Error('Invalid signature'), { status: 401 })

    // Authorization: verify signer is a registrar or the contract owner
    const parentNode = namehash(message.parent) as Hex
    const [contractOwner, isReg] = await Promise.all([
      pub.readContract({ address: l2Addr, abi: OWNER_ABI, functionName: 'owner' }),
      pub.readContract({ address: l2Addr, abi: READ_ABI, functionName: 'isRegistrar', args: [parentNode, from as Address] }),
    ])
    if (
      (contractOwner as string).toLowerCase() !== from.toLowerCase() &&
      !isReg
    ) {
      throw Object.assign(new Error('Signer is not a registrar or contract owner'), { status: 403 })
    }

    const lh = labelhash(message.label) as Hex
    const node = namehash(`${message.label}.${message.parent}`) as Hex

    const existingOwner = await pub.readContract({ address: l2Addr, abi: READ_ABI, functionName: 'subnodeOwner', args: [node] })
    if ((existingOwner as string) !== '0x0000000000000000000000000000000000000000') {
      return jsonError(`Label "${message.label}" is already registered`, 409, 'LABEL_TAKEN')
    }

    const existingPrimary = await pub.readContract({ address: l2Addr, abi: READ_ABI, functionName: 'primaryNode', args: [from as Address] })
    if ((existingPrimary as string) !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
      return jsonError(`This wallet has already registered a subdomain`, 409, 'ALREADY_REGISTERED')
    }

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
      nonce: asBigInt(msg.nonce),
      deadline: asBigInt(msg.deadline),
    }
    checkDeadline(message.deadline)

    const ok = await verifyTypedData({ address: from, domain, primaryType: 'SetText', types: SetTextTypes as any, message: message as any, signature })
    if (!ok) throw Object.assign(new Error('Invalid signature'), { status: 401 })

    const subnodeOwner = await pub.readContract({ address: l2Addr, abi: READ_ABI, functionName: 'subnodeOwner', args: [message.node] })
    if ((subnodeOwner as string).toLowerCase() !== from.toLowerCase()) {
      throw Object.assign(new Error('Signer is not the subdomain owner'), { status: 403 })
    }

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
      nonce: asBigInt(msg.nonce),
      deadline: asBigInt(msg.deadline),
    }
    checkDeadline(message.deadline)

    const ok = await verifyTypedData({ address: from, domain, primaryType: 'SetContenthash', types: SetContenthashTypes as any, message: message as any, signature })
    if (!ok) throw Object.assign(new Error('Invalid signature'), { status: 401 })

    const subnodeOwner = await pub.readContract({ address: l2Addr, abi: READ_ABI, functionName: 'subnodeOwner', args: [message.node] })
    if ((subnodeOwner as string).toLowerCase() !== from.toLowerCase()) {
      throw Object.assign(new Error('Signer is not the subdomain owner'), { status: 403 })
    }

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
      quota: asBigInt(msg.quota),
      expiry: asBigInt(msg.expiry),
      nonce: asBigInt(msg.nonce),
      deadline: asBigInt(msg.deadline),
    }
    checkDeadline(message.deadline)

    const ok = await verifyTypedData({ address: from, domain, primaryType: 'AddRegistrar', types: AddRegistrarTypes as any, message: message as any, signature })
    if (!ok) throw Object.assign(new Error('Invalid signature'), { status: 401 })

    const contractOwner = await pub.readContract({ address: l2Addr, abi: OWNER_ABI, functionName: 'owner' })
    if ((contractOwner as string).toLowerCase() !== from.toLowerCase()) {
      throw Object.assign(new Error('Only contract owner can add registrars'), { status: 403 })
    }

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
      nonce: asBigInt(msg.nonce),
      deadline: asBigInt(msg.deadline),
    }
    checkDeadline(message.deadline)

    const ok = await verifyTypedData({ address: from, domain, primaryType: 'RemoveRegistrar', types: RemoveRegistrarTypes as any, message: message as any, signature })
    if (!ok) throw Object.assign(new Error('Invalid signature'), { status: 401 })

    const contractOwner = await pub.readContract({ address: l2Addr, abi: OWNER_ABI, functionName: 'owner' })
    if ((contractOwner as string).toLowerCase() !== from.toLowerCase()) {
      throw Object.assign(new Error('Only contract owner can remove registrars'), { status: 403 })
    }

    const writer = requireWriter(env)
    const txHash = await writer.removeRegistrar(message.parentNode, message.registrar)
    return json({ ok, action: 'remove-registrar', txHash })
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

function asBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(value)
  if (typeof value === 'string') return BigInt(value)
  throw new Error('Invalid bigint field')
}

function checkDeadline(deadline: bigint): void {
  const now = BigInt(Math.floor(Date.now() / 1000))
  if (deadline < now) throw Object.assign(new Error('Request deadline expired'), { status: 400 })
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
