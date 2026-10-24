import { describe, expect, it } from 'vitest'
import { concatHex, encodeAbiParameters, encodeEventTopics, keccak256, parseAbiParameters, toHex,
  type Address, type Hex } from 'viem'
import { prepareV4UnsignedExecution, verifyV4ExternalReceipt, type V4Admission,
  type V4UnsignedHandoff } from '../../workers/api/src/v4-execution-adapter'
import type { V4IssuanceIntent, V4IssuancePin } from '../../workers/api/src/v4-issuance-preflight'

const contract = '0x1111111111111111111111111111111111111111' as Address
const operator = '0x2222222222222222222222222222222222222222' as Address
const member = '0x3333333333333333333333333333333333333333' as Address
const controller = '0x4444444444444444444444444444444444444444' as Address
const initialAddr = '0x0000000000000000000000000000000000000000' as Address
const parentNode = `0x${'ab'.repeat(32)}` as Hex
const blockHash = `0x${'cd'.repeat(32)}` as Hex
const txHash = `0x${'ef'.repeat(32)}` as Hex
const bytecode = '0x6001600055' as Hex
const pin: V4IssuancePin = { chainId: 11155420, contract, parentNode, expectedCodeHash: keccak256(bytecode) }
const intent: V4IssuanceIntent = {
  operator, label: 'alice', member, initialAddr, nonce: 7n, deadline: 1700n, signature: '0x1234',
}
const credential = 'fully-authenticated-test-token'
const eventAbi = [{ type: 'event', name: 'IssuanceNonceConsumed', inputs: [
  { name: 'operator', type: 'address', indexed: true },
  { name: 'nonce', type: 'uint256', indexed: false },
  { name: 'node', type: 'bytes32', indexed: true },
] }, { type: 'event', name: 'SubnodeIssued', inputs: [
  { name: 'parent', type: 'bytes32', indexed: true },
  { name: 'node', type: 'bytes32', indexed: true },
  { name: 'holder', type: 'address', indexed: true },
  { name: 'issuer', type: 'address', indexed: false },
] }] as const
const node = keccak256(concatHex([parentNode, keccak256(toHex('alice'))]))

class TestReader {
  ccipRead = false as const
  chain = 11155420
  head = 40n
  hash = blockHash
  timestamp = 1000n
  nonce = 7n
  revision = 2n
  epoch = 3n
  quota = 2n
  permissions = 5n
  simulated = 0
  badSignature = false
  reads: Array<[string, bigint | undefined]> = []
  getChainId = async () => this.chain
  getBlock = async ({ blockTag, blockNumber }: { blockTag?: string; blockNumber?: bigint }) => {
    if (blockTag === 'finalized') return { number: 60n, hash: blockHash, timestamp: this.timestamp }
    return { number: blockNumber ?? this.head, hash: this.hash, timestamp: this.timestamp }
  }
  getBytecode = async ({ blockNumber }: { blockNumber: bigint }) => {
    this.reads.push(['code', blockNumber]); return bytecode
  }
  readContract = async ({ functionName, blockNumber }: { functionName: string; blockNumber: bigint }) => {
    this.reads.push([functionName, blockNumber])
    switch (functionName) {
      case 'parentNode': return parentNode
      case 'l1OwnershipVerified': return false
      case 'rootController': return controller
      case 'controllerEpoch': return this.epoch
      case 'issuanceNonce': return this.nonce
      case 'operatorRevision': return this.revision
      case 'operators': return [this.permissions, this.quota, 1800n, this.epoch]
      default: throw Error('unknown function')
    }
  }
  simulateContract = async ({ account, functionName, blockNumber, args }: {
    account: Address; functionName: string; blockNumber: bigint; args: readonly unknown[]
  }) => {
    this.simulated++
    this.reads.push(['simulation', blockNumber])
    if (this.badSignature || account !== operator || functionName !== 'issueBySig' ||
        args[3] !== this.nonce || args[5] !== intent.signature) throw Error('secret-network-rpc-failure')
    return { result: node }
  }
}

class AtomicAdmission implements V4Admission {
  authenticated = true
  allowed = true
  claims = new Set<string>()
  takeCount = 0
  authCount = 0
  throttleCount = 0
  async authenticate(credentialValue: string, actor: Address, destination: Address) {
    this.authCount++
    return this.authenticated && credentialValue === credential && actor === operator &&
      destination === contract ? 'trusted-controller-01' : null
  }
  async throttle(_principal: string, _key: string) { this.throttleCount++; return this.allowed }
  async reserve(key: string) {
    this.takeCount++
    // A real implementation MUST be durable globally atomic, e.g. one
    // consistent owner; this Set is only a single-process adversarial fixture.
    if (this.claims.has(key)) return false
    this.claims.add(key)
    await Promise.resolve() // force interleaving after the atomic claim
    return true
  }
}
function prep(reader = new TestReader(), admission = new AtomicAdmission(), overrides = {}) {
  return prepareV4UnsignedExecution({ enabled: true, credential, admission,
    expectedOperator: operator, pin, intent, reader: reader as unknown as
      Parameters<typeof prepareV4UnsignedExecution>[0]['reader'], ...overrides })
}
const denied = (p: Promise<unknown>, code: string) => expect(p).rejects.toMatchObject({ code })

function externalReceipt(handoff: V4UnsignedHandoff, changes: Record<string, unknown> = {}) {
  const issuance = { address: contract, transactionHash: txHash, blockHash, blockNumber: 50n,
    topics: encodeEventTopics({ abi: eventAbi, eventName: 'IssuanceNonceConsumed',
      args: { operator, node } }), data: encodeAbiParameters(parseAbiParameters('uint256'), [7n]), removed: false }
  const issued = { address: contract, transactionHash: txHash, blockHash, blockNumber: 50n,
    topics: encodeEventTopics({ abi: eventAbi, eventName: 'SubnodeIssued',
      args: { parent: parentNode, node, holder: member } }),
    data: encodeAbiParameters(parseAbiParameters('address'), [operator]), removed: false }
  const tx = { hash: txHash, from: operator, to: contract, input: handoff.data,
    blockNumber: 50n, value: 0n, ...(changes.tx as object ?? {}) }
  const receipt = { transactionHash: txHash, from: operator, to: contract,
    status: 'success', blockHash, blockNumber: 50n, logs: [issuance, issued],
    ...(changes.receipt as object ?? {}) }
  const reader = {
    async getChainId() { return changes.chain ?? 11155420 },
    async getTransaction() { if (changes.throwRpc) throw Error('secret-rpc-url'); return tx },
    async getTransactionReceipt() { return receipt },
    async getBytecode() { return changes.runtimeChanged ? '0x6000' : bytecode },
    async getBlock({ blockTag }: { blockTag?: string }) {
      if (blockTag === 'finalized') return { number: changes.unfinalized ? 45n : 60n, hash: blockHash }
      return { hash: changes.reorg ? `0x${'ee'.repeat(32)}` : blockHash, number: 50n }
    },
    async readContract() { return changes.nonceNotConsumed ? 7n : 8n },
  }
  return { reader, receipt, issuance, issued }
}

describe('G2.6 opt-in V4 unsigned Worker execution adapter', () => {
  it('is disabled by default before authentication, quota, RPC, or reservation', async () => {
    const auth = new AtomicAdmission()
    const reader = new TestReader()
    await denied(prep(reader, auth, { enabled: undefined }), 'disabled')
    expect(auth.authCount).toBe(0)
    expect(auth.takeCount).toBe(0)
    expect(reader.reads).toEqual([])
  })

  it('requires server-authenticated scoped identity and durable atomic rate admission', async () => {
    const auth = new AtomicAdmission()
    auth.authenticated = false
    await denied(prep(new TestReader(), auth), 'unauthorized')
    expect(auth.throttleCount).toBe(0)
    auth.authenticated = true
    auth.allowed = false
    await denied(prep(new TestReader(), auth), 'rate-limited')
    expect(auth.takeCount).toBe(0)
    await denied(prep(new TestReader(), auth, { expectedOperator: controller }), 'invalid')
    await denied(prep(new TestReader(), auth, { credential: 'invalid' }), 'invalid')
  })

  it('requires full OP V4 onchain signature/nonce/grant simulation before reserving an execution handoff', async () => {
    const auth = new AtomicAdmission()
    const bad = new TestReader(); bad.badSignature = true
    await denied(prep(bad, auth), 'preflight-failed')
    const stale = new TestReader(); stale.nonce = 8n
    await denied(prep(stale, auth), 'preflight-failed')
    expect(auth.takeCount).toBe(0)
    const valid = new TestReader()
    const handoff = await prep(valid, auth)
    expect(handoff).toMatchObject({ status: 'UNSIGNED_HANDOFF_ONLY', signed: false,
      broadcast: false, l1NativeRights: false, scope: 'op-application-only',
      nonce: 7n, operator, member, chainId: 11155420, blockNumber: 40n })
    expect(valid.reads.every(([, block]) => block === 40n)).toBe(true)
    expect(handoff.data.startsWith('0x')).toBe(true)
    expect(handoff.digest).toBe(keccak256(handoff.data))
    expect(auth.takeCount).toBe(1)
  })

  it('rejects duplicate sequential and simultaneous same onchain nonce under shared atomic admission', async () => {
    const a = new AtomicAdmission()
    const [x, y] = await Promise.allSettled([prep(new TestReader(), a), prep(new TestReader(), a)])
    expect([x.status, y.status].sort()).toEqual(['fulfilled', 'rejected'])
    expect(a.takeCount).toBe(2)
    await denied(prep(new TestReader(), a), 'nonce-busy')
    expect(a.claims.size).toBe(1)
    // Even a separate process with a separate store might race; the EVM still
    // enforces the real issuanceNonce and the later transaction must revert.
    const changed = new TestReader(); changed.nonce = 8n
    await denied(prep(changed, new AtomicAdmission()), 'preflight-failed')
  })

  it('never logs or reflects signatures, credentials or RPC provider secrets in denial', async () => {
    const bad = new TestReader(); bad.badSignature = true
    const spy = new AtomicAdmission()
    try { await prep(bad, spy); throw Error('expected fail') } catch (error) {
      expect(String(error)).not.toContain(intent.signature)
      expect(String(error)).not.toContain(credential)
      expect(String(error)).not.toContain('secret-network-rpc-failure')
    }
  })

  it('validates independently externally mined finalized transaction, exact calldata and both V4 events', async () => {
    const handoff = await prep()
    const { reader } = externalReceipt(handoff)
    const result = await verifyV4ExternalReceipt(reader as unknown as
      Parameters<typeof verifyV4ExternalReceipt>[0], handoff, txHash)
    expect(result).toMatchObject({ status: 'EXTERNAL_OP_TX_OBSERVED_ONLY',
      receiptVerified: true, l1NativeRights: false, broadcastHere: false, signedHere: false,
      txHash, node, blockNumber: 50n })
  })

  it('fails closed for tampered, premature, reverted, replayed or forged receipt evidence', async () => {
    const handoff = await prep()
    const original = externalReceipt(handoff)
    const cases = [
      { chain: 10 }, { unfinalized: true }, { reorg: true }, { nonceNotConsumed: true },
      { runtimeChanged: true },
      { throwRpc: true }, { tx: { input: '0xaaaa' } }, { tx: { from: controller } },
      { tx: { to: controller } }, { tx: { value: 1n } },
      { receipt: { status: 'reverted' } }, { receipt: { blockHash: parentNode } },
      { receipt: { blockNumber: 30n }, tx: { blockNumber: 30n } },
      { receipt: { logs: [original.issued] } }, { receipt: { logs: [original.issuance] } },
      { receipt: { logs: [{ ...original.issuance, removed: true }, original.issued] } },
      { receipt: { logs: [{ ...original.issuance, blockNumber: 49n }, original.issued] } },
      { receipt: { logs: [{ ...original.issuance, address: controller }, original.issued] } },
      { receipt: { logs: [original.issuance, { ...original.issued,
        topics: encodeEventTopics({ abi: eventAbi, eventName: 'SubnodeIssued',
          args: { parent: parentNode, node, holder: controller } }) }] } },
      { receipt: { logs: [{ ...original.issuance, data: encodeAbiParameters(
        parseAbiParameters('uint256'), [8n]) }, original.issued] } },
    ]
    for (const item of cases) {
      const { reader } = externalReceipt(handoff, item)
      await denied(verifyV4ExternalReceipt(reader as unknown as
        Parameters<typeof verifyV4ExternalReceipt>[0], handoff, txHash), 'unverified-receipt')
    }
    await denied(verifyV4ExternalReceipt(original.reader as unknown as
      Parameters<typeof verifyV4ExternalReceipt>[0], { ...handoff, digest: parentNode }, txHash), 'unverified-receipt')
  })
})
