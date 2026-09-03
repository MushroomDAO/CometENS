import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { optimismSepolia } from 'viem/chains'
import type { Address } from 'viem'

/**
 * Every write endpoint must answer a malformed signature with 401, never 5xx.
 *
 * A malformed signature makes viem THROW rather than return false, so the bare
 * `const ok = await verifyTypedData(...); if (!ok) throw 401` pattern let the throw escape as
 * 500 — telling the caller "our fault" when the truth is "your signature is unusable".
 *
 * The endpoint list is DERIVED FROM THE SOURCE rather than typed out here. A hand-written list
 * proves only that the endpoints someone remembered are covered; deriving it means a new write
 * endpoint that skips the helper fails this test on the day it is added. That is the difference
 * between "we edited nine places" and "none was missed".
 */
const SOURCE = join(__dirname, '..', '..', 'workers', 'api', 'src', 'index.ts')
const CONTRACT = '0x1111111111111111111111111111111111111111' as Address

/**
 * Read-only routes. Everything else that the worker dispatches is treated as a write path and
 * must answer a malformed signature with 401.
 *
 * DERIVED INVERSELY, on pr-daemon's note: the first version matched the ONE shape
 * `if (path === '/x') { response = await handleManage(...) }`, so an endpoint written any other
 * way was silently absent from the list. That is not hypothetical — at b7aecad `/apply` was
 * written exactly that other way, and #33's missing-auth hole lived precisely there.
 *
 * An allowlist inverts the failure: a NEW endpoint is a write path by default, so forgetting to
 * classify it makes this suite fail rather than quietly skip it. Adding a name here is a
 * deliberate act someone has to justify in review.
 */
const READ_ONLY = new Set([
  '/health', '/check-label', '/check-owner', '/lookup', '/resolve-status',
  '/root-domains', '/application', '/applications', '/approval-mode',
])

function allDispatchedPaths(): string[] {
  const src = readFileSync(SOURCE, 'utf8')
  const found = [...src.matchAll(/path === '(\/[a-z0-9/-]+)'/g)]
  return [...new Set(found.map((m) => m[1]))]
}

function writeEndpoints(): string[] {
  return allDispatchedPaths().filter((p) => !READ_ONLY.has(p))
}

const { mockReadContract } = vi.hoisted(() => ({ mockReadContract: vi.fn() }))

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  return {
    ...actual,
    createPublicClient: vi.fn().mockReturnValue({ readContract: mockReadContract }),
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

const env = () => ({
  REGISTRY: fakeKV(), RECORD_CACHE: fakeKV(),
  NETWORK: 'op-sepolia', L2_RECORDS_ADDRESS: CONTRACT,
  ROOT_DOMAIN: 'aastar.eth', ROOT_DOMAINS: 'aastar.eth',
  OP_RPC_URL: 'http://localhost:8545',
  // /v1/register refuses with 503 when this is unset — correct for an unconfigured deployment,
  // but it would mean this suite never reached that endpoint's signature check at all.
  UPSTREAM_ALLOWED_SIGNERS: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
})

/**
 * A body that is structurally plausible everywhere — the point is to get PAST field validation
 * and reach signature verification, so the signature is the thing under test.
 */
function malformedBody() {
  const future = String(Math.floor(Date.now() / 1000) + 600)
  return {
    from: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    // Hex-shaped so it passes the isHex() field check, but the wrong length — this is the
    // input that makes viem THROW instead of returning false, which was surfacing as 500.
    signature: '0x1234',
    domain: { verifyingContract: CONTRACT },
    message: {
      parent: 'aastar.eth', label: 'alice', owner: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      node: `0x${'11'.repeat(32)}`, addr: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      key: 'url', value: 'https://example.test', hash: '0x1234',
      coinType: '60',
      parentNode: `0x${'22'.repeat(32)}`,
      registrar: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', quota: '1', expiry: future,
      // Different from `from`, or /transfer-subnode rejects it as a self-transfer before ever
      // looking at the signature.
      to: '0x000000000000000000000000000000000000dEaD',
      id: 'alice.aastar.eth', decision: 'approve', reason: '',
      nonce: String(Date.now()), deadline: future,
    },
    // /v1/register is personal_sign and reads these at the top level, not under `message`.
    label: 'alice',
    owner: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    timestamp: Math.floor(Date.now() / 1000),
  }
}

async function post(path: string) {
  const worker = (await import('../../workers/api/src/index')).default
  return worker.fetch(
    new Request(`https://api.test${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(malformedBody()),
    }),
    env() as any,
    {} as ExecutionContext,
  )
}

beforeEach(() => {
  mockReadContract.mockReset()
  mockReadContract.mockImplementation(({ functionName }: any) => {
    if (functionName === 'owner') return Promise.resolve('0x2222222222222222222222222222222222222222')
    return Promise.resolve('0x0000000000000000000000000000000000000000')
  })
})

describe('a malformed signature is 401, never 5xx', () => {
  const endpoints = writeEndpoints()

  it('the endpoint list is non-trivial and derived (control)', () => {
    // Without this, a regex that silently matched nothing would make every case below vacuous.
    expect(endpoints.length).toBeGreaterThanOrEqual(7)
    expect(endpoints).toContain('/register')
    expect(endpoints).toContain('/apply')
  })

  it('every READ_ONLY name is a route that actually exists (control)', () => {
    // An allowlist entry for a route that no longer exists is a silent exemption waiting to
    // match a future endpoint of the same name. Stale allowlists are how these decay.
    const dispatched = new Set(allDispatchedPaths())
    expect([...READ_ONLY].filter((p) => !dispatched.has(p))).toEqual([])
  })

  it('every READ_ONLY route actually answers a GET — membership is earned, not asserted', () => {
    // An allowlist whose entries are just names someone typed can silently exempt a write
    // endpoint: adding '/v1/register' to READ_ONLY makes this whole suite green again, and
    // nothing else notices. So membership needs a property the route must actually have.
    //
    // Reading is what these routes are for, so: a read-only route answers GET. A write route
    // does not — it is POST-only and a GET falls through to 404.
    return Promise.all(
      [...READ_ONLY].map(async (path) => {
        const worker = (await import('../../workers/api/src/index')).default
        const res = await worker.fetch(
          new Request(`https://api.test${path}`, { method: 'GET' }),
          env() as any, {} as ExecutionContext,
        )
        expect({ path, status: res.status }).not.toMatchObject({ status: 404 })
      }),
    )
  })

  it('a WRITE route does not answer a GET (control)', async () => {
    // The other half: without this, "answers a GET" would be a property every route has, and
    // the membership check above would exempt nothing.
    const worker = (await import('../../workers/api/src/index')).default
    const res = await worker.fetch(
      new Request('https://api.test/register', { method: 'GET' }),
      env() as any, {} as ExecutionContext,
    )
    expect(res.status).toBe(404)
  })

  it('the write list is pinned, not floored', () => {
    // What this replaced was `|all ∩ RO| + |all \ RO| == |all|` — a construction property of
    // `filter`, true for ANY contents. Emptying READ_ONLY left it green while every per-route
    // assertion went red, so it was serving as a safety net that could not catch anything.
    //
    // An exact count is the version with teeth: moving a route into READ_ONLY, or a dispatch
    // line changing shape so the regex stops seeing it, both land here. Same lesson as the
    // `>= 2` floor in #48 — a bound that equals today's value cannot detect shrinkage.
    expect(endpoints).toHaveLength(10)
  })

  for (const path of endpoints) {
    it(`${path} → 401`, async () => {
      const res = await post(path)
      // A 400 here would mean the request never reached signature verification, so the test
      // would be green for the wrong reason — the body must be plausible enough to get past
      // field validation everywhere.
      expect(res.status).not.toBe(400)
      expect(res.status).toBe(401)
    })
  }

  it('a well-formed but WRONG signature is also 401, not a different code (control)', async () => {
    // Distinguishes "we catch parse errors" from "we reject bad signatures": a fix that only
    // caught throws would leave the ordinary wrong-signature path untested here.
    const worker = (await import('../../workers/api/src/index')).default
    const body = malformedBody()
    body.signature = `0x${'11'.repeat(65)}`
    const res = await worker.fetch(
      new Request('https://api.test/register', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }),
      env() as any, {} as ExecutionContext,
    )
    expect(res.status).toBe(401)
  })
})
