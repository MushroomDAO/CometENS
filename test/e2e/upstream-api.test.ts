/**
 * E2E Test: /api/v1/register upstream API — full flow with local Anvil + HTTP server.
 *
 * Flow:
 *   1. Start Anvil on port 18549 and deploy L2Records
 *   2. Start the gateway HTTP server (handles /api/v1/register)
 *   3. Upstream app generates keypair, signs canonical message
 *   4. POST /api/v1/register → gateway registers subdomain on L2
 *   5. Verify subdomain owner + addr on L2Records
 *   6. Test auth rejection cases (wrong signer, stale timestamp, tampered label)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  createPublicClient,
  createWalletClient,
  http,
  namehash,
  type Hex,
  type Address,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { spawn, type ChildProcess } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createServer, type Server } from 'http'

// ─── Config ───────────────────────────────────────────────────────────────────

const ANVIL_PORT = 18549
const GW_PORT    = 18550
const CONTRACTS_DIR = join(import.meta.dirname, '..', '..', 'contracts')
const ROOT_DOMAIN = 'aastar.eth'

// Anvil well-known test accounts
const DEPLOYER_PK   = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex
const UPSTREAM_PK   = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as Hex
const UNTRUSTED_PK  = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' as Hex

const deployer   = privateKeyToAccount(DEPLOYER_PK)
const upstream   = privateKeyToAccount(UPSTREAM_PK)
const untrusted  = privateKeyToAccount(UNTRUSTED_PK)

const anvilChain = {
  ...foundry,
  id: 31337,
  rpcUrls: { default: { http: [`http://127.0.0.1:${ANVIL_PORT}`] } },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function waitForPort(port: number, retries = 30): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      })
      if (res.ok) return
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error(`Port ${port} not ready`)
}

async function deployL2Records(): Promise<Address> {
  const artifact = JSON.parse(
    readFileSync(join(CONTRACTS_DIR, 'out', 'L2Records.sol', 'L2Records.json'), 'utf8')
  )
  const wallet = createWalletClient({ account: deployer, chain: anvilChain, transport: http(`http://127.0.0.1:${ANVIL_PORT}`) })
  const pub    = createPublicClient({ chain: anvilChain, transport: http(`http://127.0.0.1:${ANVIL_PORT}`) })
  const txHash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [deployer.address] })
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash })
  if (!receipt.contractAddress) throw new Error('Deploy failed')
  return receipt.contractAddress
}

/** Canonical message format for upstream API auth */
function signatureMessage(label: string, owner: string, timestamp: number): string {
  return `CometENS:register:${label}:${owner}:${timestamp}`
}

// ─── Gateway server (uses the real shared handler, same as vite.config.ts) ───

function startApiServer(l2RecordsAddr: Address, allowedSigners: Address[]): Server {
  return createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json')

    if (req.method !== 'POST') {
      res.writeHead(405); res.end(JSON.stringify({ error: 'Method Not Allowed' })); return
    }

    const body = await new Promise<string>((resolve) => {
      let raw = ''
      req.on('data', (c: Buffer) => { raw += c.toString() })
      req.on('end', () => resolve(raw))
    })

    try {
      const { handleV1Register } = await import('../../server/gateway/v1/register')
      const { L2RecordsWriter } = await import('../../server/gateway/writer/L2RecordsWriter')
      const writer = new L2RecordsWriter(deployer, anvilChain, `http://127.0.0.1:${ANVIL_PORT}`, l2RecordsAddr)
      const payload = JSON.parse(body)
      const result = await handleV1Register(payload, allowedSigners as string[], ROOT_DOMAIN, writer)
      res.writeHead(200)
      res.end(JSON.stringify(result))
    } catch (e: any) {
      res.writeHead(e?.status ?? 400)
      res.end(JSON.stringify({ error: e?.message ?? String(e) }))
    }
  })
}

// ─── L2Records read ABI ───────────────────────────────────────────────────────

const L2_ABI = [
  { type: 'function', name: 'subnodeOwner', stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'addr', stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }] },
] as const

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('E2E: /api/v1/register upstream API', () => {
  let anvil: ChildProcess
  let server: Server
  let l2RecordsAddr: Address
  let l2Pub: ReturnType<typeof createPublicClient>

  const ALICE: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

  beforeAll(async () => {
    anvil = spawn('anvil', ['--port', String(ANVIL_PORT), '--silent'])
    await waitForPort(ANVIL_PORT)

    l2RecordsAddr = await deployL2Records()
    l2Pub = createPublicClient({ chain: anvilChain, transport: http(`http://127.0.0.1:${ANVIL_PORT}`) })

    // Only upstream app's address is in the whitelist
    server = startApiServer(l2RecordsAddr, [upstream.address])
    await new Promise<void>(resolve => server.listen(GW_PORT, '127.0.0.1', resolve))
  }, 30_000)

  afterAll(() => {
    anvil?.kill()
    server?.close()
  })

  it('registers a subdomain when signed by an allowed upstream app', async () => {
    const label = 'alice'
    const timestamp = Math.floor(Date.now() / 1000)
    const message = signatureMessage(label, ALICE, timestamp)
    const signature = await upstream.signMessage({ message })

    const res = await fetch(`http://127.0.0.1:${GW_PORT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label, owner: ALICE, timestamp, signature }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ok).toBe(true)
    expect(body.name).toBe(`alice.${ROOT_DOMAIN}`)
    expect(body.txHash).toMatch(/^0x/)

    // Verify on-chain: subdomain owner
    const node = namehash(`alice.${ROOT_DOMAIN}`) as Hex
    const owner = await l2Pub.readContract({
      address: l2RecordsAddr, abi: L2_ABI, functionName: 'subnodeOwner', args: [node],
    })
    expect(owner.toLowerCase()).toBe(ALICE.toLowerCase())

    // Verify on-chain: ETH addr record (defaults to owner)
    const addr = await l2Pub.readContract({
      address: l2RecordsAddr, abi: L2_ABI, functionName: 'addr', args: [node],
    })
    expect(addr.toLowerCase()).toBe(ALICE.toLowerCase())
  }, 30_000)

  it('registers with a custom addr different from owner', async () => {
    const label = 'bob'
    const BOB_ADDR: Address = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
    const CUSTOM_ADDR: Address = '0x90F79bf6EB2c4f870365E785982E1f101E93b906'
    const timestamp = Math.floor(Date.now() / 1000)
    const message = signatureMessage(label, BOB_ADDR, timestamp)
    const signature = await upstream.signMessage({ message })

    const res = await fetch(`http://127.0.0.1:${GW_PORT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label, owner: BOB_ADDR, addr: CUSTOM_ADDR, timestamp, signature }),
    })
    expect(res.status).toBe(200)

    const node = namehash(`bob.${ROOT_DOMAIN}`) as Hex
    const addr = await l2Pub.readContract({
      address: l2RecordsAddr, abi: L2_ABI, functionName: 'addr', args: [node],
    })
    expect(addr.toLowerCase()).toBe(CUSTOM_ADDR.toLowerCase())
  }, 30_000)

  it('rejects a request signed by an address not in the whitelist', async () => {
    const label = 'carol'
    const timestamp = Math.floor(Date.now() / 1000)
    const message = signatureMessage(label, ALICE, timestamp)
    const signature = await untrusted.signMessage({ message }) // not in whitelist

    const res = await fetch(`http://127.0.0.1:${GW_PORT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label, owner: ALICE, timestamp, signature }),
    })
    expect(res.status).toBe(401)
    const body = await res.json() as any
    expect(body.error).toMatch(/not in the allowed list/)
  })

  it('rejects a request with a stale timestamp (anti-replay)', async () => {
    const label = 'dave'
    const staleTimestamp = Math.floor(Date.now() / 1000) - 90 // 90s ago
    const message = signatureMessage(label, ALICE, staleTimestamp)
    const signature = await upstream.signMessage({ message })

    const res = await fetch(`http://127.0.0.1:${GW_PORT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label, owner: ALICE, timestamp: staleTimestamp, signature }),
    })
    expect(res.status).toBe(401)
    const body = await res.json() as any
    expect(body.error).toMatch(/Timestamp drift/)
  })

  it('rejects a signature over tampered label (binding check)', async () => {
    const timestamp = Math.floor(Date.now() / 1000)
    // Sign for "frank" but send "evil" as label
    const message = signatureMessage('frank', ALICE, timestamp)
    const signature = await upstream.signMessage({ message })

    const res = await fetch(`http://127.0.0.1:${GW_PORT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'evil', owner: ALICE, timestamp, signature }),
    })
    expect(res.status).toBe(401)
    const body = await res.json() as any
    expect(body.error).toMatch(/not in the allowed list/)
  })

  it('rejects a request with missing signature', async () => {
    const res = await fetch(`http://127.0.0.1:${GW_PORT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'grace', owner: ALICE, timestamp: Math.floor(Date.now() / 1000) }),
    })
    expect(res.status).toBe(401)
  })

  it('rejects an invalid label format', async () => {
    const timestamp = Math.floor(Date.now() / 1000)
    const label = 'hello world'  // spaces not allowed
    const message = signatureMessage(label, ALICE, timestamp)
    const signature = await upstream.signMessage({ message })

    const res = await fetch(`http://127.0.0.1:${GW_PORT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label, owner: ALICE, timestamp, signature }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.error).toMatch(/Invalid label/)
  })
})
