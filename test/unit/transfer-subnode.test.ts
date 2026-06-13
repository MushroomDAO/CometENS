/**
 * Unit tests for the /transfer-subnode endpoint validation.
 *
 * Tests validation logic WITHOUT making real RPC calls by mocking
 * createPublicClient so readContract returns a controlled value.
 *
 * The worker is imported after vi.mock() calls so the mocks are in place
 * before any module-level code runs (using dynamic import inside each test).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { optimismSepolia } from 'viem/chains'
import { keccak256, toBytes, type Hex, type Address } from 'viem'
import { buildDomain, TransferSubnodeTypes } from '../../server/gateway/manage/schemas'

// ─── Test accounts ────────────────────────────────────────────────────────────

const OWNER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const
const OTHER_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const
const owner = privateKeyToAccount(OWNER_PK)
const other = privateKeyToAccount(OTHER_PK)

// ─── Constants ────────────────────────────────────────────────────────────────

const CONTRACT_ADDRESS = '0x1234567890123456789012345678901234567890' as Address
const TEST_NODE = keccak256(toBytes('alice.aastar.eth')) as Hex
const RECIPIENT = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' as Address
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address

// ─── Mock viem ────────────────────────────────────────────────────────────────

const { mockReadContract } = vi.hoisted(() => ({
  mockReadContract: vi.fn(),
}))

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  return {
    ...actual,
    createPublicClient: vi.fn().mockReturnValue({
      readContract: mockReadContract,
    }),
    createWalletClient: vi.fn().mockReturnValue({
      writeContract: vi.fn(),
      chain: optimismSepolia,
    }),
    http: vi.fn().mockReturnValue({}),
  }
})

vi.mock('viem/accounts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem/accounts')>()
  return { ...actual }
})

// ─── Minimal Env stub ─────────────────────────────────────────────────────────

function makeEnv(overrides: Partial<{
  WORKER_EOA_PRIVATE_KEY: string
  NONCE_STORE: DurableObjectNamespace
  RECORD_CACHE: KVNamespace
}> = {}): any {
  return {
    NETWORK: 'op-sepolia',
    L2_RECORDS_ADDRESS: CONTRACT_ADDRESS,
    ROOT_DOMAIN: 'aastar.eth',
    OP_RPC_URL: 'http://localhost:8545',
    WORKER_EOA_PRIVATE_KEY: OWNER_PK,
    ...overrides,
  }
}

// ─── Helper: build a signed transfer request ──────────────────────────────────

/**
 * Builds a /transfer-subnode POST request.
 *
 * When `skipSign` is true, uses TEST_NODE for signing but puts the overridden
 * node value directly into the body. This lets us test server-side node
 * validation without triggering a viem client-side signing error.
 */
async function buildTransferRequest(
  signerAccount: ReturnType<typeof privateKeyToAccount>,
  params: {
    from?: Address
    node?: string
    to?: string
    nonce?: bigint | string | number
    deadline?: bigint | string | number
    /** Override signature directly (skips signing) */
    signature?: Hex
    /** If true, sign with TEST_NODE but put node override in body only */
    skipSign?: boolean
  } = {}
): Promise<Request> {
  const chainId = optimismSepolia.id
  const domain = buildDomain(chainId, CONTRACT_ADDRESS)

  const deadline = params.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 3600)
  const nonce = params.nonce ?? 1n
  const bodyNode = (params.node ?? TEST_NODE) as string
  const signNode = (params.skipSign ? TEST_NODE : bodyNode) as Hex
  const to = (params.to ?? RECIPIENT) as Address
  const from = params.from ?? signerAccount.address

  const messageForSign = {
    node: signNode,
    to,
    nonce: typeof nonce === 'bigint' ? nonce : BigInt(String(nonce)),
    deadline: typeof deadline === 'bigint' ? deadline : BigInt(String(deadline)),
  }

  const signature: Hex = params.signature ?? await signerAccount.signTypedData({
    domain,
    types: TransferSubnodeTypes,
    primaryType: 'TransferSubnode',
    message: messageForSign,
  })

  const body = {
    from,
    signature,
    message: {
      node: bodyNode,
      to,
      nonce: messageForSign.nonce.toString(),
      deadline: messageForSign.deadline.toString(),
    },
  }

  return new Request('https://worker.test/transfer-subnode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('/transfer-subnode validation', () => {
  beforeEach(() => {
    vi.resetModules()
    // Default: readContract returns the owner address (for subnodeOwner calls)
    mockReadContract.mockResolvedValue(owner.address)
  })

  it('zero address `to` → 400', async () => {
    const req = await buildTransferRequest(owner, { to: ZERO_ADDRESS })
    const worker = (await import('../../workers/api/src/index')).default
    const res = await worker.fetch(req, makeEnv(), {} as ExecutionContext)
    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.error).toMatch(/zero address/i)
  })

  it('self-transfer (to == from) → 400', async () => {
    const req = await buildTransferRequest(owner, { to: owner.address })
    const worker = (await import('../../workers/api/src/index')).default
    const res = await worker.fetch(req, makeEnv(), {} as ExecutionContext)
    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.error).toMatch(/self/i)
  })

  it('invalid node (not 32 bytes hex) → 400', async () => {
    // skipSign=true so we sign with a valid node but send the invalid one in the body
    const req = await buildTransferRequest(owner, { node: '0xdeadbeef', skipSign: true })
    const worker = (await import('../../workers/api/src/index')).default
    const res = await worker.fetch(req, makeEnv(), {} as ExecutionContext)
    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.error).toMatch(/node/i)
  })

  it('expired deadline → 400', async () => {
    const pastDeadline = BigInt(Math.floor(Date.now() / 1000) - 10)
    const req = await buildTransferRequest(owner, { deadline: pastDeadline })
    const worker = (await import('../../workers/api/src/index')).default
    const res = await worker.fetch(req, makeEnv(), {} as ExecutionContext)
    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.error).toMatch(/deadline/i)
  })

  it('invalid signature (signed by unrelated key) → 401', async () => {
    // Sign the message with a different private key — verifyTypedData returns
    // false because the recovered signer != from (owner.address).
    // `other` is a different account, so the signature won't verify as `owner`.
    const req = await buildTransferRequest(other, { from: owner.address })
    // Override mockReadContract to return owner for the subnodeOwner check
    // (this test focuses on the EIP-712 sig check, not the on-chain ownership check)
    mockReadContract.mockResolvedValue(owner.address)
    const worker = (await import('../../workers/api/src/index')).default
    const res = await worker.fetch(req, makeEnv(), {} as ExecutionContext)
    // from=owner but signed by other → verifyTypedData returns false → 401
    expect(res.status).toBe(401)
    const json = await res.json() as any
    expect(json.error).toMatch(/signature/i)
  })

  it('non-owner signer → 403', async () => {
    // `other` signs the request but the contract reports `owner` as the subdomain owner
    // readContract already defaults to owner.address — other is not the owner
    const req = await buildTransferRequest(other, { from: other.address })
    const worker = (await import('../../workers/api/src/index')).default
    const res = await worker.fetch(req, makeEnv(), {} as ExecutionContext)
    expect(res.status).toBe(403)
    const json = await res.json() as any
    expect(json.error).toMatch(/owner/i)
  })
})
