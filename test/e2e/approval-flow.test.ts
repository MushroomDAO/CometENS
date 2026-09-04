/**
 * E2E: the manual-approval path, from application to a name on chain.
 *
 * Unit tests cover each piece — `decideOnSubmit`, `applyDecision`, `isAuthorisedApprover`, the
 * route handlers. What none of them can answer is whether the whole path actually defers the
 * write and then performs it: every one of them mocks the chain away.
 *
 * The two assertions that matter are the ones about chain STATE, not status codes:
 *   after /apply in manual mode  → subnodeOwner is still zero  (the queue really deferred it)
 *   after /approve               → subnodeOwner is the applicant's address
 *
 * A status-only version of this test would pass against an implementation that wrote the name
 * immediately and merely reported "pending".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { TestExecutionContext } from '../worker-types'
import {
  createPublicClient, createWalletClient, http, namehash, type Hex, type Address,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { spawn, type ChildProcess } from 'child_process'
import { readFileSync } from 'fs'
import { loadArtifact } from './artifacts'
import { join } from 'path'
import { buildDomain, ApplyTypes, ApproveApplicationTypes } from '../../server/gateway/manage/schemas'

// Every e2e file spawns its own anvil, and vitest runs files in parallel — a shared port
// means the second process fails to bind, its client connects to somebody else's chain, and
// both send from the same default accounts (NonceTooLowError). 18549 collided with
// upstream-api.test.ts: running just those two failed 3/3.
// test/unit/e2e-ports.test.ts asserts these stay distinct.
const ANVIL_PORT = 18553
const CONTRACTS_DIR = join(import.meta.dirname, '..', '..', 'contracts')
const ROOT = 'community.eth'
const ZERO = '0x0000000000000000000000000000000000000000'

// Anvil's well-known accounts. The owner is both contract owner and the approver.
// Kept as a constant because viem's account object does not expose the key it was built from
// — `owner.privateKey` is undefined, and the worker then reports "writer not configured" (503).
const OWNER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex
const owner = privateKeyToAccount(OWNER_PK)
const applicant = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
const stranger = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a')
const RECIPIENT = applicant.address

const anvilChain = { ...foundry, rpcUrls: { default: { http: [`http://127.0.0.1:${ANVIL_PORT}`] } } }

const L2_READ_ABI = [
  { type: 'function', name: 'subnodeOwner', stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }] },
] as const

let anvil: ChildProcess
let contract: Address
let pub: ReturnType<typeof createPublicClient>

/** An in-memory KV good enough for the worker's registry/cache/application store. */
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

/** Shared across a scenario so an application survives from /apply to /approve. */
function makeEnv(mode: 'auto' | 'manual', kv = fakeKV()): any {
  return {
    REGISTRY: kv,
    RECORD_CACHE: kv,
    NETWORK: 'local',
    OP_RPC_URL: `http://127.0.0.1:${ANVIL_PORT}`,
    L2_RECORDS_ADDRESS: contract,
    ROOT_DOMAIN: ROOT,
    ROOT_DOMAINS: ROOT,
    APPROVAL_MODE: mode,
    WRITER_KEY: OWNER_PK,
  }
}

async function post(path: string, body: unknown, env: any) {
  const worker = (await import('../../workers/api/src/index')).default
  return worker.fetch(
    new Request(`https://api.test${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    env, {} as unknown as TestExecutionContext,
  )
}

async function signedApply(label: string) {
  const message = {
    parent: ROOT, label, owner: RECIPIENT,
    nonce: BigInt(Date.now() + Math.floor(Math.random() * 1e6)),
    deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
  }
  const signature = await applicant.signTypedData({
    domain: buildDomain(31337, contract), primaryType: 'Apply',
    types: ApplyTypes as any, message: message as any,
  })
  return {
    from: applicant.address, signature, domain: { verifyingContract: contract },
    message: { ...message, nonce: message.nonce.toString(), deadline: message.deadline.toString() },
  }
}

async function signedApprove(id: string, decision: 'approve' | 'reject', by = owner) {
  const message = {
    id, decision, reason: '',
    nonce: BigInt(Date.now() + Math.floor(Math.random() * 1e6)),
    deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
  }
  const signature = await by.signTypedData({
    domain: buildDomain(31337, contract), primaryType: 'ApproveApplication',
    types: ApproveApplicationTypes as any, message: message as any,
  })
  return {
    from: by.address, signature, domain: { verifyingContract: contract },
    message: { ...message, nonce: message.nonce.toString(), deadline: message.deadline.toString() },
  }
}

const ownerOf = (label: string) =>
  pub.readContract({
    address: contract, abi: L2_READ_ABI, functionName: 'subnodeOwner',
    args: [namehash(`${label}.${ROOT}`) as Hex],
  }) as Promise<Address>

beforeAll(async () => {
  anvil = spawn('anvil', ['--port', String(ANVIL_PORT), '--silent'])
  pub = createPublicClient({ chain: anvilChain, transport: http(`http://127.0.0.1:${ANVIL_PORT}`) })
  for (let i = 0; i < 40; i++) {
    try {
      await pub.getChainId()
      break
    } catch {
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  const artifact = loadArtifact(CONTRACTS_DIR, 'L2RecordsV3')
  const wallet = createWalletClient({ account: owner, chain: anvilChain, transport: http(`http://127.0.0.1:${ANVIL_PORT}`) })
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [owner.address] })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  contract = receipt.contractAddress as Address
}, 60_000)

afterAll(() => void anvil?.kill())

describe('manual approval: the write is deferred, then performed', () => {
  it('queues without touching the chain, then grants on approval', async () => {
    const env = makeEnv('manual')
    const label = 'deferred'

    const applied = await post('/apply', await signedApply(label), env)
    expect(applied.status).toBe(200)
    const app = (await applied.json()) as any
    expect(app.status).toBe('pending')

    // THE POINT. A implementation that wrote the name and merely reported "pending" would pass
    // every status assertion in this file and every unit test we have.
    expect(await ownerOf(label)).toBe(ZERO)

    const approved = await post('/approve', await signedApprove(app.id, 'approve'), env)
    expect(approved.status).toBe(200)
    const decided = (await approved.json()) as any
    expect(decided.status).toBe('approved')
    expect(decided.txHash).toMatch(/^0x/)

    expect((await ownerOf(label)).toLowerCase()).toBe(RECIPIENT.toLowerCase())
  }, 60_000)

  it('auto mode writes immediately — so "still zero" above is not vacuous (control)', async () => {
    // Without this, a deployment where /apply never wrote under ANY mode would satisfy the
    // deferral assertion for the wrong reason.
    const label = 'immediate'
    const res = await post('/apply', await signedApply(label), makeEnv('auto'))
    expect(res.status).toBe(200)
    expect((await res.json() as any).status).toBe('approved')
    expect((await ownerOf(label)).toLowerCase()).toBe(RECIPIENT.toLowerCase())
  }, 60_000)

  it('a stranger cannot approve, and the chain stays untouched', async () => {
    const env = makeEnv('manual')
    const label = 'contested-approval'
    const app = (await (await post('/apply', await signedApply(label), env)).json()) as any

    const res = await post('/approve', await signedApprove(app.id, 'approve', stranger), env)
    expect(res.status).not.toBe(200)

    // Status alone would not catch an implementation that rejected the response after writing.
    expect(await ownerOf(label)).toBe(ZERO)
  }, 60_000)

  it('a rejected application never reaches the chain', async () => {
    const env = makeEnv('manual')
    const label = 'rejected'
    const app = (await (await post('/apply', await signedApply(label), env)).json()) as any

    const res = await post('/approve', await signedApprove(app.id, 'reject'), env)
    expect(res.status).toBe(200)
    expect((await res.json() as any).status).toBe('rejected')
    expect(await ownerOf(label)).toBe(ZERO)
  }, 60_000)
})
