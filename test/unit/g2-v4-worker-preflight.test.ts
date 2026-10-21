import { describe, expect, it } from 'vitest'
import { keccak256, type Address, type Hex } from 'viem'
import { preflightV4SignedIssuance, V4PreflightDenied, type V4IssuanceIntent, type V4IssuancePin } from '../../workers/api/src/v4-issuance-preflight'
import worker from '../../workers/api/src/index'

const contract = '0x1111111111111111111111111111111111111111' as Address
const operator = '0x2222222222222222222222222222222222222222' as Address
const holder = '0x3333333333333333333333333333333333333333' as Address
const controller = '0x4444444444444444444444444444444444444444' as Address
const initialAddr = '0x0000000000000000000000000000000000000000' as Address
const parentNode = `0x${'aa'.repeat(32)}` as Hex
const blockHash = `0x${'dd'.repeat(32)}` as Hex
const bytecode = '0x6001600055' as Hex
const pin: V4IssuancePin = { chainId: 11155420, contract, parentNode, expectedCodeHash: keccak256(bytecode) }
const intent: V4IssuanceIntent = {
  operator, member: holder, label: 'alice', initialAddr,
  nonce: 7n, deadline: 1700n, signature: '0x1234',
}

class FakeOp {
  chainId = 11155420
  latest = 40n
  hash = blockHash
  code = bytecode
  parent = parentNode
  controller = controller
  epoch = 3n
  grantEpoch = 3n
  revision = 2n
  nonce = 7n
  permissions = 5n
  quota = 2n
  expiry = 1800n
  timestamp = 1000n
  nativeClaim = false
  simulateCalls = 0
  capturedOperator?: Address
  changedBeforeSimulation = false
  badSignature = false
  readings: Array<{ name: string; number: bigint }> = []
  getChainId = async () => this.chainId
  getBlock = async ({ blockTag }: { blockTag: string }) => {
    if (blockTag !== 'latest') throw new Error('wrong tag')
    return { number: this.latest, hash: this.hash, timestamp: this.timestamp }
  }
  getBytecode = async ({ blockNumber }: { blockNumber: bigint }) => {
    this.readings.push({ name: 'code', number: blockNumber })
    return this.code
  }
  readContract = async ({ address, functionName, blockNumber, args }: {
    address: Address; functionName: string; blockNumber: bigint; args?: readonly unknown[]
  }) => {
    if (address !== contract) throw new Error('wrong contract')
    this.readings.push({ name: functionName, number: blockNumber })
    if (['operatorRevision', 'operators'].includes(functionName) && args?.[0] !== operator) throw new Error('wrong operator')
    switch (functionName) {
      case 'parentNode': return this.parent
      case 'l1OwnershipVerified': return this.nativeClaim
      case 'rootController': return this.controller
      case 'controllerEpoch': return this.epoch
      case 'issuanceNonce': return this.nonce
      case 'operatorRevision': return this.revision
      case 'operators': return [this.permissions, this.quota, this.expiry, this.grantEpoch]
    }
    throw new Error('unexpected read')
  }
  simulateContract = async ({ account, address, functionName, blockNumber, args }: {
    account: Address; address: Address; functionName: string; blockNumber: bigint; args: readonly unknown[]
  }) => {
    this.simulateCalls++
    this.capturedOperator = account
    this.readings.push({ name: 'simulate', number: blockNumber })
    if (this.changedBeforeSimulation) this.nonce++
    if (address !== contract || functionName !== 'issueBySig' || account !== operator ||
        args[0] !== 'alice' || args[1] !== holder || args[2] !== initialAddr ||
        args[3] !== this.nonce || args[4] !== 1700n || args[5] !== '0x1234' ||
        this.badSignature) throw new Error('contract issueBySig reverted: signature and nonce')
    return { result: parentNode }
  }
}

// Mock only the documented reader shape. No provider/network or API keys involved.
const run = (rpc: FakeOp, overrides: Partial<V4IssuanceIntent> = {}, profile: V4IssuancePin = pin) =>
  preflightV4SignedIssuance(rpc as unknown as Parameters<typeof preflightV4SignedIssuance>[0], profile, { ...intent, ...overrides })

async function denied(promise: Promise<unknown>, code: V4PreflightDenied['code']) {
  await expect(promise).rejects.toMatchObject({ code })
}

describe('G2.6 Worker V4 chain-authoritative read-only boundary', () => {
  it('simulates the real issueBySig as named operator at the SAME chain block; returns advisory only', async () => {
    const rpc = new FakeOp()
    const result = await run(rpc)
    expect(result).toMatchObject({ blockNumber: 40n, blockHash, issuanceNonce: 7n, operatorRevision: 2n,
      controllerEpoch: 3n, scope: 'op-application-only', preflightOnly: true, atomicExecutionVerified: false })
    expect(rpc.capturedOperator).toBe(operator)
    expect(rpc.simulateCalls).toBe(1)
    expect(rpc.readings).toHaveLength(9)
    expect(rpc.readings.every((r) => r.number === 40n)).toBe(true)
    expect(JSON.stringify(result, (_key, value) => typeof value === 'bigint' ? String(value) : value)).not.toContain(intent.signature)
  })

  it('refuses stale KV success and replayed nonce; requires OP chain state, never KV', async () => {
    const rpc = new FakeOp()
    const staleKv = { cachedNonce: 7n, cachedApproved: true, value: '1' }
    rpc.nonce = 8n // another relayer already consumed the real OP nonce
    await denied(run(rpc, { ...staleKv } as unknown as Partial<V4IssuanceIntent>), 'stale')
    expect(rpc.simulateCalls).toBe(0)
  })

  it('fails closed when onchain nonce changes AFTER preflight reads or when EIP712 signature is invalid', async () => {
    const rpc = new FakeOp()
    rpc.changedBeforeSimulation = true
    await denied(run(rpc), 'rejected')
    const bad = new FakeOp()
    bad.badSignature = true
    await denied(run(bad), 'rejected')
  })

  it('two relayers can both pass the same block preflight; neither receives a nonce reservation', async () => {
    const rpc = new FakeOp()
    const [first, second] = await Promise.all([run(rpc), run(rpc)])
    expect(first.preflightOnly).toBe(true)
    expect(second.atomicExecutionVerified).toBe(false)
    expect(first.issuanceNonce).toBe(second.issuanceNonce)
    expect(rpc.simulateCalls).toBe(2)
    expect(rpc.nonce).toBe(7n) // eth_call is read-only; onchain tx later picks the winner
  })

  it('snapshots untrusted pin getters and intent fields before first RPC await', async () => {
    const rpc = new FakeOp()
    const mutable = { ...intent }
    const getBlock = rpc.getBlock
    rpc.getBlock = async (args) => {
      mutable.nonce = 99n
      mutable.operator = controller
      mutable.signature = '0xeeee'
      return getBlock(args)
    }
    let readCount = 0
    const dynamicPin = Object.defineProperty({ ...pin }, 'contract', {
      enumerable: true, get: () => ++readCount === 1 ? contract : controller,
    }) as V4IssuancePin
    const result = await preflightV4SignedIssuance(
      rpc as unknown as Parameters<typeof preflightV4SignedIssuance>[0], dynamicPin, mutable,
    )
    expect(result.issuanceNonce).toBe(7n)
    expect(result.contract).toBe(contract)
    expect(rpc.capturedOperator).toBe(operator)
    expect(readCount).toBe(1)
  })

  it('rejects a head change or reorg after the simulation, including same-number different hash', async () => {
    const rpc = new FakeOp()
    const original = rpc.simulateContract
    rpc.simulateContract = async (args) => { const result = await original(args); rpc.hash = `0x${'ab'.repeat(32)}` as Hex; return result }
    await denied(run(rpc), 'stale')
    const advanced = new FakeOp()
    const original2 = advanced.simulateContract
    advanced.simulateContract = async (args) => { const result = await original2(args); advanced.latest++; return result }
    await denied(run(advanced), 'stale')
  })

  it('refuses wrong OP chain, contract codehash, parent, sovereign flag, zero controller and missing code', async () => {
    for (const mutate of [
      (r: FakeOp) => { r.chainId = 10 },
      (r: FakeOp) => { r.code = '0x6000' },
      (r: FakeOp) => { r.parent = `0x${'bb'.repeat(32)}` as Hex },
      (r: FakeOp) => { r.nativeClaim = true },
      (r: FakeOp) => { r.controller = initialAddr },
      (r: FakeOp) => { r.code = '0x' as Hex },
    ]) {
      const rpc = new FakeOp()
      mutate(rpc)
      await denied(run(rpc), 'identity')
      expect(rpc.simulateCalls).toBe(0)
    }
  })

  it('refuses revoked/unsigned-only/depleted/expired/wrong-epoch operator and overdue intent', async () => {
    for (const mutate of [
      (r: FakeOp) => { r.permissions = 0n },
      (r: FakeOp) => { r.permissions = 1n },
      (r: FakeOp) => { r.quota = 0n },
      (r: FakeOp) => { r.expiry = 1000n },
      (r: FakeOp) => { r.epoch++ },
      (r: FakeOp) => { r.timestamp = 1701n },
    ]) {
      const rpc = new FakeOp()
      mutate(rpc)
      await denied(run(rpc), 'stale')
      expect(rpc.simulateCalls).toBe(0)
    }
    const rpc = new FakeOp()
    await denied(run(rpc, { initialAddr: holder }), 'stale') // CAP_INITIAL_ADDR absent
  })

  it('does not leak signature or provider secrets in thrown errors', async () => {
    const rpc = new FakeOp()
    rpc.simulateContract = async () => { throw new Error(`private-key=DO_NOT_LOG signature=${intent.signature}`) }
    try { await run(rpc); throw new Error('expected denial') } catch (error) {
      expect(error).toBeInstanceOf(V4PreflightDenied)
      expect(String(error)).not.toMatch(/DO_NOT_LOG|0x1234/)
    }
  })

  it('rejects non-OP profiles, loose addresses, missing signatures and invalid nonce input', async () => {
    const rpc = new FakeOp()
    await denied(run(rpc, {}, { ...pin, chainId: 10 } as unknown as V4IssuancePin), 'invalid-input')
    await denied(run(rpc, { operator: initialAddr }), 'invalid-input')
    await denied(run(rpc, { signature: '0x' }), 'invalid-input')
    await denied(run(rpc, { nonce: -1n }), 'invalid-input')
    expect(rpc.readings).toHaveLength(0)
  })

  it('never activates a V4 Worker endpoint or falls back to V3 KV nonce claims', async () => {
    let puts = 0
    const kv = { get: async () => 'nonce-used', put: async () => { puts++ }, delete: async () => {},
      list: async () => ({ keys: [], list_complete: true }) }
    const response = await worker.fetch(new Request('https://example.test/v4/issue', { method: 'POST' }), {
      NETWORK: 'op-sepolia', ROOT_DOMAIN: 'community.eth', L2_RECORDS_ADDRESS: contract,
      OP_RPC_URL: 'http://127.0.0.1:1', REGISTRY: kv,
    })
    expect(response.status).toBe(404)
    expect(puts).toBe(0)
  })
})
