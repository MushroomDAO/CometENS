import { defineConfig, loadEnv } from 'vite'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

const MAX_BODY_BYTES = 10 * 1024 // 10 KB

// ─── Registration registry (address → label, persisted to .registrations.json) ─

const REGISTRY_FILE = join(process.cwd(), '.registrations.json')

const registrationRegistry: Map<string, string> = (() => {
  try {
    if (existsSync(REGISTRY_FILE)) {
      const data = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8')) as Record<string, string>
      return new Map(Object.entries(data))
    }
  } catch {}
  return new Map()
})()

function saveToRegistry(address: string, label: string) {
  registrationRegistry.set(address.toLowerCase(), label.toLowerCase())
  const obj = Object.fromEntries(registrationRegistry)
  try {
    writeFileSync(REGISTRY_FILE, JSON.stringify(obj, null, 2))
  } catch (e) {
    console.error('[registry] Failed to persist .registrations.json:', e)
  }
}

// ─── ABI constants (shared across request handlers) ──────────────────────────

const L2_READ_ABI = [
  { type: 'function', name: 'subnodeOwner', stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'primaryNode', stateMutability: 'view',
    inputs: [{ name: 'addr_', type: 'address' }], outputs: [{ type: 'bytes32' }] },
] as const

export default defineConfig(({ mode }) => {
  // Load ALL env vars (empty prefix = no filter) into process.env so server
  // middleware can read WORKER_EOA_PRIVATE_KEY, PRIVATE_KEY_SUPPLIER, etc.
  // loadEnv with '' prefix loads everything; Object.assign merges into process.env.
  const env = loadEnv(mode, process.cwd(), '')
  Object.assign(process.env, env)

  return {
  envPrefix: ['VITE_', 'OP_'],
  plugins: [
    {
      name: 'ccip-dev-gateway',
      configureServer(server) {
        // ─── /api/ccip ──────────────────────────────────────────────────────

        server.middlewares.use('/api/ccip', async (req, res) => {
          const anyReq = req as any

          if (anyReq.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ error: 'Method Not Allowed' }))
            return
          }

          const body = await readBody(anyReq)

          try {
            const payload = JSON.parse(body || '{}') as {
              data?: `0x${string}`
              calldata?: `0x${string}`
              sender?: `0x${string}`
            }
            const calldata = payload.calldata ?? payload.data
            if (!calldata || !calldata.startsWith('0x')) throw new Error('Missing calldata')

            // sender = L1 OffchainResolver address (from viem CCIP-Read request)
            const resolverAddress = payload.sender ?? ('0x0000000000000000000000000000000000000000' as `0x${string}`)

            const { handleResolveSigned } = await import('./server/gateway/index')
            const result = await handleResolveSigned(calldata, resolverAddress)

            res.statusCode = 200
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify(result))
          } catch (e) {
            res.statusCode = 400
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
          }
        })

        // ─── /api/manage ────────────────────────────────────────────────────

        // ─── /api/v1 — upstream machine-to-machine API ──────────────────────
        //
        // Authentication: each request must be signed by a registered upstream app.
        // The server maintains a whitelist of allowed signer addresses
        // (UPSTREAM_ALLOWED_SIGNERS env var, comma-separated Ethereum addresses).
        //
        // Request body must include:
        //   timestamp  — Unix seconds; rejected if |now - timestamp| > 60s (anti-replay)
        //   signature  — secp256k1 signature of the canonical message (see below)
        //
        // Canonical message format (personal_sign):
        //   "CometENS:register:{label}:{owner}:{timestamp}"
        //
        // Upstream app generates this with:
        //   wallet.signMessage(`CometENS:register:${label}:${owner}:${timestamp}`)

        server.middlewares.use('/api/v1', async (req, res) => {
          const anyReq = req as any
          const url = String(anyReq.url || '')

          res.setHeader('content-type', 'application/json')

          if (anyReq.method !== 'POST') {
            res.statusCode = 405
            res.end(JSON.stringify({ error: 'Method Not Allowed' }))
            return
          }

          const allowedRaw = process.env.UPSTREAM_ALLOWED_SIGNERS ?? ''
          if (!allowedRaw) {
            res.statusCode = 503
            res.end(JSON.stringify({ error: 'UPSTREAM_ALLOWED_SIGNERS not configured on server' }))
            return
          }

          const rootDomain = process.env.VITE_ROOT_DOMAIN || ''
          if (!rootDomain) {
            res.statusCode = 503
            res.end(JSON.stringify({ error: 'VITE_ROOT_DOMAIN not configured on server' }))
            return
          }

          if (url !== '/register') {
            res.statusCode = 404
            res.end(JSON.stringify({ error: `Unknown endpoint: /api/v1${url}` }))
            return
          }

          const body = await readBody(anyReq)
          const payload = JSON.parse(body || '{}')
          const allowedSigners = allowedRaw.split(',').map((a: string) => a.trim())

          try {
            const { handleV1Register } = await import('./server/gateway/v1/register')
            const writer = await buildWriter()
            const result = await handleV1Register(payload, allowedSigners, rootDomain, writer)
            res.statusCode = 200
            res.end(JSON.stringify(result))
          } catch (e: any) {
            res.statusCode = e?.status ?? 400
            res.end(JSON.stringify({ error: e?.message ?? String(e) }))
          }
        })

        server.middlewares.use('/api/manage', async (req, res) => {
          const anyReq = req as any
          const url = String(anyReq.url || '')

          res.setHeader('content-type', 'application/json')

          // ── GET /api/manage/check-label?label=alice&parent=aastar.eth ────
          if (anyReq.method === 'GET' && url.startsWith('/check-label')) {
            const qs = new URLSearchParams(url.split('?')[1] ?? '')
            const label = qs.get('label')?.trim().toLowerCase()
            const parent = qs.get('parent')?.trim()
            if (!label || !parent) {
              res.statusCode = 400
              res.end(JSON.stringify({ error: 'Missing label or parent param' }))
              return
            }
            try {
              const { namehash: nh } = await import('viem/ens')
              const { createPublicClient, http: viemHttp } = await import('viem')
              const { optimismSepolia: opSep } = await import('viem/chains')
              const l2Addr = (process.env.OP_L2_RECORDS_ADDRESS ?? process.env.VITE_L2_RECORDS_ADDRESS ?? '') as `0x${string}`
              const l2Rpc  = process.env.OP_SEPOLIA_RPC_URL ?? process.env.L2_RPC_URL ?? ''
              const node = nh(`${label}.${parent}`) as `0x${string}`
              const pubClient = createPublicClient({ chain: opSep, transport: viemHttp(l2Rpc) })
              const owner = await pubClient.readContract({ address: l2Addr, abi: L2_READ_ABI, functionName: 'subnodeOwner', args: [node] })
              const taken = owner !== '0x0000000000000000000000000000000000000000'
              res.statusCode = 200
              res.end(JSON.stringify({ available: !taken, owner: taken ? owner : null }))
            } catch (e) {
              res.statusCode = 500
              res.end(JSON.stringify({ error: (e as Error).message }))
            }
            return
          }

          // ── GET /api/manage/lookup?address=0x... ───────────────────────────
          if (anyReq.method === 'GET' && url.startsWith('/lookup')) {
            const qs = new URLSearchParams(url.split('?')[1] ?? '')
            const address = qs.get('address')?.toLowerCase()
            if (!address) {
              res.statusCode = 400
              res.end(JSON.stringify({ error: 'Missing address param' }))
              return
            }
            const label = registrationRegistry.get(address)
            if (!label) {
              res.statusCode = 404
              res.end(JSON.stringify({ found: false }))
              return
            }
            // Verify the cached entry still exists on-chain (guards against stale cache after redeployment)
            try {
              const { createPublicClient, http: viemHttp, isAddress } = await import('viem')
              const { optimismSepolia: opSep } = await import('viem/chains')
              if (isAddress(address)) {
                const l2Addr = (process.env.OP_L2_RECORDS_ADDRESS ?? process.env.VITE_L2_RECORDS_ADDRESS ?? '') as `0x${string}`
                const l2Rpc  = process.env.OP_SEPOLIA_RPC_URL ?? process.env.L2_RPC_URL ?? ''
                const pub = createPublicClient({ chain: opSep, transport: viemHttp(l2Rpc) })
                const existingNode = await pub.readContract({
                  address: l2Addr, abi: L2_READ_ABI, functionName: 'primaryNode', args: [address as `0x${string}`],
                })
                if (existingNode === '0x0000000000000000000000000000000000000000000000000000000000000000') {
                  // Stale cache entry (e.g. after contract redeployment) — purge and report not found
                  registrationRegistry.delete(address)
                  try { writeFileSync(REGISTRY_FILE, JSON.stringify(Object.fromEntries(registrationRegistry), null, 2)) } catch {}
                  res.statusCode = 404
                  res.end(JSON.stringify({ found: false }))
                  return
                }
              }
            } catch { /* chain unreachable — fall through to return cached value */ }
            const rootDomain = process.env.VITE_ROOT_DOMAIN || ''
            const fullName = `${label}.${rootDomain}`
            res.statusCode = 200
            res.end(JSON.stringify({ found: true, label, fullName }))
            return
          }

          if (anyReq.method !== 'POST') {
            res.statusCode = 405
            res.end(JSON.stringify({ error: 'Method Not Allowed' }))
            return
          }

          const body = await readBody(anyReq)

          try {
            const payload = JSON.parse(body || '{}') as any
            const { verifyTypedData, isAddress, isHex } = await import('viem')
            const { buildDomain, RegisterTypes, SetAddrTypes, SetTextTypes } = await import('./server/gateway/manage/schemas')
            const { optimismSepolia, optimism } = await import('viem/chains')

            const from = payload.from as string | undefined
            if (!from || !isAddress(from)) throw new Error('Invalid from address')

            const signature = payload.signature as `0x${string}` | undefined
            if (!signature || !isHex(signature)) throw new Error('Missing or invalid signature')

            const verifyingContract = (
              payload.domain?.verifyingContract ??
              payload.verifyingContract ??
              '0x0000000000000000000000000000000000000000'
            ) as `0x${string}`
            if (!isAddress(verifyingContract)) throw new Error('Invalid verifyingContract')

            const network = process.env.VITE_NETWORK || 'op-sepolia'
            const chainId = network === 'op-mainnet' ? optimism.id : optimismSepolia.id
            const domain = buildDomain(chainId, verifyingContract)

            if (url === '/set-addr') {
              const msg = payload.message ?? {}

              if (!isHex(msg.node)) throw new Error('Invalid node')
              if (!isAddress(msg.addr)) throw new Error('Invalid addr')

              const message = {
                node: msg.node as `0x${string}`,
                coinType: asBigInt(msg.coinType),
                addr: msg.addr as `0x${string}`,
                nonce: asBigInt(msg.nonce),
                deadline: asBigInt(msg.deadline),
              }

              checkDeadline(message.deadline)

              const ok = await verifyTypedData({
                address: from,
                domain,
                primaryType: 'SetAddr',
                types: SetAddrTypes as any,
                message: message as any,
                signature,
              })
              if (!ok) throw new Error('Invalid signature')

              const txHash = await withWriter(async (writer) =>
                writer.setAddr(message.node, message.coinType, message.addr)
              )

              res.statusCode = 200
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify({ ok, action: 'set-addr', txHash }))
              return
            }

            if (url === '/register') {
              const msg = payload.message ?? {}

              if (typeof msg.parent !== 'string' || !msg.parent) throw new Error('Invalid parent')
              if (typeof msg.label !== 'string' || !msg.label) throw new Error('Invalid label')
              if (!isAddress(msg.owner)) throw new Error('Invalid owner')

              const message = {
                parent: msg.parent as string,
                label: msg.label as string,
                owner: msg.owner as `0x${string}`,
                nonce: asBigInt(msg.nonce),
                deadline: asBigInt(msg.deadline),
              }

              checkDeadline(message.deadline)

              const ok = await verifyTypedData({
                address: from,
                domain,
                primaryType: 'Register',
                types: RegisterTypes as any,
                message: message as any,
                signature,
              })
              if (!ok) throw new Error('Invalid signature')

              // ── Duplicate checks (before executing) ───────────────────────
              const { namehash: nh, labelhash: lh } = await import('viem/ens')
              const { createPublicClient, http: viemHttp } = await import('viem')
              const { optimismSepolia: opSep } = await import('viem/chains')

              const l2Addr = (process.env.OP_L2_RECORDS_ADDRESS ?? process.env.VITE_L2_RECORDS_ADDRESS ?? '') as `0x${string}`
              const l2Rpc  = process.env.OP_SEPOLIA_RPC_URL ?? process.env.L2_RPC_URL ?? ''
              const pubClient = createPublicClient({ chain: opSep, transport: viemHttp(l2Rpc) })

              const parentNode = nh(message.parent) as `0x${string}`
              const labelHash  = lh(message.label)  as `0x${string}`
              const node       = nh(`${message.label}.${message.parent}`) as `0x${string}`

              // Check 1: label already taken
              const existingOwner = await pubClient.readContract({
                address: l2Addr, abi: L2_READ_ABI, functionName: 'subnodeOwner', args: [node],
              })
              if (existingOwner !== '0x0000000000000000000000000000000000000000') {
                res.statusCode = 409
                res.setHeader('content-type', 'application/json')
                res.end(JSON.stringify({
                  error: `Label "${message.label}" is already registered under ${message.parent}`,
                  code: 'LABEL_TAKEN',
                }))
                return
              }

              // Check 2: wallet already has a registration (primaryNode is set on first registration)
              const existingPrimaryNode = await pubClient.readContract({
                address: l2Addr, abi: L2_READ_ABI, functionName: 'primaryNode', args: [from as `0x${string}`],
              })
              if (existingPrimaryNode !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
                res.statusCode = 409
                res.setHeader('content-type', 'application/json')
                res.end(JSON.stringify({
                  error: `This wallet has already registered a subdomain under ${message.parent}`,
                  code: 'ALREADY_REGISTERED',
                  node: existingPrimaryNode,
                }))
                return
              }

              // Single transaction: register subdomain + set ETH addr record atomically
              const { toHex, toBytes } = await import('viem')
              const addrBytes = toHex(toBytes(message.owner), { size: 20 }) as `0x${string}`
              const txHash = await withWriter((writer) =>
                writer.registerSubnode(parentNode, labelHash, message.owner, message.label, addrBytes)
              )

              // Persist owner → label mapping so lookup can return the human-readable name
              saveToRegistry(message.owner, message.label)

              res.statusCode = 200
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify({ ok, action: 'register', txHash }))
              return
            }

            if (url === '/set-text') {
              const msg = payload.message ?? {}

              if (!isHex(msg.node)) throw new Error('Invalid node')
              if (typeof msg.key !== 'string' || !msg.key) throw new Error('Invalid key')
              if (typeof msg.value !== 'string') throw new Error('Invalid value')

              const message = {
                node: msg.node as `0x${string}`,
                key: msg.key as string,
                value: msg.value as string,
                nonce: asBigInt(msg.nonce),
                deadline: asBigInt(msg.deadline),
              }

              checkDeadline(message.deadline)

              const ok = await verifyTypedData({
                address: from,
                domain,
                primaryType: 'SetText',
                types: SetTextTypes as any,
                message: message as any,
                signature,
              })
              if (!ok) throw new Error('Invalid signature')

              const txHash = await withWriter(async (writer) =>
                writer.setText(message.node, message.key, message.value)
              )

              res.statusCode = 200
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify({ ok, action: 'set-text', txHash }))
              return
            }

            res.statusCode = 404
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ error: 'Unknown manage endpoint' }))
          } catch (e) {
            res.statusCode = 400
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
          }
        })
      },
    },
  ],
  server: {
    port: 4173,
    strictPort: true,
  },
  }
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readBody(req: any): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'))
        return
      }
      data += chunk.toString()
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function asBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(value)
  if (typeof value === 'string') return BigInt(value)
  throw new Error('Invalid bigint field')
}

function checkDeadline(deadline: bigint): void {
  const now = BigInt(Math.floor(Date.now() / 1000))
  if (deadline < now) throw new Error('Expired')
}

async function buildWriter(): Promise<import('./server/gateway/writer/L2RecordsWriter').L2RecordsWriter | undefined> {
  const workerPk = process.env.WORKER_EOA_PRIVATE_KEY as `0x${string}` | undefined
  if (!workerPk) return undefined

  const { privateKeyToAccount } = await import('viem/accounts')
  const { L2RecordsWriter } = await import('./server/gateway/writer/L2RecordsWriter')
  const { optimismSepolia } = await import('viem/chains')

  const workerAccount = privateKeyToAccount(workerPk)
  const l2Address = (
    process.env.OP_L2_RECORDS_ADDRESS ??
    process.env.VITE_L2_RECORDS_ADDRESS ??
    '0x0000000000000000000000000000000000000000'
  ) as `0x${string}`
  const rpcUrl = process.env.OP_SEPOLIA_RPC_URL ?? process.env.L2_RPC_URL ?? ''

  return new L2RecordsWriter(workerAccount, optimismSepolia, rpcUrl, l2Address)
}

async function withWriter<T>(
  fn: (writer: import('./server/gateway/writer/L2RecordsWriter').L2RecordsWriter) => Promise<T>
): Promise<T | undefined> {
  const writer = await buildWriter()
  if (!writer) return undefined
  return fn(writer)
}
