import { describe, expect, it } from 'vitest'
import {
  corroborateNativeResultBlocks, reconcileWithSecondProviders,
} from '../../scripts/corroborate-g2-native-result.mjs'

const l1Hash = `0x${'11'.repeat(32)}`
const opHash = `0x${'22'.repeat(32)}`
const headHash = `0x${'33'.repeat(32)}`
const otherHash = `0x${'44'.repeat(32)}`
const requestId = `0x${'55'.repeat(32)}`
const node = `0x${'66'.repeat(32)}`
const l1TransactionHash = `0x${'77'.repeat(32)}`
const opTransactionHash = `0x${'88'.repeat(32)}`
const now = 2_000_000_000n
const observation = () => ({
  status: 'DUAL_RPC_OBSERVED', evidenceLevel: 'TWO_FINALIZED_RPC_OBSERVATIONS_ONLY',
  requestId, node, l1TransactionHash, opTransactionHash,
  sourceBlock: { number: '100', hash: l1Hash },
  opBlock: { number: '200', hash: opHash },
  ethereumConsensusIndependentlyVerified: false,
  nativeCurrentAuthorityVerified: false,
  finalizedL1IssuanceVerifiedOnOP: false,
  opGrantsNativeRights: false, sovereignReceipt: false,
})

function provider(chainId, number, hash, options = {}) {
  const calls = []
  let finalizedReads = 0
  let historicReads = 0
  return {
    calls,
    async getChainId() { calls.push(['chain']); return options.chainId ?? chainId },
    async getBlock(arg) {
      calls.push(['block', arg])
      if (arg.blockTag === 'finalized') {
        finalizedReads++
        return {
          number: finalizedReads > 1 ? (options.secondHeight ?? number + 10n) :
            (options.finalizedHeight ?? number + 10n),
          timestamp: options.timestamp ?? now - 60n,
          hash: finalizedReads > 1 ? (options.secondHeadHash ?? headHash) : headHash,
        }
      }
      historicReads++
      if (options.rpcError) throw new Error('https://api.host/?secret=NEVER_LEAK')
      return {
        number: options.historicHeight ?? number,
        hash: historicReads > 1 ? (options.secondHistoricalHash ?? hash) :
          (options.historicHash ?? hash),
      }
    },
  }
}
const l1 = config => provider(11155111, 100n, l1Hash, config)
const op = config => provider(11155420, 200n, opHash, config)
const check = (l1Config = {}, opConfig = {}, source = observation()) =>
  corroborateNativeResultBlocks({
    observation: source, secondaryL1: l1(l1Config), secondaryOp: op(opConfig),
    now: () => now,
  })

describe('G2 independent RPC header agreement is not native chain authority', () => {
  it('corroborates both historical block hashes, retaining all non-authority flags', async () => {
    const secondaryL1 = l1()
    const secondaryOp = op()
    const result = await corroborateNativeResultBlocks({
      observation: observation(), secondaryL1, secondaryOp, now: () => now,
    })
    expect(result).toMatchObject({
      status: 'TWO_RPC_PROVIDER_BLOCK_HASH_AGREEMENT', requestId, node,
      sourceBlock: { blockNumber: '100', blockHash: l1Hash },
      opBlock: { blockNumber: '200', blockHash: opHash },
      historicalObservationsCorroborated: true,
      providerIndependenceVerified: false, ethereumConsensusIndependentlyVerified: false,
      nativeCurrentAuthorityVerified: false, finalizedL1IssuanceVerifiedOnOP: false,
      opGrantsNativeRights: false, sovereignReceipt: false,
      evidenceLevel: 'SECONDARY_FINALIZED_RPC_HEADER_AGREEMENT_ONLY',
    })
    for (const [client, height] of [[secondaryL1, 100n], [secondaryOp, 200n]]) {
      expect(client.calls.filter(c => c[0] === 'block' && c[1].blockTag === 'finalized')).toHaveLength(2)
      expect(client.calls.filter(c => c[0] === 'block' && c[1].blockNumber === height)).toHaveLength(2)
    }
  })

  it('runs simultaneous read-only provider checks and pins both historical heights', async () => {
    const secondaryL1 = l1()
    const secondaryOp = op()
    let active = 0
    let peak = 0
    for (const client of [secondaryL1, secondaryOp]) {
      const original = client.getChainId
      client.getChainId = async () => {
        active++
        peak = Math.max(peak, active)
        await Promise.resolve()
        try { return await original() } finally { active-- }
      }
    }
    await corroborateNativeResultBlocks({
      observation: observation(), secondaryL1, secondaryOp, now: () => now,
    })
    expect(peak).toBeGreaterThanOrEqual(2)
    expect(secondaryL1.calls.filter(c => c[0] === 'block' && c[1].blockNumber === 100n)).toHaveLength(2)
    expect(secondaryOp.calls.filter(c => c[0] === 'block' && c[1].blockNumber === 200n)).toHaveLength(2)
  })

  it('fails on wrong secondary chain, missing finalized head, stale or future timestamp', async () => {
    for (const config of [
      { chainId: 1 }, { finalizedHeight: 99n }, { timestamp: 1n },
      { timestamp: now + 121n },
    ]) await expect(check(config)).rejects.toMatchObject({
      code: config.chainId ? 'wrong-secondary-chain' : 'untrusted-secondary-finality',
    })
  })

  it('fails if either provider disagrees with the observed historical block', async () => {
    await expect(check({ historicHash: otherHash })).rejects.toMatchObject({
      code: 'secondary-block-disagreement',
    })
    await expect(check({}, { historicHash: otherHash })).rejects.toMatchObject({
      code: 'secondary-block-disagreement',
    })
    await expect(check({ historicHeight: 101n })).rejects.toMatchObject({
      code: 'secondary-block-disagreement',
    })
    await expect(check({ secondHistoricalHash: otherHash })).rejects.toMatchObject({
      code: 'secondary-block-disagreement',
    })
  })

  it('rejects moving finalized head backwards or changing its hash at one height', async () => {
    await expect(check({ secondHeight: 100n })).rejects.toMatchObject({
      code: 'unstable-secondary-finality',
    })
    await expect(check({}, { secondHeight: 200n })).rejects.toMatchObject({
      code: 'unstable-secondary-finality',
    })
    await expect(check({ secondHeadHash: otherHash })).rejects.toMatchObject({
      code: 'unstable-secondary-finality',
    })
  })

  it('does not accept fabricated sovereignty, invalid source hashes or oversized heights', async () => {
    for (const source of [
      { ...observation(), sovereignReceipt: true },
      { ...observation(), providerIndependenceVerified: true,
        ethereumConsensusIndependentlyVerified: true },
      { ...observation(), sourceBlock: { number: '0', hash: l1Hash } },
      { ...observation(), opBlock: { number: '9'.repeat(150), hash: opHash } },
      { ...observation(), sourceBlock: { number: '100', hash: 'bad' } },
    ]) await expect(check({}, {}, source)).rejects.toMatchObject({ code: 'invalid-observation' })
  })

  it('rejects duplicated clients and sanitizes secondary RPC errors', async () => {
    const client = l1()
    await expect(corroborateNativeResultBlocks({
      observation: observation(), secondaryL1: client, secondaryOp: client,
      now: () => now,
    })).rejects.toMatchObject({ code: 'invalid-providers' })
    try {
      await check({ rpcError: true })
      throw new Error('expected failure')
    } catch (error) {
      expect(error.code).toBe('unverifiable-secondary-rpc')
      expect(error.message).not.toContain('NEVER_LEAK')
    }
    await expect(reconcileWithSecondProviders({
      l1Client: client, opClient: op(), secondaryL1: client, secondaryOp: op(),
      profile: {},
    })).rejects.toMatchObject({ code: 'invalid-providers' })
  })
})
