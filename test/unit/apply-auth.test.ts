import { describe, it, expect, vi, beforeEach } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { optimismSepolia } from 'viem/chains'
import type { Address } from 'viem'
import { buildDomain, ApplyTypes } from '../../server/gateway/manage/schemas'

/**
 * `/apply` must be authenticated in BOTH approval modes.
 *
 * The first version skipped auth entirely when APPROVAL_MODE was `auto` (the default), which
 * meant an anonymous POST could make the operator pay gas to mint any name to any address —
 * unattributable, unthrottled, replayable.
 *
 * The unit tests for the approval module could not see this: they cover the pure state
 * machine, and a test titled "behaves identically to the existing deployment" asserted only
 * that the mode default was `auto`. The property the title claimed was never checked.
 *
 * These tests exercise the worker endpoint, which is where the auth actually lives.
 */

const OWNER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const
const applicant = privateKeyToAccount(OWNER_PK)
const CONTRACT_ADDRESS = '0x1234567890123456789012345678901234567890' as Address
const RECIPIENT = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' as Address

const { mockReadContract } = vi.hoisted(() => ({ mockReadContract: vi.fn() }))

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  return {
    ...actual,
    createPublicClient: vi.fn().mockReturnValue({ readContract: mockReadContract }),
    createWalletClient: vi.fn().mockReturnValue({ writeContract: vi.fn(), chain: optimismSepolia }),
    http: vi.fn().mockReturnValue({}),
  }
})

/** Minimal in-memory KV. The endpoint stores applications and consumes nonces through it. */
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
    L2_RECORDS_ADDRESS: CONTRACT_ADDRESS,
    ROOT_DOMAIN: 'aastar.eth',
    ROOT_DOMAINS: 'aastar.eth',
    OP_RPC_URL: 'http://localhost:8545',
    ...overrides,
  }
}

function applyRequest(body: Record<string, unknown>): Request {
  return new Request('https://api.test/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** A well-formed, correctly signed application. */
async function signedBody(label = 'alice') {
  const message = {
    parent: 'aastar.eth',
    label,
    owner: RECIPIENT,
    nonce: BigInt(Date.now()),
    deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
  }
  const signature = await applicant.signTypedData({
    domain: buildDomain(optimismSepolia.id, CONTRACT_ADDRESS),
    primaryType: 'Apply',
    types: ApplyTypes as any,
    message: message as any,
  })
  return {
    from: applicant.address,
    signature,
    message: { ...message, nonce: message.nonce.toString(), deadline: message.deadline.toString() },
  }
}

async function post(body: Record<string, unknown>, env = makeEnv()) {
  const worker = (await import('../../workers/api/src/index')).default
  return worker.fetch(applyRequest(body), env, {} as ExecutionContext)
}

beforeEach(() => {
  mockReadContract.mockReset()
  mockReadContract.mockResolvedValue('0x0000000000000000000000000000000000000000')
})

describe('/apply requires a signature — in auto mode too', () => {
  // auto is the DEFAULT, so this is the configuration a deployment gets by simply upgrading.
  it('rejects a request with no signature at all', async () => {
    const res = await post({ message: { parent: 'aastar.eth', label: 'alice', owner: RECIPIENT } })
    expect(res.status).not.toBe(200)
    expect([400, 401]).toContain(res.status)
  })

  it('rejects a body shaped like the ORIGINAL unauthenticated call', async () => {
    // Exactly what the first implementation accepted: flat fields, no signature, no nonce.
    const res = await post({ parent: 'aastar.eth', label: 'alice', owner: RECIPIENT })
    expect(res.status).not.toBe(200)
  })

  it('rejects a forged signature', async () => {
    const body = await signedBody()
    const res = await post({ ...body, signature: `0x${'11'.repeat(65)}` })
    expect(res.status).toBe(401)
  })

  it('rejects when `from` does not match the signer', async () => {
    const body = await signedBody()
    const res = await post({ ...body, from: RECIPIENT })
    expect(res.status).toBe(401)
  })

  // THE CONTROL. Without it, the four assertions above are satisfied by an endpoint that
  // rejects everything — a fix that breaks the feature would look identical to one that works.
  it('ACCEPTS a correctly signed request (must-pass control)', async () => {
    const res = await post(await signedBody('control'), makeEnv({ APPROVAL_MODE: 'manual' }))
    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.status).toBe('pending')
    expect(json.name).toBe('control.aastar.eth')
  })

  it('a signed request in auto mode also gets past auth (control)', async () => {
    // No writer key is configured here, so it fails LATER — the point is that it gets past
    // the signature check rather than being rejected as unauthenticated.
    const res = await post(await signedBody('autoctl'), makeEnv({ APPROVAL_MODE: 'auto' }))
    expect(res.status).not.toBe(401)
  })
})

describe('/apply — an Apply signature is not a Register signature', () => {
  it('a signature over the Register primaryType is refused by /apply', async () => {
    // Distinct primaryTypes are what stop one endpoint's signature being replayed at another.
    const { RegisterTypes } = await import('../../server/gateway/manage/schemas')
    const message = {
      parent: 'aastar.eth',
      label: 'replay',
      owner: RECIPIENT,
      nonce: BigInt(Date.now()),
      deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
    }
    const signature = await applicant.signTypedData({
      domain: buildDomain(optimismSepolia.id, CONTRACT_ADDRESS),
      primaryType: 'Register',
      types: RegisterTypes as any,
      message: message as any,
    })
    const res = await post({
      from: applicant.address,
      signature,
      message: { ...message, nonce: message.nonce.toString(), deadline: message.deadline.toString() },
    })
    expect(res.status).toBe(401)
  })
})
