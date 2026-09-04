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
  labelhash,
  type Hex,
  type Address,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { spawn, type ChildProcess } from 'child_process'
import { readFileSync } from 'fs'
import { loadArtifact } from './artifacts'
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

/**
 * The artifact this suite deploys. MUST be the contract production runs.
 *
 * This used to deploy `L2Records` (V1). V1 has no `AlreadyRegistered` guard, so a duplicate
 * registration succeeded here and the suite reported a "production bug" that production does
 * not have — it was verifying production behaviour on a contract production stopped using.
 * A green test proved something true about V1 and nothing about the deployed system.
 */
const PRODUCTION_CONTRACT = 'L2RecordsV3'

async function deployL2Records(): Promise<Address> {
  return deployArtifact(PRODUCTION_CONTRACT)
}

async function deployArtifact(name: string): Promise<Address> {
  const artifact = loadArtifact(CONTRACTS_DIR, name)
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
      const result = await handleV1Register(payload, allowedSigners as string[], ROOT_DOMAIN, writer, async (node) =>
        (await createPublicClient({ chain: anvilChain, transport: http(`http://127.0.0.1:${ANVIL_PORT}`) })
          .readContract({ address: l2RecordsAddr, abi: L2_ABI, functionName: 'subnodeOwner', args: [node] })) as string,
      )
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

const L2_WRITE_ABI = [
  { type: 'function', name: 'registerSubnode', stateMutability: 'nonpayable',
    inputs: [
      { name: 'parentNode', type: 'bytes32' }, { name: 'labelhash', type: 'bytes32' },
      { name: 'newOwner', type: 'address' }, { name: 'label', type: 'string' },
      { name: 'addrBytes', type: 'bytes' },
    ], outputs: [] },
] as const

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

  // ─── Branches T1.3.3 found uncovered ───────────────────────────────────────

  it('CONTROL: an unregistered name reads back as the zero address', async () => {
    // Without this, every "subnodeOwner == ALICE" assertion above could be passing because
    // the read is broken and returns something constant. It has to be able to say "nobody".
    const node = namehash(`nobody-registered-this.${ROOT_DOMAIN}`) as Hex
    const owner = await l2Pub.readContract({
      address: l2RecordsAddr, abi: L2_ABI, functionName: 'subnodeOwner', args: [node],
    })
    expect(owner).toBe('0x0000000000000000000000000000000000000000')
  }, 30_000)

  it('IGNORES a caller-supplied parent — the root domain is server-side, not negotiable', async () => {
    // The worker EOA is the contract owner and can write under ANY parentNode on-chain, so if
    // this endpoint honoured a caller's `parent` an upstream app could mint under vitalik.eth.
    // It does not: the parent comes from ROOT_DOMAIN and the field is not read at all.
    const label = 'squatted'
    const timestamp = Math.floor(Date.now() / 1000)
    const signature = await upstream.signMessage({ message: signatureMessage(label, ALICE, timestamp) })

    const res = await fetch(`http://127.0.0.1:${GW_PORT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label, owner: ALICE, timestamp, signature, parent: 'vitalik.eth' }),
    })
    const body = await res.json() as any
    expect(body.name).toBe(`${label}.${ROOT_DOMAIN}`)

    const underVitalik = await l2Pub.readContract({
      address: l2RecordsAddr, abi: L2_ABI, functionName: 'subnodeOwner',
      args: [namehash(`${label}.vitalik.eth`) as Hex],
    })
    expect(underVitalik).toBe('0x0000000000000000000000000000000000000000')

    // CONTROL: it really did register — otherwise "nothing under vitalik.eth" would be true
    // for the boring reason that nothing happened at all.
    const underRoot = await l2Pub.readContract({
      address: l2RecordsAddr, abi: L2_ABI, functionName: 'subnodeOwner',
      args: [namehash(`${label}.${ROOT_DOMAIN}`) as Hex],
    })
    expect((underRoot as string).toLowerCase()).toBe(ALICE.toLowerCase())
  }, 30_000)

  it('rejects a label that is already taken, and leaves the first owner intact', async () => {
    const label = 'contested'
    const first = Math.floor(Date.now() / 1000)
    const sig1 = await upstream.signMessage({ message: signatureMessage(label, ALICE, first) })
    const res1 = await fetch(`http://127.0.0.1:${GW_PORT}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label, owner: ALICE, timestamp: first, signature: sig1 }),
    })
    expect(res1.status).toBe(200)

    const OTHER: Address = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
    const second = Math.floor(Date.now() / 1000)
    const sig2 = await upstream.signMessage({ message: signatureMessage(label, OTHER, second) })
    const res2 = await fetch(`http://127.0.0.1:${GW_PORT}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label, owner: OTHER, timestamp: second, signature: sig2 }),
    })
    expect(res2.status).toBe(409)

    // THE POINT, and what this endpoint used to do: return 200 ok:true and hand ALICE's name
    // to OTHER. A status-only assertion would not have caught that — the transfer is what
    // matters, and it contradicts the one thing this product promises about subdomains.
    const node = namehash(`${label}.${ROOT_DOMAIN}`) as Hex
    const owner = await l2Pub.readContract({
      address: l2RecordsAddr, abi: L2_ABI, functionName: 'subnodeOwner', args: [node],
    })
    expect((owner as string).toLowerCase()).toBe(ALICE.toLowerCase())
  }, 30_000)

  it('re-registering to the SAME owner is idempotent, not an error (control)', async () => {
    // Upstream systems retry. A duplicate job must not become an error the integrator has to
    // special-case — and without this control, "refuse every existing label" would pass the
    // test above while breaking every at-least-once delivery pipeline.
    const label = 'idempotent'
    const t1 = Math.floor(Date.now() / 1000)
    const r1 = await fetch(`http://127.0.0.1:${GW_PORT}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label, owner: ALICE, timestamp: t1, signature: await upstream.signMessage({ message: signatureMessage(label, ALICE, t1) }) }),
    })
    expect(r1.status).toBe(200)

    const t2 = Math.floor(Date.now() / 1000)
    const r2 = await fetch(`http://127.0.0.1:${GW_PORT}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label, owner: ALICE, timestamp: t2, signature: await upstream.signMessage({ message: signatureMessage(label, ALICE, t2) }) }),
    })
    expect(r2.status).toBe(200)
    const body2 = await r2.json() as any
    // Distinguishable from a fresh registration: no tx was sent, and it says so.
    expect(body2.alreadyRegistered).toBe(true)
    expect(body2.txHash).toBeUndefined()

    // CONTROL: a FIRST registration must carry a txHash. Without this, an implementation that
    // never returned one would satisfy the assertion above — "no txHash" would stop meaning
    // "nothing was written" and start meaning nothing at all.
    const body1 = await r1.json() as any
    expect(body1.txHash).toMatch(/^0x/)
    expect(body1.alreadyRegistered).toBeUndefined()
  }, 30_000)

  it('CONTROL FOR THE CONTROL: V1 does NOT have that invariant, so the check above discriminates', async () => {
    // pr-daemon: 判据本身也需要判据. The invariant test above is the only assertion in this
    // file that can tell V1 from V3 — every other test passes on both, because they exercise
    // API behaviour that is identical either way. That makes it load-bearing and therefore
    // worth pinning: if it ever started passing on V1 too, it would have quietly degraded into
    // "green on any contract" and this suite would be back to proving nothing about production.
    //
    // Deploying V1 here and asserting the duplicate SUCCEEDS is the direct evidence that the
    // assertion above measures the difference rather than something both versions share.
    const v1 = await deployArtifact('L2Records')
    const label = 'v1-has-no-invariant'
    const parentNode = namehash(ROOT_DOMAIN) as Hex
    const lh = labelhash(label) as Hex
    const wallet = createWalletClient({ account: deployer, chain: anvilChain, transport: http(`http://127.0.0.1:${ANVIL_PORT}`) })
    const args = [parentNode, lh, ALICE, label, ALICE] as const

    const first = await wallet.writeContract({ address: v1, abi: L2_WRITE_ABI, functionName: 'registerSubnode', args })
    await l2Pub.waitForTransactionReceipt({ hash: first })

    // On V1 this second call goes through. That is the behaviour that produced the original
    // false "production bug" report.
    const second = await wallet.writeContract({ address: v1, abi: L2_WRITE_ABI, functionName: 'registerSubnode', args })
    const receipt = await l2Pub.waitForTransactionReceipt({ hash: second })
    expect(receipt.status).toBe('success')
  }, 30_000)

  it('CONTRACT INVARIANT: the deployed artifact itself rejects a duplicate registration', async () => {
    // The check that would have caught deploying V1 here. The API-level guard short-circuits
    // before the contract is reached, so without this the suite could keep running against a
    // contract that has no AlreadyRegistered guard and never notice — which is exactly what
    // happened, and it produced a "production bug" report about a bug production does not have.
    const label = 'invariant-probe'
    const parentNode = namehash(ROOT_DOMAIN) as Hex
    const lh = labelhash(label) as Hex
    const wallet = createWalletClient({ account: deployer, chain: anvilChain, transport: http(`http://127.0.0.1:${ANVIL_PORT}`) })

    const args = [parentNode, lh, ALICE, label, ALICE] as const
    const first = await wallet.writeContract({
      address: l2RecordsAddr, abi: L2_WRITE_ABI, functionName: 'registerSubnode', args,
    })
    await l2Pub.waitForTransactionReceipt({ hash: first })

    // CONTROL: the first one really did register — otherwise the rejection below could be
    // failing for some unrelated reason.
    const owner = await l2Pub.readContract({
      address: l2RecordsAddr, abi: L2_ABI, functionName: 'subnodeOwner',
      args: [namehash(`${label}.${ROOT_DOMAIN}`) as Hex],
    })
    expect((owner as string).toLowerCase()).toBe(ALICE.toLowerCase())

    // The deployer IS the contract owner here. Owner bypasses authorisation checks
    // (onlyOwnerOrRegistrar, quota, expiry) — but AlreadyRegistered is not an authorisation
    // check, it is a state invariant, and nobody bypasses it. "May you do this" and "is this
    // legal" are different questions.
    await expect(
      wallet.writeContract({ address: l2RecordsAddr, abi: L2_WRITE_ABI, functionName: 'registerSubnode', args }),
    ).rejects.toThrow()
  }, 30_000)
})
