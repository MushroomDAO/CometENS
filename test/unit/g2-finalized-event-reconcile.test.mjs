import { describe, expect, it } from 'vitest'
import { keccak256, toHex } from 'viem'
import { scanFinalizedL1Events } from '../../scripts/scan-g2-finalized-l1-events.mjs'

const now = BigInt(Math.floor(Date.now() / 1000))
const addr = '0x1111111111111111111111111111111111111111'
const code = '0x6001600055'
const topic = `0x${'ba'.repeat(32)}`
const hash1 = `0x${'12'.repeat(32)}`
const hash2 = `0x${'34'.repeat(32)}`
const tx = `0x${'ab'.repeat(32)}`
const manifest = () => ({
  chainId: 11155111, startBlock: '128',
  sources: [{ address: addr, codeHash: keccak256(code), topics: [topic] }],
})
const event = (options = {}) => ({
  address: options.address ?? addr, topics: [options.topic ?? topic],
  blockNumber: toHex(options.blockNumber ?? 140n), blockHash: options.blockHash ?? hash1,
  transactionHash: options.transactionHash ?? tx, logIndex: toHex(options.logIndex ?? 0),
  removed: options.removed ?? false,
})

function fake(config = {}) {
  const calls = []
  const head = config.head ?? 150n
  const hash = config.headHash ?? hash1
  const io = {
    async getChainId() { calls.push(['chain']); return config.chainId ?? 11155111 },
    async getBlock(arg) {
      calls.push(['block', arg])
      if (arg.blockTag === 'finalized') return {
        number: config.finalizedBackwards && calls.filter(c => c[1]?.blockTag === 'finalized').length > 1
          ? head - 1n : head,
        hash: config.secondHeadHash && calls.filter(c => c[1]?.blockTag === 'finalized').length > 1
          ? config.secondHeadHash : hash,
        // The 120s future tolerance is checked against real time at execution;
        // leave ample margin for concurrent Vitest suite startup latency.
        timestamp: config.stale ? 1n : config.future ? now + 3600n : now - 30n,
      }
      return { number: config.badNumber && arg.blockNumber === head ? head - 1n : arg.blockNumber,
        hash: config.blockHashes?.[arg.blockNumber.toString()] ?? hash,
        timestamp: now - 30n }
    },
    async getBytecode({ address, blockNumber }) {
      calls.push(['code', address, blockNumber])
      if (config.rpcError) throw new Error('https://provider.invalid/?secret=SECRET')
      return config.badCode || config.badCodeAt?.includes(blockNumber.toString()) ? '0x6000' : code
    },
    async request(arg) {
      calls.push(['request', arg])
      if (config.rpcError) throw new Error('https://provider.invalid/?secret=SECRET')
      return config.logs ?? []
    },
  }
  return { io, calls }
}

describe('G2 L1 finalized event backfill trigger (not native ENS authority)', () => {
  it('scans the first finalized range and requires periodic ENS state reads even without an event', async () => {
    const { io, calls } = fake()
    const out = await scanFinalizedL1Events({ client: io, manifest: manifest() })
    expect(out).toMatchObject({
      status: 'NO_EVENTS', fromBlock: '128', toBlock: '150', caughtUp: true,
      mustReconcileNativeState: true, evidenceLevel: 'FINALIZED_RPC_TRIGGER_ONLY',
      enablesNativeIssuance: false, sovereignReceipt: false,
      cursor: { chainId: 11155111, block: { number: '150', hash: hash1 } },
    })
    expect(out.events).toEqual([])
    expect(calls.find(c => c[0] === 'request')[1]).toMatchObject({
      method: 'eth_getLogs', params: [{
        address: addr, topics: [[topic]], fromBlock: '0x80', toBlock: '0x96',
      }],
    })
  })

  it('emits validated sorted event triggers and advances cursor only after the contiguous range', async () => {
    const { io } = fake({ logs: [event({ blockNumber: 149n, logIndex: 3 }),
      event({ blockNumber: 140n, logIndex: 0 })] })
    const out = await scanFinalizedL1Events({ client: io, manifest: manifest() })
    expect(out.status).toBe('EVENTS_OBSERVED')
    expect(out.events.map(e => [e.blockNumber, e.logIndex])).toEqual([['140', 0], ['149', 3]])
    expect(out.reason).toBe('EVENT_AND_PERIODIC_STATE_CHECK')
    expect(out.cursor.block.number).toBe('150')
  })

  it('rejects bad chain, stale finalized head, runtime hash and wrong source/topic/log provenance', async () => {
    for (const cfg of [
      { chainId: 1 }, { stale: true }, { future: true }, { badCode: true },
      { logs: [event({ address: '0x2222222222222222222222222222222222222222' })] },
      { logs: [event({ topic: hash2 })] },
      { logs: [event({ blockNumber: 160n })] },
      { logs: [event({ removed: true })] },
    ]) {
      await expect(scanFinalizedL1Events({ client: fake(cfg).io, manifest: manifest() })).rejects.toBeTruthy()
    }
  })

  it('requires pinned bytecode at BOTH ends, even if the other endpoint remains valid', async () => {
    for (const badCodeAt of [['128'], ['150']]) {
      await expect(scanFinalizedL1Events({ client: fake({ badCodeAt }).io, manifest: manifest() }))
        .rejects.toMatchObject({ code: 'untrusted-source-code' })
    }
  })

  it('fails closed on invalid range bounds, unfinalized starts and prior cursor from before start', async () => {
    await expect(scanFinalizedL1Events({ client: fake().io, manifest: {
      ...manifest(), startBlock: '151',
    } })).rejects.toMatchObject({ code: 'start-not-finalized' })
    const prior = (await scanFinalizedL1Events({ client: fake().io, manifest: manifest() })).cursor
    for (const altered of [
      { ...prior, block: { ...prior.block, number: '127' } },
      { ...prior, block: { ...prior.block, number: '151' } },
    ]) {
      await expect(scanFinalizedL1Events({ client: fake().io, manifest: manifest(),
        previous: altered })).rejects.toMatchObject({ code: 'finalized-conflict' })
    }
  })

  it('rejects inconsistent hashes for logs in the same block and invalid raw index or topic', async () => {
    const differentTx = `0x${'56'.repeat(32)}`
    for (const logs of [
      [event(), event({ transactionHash: differentTx, blockHash: hash2, logIndex: 1 })],
      [{ ...event(), logIndex: '-0x1' }],
      [{ ...event(), logIndex: 'not-a-hex-number' }],
      [{ ...event(), blockHash: '0x123' }],
      [{ ...event(), topics: 'not-an-array' }],
    ]) {
      await expect(scanFinalizedL1Events({ client: fake({ logs }).io, manifest: manifest() }))
        .rejects.toMatchObject({ code: expect.stringMatching(/invalid-log-batch|conflicting-log-block/) })
    }
  })

  it('rejects oversize log batches rather than silently dropping events', async () => {
    const logs = Array.from({ length: 513 }, (_, index) => event({ logIndex: index }))
    await expect(scanFinalizedL1Events({ client: fake({ logs }).io, manifest: manifest() }))
      .rejects.toMatchObject({ code: 'invalid-log-batch' })
  })

  it('enforces source and topic ceilings, no zero codehash and no repeated selectors', async () => {
    const source = manifest().sources[0]
    for (const sources of [
      [{ ...source, codeHash: `0x${'00'.repeat(32)}` }],
      [{ ...source, topics: [topic, topic] }],
      [{ ...source, topics: Array.from({ length: 25 }, (_, i) =>
        `0x${i.toString(16).padStart(64, '0')}`) }],
      Array.from({ length: 13 }, (_, i) => ({ ...source,
        address: `0x${(i + 1).toString(16).padStart(40, '0')}` })),
    ]) {
      await expect(scanFinalizedL1Events({ client: fake().io, manifest: {
        ...manifest(), sources,
      } })).rejects.toMatchObject({ code: 'invalid-manifest' })
    }
  })

  it('refuses forged log block hashes, repeated log IDs and inconsistent finalized hash', async () => {
    const configs = [
      { logs: [event({ blockHash: hash2 })] },
      { logs: [event(), event()] },
      { secondHeadHash: hash2 },
      { finalizedBackwards: true },
      { badNumber: true },
    ]
    for (const cfg of configs) {
      await expect(scanFinalizedL1Events({ client: fake(cfg).io, manifest: manifest() }))
        .rejects.toMatchObject({ code: expect.stringMatching(/conflict|duplicate/) })
    }
  })

  it('limits range to 128 finalized blocks, rechecks the previous cursor hash, and resumes', async () => {
    const first = await scanFinalizedL1Events({ client: fake({ head: 1000n }).io, manifest: manifest() })
    expect(first.toBlock).toBe('255')
    expect(first.caughtUp).toBe(false)
    const later = await scanFinalizedL1Events({ client: fake({ head: 1100n }).io,
      manifest: manifest(), previous: first.cursor })
    expect(later.fromBlock).toBe('256')
    expect(later.toBlock).toBe('383')
    await expect(scanFinalizedL1Events({ client: fake({
      head: 1100n, blockHashes: { '255': hash2 },
    }).io, manifest: manifest(), previous: first.cursor })).rejects.toMatchObject({
      code: 'finalized-conflict',
    })
  })

  it('does not query duplicate finalized ranges when already caught up', async () => {
    const first = await scanFinalizedL1Events({ client: fake().io, manifest: manifest() })
    const { io, calls } = fake()
    const again = await scanFinalizedL1Events({ client: io, manifest: manifest(), previous: first.cursor })
    expect(again.status).toBe('UNCHANGED')
    expect(again.mustReconcileNativeState).toBe(true)
    expect(calls.some(c => c[0] === 'request')).toBe(false)
  })

  it('rejects mismatched previous source identity, truncated/forged cursor and invalid manifest', async () => {
    const first = await scanFinalizedL1Events({ client: fake().io, manifest: manifest() })
    for (const prev of [
      { ...first.cursor, version: 'old' }, { ...first.cursor, chainId: 1 },
      { ...first.cursor, block: { ...first.cursor.block, hash: 'bad' } },
      { ...first.cursor, manifestHash: hash2 },
    ]) {
      await expect(scanFinalizedL1Events({ client: fake().io, manifest: manifest(), previous: prev }))
        .rejects.toMatchObject({ code: 'invalid-previous' })
    }
    for (const bad of [
      { ...manifest(), sources: [] },
      { ...manifest(), chainId: 1 },
      { ...manifest(), sources: [manifest().sources[0], manifest().sources[0]] },
      { ...manifest(), startBlock: '-1' },
    ]) {
      await expect(scanFinalizedL1Events({ client: fake().io, manifest: bad }))
        .rejects.toMatchObject({ code: 'invalid-manifest' })
    }
  })

  it('rejects provider failures without leaking an RPC credential', async () => {
    try {
      await scanFinalizedL1Events({ client: fake({ rpcError: true }).io, manifest: manifest() })
      throw new Error('expected an error')
    } catch (e) {
      expect(e.code).toBe('unverifiable-rpc')
      expect(e.message).not.toContain('SECRET')
    }
  })
})
