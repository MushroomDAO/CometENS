import { describe, expect, it, vi } from 'vitest'
import { keccak256, namehash } from 'viem'
import {
  monitorLegacyL1, MonitorFailure, runLegacyMonitorCommand,
} from '../../scripts/monitor-g2-legacy-l1.mjs'
import {
  ENSV1_SEPOLIA_REGISTRY, ENSV1_SEPOLIA_WRAPPER,
  CANNOT_UNWRAP, PARENT_CANNOT_CONTROL,
} from '../../scripts/audit-legacy-ensv1-authority.mjs'

const parentName = 'community.eth'
const childName = 'alice.community.eth'
const a = '0x1111111111111111111111111111111111111111'
const b = '0x2222222222222222222222222222222222222222'
const c = '0x3333333333333333333333333333333333333333'
const ZERO = '0x0000000000000000000000000000000000000000'
const registryCode = '0x6001600055'
const wrapperCode = '0x6002600055'
const now = BigInt(Math.floor(Date.now() / 1000))
const expected = {
  parentName, childName,
  expectedRegistryCodeHash: keccak256(registryCode),
  expectedWrapperCodeHash: keccak256(wrapperCode),
  now: () => now,
}
const hash1 = `0x${'12'.repeat(32)}`
const hash2 = `0x${'34'.repeat(32)}`

function fake(options = {}) {
  const calls = []
  let finalizedCalls = 0
  const blockNumber = options.blockNumber ?? 54321n
  const timestamp = options.timestamp ?? now - 60n
  const hash = options.hash ?? hash1
  const parentNode = namehash(parentName)
  const childNode = namehash(childName)
  return {
    calls,
    client: {
      async getChainId() { calls.push('chain'); return options.chainId ?? 11155111 },
      async getBlock(arg) {
        calls.push(JSON.stringify(arg, (_, v) => typeof v === 'bigint' ? String(v) : v))
        if (arg.blockTag === 'finalized') {
          finalizedCalls++
          const second = finalizedCalls === 2
          return { number: second ? (options.secondFinalizedNumber ?? blockNumber) : blockNumber,
            hash: second ? (options.secondHash ?? hash) : hash, timestamp }
        }
        if (arg.blockNumber !== blockNumber) {
          expect(arg).toEqual({ blockNumber: 54321n })
          return { number: 54321n, hash: options.ancestorHash ?? hash1,
            timestamp: options.ancestorTimestamp ?? now - 60n }
        }
        return { number: options.returnedNumber ?? blockNumber, hash, timestamp: options.returnedTimestamp ?? timestamp }
      },
      async getBytecode({ address, blockNumber: at }) {
        expect(at).toBe(blockNumber)
        if (options.rpcError) throw new Error('SECRET-RPC-KEY-CANT-LEAK')
        return address === ENSV1_SEPOLIA_REGISTRY ? registryCode : wrapperCode
      },
      async readContract({ address, functionName, args, blockNumber: at }) {
        expect(at).toBe(blockNumber)
        if (options.rpcError) throw new Error('SECRET-RPC-KEY-CANT-LEAK')
        const isParent = args[0] === parentNode || args[0] === BigInt(parentNode)
        const isChild = args[0] === childNode || args[0] === BigInt(childNode)
        expect(isParent || isChild).toBe(true)
        if (functionName === 'owner') {
          expect(address).toBe(ENSV1_SEPOLIA_REGISTRY)
          return isParent ? (options.parentRegistryOwner ?? ENSV1_SEPOLIA_WRAPPER) :
            (options.childRegistryOwner ?? ENSV1_SEPOLIA_WRAPPER)
        }
        expect(address).toBe(ENSV1_SEPOLIA_WRAPPER)
        return isParent
          ? [options.parentHolder ?? a, options.parentFuses ?? CANNOT_UNWRAP, options.parentExpiry ?? now + 3600n]
          : [options.childHolder ?? b, options.childFuses ?? (CANNOT_UNWRAP | PARENT_CANNOT_CONTROL),
            options.childExpiry ?? now + 1200n]
      },
    },
  }
}

describe('G2 finalized-RPC legacy L1 monitor (never an authority gate)', () => {
  it('captures baseline with same-block finalized reads and never claims native/OP privileges', async () => {
    const { client, calls } = fake()
    const result = await monitorLegacyL1({ ...expected, client })
    expect(result).toMatchObject({
      status: 'BASELINE', changedFields: [], evidenceLevel: 'FINALIZED_RPC_OBSERVATION_ONLY',
      monitorCompleteness: 'POLLING_ONLY', enablesNativeIssuance: false,
      sovereignReceipt: false, opControllerAuthorityVerified: false, ensV2AuthorityVerified: false,
      cursor: { chainId: 11155111, block: { number: '54321', hash: hash1 }, observed: {
        parentWrappedHolder: a, childWrappedHolder: b, childEmancipated: true,
      } },
    })
    expect(calls.filter((s) => s.includes('"blockTag":"finalized"'))).toHaveLength(2)
    expect(calls).toContain('{"blockNumber":"54321"}')
  })

  it('compares genuine finalized transitions and accepts unchanged observations from later blocks', async () => {
    const previous = (await monitorLegacyL1({ ...expected, client: fake().client })).cursor
    const unchanged = await monitorLegacyL1({ ...expected,
      client: fake({ blockNumber: 54322n, hash: hash2 }).client, previous })
    expect(unchanged.status).toBe('UNCHANGED')
    const changed = await monitorLegacyL1({ ...expected, previous,
      client: fake({ blockNumber: 54322n, hash: hash2, parentHolder: c }).client })
    expect(changed.status).toBe('CHANGED')
    expect(changed.changedFields).toEqual(['parentWrappedHolder'])
    expect(changed.cursor.observed.parentWrappedHolder).toBe(c)
  })

  it('detects expiry crossing with no event and also detects lost fuses/registry holder', async () => {
    const prior = (await monitorLegacyL1({ ...expected, client: fake().client })).cursor
    const expired = await monitorLegacyL1({ ...expected, previous: prior,
      now: () => now + 1300n, client: fake({ blockNumber: 54322n, hash: hash2 }).client })
    expect(expired.status).toBe('AT_RISK')
    expect(expired.changedFields).toEqual([])
    const noNewBlock = await monitorLegacyL1({ ...expected, previous: prior,
      now: () => now + 1300n, client: fake().client })
    expect(noNewBlock.status).toBe('AT_RISK')
    expect(noNewBlock.changedFields).toEqual([])
    const unwrapped = await monitorLegacyL1({ ...expected, previous: prior,
      client: fake({ blockNumber: 54322n, hash: hash2,
        childRegistryOwner: c, childFuses: 0 }).client })
    expect(unwrapped.status).toBe('AT_RISK')
    expect(unwrapped.changedFields).toContain('childRegistryOwner')
    expect(unwrapped.changedFields).toContain('childEmancipated')
    expect(unwrapped.cursor.observed.childWrappedHolder).toBeNull()
  })

  it('detects missing parent lock and the childExpiry exactly at the expiry boundary', async () => {
    const noParentLock = await monitorLegacyL1({ ...expected, client: fake({ parentFuses: 0 }).client })
    expect(noParentLock.status).toBe('AT_RISK')
    expect(noParentLock.cursor.observed.parentLocked).toBe(false)
    const boundary = await monitorLegacyL1({ ...expected, client: fake({ childExpiry: now }).client })
    expect(boundary.status).toBe('AT_RISK')
    expect(boundary.cursor.observed.childEmancipated).toBe(false)
  })

  it('permits same-block derived expiry changes but rejects same-block raw-state changes', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Number(now * 1000n))
    try {
      const prior = (await monitorLegacyL1({ ...expected,
        client: fake({ childExpiry: now + 200n }).client })).cursor
      clock.mockReturnValue(Number((now + 300n) * 1000n))
      const expired = await monitorLegacyL1({ ...expected, previous: prior,
        now: () => now + 300n, client: fake({ childExpiry: now + 200n }).client })
      expect(expired.status).toBe('AT_RISK')
      expect(expired.changedFields).toContain('childLocked')
      expect(expired.changedFields).toContain('childEmancipated')
    } finally {
      clock.mockRestore()
    }
  })

  it('refuses finalized rollback or different same-height hash with no optimistic recovery', async () => {
    const previous = (await monitorLegacyL1({ ...expected, client: fake().client })).cursor
    for (const options of [
      { blockNumber: 54320n, hash: hash2 },
      { blockNumber: 54321n, hash: hash2 },
      { blockNumber: 54321n, parentHolder: c },
    ]) {
      await expect(monitorLegacyL1({ ...expected, previous, client: fake(options).client }))
        .rejects.toMatchObject({ code: 'finalized-conflict' })
    }
  })

  it('rechecks the prior finalized block hash and timestamp when advancing height', async () => {
    const previous = (await monitorLegacyL1({ ...expected, client: fake().client })).cursor
    for (const options of [
      { blockNumber: 54322n, hash: hash2, ancestorHash: hash2 },
      { blockNumber: 54322n, hash: hash2, ancestorTimestamp: now - 61n },
    ]) {
      await expect(monitorLegacyL1({ ...expected, previous, client: fake(options).client }))
        .rejects.toMatchObject({ code: 'finalized-conflict' })
    }
  })

  it('rejects moving finalized head and mismatched numbered block identity', async () => {
    for (const options of [
      { returnedNumber: 123n },
      { returnedTimestamp: now - 1n },
      { secondHash: hash2 },
      { secondFinalizedNumber: 54320n },
    ]) {
      await expect(monitorLegacyL1({ ...expected, client: fake(options).client }))
        .rejects.toMatchObject({ code: 'unstable-finalized-block' })
    }
  })

  it('rejects changed identity, missing proof pins, malformed cursor and wrong chain', async () => {
    const previous = (await monitorLegacyL1({ ...expected, client: fake().client })).cursor
    for (const modified of [
      { ...previous, version: 'old' },
      { ...previous, source: 'WORKER_ASSERTION' },
      { ...previous, chainId: 1 },
      { ...previous, parentName: 'other.eth' },
      { ...previous, pins: { ...previous.pins, registry: hash2 } },
      { ...previous, childName: 'bob.community.eth' },
      { ...previous, pins: { ...previous.pins, wrapper: hash2 } },
      { ...previous, block: { ...previous.block, hash: 'bad' } },
      { ...previous, observed: { ...previous.observed, parentExpiry: 'Infinity' } },
      { ...previous, observed: { ...previous.observed, childWrappedHolder: 'not-address' } },
    ]) await expect(monitorLegacyL1({ ...expected, previous: modified, client: fake().client }))
      .rejects.toMatchObject({ code: 'invalid-previous' })
    await expect(monitorLegacyL1({ ...expected, expectedRegistryCodeHash: ZERO, client: fake().client }))
      .rejects.toBeInstanceOf(MonitorFailure)
    await expect(monitorLegacyL1({ ...expected, client: fake({ chainId: 1 }).client }))
      .rejects.toMatchObject({ code: 'unverifiable-source' })
  })

  it('scrubs upstream RPC failures, never echoes secret provider exception text', async () => {
    try {
      await monitorLegacyL1({ ...expected, client: fake({ rpcError: true }).client })
      throw new Error('expected failure')
    } catch (error) {
      expect(error).toMatchObject({ code: 'unverifiable-source' })
      expect(error.message).not.toContain('SECRET')
    }
  })

  it('runs the real CLI argument pipeline to BASELINE without --previous, then accepts a valid cursor', async () => {
    const args = ['--mode', 'legacy-ensv1-sepolia', '--parent', parentName,
      '--child', childName, '--registry-codehash', expected.expectedRegistryCodeHash,
      '--wrapper-codehash', expected.expectedWrapperCodeHash]
    const first = await runLegacyMonitorCommand({
      args, rpc: 'https://rpc.example/', makeClient: () => fake().client,
      loadPrevious: async () => { throw new Error('unexpected previous read') },
    })
    expect(first.status).toBe('BASELINE')
    const result = await runLegacyMonitorCommand({
      args: [...args, '--previous', 'previous.json'], rpc: 'https://rpc.example/',
      makeClient: () => fake({ blockNumber: 54322n, hash: hash2 }).client,
      loadPrevious: async path => {
        expect(path).toBe('previous.json')
        return Buffer.from(JSON.stringify(first.cursor))
      },
    })
    expect(result.status).toBe('UNCHANGED')
  })

  it('CLI rejects explicit null/empty/truncated cursor and missing --previous value', async () => {
    const args = ['--mode', 'legacy-ensv1-sepolia', '--parent', parentName,
      '--child', childName, '--registry-codehash', expected.expectedRegistryCodeHash,
      '--wrapper-codehash', expected.expectedWrapperCodeHash]
    for (const raw of ['null', '', 'undefined', '{}']) {
      await expect(runLegacyMonitorCommand({
        args: [...args, '--previous', 'previous.json'], rpc: 'https://rpc.example/',
        makeClient: () => fake().client, loadPrevious: async () => Buffer.from(raw),
      })).rejects.toMatchObject({ code: 'invalid-previous' })
    }
    for (const broken of [
      [...args, '--previous'],
      [...args, '--previous', '--mode'],
      [...args, '--previous', ''],
    ]) {
      await expect(runLegacyMonitorCommand({
        args: broken, rpc: 'https://rpc.example/',
      })).rejects.toMatchObject({ code: 'invalid-arguments' })
    }
  })
})
