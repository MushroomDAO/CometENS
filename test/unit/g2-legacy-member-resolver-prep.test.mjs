import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, keccak256, namehash } from 'viem'
import { prepareLegacyMemberResolverChange, ResolverDraftRefused } from '../../scripts/prepare-legacy-member-resolver-change.mjs'
import { verifyLegacyNativeHandoff } from '../../scripts/verify-legacy-native-handoff.mjs'
import { ENSV1_SEPOLIA_WRAPPER } from '../../scripts/audit-legacy-ensv1-authority.mjs'

vi.mock('../../scripts/verify-legacy-native-handoff.mjs', () => ({ verifyLegacyNativeHandoff: vi.fn() }))

const ZERO = '0x0000000000000000000000000000000000000000'
const member = '0x1111111111111111111111111111111111111111'
const previousResolver = '0x2222222222222222222222222222222222222222'
const nextResolver = '0x3333333333333333333333333333333333333333'
const node = namehash('alice.community.eth')
const blockHash = `0x${'8'.repeat(64)}`
const nextCode = '0x60016000'
const nextCodeHash = keccak256(nextCode)
const input = { client: {
  getBytecode: vi.fn(async () => nextCode),
  getBlock: vi.fn(async () => ({ hash: blockHash })),
}, expectedMember: member, parentName: 'community.eth', childName: 'alice.community.eth',
  expectedResolver: previousResolver, expectedNextResolverCodeHash: nextCodeHash }
const evidence = {
  memberCanSetResolverObserved: true, memberResolverAutonomyObserved: false,
  expectedMember: member, childName: 'alice.community.eth',
  childNode: node, childResolver: previousResolver, finalizedBlockNumber: '123456',
  finalizedBlockHash: blockHash,
}

describe('G2.9 legacy member resolver draft (no native write)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(verifyLegacyNativeHandoff).mockResolvedValue(evidence)
    input.client.getBytecode.mockResolvedValue(nextCode)
    input.client.getBlock.mockResolvedValue({ hash: blockHash })
  })

  it('encodes only member-owned NameWrapper.setResolver calldata, NEVER sends or asserts sovereignty', async () => {
    const prepared = await prepareLegacyMemberResolverChange({ ...input, nextResolver })
    expect(prepared).toMatchObject({
      chainId: 11155111, from: member, to: ENSV1_SEPOLIA_WRAPPER, value: '0',
      previousResolver, proposedResolver: nextResolver,
      transactionSent: false, nativeHandoffCompleted: false, sovereignReceipt: false,
      lockedRecordVerified: false, ensV2AuthorityVerified: false,
      nextResolverCodeVerified: true, resolverInterfaceVerified: false,
      resolutionVerified: false, gatewayAvailabilityVerified: false,
    })
    const independentAbi = [{ type: 'function', name: 'setResolver', stateMutability: 'nonpayable',
      inputs: [{ type: 'bytes32' }, { type: 'address' }], outputs: [] }]
    expect(decodeFunctionData({ abi: independentAbi, data: prepared.data }))
      .toEqual({ functionName: 'setResolver', args: [node, nextResolver] })
    // Independently pinned 4-byte selector from ENSv1 NameWrapper source ABI;
    // do not let a matching mirrored test ABI hide the wrong target method.
    expect(prepared.data.slice(0, 10)).toBe('0x1896f70a')
    const { expectedNextResolverCodeHash, ...verifiedInputs } = input
    expect(verifyLegacyNativeHandoff).toHaveBeenCalledExactlyOnceWith(verifiedInputs)
    expect(input.client.getBytecode).toHaveBeenCalledWith({ address: nextResolver, blockNumber: 123456n })
    expect(input.client.getBlock).toHaveBeenCalledWith({ blockNumber: 123456n })
  })

  it('rejects invalid, unchanged or zero next resolvers before contacting evidence client', async () => {
    for (const nextResolver of [ZERO, previousResolver, 'not-an-address', '0x']) {
      await expect(prepareLegacyMemberResolverChange({ ...input, nextResolver }))
        .rejects.toBeInstanceOf(ResolverDraftRefused)
    }
    await expect(prepareLegacyMemberResolverChange({ ...input, expectedNextResolverCodeHash: '0x' }))
      .rejects.toMatchObject({ code: 'invalid-next-resolver' })
    expect(verifyLegacyNativeHandoff).toHaveBeenCalledTimes(1) // unchanged requires fresh comparison
  })

  it('refuses a locked resolver or owner whose native control was not observed', async () => {
    vi.mocked(verifyLegacyNativeHandoff).mockResolvedValue({ ...evidence, memberCanSetResolverObserved: false })
    await expect(prepareLegacyMemberResolverChange({ ...input, nextResolver }))
      .rejects.toMatchObject({ code: 'native-member-control-not-observed' })
  })

  it('propagates errors without silently treating unavailable L1 evidence as permission', async () => {
    vi.mocked(verifyLegacyNativeHandoff).mockRejectedValue(new ResolverDraftRefused('missing-native-evidence'))
    await expect(prepareLegacyMemberResolverChange({ ...input, nextResolver }))
      .rejects.toMatchObject({ code: 'missing-native-evidence' })
  })

  it('rejects EOAs, changed code, header drift and secret-bearing upstream errors', async () => {
    for (const code of ['0x', '0x6002']) {
      input.client.getBytecode.mockResolvedValue(code)
      await expect(prepareLegacyMemberResolverChange({ ...input, nextResolver }))
        .rejects.toMatchObject({ code: 'next-resolver-code-untrusted' })
    }
    input.client.getBytecode.mockResolvedValue(nextCode)
    input.client.getBlock.mockResolvedValue({ hash: `0x${'9'.repeat(64)}` })
    await expect(prepareLegacyMemberResolverChange({ ...input, nextResolver }))
      .rejects.toMatchObject({ code: 'changed-finalized-block' })
    input.client.getBytecode.mockRejectedValue(new Error('https://rpc.example/TOKEN-PRIVATE'))
    try { await prepareLegacyMemberResolverChange({ ...input, nextResolver }) }
    catch (error) {
      expect(error).toMatchObject({ code: 'resolver-rpc-unavailable' })
      expect(error.message).not.toContain('TOKEN-PRIVATE')
    }
  })
})
