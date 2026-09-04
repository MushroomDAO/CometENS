import { describe, it, expect, vi, beforeEach } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { optimismSepolia } from 'viem/chains'
import type { Address } from 'viem'
import { buildDomain, RegisterTypes } from '../../server/gateway/manage/schemas'

/**
 * APPROVAL_MODE=manual must govern /register, not just /apply.
 *
 * These exercise the WORKER ROUTE, not the decision function — mayRegisterDirectly having the
 * right answer is worth nothing if nobody calls it, and "the pure function is tested" is
 * exactly the shape that lets an unwired guard ship green.
 */
const CONTRACT = '0x1111111111111111111111111111111111111111' as Address
const RECIPIENT = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' as Address

const owner = privateKeyToAccount(`0x${'44'.repeat(32)}`)
const stranger = privateKeyToAccount(`0x${'55'.repeat(32)}`)

const { mockReadContract } = vi.hoisted(() => ({ mockReadContract: vi.fn() }))

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  return {
    ...actual,
    // waitForTransactionReceipt too: the writer awaits it after sending, and a mock missing it
    // turns every successful write into a 500 that looks exactly like a product failure.
    createPublicClient: vi.fn().mockReturnValue({
      readContract: mockReadContract,
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success', blockNumber: 1n }),
    }),
    createWalletClient: vi.fn().mockReturnValue({ writeContract: vi.fn().mockResolvedValue('0xtx'), chain: optimismSepolia }),
    http: vi.fn().mockReturnValue({}),
  }
})

function fakeKV(): any {
  const store = new Map<string, string>()
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    list: async ({ prefix = '' } = {}) => ({
      keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    }),
  }
}

function makeEnv(overrides: Record<string, unknown> = {}): any {
  return {
    REGISTRY: fakeKV(),
    RECORD_CACHE: fakeKV(),
    NETWORK: 'op-sepolia',
    L2_RECORDS_ADDRESS: CONTRACT,
    ROOT_DOMAIN: 'aastar.eth',
    ROOT_DOMAINS: 'aastar.eth',
    OP_RPC_URL: 'http://localhost:8545',
    // Present so the success path is actually reachable. Without it requireWriter throws 503
    // first, and every assertion about a successful write is answered by the wrong branch.
    WRITER_KEY: `0x${'44'.repeat(32)}`,
    ...overrides,
  }
}

async function signedRegister(account: typeof owner, label: string) {
  const message = {
    parent: 'aastar.eth',
    label,
    owner: RECIPIENT,
    nonce: BigInt(Date.now() + Math.floor(Math.random() * 1e6)),
    deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
  }
  const signature = await account.signTypedData({
    domain: buildDomain(optimismSepolia.id, CONTRACT),
    primaryType: 'Register',
    types: RegisterTypes as any,
    message: message as any,
  })
  return {
    from: account.address,
    signature,
    domain: { verifyingContract: CONTRACT },
    message: { ...message, nonce: message.nonce.toString(), deadline: message.deadline.toString() },
  }
}

async function postRegister(body: Record<string, unknown>, env = makeEnv()) {
  const worker = (await import('../../workers/api/src/index')).default
  return worker.fetch(
    new Request('https://api.test/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
    {} as ExecutionContext,
  )
}

beforeEach(() => {
  mockReadContract.mockReset()
  mockReadContract.mockImplementation(({ functionName }: any) => {
    if (functionName === 'owner') return Promise.resolve(owner.address)
    if (functionName === 'subnodeOwner') return Promise.resolve('0x0000000000000000000000000000000000000000')
    return Promise.resolve('0x0000000000000000000000000000000000000000')
  })
})

describe('/register under APPROVAL_MODE=manual', () => {
  it('rejects a stranger with 409 and points at /apply', async () => {
    const res = await postRegister(await signedRegister(stranger, 'alice'), makeEnv({ APPROVAL_MODE: 'manual' }))
    expect(res.status).toBe(409)
    expect((await res.json() as any).error).toContain('/apply')
  })

  it('still lets the contract OWNER grant (control)', async () => {
    // The admin console grants through this endpoint. A fix that closed /register outright
    // would pass the assertion above while breaking the flow manual mode exists to serve.
    //
    // Asserts 200, not `not.toBe(409)`. The weaker form is what let a ReferenceError on the
    // success path sit undetected for four PRs: `json({ ok, … })` lost its `ok` variable when
    // #47 replaced `const ok = await verifyTypedData(...)` with a helper, so every successful
    // write returned 500 — which is also not 409, so this test stayed green.
    const res = await postRegister(await signedRegister(owner, 'bob'), makeEnv({ APPROVAL_MODE: 'manual' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, action: 'register' })
  })

  it('the same stranger request succeeds under auto (control)', async () => {
    // Without this, a gate that rejected everyone always would pass the first assertion.
    const res = await postRegister(await signedRegister(stranger, 'carol'), makeEnv({ APPROVAL_MODE: 'auto' }))
    expect(res.status).not.toBe(409)
  })

  it('auto is the default — an unset APPROVAL_MODE does not silently close /register', async () => {
    const res = await postRegister(await signedRegister(stranger, 'dave'), makeEnv())
    expect(res.status).not.toBe(409)
  })

  it('an unsigned body still gets 401, not 409 — the mode is not an oracle', async () => {
    // Checking the mode BEFORE the signature would let an anonymous caller learn whether this
    // deployment reviews applications, which is not theirs to know.
    const res = await postRegister(
      { from: stranger.address, signature: `0x${'00'.repeat(65)}`, domain: { verifyingContract: CONTRACT },
        message: { parent: 'aastar.eth', label: 'eve', owner: RECIPIENT, nonce: '1', deadline: String(Math.floor(Date.now() / 1000) + 600) } },
      makeEnv({ APPROVAL_MODE: 'manual' }),
    )
    expect(res.status).toBe(401)
  })

  it('an unreadable owner() fails CLOSED under manual (control: it does not under auto)', async () => {
    mockReadContract.mockImplementation(({ functionName }: any) => {
      if (functionName === 'owner') return Promise.reject(new Error('rpc down'))
      return Promise.resolve('0x0000000000000000000000000000000000000000')
    })
    const manual = await postRegister(await signedRegister(owner, 'frank'), makeEnv({ APPROVAL_MODE: 'manual' }))
    // 503, not 409: refused because we could not check, not because of who they are.
    expect(manual.status).toBe(503)
    expect((await manual.json() as any).error).toMatch(/Could not verify/)
    const auto = await postRegister(await signedRegister(owner, 'grace'), makeEnv({ APPROVAL_MODE: 'auto' }))
    expect(auto.status).not.toBe(409)
  })
})
