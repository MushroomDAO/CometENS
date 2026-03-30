import { defineConfig } from 'vite'

const MAX_BODY_BYTES = 10 * 1024 // 10 KB

export default defineConfig({
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

          const body = await readBody(anyReq)

          try {
            const { isAddress, namehash, labelhash, recoverMessageAddress } = await import('viem')
            const payload = JSON.parse(body || '{}') as {
              label?: string
              owner?: string
              addr?: string
              timestamp?: number
              signature?: `0x${string}`
            }

            // ── Signature-based authentication ────────────────────────────────
            const allowedRaw = process.env.UPSTREAM_ALLOWED_SIGNERS ?? ''
            if (!allowedRaw) {
              res.statusCode = 503
              res.end(JSON.stringify({ error: 'UPSTREAM_ALLOWED_SIGNERS not configured on server' }))
              return
            }
            const allowedSigners = allowedRaw.split(',').map((a) => a.trim().toLowerCase())

            const { signature, timestamp } = payload
            if (!signature || !signature.startsWith('0x')) {
              res.statusCode = 401
              res.end(JSON.stringify({ error: 'Missing signature' }))
              return
            }
            if (!timestamp || typeof timestamp !== 'number') {
              res.statusCode = 400
              res.end(JSON.stringify({ error: 'Missing or invalid timestamp' }))
              return
            }

            // Anti-replay: timestamp must be within ±60 seconds of server time
            const drift = Math.abs(Math.floor(Date.now() / 1000) - timestamp)
            if (drift > 60) {
              res.statusCode = 401
              res.end(JSON.stringify({ error: `Timestamp drift too large (${drift}s). Must be within 60s of server time.` }))
              return
            }

            const label = payload.label?.trim().toLowerCase()
            if (!label || !/^[a-z0-9-]{1,63}$/.test(label)) {
              throw new Error('Invalid label: must be 1-63 lowercase alphanumeric or hyphen chars')
            }
            const owner = payload.owner as `0x${string}` | undefined
            if (!owner || !isAddress(owner)) {
              throw new Error('Invalid owner: must be a valid Ethereum address')
            }

            // Recover signer from canonical message
            const message = `CometENS:register:${label}:${owner}:${timestamp}`
            const recovered = await recoverMessageAddress({ message, signature })
            if (!allowedSigners.includes(recovered.toLowerCase())) {
              res.statusCode = 401
              res.end(JSON.stringify({ error: `Signer ${recovered} is not in the allowed list` }))
              return
            }

            const rootDomain = process.env.VITE_ROOT_DOMAIN || ''
            if (!rootDomain) throw new Error('VITE_ROOT_DOMAIN not configured on server')

            if (url === '/register') {
              const parentNode = namehash(rootDomain) as `0x${string}`
              const lh = labelhash(label) as `0x${string}`
              const fullName = `${label}.${rootDomain}`
              const node = namehash(fullName) as `0x${string}`

              // Register subdomain (setSubnodeOwner on L2)
              const txHash = await withWriter((writer) =>
                writer.setSubnodeOwner(parentNode, lh, owner, label)
              )

              // Optionally set ETH addr record in the same call sequence
              const addrTarget = (payload.addr ?? owner) as `0x${string}`
              if (addrTarget && isAddress(addrTarget)) {
                const { toHex, toBytes } = await import('viem')
                const addrBytes = toHex(toBytes(addrTarget), { size: 20 }) as `0x${string}`
                await withWriter((writer) => writer.setAddr(node, 60n, addrBytes))
              }

              res.statusCode = 200
              res.end(JSON.stringify({ ok: true, name: fullName, node, txHash }))
              return
            }

            res.statusCode = 404
            res.end(JSON.stringify({ error: `Unknown endpoint: /api/v1${url}` }))
          } catch (e) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
          }
        })

        server.middlewares.use('/api/manage', async (req, res) => {
          const anyReq = req as any
          const url = String(anyReq.url || '')

          if (anyReq.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('content-type', 'application/json')
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

              const txHash = await withWriter(async (writer) => {
                const { namehash, labelhash } = await import('viem/ens')
                const parentNode = namehash(message.parent) as `0x${string}`
                const labelHash = labelhash(message.label) as `0x${string}`
                return writer.setSubnodeOwner(parentNode, labelHash, message.owner, message.label)
              })

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

async function withWriter<T>(
  fn: (writer: import('./server/gateway/writer/L2RecordsWriter').L2RecordsWriter) => Promise<T>
): Promise<T | undefined> {
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

  const writer = new L2RecordsWriter(workerAccount, optimismSepolia, rpcUrl, l2Address)
  return fn(writer)
}
