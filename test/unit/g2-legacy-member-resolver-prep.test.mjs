import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, namehash } from 'viem'
import { prepareLegacyMemberResolverChange, ResolverDraftRefused } from '../../scripts/prepare-legacy-member-resolver-change.mjs'
import { verifyLegacyNativeHandoff } from '../../scripts/verify-legacy-native-handoff.mjs'
import { ENSV1_SEPOLIA_WRAPPER } from '../../scripts/audit-legacy-ensv1-authority.mjs'

vi.mock('../../scripts/verify-legacy-native-handoff.mjs', () => ({ verifyLegacyNativeHandoff: vi.fn() }))

const ZERO = '0x0000000000000000000000000000000000000000'
const member = '0x1111111111111111111111111111111111111111'
const previousResolver = '0x2222222222222222222222222222222222222222'
const nextResolver = '0x3333333333333333333333333333333333333333'
const node = namehash('alice.community.eth')
const input = { client: { neverSends: true }, expectedMember: member,
  parentName: 'community.eth', childName: 'alice.community.eth', expectedResolver: previousResolver }
const evidence = {
  memberResolverAutonomyObserved: true, expectedMember: member, childName: 'alice.community.eth',
  childNode: node, childResolver: previousResolver, finalizedBlockNumber: '123456',
  finalizedBlockHash: `0x${'8'.repeat(64)}`,
}

describe('G2.9 legacy member resolver draft (no native write)', () => {
  beforeEach(() => { vi.resetAllMocks(); vi.mocked(verifyLegacyNativeHandoff).mockResolvedValue(evidence) })

  it('encodes only member-owned NameWrapper.setResolver calldata, NEVER sends or asserts sovereignty', async () => {
    const prepared = await prepareLegacyMemberResolverChange({ ...input, nextResolver })
    expect(prepared).toMatchObject({
      chainId: 11155111, from: member, to: ENSV1_SEPOLIA_WRAPPER, value: '0',
      previousResolver, proposedResolver: nextResolver,
      transactionSent: false, nativeHandoffCompleted: false, sovereignReceipt: false,
      lockedRecordVerified: false, ensV2AuthorityVerified: false,
    })
    const independentAbi = [{ type: 'function', name: 'setResolver', stateMutability: 'nonpayable',
      inputs: [{ type: 'bytes32' }, { type: 'address' }], outputs: [] }]
    expect(decodeFunctionData({ abi: independentAbi, data: prepared.data }))
      .toEqual({ functionName: 'setResolver', args: [node, nextResolver] })
    expect(verifyLegacyNativeHandoff).toHaveBeenCalledExactlyOnceWith(input)
  })

  it('rejects invalid, unchanged or zero next resolvers before contacting evidence client', async () => {
    for (const nextResolver of [ZERO, previousResolver, 'not-an-address', '0x']) {
      await expect(prepareLegacyMemberResolverChange({ ...input, nextResolver }))
        .rejects.toBeInstanceOf(ResolverDraftRefused)
    }
    expect(verifyLegacyNativeHandoff).toHaveBeenCalledTimes(1) // unchanged requires fresh comparison
  })

  it('refuses a locked resolver or owner whose native control was not observed', async () => {
    vi.mocked(verifyLegacyNativeHandoff).mockResolvedValue({ ...evidence, memberResolverAutonomyObserved: false })
    await expect(prepareLegacyMemberResolverChange({ ...input, nextResolver }))
      .rejects.toMatchObject({ code: 'native-member-control-not-observed' })
  })

  it('propagates errors without silently treating unavailable L1 evidence as permission', async () => {
    vi.mocked(verifyLegacyNativeHandoff).mockRejectedValue(new ResolverDraftRefused('missing-native-evidence'))
    await expect(prepareLegacyMemberResolverChange({ ...input, nextResolver }))
      .rejects.toMatchObject({ code: 'missing-native-evidence' })
  })
})
