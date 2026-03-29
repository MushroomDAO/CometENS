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
                return writer.setSubnodeOwner(parentNode, labelHash, message.owner)
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
