import { describe, expect, it } from 'vitest'
import { keccak256, namehash, stringToHex } from 'viem'
import { verifyLegacyNativeHandoff, LegacyHandoffEvidenceError, LEGACY_SEPOLIA_REGISTRAR } from '../../scripts/verify-legacy-native-handoff.mjs'
import { ENSV1_SEPOLIA_REGISTRY as REGISTRY, ENSV1_SEPOLIA_WRAPPER as WRAPPER,
  CANNOT_UNWRAP, PARENT_CANNOT_CONTROL } from '../../scripts/audit-legacy-ensv1-authority.mjs'

const now = BigInt(Math.floor(Date.now() / 1000))
const ZERO = '0x0000000000000000000000000000000000000000'
const member = '0x1111111111111111111111111111111111111111'
const operator = '0x2222222222222222222222222222222222222222'
const resolver = '0x3333333333333333333333333333333333333333'
const parentName = 'community.eth'
const childName = `alice.${parentName}`
const parentNode = namehash(parentName)
const childNode = namehash(childName)
const parentLabelToken = BigInt(keccak256(stringToHex('community')))
const runtime = ['0x600160', '0x600260', '0x600360']
const args = { parentName, childName, expectedMember: member, expectedResolver: resolver,
  expectedRegistryCodeHash: keccak256(runtime[0]), expectedWrapperCodeHash: keccak256(runtime[1]),
  expectedRegistrarCodeHash: keccak256(runtime[2]), sampledOperators: [operator] }

function mock(o = {}) {
  const calls = []
  const client = {
    async getChainId() { calls.push('chain'); return o.chainId ?? 11155111 },
    async getBlock(input) {
      if ('blockNumber' in input) {
        expect(input).toEqual({ blockNumber: 555n }); calls.push('recheck')
      } else {
        expect(input).toEqual({ blockTag: 'finalized' }); calls.push('block')
      }
      return { number: 555n, timestamp: o.timestamp ?? now - 60n,
        hash: ('blockNumber' in input ? o.followupBlockHash : o.blockHash) ?? `0x${'4'.repeat(64)}` }
    },
    async getBytecode({ address, blockNumber }) {
      expect(blockNumber).toBe(555n)
      calls.push(`bytecode:${address}`)
      if (address === REGISTRY) return o.registryCode ?? runtime[0]
      if (address === WRAPPER) return o.wrapperCode ?? runtime[1]
      if (address === LEGACY_SEPOLIA_REGISTRAR) return o.registrarCode ?? runtime[2]
      throw new Error('unexpected code')
    },
    async readContract({ address, functionName, args: inputs, blockNumber }) {
      expect(blockNumber).toBe(555n)
      calls.push(`${functionName}:${address}`)
      if (o.rpcError) throw new Error('https://secret.rpc.example/api/KEY_NEVER_PRINT')
      if (address === REGISTRY) {
        expect([parentNode, childNode]).toContain(inputs[0])
        if (functionName === 'resolver') return o.resolver ?? resolver
        return inputs[0] === parentNode ? (o.parentRegistryOwner ?? WRAPPER) : (o.childRegistryOwner ?? WRAPPER)
      }
      if (address === LEGACY_SEPOLIA_REGISTRAR) {
        if (functionName === 'isApprovedForAll') {
          expect(inputs).toEqual([WRAPPER, operator]); return o.registrarOperatorApproved ?? false
        }
        expect(inputs).toEqual([parentLabelToken])
        if (functionName === 'ownerOf') return o.registrarOwner ?? WRAPPER
        if (functionName === 'getApproved') return o.registrarApproved ?? ZERO
        return o.registrarExpiry ?? now + 30n * 86400n
      }
      expect(address).toBe(WRAPPER)
      if (functionName === 'getData') {
        if (inputs[0] === BigInt(parentNode)) return [o.parentHolder ?? member, o.parentFuses ?? CANNOT_UNWRAP,
          o.parentExpiry ?? now + 60n * 86400n]
        expect(inputs[0]).toBe(BigInt(childNode))
        return [o.childHolder ?? member, o.childFuses ?? CANNOT_UNWRAP | PARENT_CANNOT_CONTROL,
          o.childExpiry ?? now + 7n * 86400n]
      }
      if (functionName === 'getApproved') return o.childApproved ?? ZERO
      if (functionName === 'upgradeContract') return o.upgradeContract ?? ZERO
      expect(functionName).toBe('isApprovedForAll')
      expect(inputs).toEqual([member, operator])
      return o.operatorApproved ?? false
    },
  }
  return { client, calls }
}

describe('G2 legacy native handoff observations — never sovereign receipt', () => {
  it('actually issues concurrent finalized codehash reads without an authorization or write race', async () => {
    const { client } = mock()
    const original = client.getBytecode
    let active = 0
    let maxActive = 0
    client.getBytecode = async (opts) => {
      active++
      maxActive = Math.max(maxActive, active)
      await Promise.resolve()
      try { return await original(opts) } finally { active-- }
    }
    const result = await verifyLegacyNativeHandoff({ ...args, client })
    expect(maxActive).toBe(3)
    expect(result.sovereignReceipt).toBe(false)
  })

  it('runs contract state observations concurrently at the pinned finalized block', async () => {
    const { client } = mock()
    const original = client.readContract
    let active = 0
    let maxActive = 0
    client.readContract = async (options) => {
      active++
      maxActive = Math.max(maxActive, active)
      await Promise.resolve()
      try { return await original(options) } finally { active-- }
    }
    await verifyLegacyNativeHandoff({ ...args, client })
    expect(maxActive).toBe(10)
  })

  it('observes member and PCC/CU in one finalized pinned chain snapshot', async () => {
    const { client, calls } = mock()
    const result = await verifyLegacyNativeHandoff({ ...args, client })
    expect(result).toMatchObject({
      mode: 'LEGACY_ENSV1_FINALIZED_OBSERVATIONS_NOT_SOVEREIGN',
      finalizedBlockNumber: '555', finalizedBlockHash: `0x${'4'.repeat(64)}`,
      registrarNFTCustodyMatchesWrapper: true,
      nativeTitleSnapshotMatches: true, memberCanSetResolverObserved: true,
      nativeLegacyHandoffConditionsObserved: false, nativeHandoffSafetyObserved: false,
      memberResolverAutonomyObserved: false, knownPrivilegePathObserved: false,
      memberCanTransferObserved: true, memberCanSelfExtendExpiryObserved: false,
      approvalInventoryExhaustive: false, sovereignReceipt: false,
      ensV2AuthorityVerified: false, opControllerAuthorityVerified: false,
      independentConsensusProofVerified: false,
    })
    expect(calls.filter((v) => v === 'block')).toHaveLength(1)
    expect(calls.filter((v) => v === 'recheck')).toHaveLength(1)
    expect(calls.filter((v) => v.startsWith('bytecode:'))).toHaveLength(3)
    expect(calls.filter((v) => v.startsWith('getData:'))).toHaveLength(2)
  })

  it('rejects wrong chain, stale finality, missing hash and bytecode mismatches', async () => {
    for (const [option, code] of [
      [{ chainId: 10 }, 'wrong-chain'],
      [{ timestamp: now - 9000n }, 'stale-finality'],
      [{ blockHash: '0x0' }, 'missing-finalized-block'],
      [{ blockHash: `0x${'0'.repeat(64)}` }, 'missing-finalized-block'],
      [{ followupBlockHash: `0x${'5'.repeat(64)}` }, 'changed-finalized-block'],
      [{ wrapperCode: '0x' }, 'untrusted-code'],
      [{ registrarCode: '0x6000' }, 'untrusted-code'],
    ]) await expect(verifyLegacyNativeHandoff({ ...args, client: mock(option).client }))
      .rejects.toMatchObject({ code })
  })

  it('does not count registrar grace, unwrapped parent or custody divergence as native conditions', async () => {
    for (const options of [
      { registrarExpiry: now - 1n }, { registrarExpiry: now + 3600n },
      { registrarOwner: operator }, { parentRegistryOwner: operator }, { childRegistryOwner: member },
      { parentHolder: ZERO },
      { parentFuses: 0 }, { childHolder: operator },
      { childFuses: CANNOT_UNWRAP }, { childFuses: PARENT_CANNOT_CONTROL },
      { childExpiry: now - 1n }, { childExpiry: now + 60n * 86400n },
    ]) {
      const r = await verifyLegacyNativeHandoff({ ...args, client: mock(options).client })
      expect(r.nativeTitleSnapshotMatches, JSON.stringify(options, (_, v) => typeof v === 'bigint' ? String(v) : v)).toBe(false)
      expect(r.sovereignReceipt).toBe(false)
    }
  })

  it('distinguishes member resolver capability from unproven exclusive authority', async () => {
    for (const o of [{ resolver: member }, { childFuses: CANNOT_UNWRAP | PARENT_CANNOT_CONTROL | 8 }]) {
      const r = await verifyLegacyNativeHandoff({ ...args, client: mock(o).client })
      expect(r.memberCanSetResolverObserved).toBe(false)
      expect(r.sovereignReceipt).toBe(false)
    }
    // An attacker with Registrar reclaim rights can leave name/wrapper owner
    // + PCC/CU looking valid; only the raw snapshot matches, not safe handoff.
    for (const o of [{ operatorApproved: true }, { childApproved: operator },
      { registrarApproved: operator }, { registrarOperatorApproved: true },
      { upgradeContract: operator }]) {
      const r = await verifyLegacyNativeHandoff({ ...args, client: mock(o).client })
      expect(r.nativeTitleSnapshotMatches).toBe(true)
      expect(r.knownPrivilegePathObserved).toBe(true)
      expect(r.nativeLegacyHandoffConditionsObserved).toBe(false)
      expect(r.nativeHandoffSafetyObserved).toBe(false)
      expect(r.memberResolverAutonomyObserved).toBe(false)
      expect(r.memberCanSetResolverObserved).toBe(true) // nonexclusive ability
    }
    const r = await verifyLegacyNativeHandoff({ ...args, client: mock({ registrarApproved: operator,
      upgradeContract: operator }).client })
    expect(r.registrarNFTApprovalObserved).toBe(true)
    expect(r.upstreamWrapperUpgradeContractConfigured).toBe(true)
    expect(r.approvalInventoryExhaustive).toBe(false)
  })

  it('reports transfer and member self-renewal fuse capabilities without treating either as sovereignty', async () => {
    const locked = await verifyLegacyNativeHandoff({ ...args, client: mock({
      childFuses: CANNOT_UNWRAP | PARENT_CANNOT_CONTROL | (1 << 2) | (1 << 18),
    }).client })
    expect(locked.memberCanTransferObserved).toBe(false)
    expect(locked.memberCanSelfExtendExpiryObserved).toBe(true)
    expect(locked.nativeHandoffSafetyObserved).toBe(false)
  })

  it('rejects bad scope, label normalization and pins before RPC reads', async () => {
    const { client, calls } = mock()
    for (const change of [
      { parentName: 'team.community.eth' }, { parentName: 'Community.eth' },
      { childName: 'bob.evil.eth' }, { childName: 'ALICE.community.eth' },
      { childName: 'xn--unsafe.community.eth' }, { expectedMember: ZERO },
      { expectedResolver: ZERO }, { expectedRegistrarCodeHash: '0x33' },
      { sampledOperators: [ZERO] }, { sampledOperators: Array(21).fill(operator) },
    ]) await expect(verifyLegacyNativeHandoff({ ...args, ...change, client }))
      .rejects.toBeInstanceOf(LegacyHandoffEvidenceError)
    expect(calls).toHaveLength(0)
  })

  it('redacts provider errors, not URLs or raw bodies', async () => {
    await expect(verifyLegacyNativeHandoff({ ...args, client: mock({ rpcError: true }).client }))
      .rejects.toMatchObject({ code: 'rpc-or-contract-error' })
    try { await verifyLegacyNativeHandoff({ ...args, client: mock({ rpcError: true }).client }) }
    catch (e) { expect(e.message).not.toContain('KEY_NEVER_PRINT') }
  })
})
