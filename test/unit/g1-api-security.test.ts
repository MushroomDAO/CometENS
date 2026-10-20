import { beforeEach, describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { optimismSepolia } from 'viem/chains'
import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData } from 'viem'
import { buildDomain, ApplyTypes, RegisterTypes } from '../../server/gateway/manage/schemas'
import { L2RecordsV2ABI } from '../../server/gateway/abi'

const CONTRACT = '0x1111111111111111111111111111111111111111' as const
const RESOLVER = '0x2222222222222222222222222222222222222222' as const
const OTHER = '0x3333333333333333333333333333333333333333' as const
const NODE = `0x${'22'.repeat(32)}` as const
const account = privateKeyToAccount(`0x${'44'.repeat(32)}`)

const { readContract } = vi.hoisted(() => ({ readContract: vi.fn() }))
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  return {
    ...actual,
    createPublicClient: vi.fn().mockReturnValue({ readContract }),
    http: vi.fn().mockReturnValue({}),
  }
})

function kv() {
  const map = new Map<string, string>()
  return {
    get: vi.fn(async (key: string) => map.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { map.set(key, value) }),
    delete: vi.fn(async (key: string) => { map.delete(key) }),
    list: vi.fn(async () => ({ keys: [], list_complete: true })),
  }
}

function apiEnv(extra: Record<string, unknown> = {}) {
  return {
    NETWORK: 'op-sepolia', L2_RECORDS_ADDRESS: CONTRACT, OP_RPC_URL: 'https://rpc.invalid',
    ROOT_DOMAIN: 'aastar.eth', ROOT_DOMAINS: 'aastar.eth', APPROVAL_MODE: 'manual',
    REGISTRY: kv(), ...extra,
  } as any
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://gateway.test${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function signed(primaryType: 'Register' | 'Apply', label = 'alice') {
  const message = {
    parent: 'aastar.eth', label, owner: account.address,
    nonce: BigInt(Date.now()), deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
  }
  const signature = await account.signTypedData({
    domain: buildDomain(optimismSepolia.id, CONTRACT),
    types: (primaryType === 'Register' ? RegisterTypes : ApplyTypes) as any,
    primaryType, message,
  })
  return { from: account.address, signature, message: {
    ...message, nonce: message.nonce.toString(), deadline: message.deadline.toString(),
  } }
}

beforeEach(() => {
  readContract.mockReset()
  readContract.mockResolvedValue('0x0000000000000000000000000000000000000000')
})

describe('G1 API root and nonce defaults', () => {
  it('rejects /register and /apply when no root is configured, before any RPC call', async () => {
    const api = (await import('../../workers/api/src/index')).default
    const env = apiEnv({ ROOT_DOMAIN: '', ROOT_DOMAINS: '' })
    const register = await api.fetch(post('/register', await signed('Register')), env)
    const apply = await api.fetch(post('/apply', await signed('Apply')), env)
    expect(register.status).toBe(503)
    expect(apply.status).toBe(503)
    expect(readContract).not.toHaveBeenCalled()
  })

  it('rejects /check-label with no allowlist instead of querying arbitrary names', async () => {
    const api = (await import('../../workers/api/src/index')).default
    const res = await api.fetch(new Request('https://api.test/check-label?label=alice&parent=other.eth'),
      apiEnv({ ROOT_DOMAIN: '', ROOT_DOMAINS: '' }))
    expect(res.status).toBe(503)
    expect(readContract).not.toHaveBeenCalled()
  })

  it('rejects a signed write without either KV binding', async () => {
    const api = (await import('../../workers/api/src/index')).default
    const response = await api.fetch(post('/apply', await signed('Apply')),
      apiEnv({ REGISTRY: undefined, RECORD_CACHE: undefined }))
    expect(response.status).toBe(503)
    expect(readContract).not.toHaveBeenCalled()
  })

  it('refuses to write when nonce KV fails and redacts backend diagnostics', async () => {
    const api = (await import('../../workers/api/src/index')).default
    const store = kv()
    store.get.mockRejectedValueOnce(new Error('https://secret.example/v2/API_KEY_SENSITIVE'))
    const response = await api.fetch(post('/apply', await signed('Apply')), apiEnv({ REGISTRY: store }))
    expect(response.status).toBe(503)
    expect(JSON.stringify(await response.json())).not.toContain('API_KEY_SENSITIVE')
    expect(store.put).not.toHaveBeenCalled()
  })

  it('rejects sequential replay of the same signed application', async () => {
    const api = (await import('../../workers/api/src/index')).default
    const env = apiEnv()
    const body = await signed('Apply')
    const first = await api.fetch(post('/apply', body), env)
    const replay = await api.fetch(post('/apply', body), env)
    expect(first.status).toBe(200)
    expect(replay.status).toBe(409)
  })

  it('enforces a request body cap without content-length header', async () => {
    const api = (await import('../../workers/api/src/index')).default
    const res = await api.fetch(post('/apply', JSON.stringify({ big: 'x'.repeat(33_000) }),
      { 'content-length': '0' }), apiEnv())
    expect(res.status).toBe(413)
  })
})

describe('G1 CCIP sender, calldata and error boundaries', () => {
  const gatewayEnv = (extra: Record<string, unknown> = {}) => ({
    NETWORK: 'op-sepolia', L2_RECORDS_ADDRESS: CONTRACT,
    OP_RPC_URL: 'https://rpc.invalid/v2/DO_NOT_DISCLOSE', ALLOWED_SENDERS: RESOLVER,
    PRIVATE_KEY_SUPPLIER: `0x${'44'.repeat(32)}`, ...extra,
  }) as any
  const calldata = encodeFunctionData({ abi: L2RecordsV2ABI, functionName: 'addr', args: [NODE] })

  it('all POST paths reject an unlisted resolver before RPC', async () => {
    const gateway = (await import('../../workers/gateway/src/index')).default
    for (const path of ['/api/ccip', '/', '/hybrid']) {
      const res = await gateway.fetch(post(path, { sender: OTHER, data: calldata }), gatewayEnv())
      expect({ path, status: res.status }).toMatchObject({ status: 403 })
    }
    expect(readContract).not.toHaveBeenCalled()
  })

  it('all POST paths require an allowlist rather than signing arbitrary resolver addresses', async () => {
    const gateway = (await import('../../workers/gateway/src/index')).default
    for (const path of ['/api/ccip', '/', '/hybrid']) {
      const res = await gateway.fetch(post(path, { sender: RESOLVER, data: calldata }), gatewayEnv({ ALLOWED_SENDERS: '' }))
      expect(res.status).toBe(503)
    }
    expect(readContract).not.toHaveBeenCalled()
  })

  it('rejects odd hex, non-address senders, and oversized JSON as client errors', async () => {
    const gateway = (await import('../../workers/gateway/src/index')).default
    expect((await gateway.fetch(post('/api/ccip', { sender: RESOLVER, data: '0x123' }), gatewayEnv())).status).toBe(400)
    expect((await gateway.fetch(post('/api/ccip', { sender: '0x123', data: calldata }), gatewayEnv())).status).toBe(400)
    expect((await gateway.fetch(post('/hybrid', { sender: RESOLVER, data: '0x123' }), gatewayEnv())).status).toBe(400)
    expect((await gateway.fetch(post('/api/ccip', { sender: RESOLVER, data: '0x' + 'ab'.repeat(33_000) }), gatewayEnv())).status).toBe(413)
    expect(readContract).not.toHaveBeenCalled()
  })

  it('rejects malformed hybrid ABI as 400 (no signer or proof operation)', async () => {
    const gateway = (await import('../../workers/gateway/src/index')).default
    const response = await gateway.fetch(post('/hybrid', { sender: RESOLVER, data: '0x12345678' }), gatewayEnv())
    expect(response.status).toBe(400)
    expect(readContract).not.toHaveBeenCalled()
  })

  it('preserves valid legacy signature and hybrid signature resolution', async () => {
    const gateway = (await import('../../workers/gateway/src/index')).default
    readContract.mockResolvedValue(account.address)
    const legacy = await gateway.fetch(post('/api/ccip', { sender: RESOLVER, data: calldata }), gatewayEnv())
    expect(legacy.status).toBe(200)
    const legacyBody = await legacy.json() as { data: string }
    expect(legacyBody.data).toMatch(/^0x[0-9a-f]+$/)

    const blob = encodeAbiParameters([
      { type: 'bytes' },
      { type: 'tuple', components: [{ name: 'ops', type: 'bytes' }] },
      { type: 'bytes' },
    ], ['0x', { ops: '0x' }, calldata])
    const hybrid = await gateway.fetch(post('/hybrid', { sender: RESOLVER, data: blob }), gatewayEnv())
    expect(hybrid.status).toBe(200)
    const hybridBody = await hybrid.json() as { data: `0x${string}` }
    const [mode] = decodeAbiParameters([{ type: 'uint8' }, { type: 'bytes' }], hybridBody.data)
    expect(mode).toBe(0) // Signature branch when hybrid proof is not configured
  })

  it('GET proof mode requires the same sender allowlist and bounded hex', async () => {
    const gateway = (await import('../../workers/gateway/src/index')).default
    const path = `/` + OTHER + '/' + calldata
    expect((await gateway.fetch(new Request('https://gateway.test' + path), gatewayEnv({ PROOF_MODE: 'true' }))).status).toBe(403)
    expect((await gateway.fetch(new Request('https://gateway.test/' + RESOLVER + '/' + calldata),
      gatewayEnv({ PROOF_MODE: 'true', ALLOWED_SENDERS: undefined }))).status).toBe(503)
    expect((await gateway.fetch(new Request('https://gateway.test/' + RESOLVER + '/0x123'),
      gatewayEnv({ PROOF_MODE: 'true' }))).status).toBe(400)
  })

  it('does not disclose backend failure messages from signature endpoint', async () => {
    const gateway = (await import('../../workers/gateway/src/index')).default
    readContract.mockRejectedValue(new Error('https://rpc.invalid/v2/DO_NOT_DISCLOSE'))
    const response = await gateway.fetch(post('/api/ccip', { sender: RESOLVER, data: calldata }), gatewayEnv())
    expect(response.status).toBe(502)
    expect(JSON.stringify(await response.json())).not.toContain('DO_NOT_DISCLOSE')
  })
})
